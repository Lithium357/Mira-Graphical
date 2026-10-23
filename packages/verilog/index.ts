// SPDX-License-Identifier: GPL-3.0-only
import { Lexer, createToken, type IToken } from 'chevrotain';
import { randomUUID } from 'node:crypto';
import { operators, type Operator, type Edit, type GraphChange } from '../protocol/index.js';
import { literalWidth } from './literals.js';
const WS = createToken({
  name: 'Whitespace',
  pattern: /\s+/,
  group: Lexer.SKIPPED,
  line_breaks: true,
});
const Comment = createToken({
  name: 'Comment',
  pattern: /\/\/[^\r\n]*|\/\*[\s\S]*?\*\//,
  group: Lexer.SKIPPED,
  line_breaks: true,
});
const Identifier = createToken({ name: 'Identifier', pattern: /[a-zA-Z_][a-zA-Z0-9_$]*/ });
const Based = createToken({ name: 'Based', pattern: /[0-9][0-9_]*'[bBoOdDhH][0-9a-fA-FxXzZ_]+/ });
const Integer = createToken({ name: 'Integer', pattern: /[0-9][0-9_]*/ });
const Symbol = createToken({ name: 'Symbol', pattern: /[()[\]:?;,=+*\-&|^]/ });
const lexer = new Lexer([WS, Comment, Identifier, Based, Integer, Symbol], {
  ensureOptimizations: false,
});
export type Diagnostic = { message: string; start: number; end: number };
class ParseError extends Error implements Diagnostic {
  constructor(
    message: string,
    public start: number,
    public end: number,
  ) {
    super(message);
  }
}
export type Expr = (
  | { kind: 'ref'; value: string; start: number; end: number }
  | { kind: 'literal'; value: string; start: number; end: number }
  | {
      kind: 'op';
      op: Operator;
      left: Expr;
      right: Expr;
      start: number;
      end: number;
      tokenStart: number;
      tokenEnd: number;
    }
  | {
      kind: 'slice';
      value: string;
      msb: number;
      lsb: number;
      bit: boolean;
      start: number;
      end: number;
      rangeStart: number;
      rangeEnd: number;
    }
  | { kind: 'mux'; condition: Expr; truthy: Expr; falsy: Expr; start: number; end: number }
) & { outerStart?: number; outerEnd?: number };
export type Net = {
  name: string;
  direction: 'input' | 'output' | 'wire';
  width: number;
  msb: number;
  lsb: number;
  declarationStart?: number;
  declarationEnd?: number;
};
function children(e: Expr): [string, Expr][] {
  return e.kind === 'op'
    ? [
        ['L', e.left],
        ['R', e.right],
      ]
    : e.kind === 'mux'
      ? [
          ['C', e.condition],
          ['T', e.truthy],
          ['F', e.falsy],
        ]
      : [];
}
export type Module = {
  name: string;
  nets: Net[];
  assigns: { target: string; expr: Expr; start: number; end: number }[];
  portClose: number;
  lastPortEnd: number;
  portCount: number;
  endmoduleStart: number;
};
const keywords = new Set(
  'always and assign automatic begin buf bufif0 bufif1 case casex casez cell cmos config deassign default defparam design disable edge else end endcase endconfig endfunction endgenerate endmodule endprimitive endspecify endtable endtask event for force forever fork function generate genvar highz0 highz1 if ifnone incdir include initial inout input instance integer join large liblist library localparam macromodule medium module nand negedge nmos nor noshowcancelled not notif0 notif1 or output parameter pmos posedge primitive pull0 pull1 pulldown pullup pulsestyle_onevent pulsestyle_ondetect rcmos real realtime reg release repeat rnmos rpmos rtran rtranif0 rtranif1 scalared showcancelled signed small specify specparam strong0 strong1 supply0 supply1 table task time tran tranif0 tranif1 tri tri0 tri1 triand trior trireg unsigned use vectored wait wand weak0 weak1 while wire wor xnor xor logic bit int byte shortint longint always_comb always_ff always_latch interface endinterface package endpackage typedef struct union enum return void'.split(
    ' ',
  ),
);
export function assertIdentifier(value: string) {
  if (
    typeof value !== 'string' ||
    value.length > 128 ||
    !/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(value) ||
    keywords.has(value)
  )
    throw new Error('Use a unique Verilog identifier (not a keyword, maximum 128 characters).');
}
export const expressionSpan = (e: Expr) => ({
  start: e.outerStart ?? e.start,
  end: e.outerEnd ?? e.end,
});
const precedence: Record<string, number> = { '|': 1, '^': 2, '&': 3, '+': 4, '-': 4, '*': 5 };
export function parse(source: string): Module {
  if (source.length > 1_000_000)
    throw new ParseError('Source exceeds MVP limit (1 million UTF-16 units).', 0, 0);
  const result = lexer.tokenize(source);
  if (result.errors.length) {
    const e = result.errors[0];
    throw new ParseError(`Unsupported token: ${e.message}`, e.offset, e.offset + e.length);
  }
  const tokens = result.tokens;
  let i = 0;
  let recursion = 0;
  if (tokens.length > 4096)
    throw new ParseError('Module exceeds the MVP limit of 4096 tokens.', 0, source.length);
  const peek = () => tokens[i]?.image;
  const fail = (message: string): never => {
    const t = tokens[i];
    throw new ParseError(
      message,
      t?.startOffset ?? source.length,
      (t?.endOffset ?? source.length) + 1,
    );
  };
  const take = (value?: string): IToken => {
    if (!tokens[i] || (value && peek() !== value))
      fail(`Expected ${value ?? 'token'}, found ${peek() ?? 'end of source'}.`);
    return tokens[i++];
  };
  const name = () => {
    if (tokens[i]?.tokenType !== Identifier) fail('Expected identifier.');
    const token = take();
    if (keywords.has(token.image))
      throw new ParseError(
        `Unsupported or misplaced keyword ${token.image}.`,
        token.startOffset,
        token.endOffset! + 1,
      );
    return token.image;
  };
  const integer = () => {
    if (tokens[i]?.tokenType !== Integer) fail('Expected unsigned decimal integer.');
    const n = Number(take().image.replaceAll('_', ''));
    if (!Number.isSafeInteger(n) || n > 2147483647) fail('Integer exceeds supported 31-bit range.');
    return n;
  };
  const width = () => {
    if (peek() !== '[') return { width: 1, msb: 0, lsb: 0 };
    take('[');
    const msb = integer();
    take(':');
    const lsb = integer();
    take(']');
    return { width: Math.abs(msb - lsb) + 1, msb, lsb };
  };
  function expr(min = 0): Expr {
    if (++recursion > 128) fail('Expression nesting exceeds 128 levels.');
    let left: Expr;
    if (peek() === '(') {
      const open = take('(');
      left = expr();
      const close = take(')');
      left = { ...left, outerStart: open.startOffset, outerEnd: close.endOffset! + 1 };
    } else {
      const t = tokens[i];
      if (t?.tokenType === Integer || t?.tokenType === Based) {
        take();
        try {
          literalWidth(t.image);
        } catch (error) {
          throw new ParseError(String(error), t.startOffset, t.endOffset! + 1);
        }
        left = { kind: 'literal', value: t.image, start: t.startOffset, end: t.endOffset! + 1 };
      } else {
        const value = name();
        left = { kind: 'ref', value, start: t.startOffset, end: t.endOffset! + 1 };
        if (peek() === '[') {
          const rangeStart = take('[').startOffset;
          const msb = integer();
          const bit = peek() !== ':';
          if (!bit) take(':');
          const lsb = bit ? msb : integer();
          const end = take(']').endOffset! + 1;
          left = {
            kind: 'slice',
            value,
            msb,
            lsb,
            bit,
            start: t.startOffset,
            end,
            rangeStart,
            rangeEnd: end,
          };
        }
      }
    }
    while (peek() && (precedence[peek()] ?? -1) >= min) {
      const t = take();
      const right = expr(precedence[t.image] + 1);
      left = {
        kind: 'op',
        op: t.image as Operator,
        left,
        right,
        start: expressionSpan(left).start,
        end: expressionSpan(right).end,
        tokenStart: t.startOffset,
        tokenEnd: t.endOffset! + 1,
      };
    }
    if (min === 0 && peek() === '?') {
      take('?');
      const truthy = expr();
      take(':');
      const falsy = expr();
      left = {
        kind: 'mux',
        condition: left,
        truthy,
        falsy,
        start: expressionSpan(left).start,
        end: expressionSpan(falsy).end,
      };
    }
    recursion--;
    return left;
  }
  take('module');
  const moduleName = name();
  take('(');
  const nets: Net[] = [];
  let direction: 'input' | 'output' | undefined;
  let portWidth = { width: 1, msb: 0, lsb: 0 };
  while (peek() !== ')') {
    if (peek() === 'input' || peek() === 'output') {
      direction = take().image as 'input' | 'output';
      if (peek() === 'wire') take();
      portWidth = width();
    }
    if (!direction) fail('Only ANSI input/output ports are supported.');
    nets.push({ name: name(), direction: direction!, ...portWidth });
    if (peek() !== ',') break;
    take(',');
    if (peek() === ')') fail('Trailing port comma.');
  }
  if (!tokens[i]) fail('Expected closing port list.');
  const portClose = tokens[i].startOffset,
    lastPortEnd = tokens[i - 1].endOffset! + 1,
    portCount = nets.length;
  take(')');
  take(';');
  const assigns: Module['assigns'] = [];
  while (peek() !== 'endmodule') {
    if (peek() === 'wire') {
      const start = take().startOffset,
        first = nets.length;
      const w = width();
      do {
        nets.push({ name: name(), direction: 'wire', ...w });
        if (peek() !== ',') break;
        take(',');
      } while (true);
      const end = take(';').endOffset! + 1;
      for (const net of nets.slice(first)) {
        net.declarationStart = start;
        net.declarationEnd = end;
      }
    } else if (peek() === 'assign') {
      const start = take().startOffset;
      const target = name();
      take('=');
      const expression = expr();
      const end = take(';').endOffset! + 1;
      assigns.push({ target, expr: expression, start, end });
    } else
      fail(`Unsupported construct ${peek() ?? '(incomplete module)'}. Last valid graph retained.`);
  }
  const endmoduleStart = take('endmodule').startOffset;
  if (i !== tokens.length) fail('Only one module per shared document is supported.');
  const declared = new Map<string, Net>();
  for (const net of nets) {
    if (declared.has(net.name)) fail(`Duplicate declaration ${net.name}.`);
    declared.set(net.name, net);
  }
  const driven = new Set<string>();
  for (const a of assigns) {
    if (
      !declared.has(a.target) ||
      declared.get(a.target)?.direction === 'input' ||
      driven.has(a.target)
    )
      fail(`Invalid or multiply driven assignment target ${a.target}.`);
    driven.add(a.target);
    const check = (e: Expr): void => {
      for (const [, c] of children(e)) check(c);
      if ((e.kind === 'ref' || e.kind === 'slice') && !declared.has(e.value))
        throw new ParseError(`Undeclared identifier ${e.value}.`, e.start, e.end);
      if (e.kind === 'slice') {
        const n = declared.get(e.value)!;
        if (
          Math.min(e.msb, e.lsb) < Math.min(n.msb, n.lsb) ||
          Math.max(e.msb, e.lsb) > Math.max(n.msb, n.lsb) ||
          (e.msb - e.lsb) * (n.msb - n.lsb) < 0
        )
          throw new ParseError(
            'Slice is out of range or reverses the declared bus direction.',
            e.rangeStart,
            e.rangeEnd,
          );
      }
    };
    check(a.expr);
  }
  return { name: moduleName, nets, assigns, portClose, lastPortEnd, portCount, endmoduleStart };
}
export type Node = {
  id: string;
  key: string;
  label: string;
  kind: 'input' | 'output' | 'wire' | 'op' | 'literal' | 'slice' | 'mux';
  width?: number;
  op?: Operator;
  operands?: string[];
  operandSignature?: string;
  expressionKey?: string;
  range?: string;
  selector?: string;
  depth: number;
  row: number;
  sourceNet?: string;
  assignmentTarget?: string;
  undriven?: boolean;
  netRange?: string;
};
export type Circuit = {
  module: string;
  nodes: Node[];
  edges: { id: string; source: string; target: string; targetHandle: string }[];
};
export const opNames: Record<Operator, string> = {
  '+': 'ADD',
  '-': 'SUB',
  '*': 'MUL',
  '&': 'AND',
  '|': 'OR',
  '^': 'XOR',
};
export function project(
  ast: Module,
  previous?: Circuit,
  saved: Record<string, string> = {},
): Circuit {
  const old = new Map(previous?.nodes.map((n) => [n.key, n.id]) ?? Object.entries(saved));
  const nodes: Node[] = [];
  const edges: Circuit['edges'] = [];
  const add = (key: string, data: Omit<Node, 'key' | 'id' | 'row' | 'depth'>) => {
    const n: Node = { ...data, key, id: old.get(key) ?? randomUUID(), depth: 0, row: 0 };
    nodes.push(n);
    return n;
  };
  const nets = new Map(
    ast.nets.map((n) => [
      n.name,
      add(`${ast.name}/net/${n.name}`, {
        kind: n.direction,
        label: n.name,
        width: n.width,
        sourceNet: n.name,
        netRange: n.width === 1 ? '[0]' : `[${n.msb}:${n.lsb}]`,
        undriven: n.direction !== 'input' && !ast.assigns.some((a) => a.target === n.name),
      }),
    ]),
  );
  const connect = (source: Node, target: Node, port: string) =>
    edges.push({
      id: `${source.id}:${target.id}:${port}`,
      source: source.id,
      target: target.id,
      targetHandle: port,
    });
  function visit(e: Expr, key: string): Node {
    if (e.kind === 'ref') return nets.get(e.value)!;
    if (e.kind === 'literal')
      return add(`${key}/literal`, {
        kind: 'literal',
        expressionKey: key,
        label: e.value,
        width: literalWidth(e.value),
      });
    if (e.kind === 'slice') {
      const range = e.bit ? `[${e.msb}]` : `[${e.msb}:${e.lsb}]`;
      const n = add(`${key}/slice`, {
        kind: 'slice',
        label: e.value + range,
        expressionKey: key,
        range,
        width: Math.abs(e.msb - e.lsb) + 1,
      });
      connect(nets.get(e.value)!, n, 'left');
      return n;
    }
    if (e.kind === 'mux') {
      const c = visit(e.condition, `${key}/C`),
        t = visit(e.truthy, `${key}/T`),
        f = visit(e.falsy, `${key}/F`);
      const n = add(`${key}/mux`, {
        kind: 'mux',
        label: 'MUX',
        expressionKey: key,
        selector: e.condition.kind === 'ref' ? e.condition.value : undefined,
        operandSignature: JSON.stringify([semantic(e.truthy), semantic(e.falsy)]),
        operands: [c.label, t.label, f.label],
        width: Math.max(t.width ?? 1, f.width ?? 1),
      });
      connect(c, n, 'select');
      connect(t, n, 'left');
      connect(f, n, 'right');
      return n;
    }
    const l = visit(e.left, `${key}/L`);
    const r = visit(e.right, `${key}/R`);
    const n = add(key, {
      kind: 'op',
      expressionKey: key,
      label: opNames[e.op],
      op: e.op,
      operands: [l.label, r.label],
      operandSignature: JSON.stringify([semantic(e.left), semantic(e.right)]),
      width: Math.max(l.width ?? 1, r.width ?? 1),
    });
    connect(l, n, 'left');
    connect(r, n, 'right');
    return n;
  }
  for (const a of ast.assigns) {
    const root = visit(a.expr, `${ast.name}/assign/${a.target}/expr`);
    if (!['input', 'output', 'wire'].includes(root.kind)) {
      root.sourceNet = a.target;
      root.assignmentTarget = a.target;
    }
    connect(root, nets.get(a.target)!, 'left');
  }
  const incoming = new Map(
    nodes.map((n) => [n.id, edges.filter((e) => e.target === n.id).map((e) => e.source)]),
  );
  const depths = new Map<string, number>();
  const active = new Set<string>();
  function depth(id: string): number {
    if (depths.has(id)) return depths.get(id)!;
    if (active.has(id)) throw new ParseError('Combinational cycles are unsupported.', 0, 0);
    active.add(id);
    const d = Math.max(0, ...incoming.get(id)!.map((s) => depth(s) + 1));
    active.delete(id);
    depths.set(id, d);
    return d;
  }
  const rows = new Map<number, number>();
  for (const n of nodes) {
    n.depth = depth(n.id);
    n.row = rows.get(n.depth) ?? 0;
    rows.set(n.depth, n.row + 1);
  }
  return { module: ast.name, nodes, edges };
}
export function expressions(ast: Module) {
  const all = new Map<string, Expr>();
  const visit = (e: Expr, k: string) => {
    all.set(k, e);
    for (const [segment, c] of children(e)) visit(c, `${k}/${segment}`);
  };
  for (const a of ast.assigns) visit(a.expr, `${ast.name}/assign/${a.target}/expr`);
  return all;
}
function shape(e: Expr): string {
  return e.kind === 'mux'
    ? `mux(${shape(e.condition)},${shape(e.truthy)},${shape(e.falsy)})`
    : e.kind === 'op'
      ? `(${shape(e.left)},${shape(e.right)})`
      : e.kind === 'slice'
        ? `slice:${e.value}:${e.msb}:${e.lsb}`
        : `${e.kind}:${e.value}`;
}
function semantic(e: Expr): string {
  return e.kind === 'mux'
    ? `mux(${semantic(e.condition)},${semantic(e.truthy)},${semantic(e.falsy)})`
    : e.kind === 'op'
      ? `${e.op}(${semantic(e.left)},${semantic(e.right)})`
      : shape(e);
}
export function operatorPatch(
  source: string,
  graph: Circuit | undefined,
  id: string,
  op: Operator,
): Edit {
  if (!operators.includes(op)) throw new Error('Unsupported operator.');
  const node = graph?.nodes.find((n) => n.id === id && n.kind === 'op');
  if (!node) throw new Error('Select an editable operation.');
  const ast = parse(source);
  project(ast);
  const all = expressions(ast);
  const e = all.get(node.key);
  if (e?.kind !== 'op') throw new Error('Operation no longer exists in the live source.');
  const currentGraph = project(ast);
  const current = currentGraph.nodes.find((n) => n.key === node.key);
  if (current?.operandSignature !== node.operandSignature)
    throw new Error('Operands changed in the live buffer. Commit source changes first.');
  const patch = { start: e.tokenStart, end: e.tokenEnd, text: op };
  const next = parse(source.slice(0, patch.start) + op + source.slice(patch.end));
  if (
    JSON.stringify(ast.assigns.map((a) => shape(a.expr))) !==
    JSON.stringify(next.assigns.map((a) => shape(a.expr)))
  )
    throw new Error(
      'This operator changes precedence grouping. Add parentheses in the source first.',
    );
  return patch;
}
export function graphPatch(
  source: string,
  graph: Circuit | undefined,
  id: string,
  change: GraphChange,
): Edit {
  if (change.kind === 'operator') return operatorPatch(source, graph, id, change.value as Operator);
  const node = graph?.nodes.find((n) => n.id === id);
  if (!node?.expressionKey)
    throw new Error('Select an editable literal, slice or simple mux selector.');
  const ast = parse(source);
  const current = project(ast).nodes.find((n) => n.key === node.key);
  const e = expressions(ast).get(node.expressionKey);
  let edit: Edit;
  if (change.kind === 'literal' && e?.kind === 'literal' && node.kind === 'literal') {
    if (e.value !== node.label)
      throw new Error('Literal changed in the live buffer. Commit source changes first.');
    literalWidth(change.value);
    edit = { start: e.start, end: e.end, text: change.value };
  } else if (change.kind === 'slice' && e?.kind === 'slice' && node.kind === 'slice') {
    if (current?.label !== node.label)
      throw new Error('Slice changed in the live buffer. Commit source changes first.');
    if (!/^\[[0-9]+(?::[0-9]+)?\]$/.test(change.value)) throw new Error('Use [bit] or [msb:lsb].');
    edit = { start: e.rangeStart, end: e.rangeEnd, text: change.value };
  } else if (
    change.kind === 'selector' &&
    e?.kind === 'mux' &&
    e.condition.kind === 'ref' &&
    node.kind === 'mux'
  ) {
    if (current?.operandSignature !== node.operandSignature)
      throw new Error('Mux branches changed in the live buffer. Commit source changes first.');
    if (!ast.nets.some((n) => n.name === change.value && n.width === 1))
      throw new Error('Choose a declared scalar selector.');
    edit = { start: e.condition.start, end: e.condition.end, text: change.value };
  } else throw new Error('This component does not support that edit.');
  validateEditableEdits(source, [edit]);
  return edit;
}
/** Defense in depth in the editor: patches must match supported AST token/selection spans. */
export function validateEditableEdits(source: string, edits: Edit[]): void {
  const ast = parse(source);
  const allowed: { start: number; end: number; kind: GraphChange['kind'] }[] = [];
  for (const e of expressions(ast).values()) {
    if (e.kind === 'op') allowed.push({ start: e.tokenStart, end: e.tokenEnd, kind: 'operator' });
    if (e.kind === 'literal') allowed.push({ start: e.start, end: e.end, kind: 'literal' });
    if (e.kind === 'slice') allowed.push({ start: e.rangeStart, end: e.rangeEnd, kind: 'slice' });
    if (e.kind === 'mux' && e.condition.kind === 'ref')
      allowed.push({ start: e.condition.start, end: e.condition.end, kind: 'selector' });
  }
  let operatorOnly = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    const span = allowed.find((s) => s.start === edit.start && s.end === edit.end);
    if (!span) throw new Error('Patch is outside a supported editable source span.');
    if (span.kind === 'operator') {
      if (!operators.includes(edit.text as Operator)) throw new Error('Invalid operator.');
      operatorOnly = operatorOnly.slice(0, edit.start) + edit.text + operatorOnly.slice(edit.end);
    } else if (span.kind === 'literal') literalWidth(edit.text);
    else if (span.kind === 'slice' && !/^\[[0-9]+(?::[0-9]+)?\]$/.test(edit.text))
      throw new Error('Invalid slice range.');
    else if (
      span.kind === 'selector' &&
      !ast.nets.some((n) => n.name === edit.text && n.width === 1)
    )
      throw new Error('Invalid scalar selector.');
  }
  if (
    JSON.stringify(ast.assigns.map((a) => shape(a.expr))) !==
    JSON.stringify(parse(operatorOnly).assigns.map((a) => shape(a.expr)))
  )
    throw new Error('Operator changes precedence grouping.');
  let next = source;
  for (const e of [...edits].sort((a, b) => b.start - a.start))
    next = next.slice(0, e.start) + e.text + next.slice(e.end);
  project(parse(next));
}
