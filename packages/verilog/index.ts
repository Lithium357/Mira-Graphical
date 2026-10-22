// SPDX-License-Identifier: GPL-3.0-only
import { Lexer, createToken, type IToken } from 'chevrotain';
import { randomUUID } from 'node:crypto';
import { operators, type Operator, type Edit } from '../protocol/index.js';
const WS = createToken({ name: 'Whitespace', pattern: /\s+/, group: Lexer.SKIPPED, line_breaks: true });
const Comment = createToken({ name: 'Comment', pattern: /\/\/[^\r\n]*|\/\*[\s\S]*?\*\//, group: Lexer.SKIPPED, line_breaks: true });
const Identifier = createToken({ name: 'Identifier', pattern: /[a-zA-Z_][a-zA-Z0-9_$]*/ });
const Integer = createToken({ name: 'Integer', pattern: /[0-9]+/ });
const Symbol = createToken({ name: 'Symbol', pattern: /[()[\]:;,=+*\-&|^]/ });
const lexer = new Lexer([WS, Comment, Identifier, Integer, Symbol], { ensureOptimizations: false });
export type Diagnostic = { message: string; start: number; end: number };
class ParseError extends Error implements Diagnostic { constructor(message: string, public start: number, public end: number) { super(message); } }
export type Expr = { kind: 'ref'; value: string; start: number; end: number } | { kind: 'literal'; value: string; start: number; end: number } | { kind: 'op'; op: Operator; left: Expr; right: Expr; start: number; end: number; tokenStart: number; tokenEnd: number };
export type Net = { name: string; direction: 'input' | 'output' | 'wire'; width: number };
export type Module = { name: string; nets: Net[]; assigns: { target: string; expr: Expr }[] };
const precedence: Record<string, number> = { '|': 1, '^': 2, '&': 3, '+': 4, '-': 4, '*': 5 };
export function parse(source: string): Module {
  if (source.length > 1_000_000) throw new ParseError('Source exceeds MVP limit (1 million UTF-16 units).', 0, 0);
  const result = lexer.tokenize(source);
  if (result.errors.length) { const e = result.errors[0]; throw new ParseError(`Unsupported token: ${e.message}`, e.offset, e.offset + e.length); }
  const tokens = result.tokens; let i = 0; let recursion = 0;
  if (tokens.length > 4096) throw new ParseError('Module exceeds the MVP limit of 4096 tokens.', 0, source.length);
  const peek = () => tokens[i]?.image;
  const fail = (message: string): never => { const t = tokens[i]; throw new ParseError(message, t?.startOffset ?? source.length, (t?.endOffset ?? source.length) + 1); };
  const take = (value?: string): IToken => { if (!tokens[i] || (value && peek() !== value)) fail(`Expected ${value ?? 'token'}, found ${peek() ?? 'end of source'}.`); return tokens[i++]; };
  const name = () => { if (tokens[i]?.tokenType !== Identifier) fail('Expected identifier.'); const n = take().image; if (['always','reg','signed','inout','parameter','generate','endmodule','module','assign','input','output','wire'].includes(n)) fail(`Unsupported or misplaced keyword ${n}.`); return n; };
  const integer = () => { if (tokens[i]?.tokenType !== Integer) fail('Expected unsigned decimal integer.'); const n = Number(take().image); if (!Number.isSafeInteger(n) || n > 2147483647) fail('Integer exceeds supported 31-bit range.'); return n; };
  const width = () => { if (peek() !== '[') return 1; take('['); const a = integer(); take(':'); const b = integer(); take(']'); return Math.abs(a-b)+1; };
  function expr(min = 0): Expr {
    if (++recursion > 128) fail('Expression nesting exceeds 128 levels.');
    let left: Expr;
    if (peek() === '(') { take('('); left = expr(); take(')'); }
    else { const t = tokens[i]; if (t?.tokenType === Integer) { integer(); left = { kind: 'literal', value: t.image, start: t.startOffset, end: t.endOffset! + 1 }; } else { const value = name(); left = { kind: 'ref', value, start: t.startOffset, end: t.endOffset! + 1 }; } }
    while (peek() && (precedence[peek()] ?? -1) >= min) {
      const t = take(); const right = expr(precedence[t.image] + 1);
      left = { kind: 'op', op: t.image as Operator, left, right, start: left.start, end: right.end, tokenStart: t.startOffset, tokenEnd: t.endOffset! + 1 };
    }
    recursion--; return left;
  }
  take('module'); const moduleName = name(); take('(');
  const nets: Net[] = []; let direction: 'input' | 'output' | undefined; let portWidth = 1;
  while (peek() !== ')') {
    if (peek() === 'input' || peek() === 'output') { direction = take().image as 'input' | 'output'; if (peek() === 'wire') take(); portWidth = width(); }
    if (!direction) fail('Only ANSI input/output ports are supported.');
    nets.push({ name: name(), direction: direction!, width: portWidth });
    if (peek() !== ',') break; take(','); if (peek() === ')') fail('Trailing port comma.');
  }
  take(')'); take(';'); const assigns: Module['assigns'] = [];
  while (peek() !== 'endmodule') {
    if (peek() === 'wire') { take(); const w = width(); do { nets.push({ name: name(), direction: 'wire', width: w }); if (peek() !== ',') break; take(','); } while (true); take(';'); }
    else if (peek() === 'assign') { take(); const target = name(); take('='); assigns.push({ target, expr: expr() }); take(';'); }
    else fail(`Unsupported construct ${peek() ?? '(incomplete module)'}. Last valid graph retained.`);
  }
  take('endmodule'); if (i !== tokens.length) fail('Only one module per shared document is supported.');
  const declared = new Map<string, Net>();
  for (const net of nets) { if (declared.has(net.name)) fail(`Duplicate declaration ${net.name}.`); declared.set(net.name, net); }
  const driven = new Set<string>();
  for (const a of assigns) {
    if (!declared.has(a.target) || declared.get(a.target)?.direction === 'input' || driven.has(a.target)) fail(`Invalid or multiply driven assignment target ${a.target}.`);
    driven.add(a.target);
    const check = (e: Expr): void => { if (e.kind === 'op') { check(e.left); check(e.right); } else if (e.kind === 'ref' && !declared.has(e.value)) throw new ParseError(`Undeclared identifier ${e.value}.`, e.start, e.end); };
    check(a.expr);
  }
  return { name: moduleName, nets, assigns };
}
export type Node = { id: string; key: string; label: string; kind: 'input' | 'output' | 'wire' | 'op' | 'literal'; width?: number; op?: Operator; operands?: string[]; depth: number; row: number };
export type Circuit = { module: string; nodes: Node[]; edges: { id: string; source: string; target: string; targetHandle: string }[] };
export const opNames: Record<Operator, string> = { '+': 'ADD', '-': 'SUB', '*': 'MUL', '&': 'AND', '|': 'OR', '^': 'XOR' };
export function project(ast: Module, previous?: Circuit, saved: Record<string, string> = {}): Circuit {
  const old = new Map(previous?.nodes.map(n => [n.key, n.id]) ?? Object.entries(saved));
  const nodes: Node[] = []; const edges: Circuit['edges'] = [];
  const add = (key: string, data: Omit<Node, 'key' | 'id' | 'row' | 'depth'>) => { const n: Node = { ...data, key, id: old.get(key) ?? randomUUID(), depth: 0, row: 0 }; nodes.push(n); return n; };
  const nets = new Map(ast.nets.map(n => [n.name, add(`${ast.name}/net/${n.name}`, { kind: n.direction, label: n.name, width: n.width })]));
  const connect = (source: Node, target: Node, port: string) => edges.push({ id: `${source.id}:${target.id}:${port}`, source: source.id, target: target.id, targetHandle: port });
  function visit(e: Expr, key: string): Node {
    if (e.kind === 'ref') return nets.get(e.value)!;
    if (e.kind === 'literal') return add(key, { kind: 'literal', label: e.value, width: 32 });
    const l = visit(e.left, `${key}/L`); const r = visit(e.right, `${key}/R`);
    const n = add(key, { kind: 'op', label: opNames[e.op], op: e.op, operands: [l.label, r.label], width: Math.max(l.width ?? 1, r.width ?? 1) });
    connect(l, n, 'left'); connect(r, n, 'right'); return n;
  }
  for (const a of ast.assigns) connect(visit(a.expr, `${ast.name}/assign/${a.target}/expr`), nets.get(a.target)!, 'left');
  const incoming = new Map(nodes.map(n => [n.id, edges.filter(e => e.target === n.id).map(e => e.source)]));
  const depths = new Map<string, number>(); const active = new Set<string>();
  function depth(id: string): number { if (depths.has(id)) return depths.get(id)!; if (active.has(id)) throw new ParseError('Combinational cycles are unsupported.', 0, 0); active.add(id); const d = Math.max(0, ...incoming.get(id)!.map(s => depth(s) + 1)); active.delete(id); depths.set(id, d); return d; }
  const rows = new Map<number, number>();
  for (const n of nodes) { n.depth = depth(n.id); n.row = rows.get(n.depth) ?? 0; rows.set(n.depth, n.row + 1); }
  return { module: ast.name, nodes, edges };
}
function expressions(ast: Module) {
  const all = new Map<string, Expr>();
  const visit = (e: Expr, k: string) => { all.set(k, e); if (e.kind === 'op') { visit(e.left, `${k}/L`); visit(e.right, `${k}/R`); } };
  for (const a of ast.assigns) visit(a.expr, `${ast.name}/assign/${a.target}/expr`);
  return all;
}
function shape(e: Expr): string { return e.kind === 'op' ? `(${shape(e.left)},${shape(e.right)})` : `${e.kind}:${e.value}`; }
export function operatorPatch(source: string, graph: Circuit | undefined, id: string, op: Operator): Edit {
  if (!operators.includes(op)) throw new Error('Unsupported operator.');
  const node = graph?.nodes.find(n => n.id === id && n.kind === 'op');
  if (!node) throw new Error('Select an editable operation.');
  const ast = parse(source); project(ast); const all = expressions(ast); const e = all.get(node.key);
  if (e?.kind !== 'op') throw new Error('Operation no longer exists in the live source.');
  const currentGraph = project(ast);
  const current = currentGraph.nodes.find(n => n.key === node.key);
  if (JSON.stringify(current?.operands) !== JSON.stringify(node.operands)) throw new Error('Operands changed in the live buffer. Commit source changes first.');
  const patch = { start: e.tokenStart, end: e.tokenEnd, text: op };
  const next = parse(source.slice(0, patch.start) + op + source.slice(patch.end));
  if (JSON.stringify(ast.assigns.map(a => shape(a.expr))) !== JSON.stringify(next.assigns.map(a => shape(a.expr)))) throw new Error('This operator changes precedence grouping. Add parentheses in the source first.');
  return patch;
}
