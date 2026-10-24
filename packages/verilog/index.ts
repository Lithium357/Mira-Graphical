// SPDX-License-Identifier: GPL-3.0-only
import { Lexer, createToken, type IToken } from 'chevrotain';
import { randomUUID } from 'node:crypto';
import { operators, type Operator, type Edit, type GraphChange } from '../protocol/index.js';
import { literalWidth } from './literals.js';
import {
  parseVhdl,
  isVhdl,
  vhdlOperator,
  vhdlTokenEdit,
  validateVhdlEdits,
} from '../vhdl/index.js';
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
const Fill = createToken({ name: 'Fill', pattern: /'[01]/ });
const Based = createToken({ name: 'Based', pattern: /[0-9][0-9_]*'[bBoOdDhH][0-9a-fA-FxXzZ_]+/ });
const Integer = createToken({ name: 'Integer', pattern: /[0-9][0-9_]*/ });
const Symbol = createToken({ name: 'Symbol', pattern: /[{}()[\]:?;,.=+*\-&|^]/ });
const lexer = new Lexer([WS, Comment, Identifier, Fill, Based, Integer, Symbol], {
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
  | {
      kind: 'convert';
      conversion: 'unsigned' | 'std_logic_vector' | 'resize';
      value: Expr;
      resultWidth?: number;
      qualified?: boolean;
      start: number;
      end: number;
    }
  | { kind: 'concat'; parts: Expr[]; start: number; end: number }
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
) & {
  outerStart?: number;
  outerEnd?: number;
  nativeType?: 'std_logic' | 'std_logic_vector' | 'unsigned';
  nativeWidth?: number;
};
export type Net = {
  name: string;
  direction: 'input' | 'output' | 'wire';
  width: number;
  msb: number;
  lsb: number;
  nativeType?: 'std_logic' | 'std_logic_vector' | 'unsigned';
  netType?: string;
  declarationStart?: number;
  declarationEnd?: number;
};
export function children(e: Expr): [string, Expr][] {
  if (e.kind === 'convert') return [['V', e.value]];
  if (e.kind === 'concat') return e.parts.map((p, i) => [`P${i}`, p]);
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
  language?: 'verilog' | 'systemverilog' | 'vhdl';
  vhdl?: {
    entityStart: number;
    entityEnd: number;
    architectureStart: number;
    architectureEnd: number;
    entityEndStart: number;
    declarationsEnd: number;
    architecture: string;
  };
  name: string;
  start: number;
  end: number;
  instances: {
    name: string;
    module: string;
    start: number;
    end: number;
    ports: { name: string; expr: Expr }[];
  }[];
  library: Record<string, Module>;
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
export function parse(source: string, selected?: string): Module {
  if (isVhdl(source)) return parseVhdl(source, selected);
  if (source.length > 1_000_000)
    throw new ParseError('Source exceeds limit (1 million UTF-16 units).', 0, 0);
  const result = lexer.tokenize(source);
  if (result.errors.length) {
    const e = result.errors[0];
    if (source[e.offset] === '`')
      throw new ParseError(
        `Unsupported preprocessor directive ${source.slice(e.offset).match(/^`[A-Za-z_][A-Za-z_0-9]*/)?.[0] ?? '`'}. Share self-contained modules without directives or macro expansion.`,
        e.offset,
        e.offset + e.length,
      );
    if (source[e.offset] === '@')
      throw new ParseError(
        'Unsupported event control (@). Clocked/event-driven HDL is outside the combinational subset.',
        e.offset,
        e.offset + e.length,
      );
    throw new ParseError(`Unsupported token: ${e.message}`, e.offset, e.offset + e.length);
  }
  if (result.tokens.length > 32768)
    throw new ParseError('Document exceeds 32768 tokens.', 0, source.length);
  const library: Record<string, Module> = Object.create(null);
  let start = 0;
  while (start < result.tokens.length) {
    if (result.tokens[start].image !== 'module')
      throw new ParseError(
        'Expected a module definition.',
        result.tokens[start].startOffset,
        result.tokens[start].endOffset! + 1,
      );
    let end = start + 1;
    while (end < result.tokens.length && result.tokens[end].image !== 'endmodule') end++;
    const ast = parseSingle(source, result.tokens.slice(start, end + 1));
    if (library[ast.name])
      throw new ParseError(
        `Duplicate module ${ast.name}.`,
        result.tokens[start].startOffset,
        ast.endmoduleStart,
      );
    library[ast.name] = ast;
    start = end + 1;
    if (Object.keys(library).length > 64) throw new Error('Limit: 64 modules per document.');
  }
  if (!Object.keys(library).length)
    throw new ParseError('Expected a module definition.', 0, source.length);
  return validateLibrary(source, library, selected);
}
export function validateLibrary(
  source: string,
  library: Record<string, Module>,
  selected?: string,
): Module {
  for (const ast of Object.values(library)) ast.library = library;
  for (const ast of Object.values(library)) {
    const driven = new Set(ast.assigns.map((a) => a.target));
    for (const inst of ast.instances) {
      const child = library[inst.module];
      if (!child)
        throw new ParseError(
          `Unknown module ${inst.module}. Include its definition in this shared document.`,
          inst.start,
          inst.end,
        );
      const ports = child.nets.filter((n) => n.direction !== 'wire');
      if (
        inst.ports.length !== ports.length ||
        new Set(inst.ports.map((p) => p.name)).size !== ports.length ||
        inst.ports.some((p) => !ports.some((n) => n.name === p.name))
      )
        throw new ParseError(
          `Instance ${inst.name} must connect each named port exactly once.`,
          inst.start,
          inst.end,
        );
      for (const port of ports.filter((n) => n.direction === 'output')) {
        const e = inst.ports.find((p) => p.name === port.name)!.expr;
        if (
          e.kind !== 'ref' ||
          !ast.nets.some((n) => n.name === e.value && n.direction !== 'input') ||
          driven.has(e.value)
        )
          throw new ParseError(
            'Instance outputs need distinct, declared, non-input signal drivers.',
            e.start,
            e.end,
          );
        driven.add(e.value);
      }
    }
  }
  for (const ast of Object.values(library)) {
    let count = 0;
    const walk = (m: Module, path: string[]) => {
      if (path.includes(m.name) || path.length >= 32)
        throw new ParseError('Recursive or excessively deep module hierarchy.', 0, source.length);
      if (++count > 256) throw new Error('Expanded hierarchy exceeds 256 module instances.');
      for (const inst of m.instances) walk(library[inst.module], [...path, m.name]);
    };
    walk(ast, []);
    project(ast);
  }
  const ast = selected ? library[selected] : Object.values(library)[0];
  if (!ast) throw new Error(`Module ${selected} no longer exists.`);
  return ast;
}
function parseSingle(source: string, tokens: IToken[]): Module {
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
    if (peek() === '{') {
      const open = take('{');
      const parts: Expr[] = [];
      do {
        parts.push(expr());
        if (peek() !== ',') break;
        take(',');
      } while (true);
      const end = take('}').endOffset! + 1;
      if (parts.length < 1 || parts.length > 64) fail('Concatenation needs 1–64 parts.');
      left = { kind: 'concat', parts, start: open.startOffset, end };
    } else if (peek() === '(') {
      const open = take('(');
      left = expr();
      const close = take(')');
      left = { ...left, outerStart: open.startOffset, outerEnd: close.endOffset! + 1 };
    } else {
      const t = tokens[i];
      if (t?.tokenType === Integer || t?.tokenType === Based || t?.tokenType === Fill) {
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
  const moduleStart = take('module').startOffset;
  const moduleName = name();
  take('(');
  const nets: Net[] = [];
  let direction: 'input' | 'output' | undefined;
  let portWidth = { width: 1, msb: 0, lsb: 0 };
  let portType = 'wire';
  while (peek() !== ')') {
    if (peek() === 'input' || peek() === 'output') {
      direction = take().image as 'input' | 'output';
      if (['wire', 'logic', 'reg'].includes(peek())) portType = take().image;
      else portType = 'wire';
      if (peek() === 'unsigned') take();
      portWidth = width();
    }
    if (!direction) fail('Only ANSI input/output ports are supported.');
    nets.push({ name: name(), direction: direction!, netType: portType, ...portWidth });
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
  const instances: Module['instances'] = [];
  while (peek() !== 'endmodule') {
    if (['wire', 'logic', 'reg'].includes(peek())) {
      const start = take().startOffset,
        first = nets.length;
      const netType = tokens[i - 1].image;
      if (peek() === 'unsigned') take();
      const w = width();
      do {
        nets.push({ name: name(), direction: 'wire', netType, ...w });
        if (peek() !== ',') break;
        take(',');
      } while (true);
      const end = take(';').endOffset! + 1;
      for (const net of nets.slice(first)) {
        net.declarationStart = start;
        net.declarationEnd = end;
      }
    } else if (peek() === 'always_comb') {
      take();
      const block = peek() === 'begin';
      if (block) take();
      const process: Module['assigns'] = [];
      const assignment = () => {
        const start = tokens[i]?.startOffset ?? source.length,
          target = name();
        take('=');
        const value = expr(),
          end = take(';').endOffset! + 1;
        return { target, expr: value, start, end };
      };
      do {
        if (block && peek() === 'end') break;
        if (peek() === 'if') {
          const start = take().startOffset;
          take('(');
          const condition = expr();
          take(')');
          const branch = () => {
            const wrapped = peek() === 'begin';
            if (wrapped) take();
            const a = assignment();
            if (wrapped) take('end');
            return a;
          };
          const truthy = branch();
          take('else');
          const falsy = branch();
          if (truthy.target !== falsy.target)
            fail('Combinational branches must drive the same output on both paths.');
          const end = tokens[i - 1].endOffset! + 1;
          process.push({
            target: truthy.target,
            expr: {
              kind: 'mux',
              condition,
              truthy: truthy.expr,
              falsy: falsy.expr,
              start: condition.start,
              end,
            },
            start,
            end,
          });
        } else process.push(assignment());
        if (!block) break;
      } while (peek() !== 'end');
      if (block) take('end');
      const targets = new Set(process.map((a) => a.target));
      for (const a of process) {
        if (!nets.some((n) => n.name === a.target && ['logic', 'reg'].includes(n.netType ?? '')))
          fail('always_comb targets must be declared logic or reg.');
        const check = (e: Expr): void => {
          if ((e.kind === 'ref' || e.kind === 'slice') && targets.has(e.value))
            fail(
              'Reads of signals written by the same always_comb block are unsupported; use independent assignments or continuous wiring.',
            );
          for (const [, child] of children(e)) check(child);
        };
        check(a.expr);
      }
      assigns.push(...process);
    } else if (peek() === 'assign') {
      const start = take().startOffset;
      const target = name();
      take('=');
      const expression = expr();
      const end = take(';').endOffset! + 1;
      assigns.push({ target, expr: expression, start, end });
    } else if (tokens[i]?.tokenType === Identifier && !keywords.has(peek())) {
      const start = tokens[i].startOffset,
        module = name(),
        instanceName = name();
      take('(');
      const ports: Module['instances'][number]['ports'] = [];
      while (peek() !== ')') {
        take('.');
        const port = name();
        take('(');
        const expression = expr();
        take(')');
        ports.push({ name: port, expr: expression });
        if (peek() !== ',') break;
        take(',');
      }
      take(')');
      const end = take(';').endOffset! + 1;
      instances.push({ name: instanceName, module, ports, start, end });
    } else
      fail(`Unsupported construct ${peek() ?? '(incomplete module)'}. Last valid graph retained.`);
  }
  const closing = take('endmodule'),
    endmoduleStart = closing.startOffset,
    moduleEnd = closing.endOffset! + 1;
  if (i !== tokens.length) fail('Unexpected text after module.');
  if (
    new Set(instances.map((n) => n.name)).size !== instances.length ||
    instances.some((n) => nets.some((net) => net.name === n.name))
  )
    fail('Duplicate instance or signal name.');
  const declared = new Map<string, Net>();
  for (const net of nets) {
    if (declared.has(net.name)) fail(`Duplicate declaration ${net.name}.`);
    declared.set(net.name, net);
  }
  const driven = new Set<string>();
  for (const a of [
    ...assigns,
    ...instances.flatMap((inst) => inst.ports.map((p) => ({ target: undefined, expr: p.expr }))),
  ]) {
    if (
      a.target !== undefined &&
      (!declared.has(a.target) ||
        declared.get(a.target)?.direction === 'input' ||
        driven.has(a.target))
    )
      fail(`Invalid or multiply driven assignment target ${a.target}.`);
    if (a.target !== undefined) driven.add(a.target);
    const check = (e: Expr): void => {
      for (const [, c] of children(e)) check(c);
      if ((e.kind === 'ref' || e.kind === 'slice') && !declared.has(e.value))
        throw new ParseError(`Undeclared identifier ${e.value}.`, e.start, e.end);
      if (e.kind === 'concat') {
        const sized = (part: Expr): void => {
          if (part.kind === 'literal' && !part.value.includes("'"))
            throw new ParseError(
              'Concatenations require explicitly sized literals.',
              part.start,
              part.end,
            );
          for (const [, child] of children(part)) sized(child);
        };
        e.parts.forEach(sized);
      }
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
  return {
    language: tokens.some((t) => ['logic', 'always_comb'].includes(t.image) || t.tokenType === Fill)
      ? 'systemverilog'
      : 'verilog',
    name: moduleName,
    start: moduleStart,
    end: moduleEnd,
    nets,
    assigns,
    instances,
    library: {},
    portClose,
    lastPortEnd,
    portCount,
    endmoduleStart,
  };
}
export type Node = {
  nativeType?: Net['nativeType'];
  id: string;
  key: string;
  label: string;
  kind:
    | 'input'
    | 'output'
    | 'wire'
    | 'op'
    | 'literal'
    | 'slice'
    | 'mux'
    | 'concat'
    | 'instance'
    | 'convert';
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
  childModule?: string;
  inputPorts?: { name: string; width: number }[];
  outputPorts?: { name: string; width: number; signal: string }[];
};
export type Circuit = {
  language?: Module['language'];
  module: string;
  library?: { name: string; ports: { name: string; direction: string; width: number }[] }[];
  issues?: { code: string; message: string; nodeKey: string }[];
  nodes: Node[];
  edges: {
    id: string;
    source: string;
    target: string;
    targetHandle: string;
    sourceHandle?: string;
  }[];
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
  const old = new Map([
    ...Object.entries(saved),
    ...(previous?.nodes.map((n) => [n.key, n.id] as [string, string]) ?? []),
  ]);
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
        nativeType: n.nativeType,
        label: n.name,
        width: n.width,
        sourceNet: n.name,
        netRange: n.width === 1 ? '[0]' : `[${n.msb}:${n.lsb}]`,
        undriven:
          n.direction !== 'input' &&
          !ast.assigns.some((a) => a.target === n.name) &&
          !ast.instances.some((inst) =>
            inst.ports.some(
              (p) =>
                p.expr.kind === 'ref' &&
                p.expr.value === n.name &&
                ast.library[inst.module]?.nets.some(
                  (port) => port.name === p.name && port.direction === 'output',
                ),
            ),
          ),
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
  const widthOf = (e: Expr): number =>
    e.kind === 'convert'
      ? (e.resultWidth ?? widthOf(e.value))
      : (e.nativeWidth ??
        (e.kind === 'ref'
          ? nets.get(e.value)!.width!
          : e.kind === 'slice'
            ? Math.abs(e.msb - e.lsb) + 1
            : e.kind === 'literal'
              ? literalWidth(e.value)
              : e.kind === 'concat'
                ? e.parts.reduce((sum, p) => sum + widthOf(p), 0)
                : e.kind === 'mux'
                  ? Math.max(widthOf(e.truthy), widthOf(e.falsy))
                  : Math.max(widthOf(e.left), widthOf(e.right))));
  function visit(e: Expr, key: string, context = 0): Node {
    if (ast.language === 'vhdl') context = 0;
    if (e.kind === 'convert') {
      const child = visit(e.value, `${key}/V`);
      const node = add(key, {
        kind: 'convert',
        label: e.conversion.toUpperCase(),
        expressionKey: key,
        width: widthOf(e),
        operands: [child.label],
      });
      connect(child, node, 'left');
      return node;
    }
    if (e.kind === 'ref') return nets.get(e.value)!;
    if (e.kind === 'literal')
      return add(`${key}/literal`, {
        kind: 'literal',
        expressionKey: key,
        label: e.value,
        width: /^'[01]$/.test(e.value) ? Math.max(1, context) : literalWidth(e.value),
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
    if (e.kind === 'concat') {
      const parts = e.parts.map((p, i) => visit(p, `${key}/P${i}`));
      const node = add(`${key}/concat`, {
        kind: 'concat',
        label: 'JOIN',
        expressionKey: key,
        operands: parts.map((p) => p.label),
        width: parts.reduce((w, p) => w + p.width!, 0),
        inputPorts: parts.map((p, i) => ({ name: `part:${i}`, width: p.width! })),
      });
      parts.forEach((p, i) => connect(p, node, `part:${i}`));
      return node;
    }
    if (e.kind === 'mux') {
      const w = Math.max(context, widthOf(e));
      const c = visit(e.condition, `${key}/C`),
        t = visit(e.truthy, `${key}/T`, w),
        f = visit(e.falsy, `${key}/F`, w);
      const n = add(`${key}/mux`, {
        kind: 'mux',
        label: 'MUX',
        expressionKey: key,
        selector: e.condition.kind === 'ref' ? e.condition.value : undefined,
        operandSignature: JSON.stringify([semantic(e.truthy), semantic(e.falsy)]),
        operands: [c.label, t.label, f.label],
        width: w,
      });
      connect(c, n, 'select');
      connect(t, n, 'left');
      connect(f, n, 'right');
      return n;
    }
    const w = Math.max(context, widthOf(e));
    const l = visit(e.left, `${key}/L`, w);
    const r = visit(e.right, `${key}/R`, w);
    const n = add(key, {
      kind: 'op',
      expressionKey: key,
      label: opNames[e.op],
      op: e.op,
      operands: [l.label, r.label],
      operandSignature: JSON.stringify([semantic(e.left), semantic(e.right)]),
      width: w,
    });
    connect(l, n, 'left');
    connect(r, n, 'right');
    return n;
  }
  for (const inst of ast.instances) {
    const child = ast.library[inst.module],
      inputs = child.nets.filter((n) => n.direction === 'input'),
      outputs = child.nets.filter((n) => n.direction === 'output');
    const node = add(`${ast.name}/instance/${inst.name}`, {
      kind: 'instance',
      label: inst.name,
      childModule: inst.module,
      inputPorts: inputs.map((p) => ({ name: `port:${p.name}`, width: p.width })),
      outputPorts: outputs.map((p) => ({
        name: p.name,
        width: p.width,
        signal: (inst.ports.find((b) => b.name === p.name)!.expr as Extract<Expr, { kind: 'ref' }>)
          .value,
      })),
    });
    for (const port of inputs) {
      const e = inst.ports.find((p) => p.name === port.name)!.expr;
      connect(
        visit(e, `${ast.name}/instance/${inst.name}/port/${port.name}`, port.width),
        node,
        `port:${port.name}`,
      );
    }
    for (const port of node.outputPorts!) {
      connect(node, nets.get(port.signal)!, 'left');
      edges.at(-1)!.sourceHandle = `out:${port.name}`;
    }
  }
  for (const a of ast.assigns) {
    const root = visit(a.expr, `${ast.name}/assign/${a.target}/expr`, nets.get(a.target)!.width);
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
  const issues: NonNullable<Circuit['issues']> = [];
  const warn = (node: Node, code: string, message: string) =>
    issues.push({ nodeKey: node.key, code, message });
  for (const node of nodes) {
    if (node.undriven) warn(node, 'undriven', `${node.label} has no driver.`);
    if (['wire', 'input'].includes(node.kind) && !edges.some((e) => e.source === node.id))
      warn(node, 'unused', `${node.label} is unused.`);
    for (const edge of edges.filter((e) => e.target === node.id)) {
      const from = nodes.find((n) => n.id === edge.source)!;
      const expected =
        node.kind === 'mux' && edge.targetHandle === 'select'
          ? 1
          : node.kind === 'instance' || node.kind === 'concat'
            ? node.inputPorts?.find((p) => p.name === edge.targetHandle)?.width
            : node.width;
      const actual =
        from.kind === 'instance'
          ? from.outputPorts?.find((p) => `out:${p.name}` === edge.sourceHandle)?.width
          : from.width;
      if (node.kind === 'mux' && edge.targetHandle === 'select' && actual && actual !== 1) {
        warn(
          node,
          'selector-width',
          `${actual}-bit selector is tested for nonzero; graph wiring requires a scalar.`,
        );
        continue;
      }
      if (
        actual &&
        expected &&
        actual !== expected &&
        node.kind !== 'slice' &&
        node.kind !== 'concat'
      )
        warn(
          node,
          actual > expected ? 'truncation' : 'extension',
          `${from.sourceNet ?? from.label}: ${actual} -> ${expected} bits at ${node.label} (${actual > expected ? 'high bits discarded' : 'zero extended'}).`,
        );
    }
  }
  return {
    language: ast.language,
    module: ast.name,
    nodes,
    edges,
    issues,
    library: Object.values(ast.library).map((m) => ({
      name: m.name,
      ports: m.nets
        .filter((n) => n.direction !== 'wire')
        .map((n) => ({ name: n.name, direction: n.direction, width: n.width })),
    })),
  };
}
export function expressions(ast: Module) {
  const all = new Map<string, Expr>();
  const visit = (e: Expr, k: string) => {
    all.set(k, e);
    for (const [segment, c] of children(e)) visit(c, `${k}/${segment}`);
  };
  for (const a of ast.assigns) visit(a.expr, `${ast.name}/assign/${a.target}/expr`);
  for (const inst of ast.instances)
    for (const port of inst.ports)
      visit(port.expr, `${ast.name}/instance/${inst.name}/port/${port.name}`);
  return all;
}
export function shape(e: Expr): string {
  if (e.kind === 'convert') return `${e.conversion}:${e.resultWidth ?? ''}(${shape(e.value)})`;
  if (e.kind === 'concat') return `concat(${e.parts.map(shape).join(',')})`;
  return e.kind === 'mux'
    ? `mux(${shape(e.condition)},${shape(e.truthy)},${shape(e.falsy)})`
    : e.kind === 'op'
      ? `(${shape(e.left)},${shape(e.right)})`
      : e.kind === 'slice'
        ? `slice:${e.value}:${e.msb}:${e.lsb}`
        : `${e.kind}:${e.value}`;
}
function semantic(e: Expr): string {
  if (e.kind === 'convert') return `${e.conversion}:${e.resultWidth ?? ''}(${semantic(e.value)})`;
  if (e.kind === 'concat') return `concat(${e.parts.map(semantic).join(',')})`;
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
  const ast = parse(source, graph?.module);
  project(ast);
  const all = expressions(ast);
  const e = all.get(node.key);
  if (e?.kind !== 'op') throw new Error('Operation no longer exists in the live source.');
  const currentGraph = project(ast);
  const current = currentGraph.nodes.find((n) => n.key === node.key);
  if (current?.operandSignature !== node.operandSignature)
    throw new Error('Operands changed in the live buffer. Commit source changes first.');
  const replacement = ast.language === 'vhdl' ? vhdlOperator(op) : op;
  const patch = { start: e.tokenStart, end: e.tokenEnd, text: replacement };
  const next = parse(
    source.slice(0, patch.start) + replacement + source.slice(patch.end),
    ast.name,
  );
  if (
    JSON.stringify(
      Object.values(ast.library).map((m) => [
        m.assigns.map((a) => shape(a.expr)),
        m.instances.map((i) => i.ports.map((p) => shape(p.expr))),
      ]),
    ) !==
    JSON.stringify(
      Object.values(next.library).map((m) => [
        m.assigns.map((a) => shape(a.expr)),
        m.instances.map((i) => i.ports.map((p) => shape(p.expr))),
      ]),
    )
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
  const ast = parse(source, graph?.module);
  const current = project(ast).nodes.find((n) => n.key === node.key);
  const e = expressions(ast).get(node.expressionKey);
  if (ast.language === 'vhdl') return vhdlTokenEdit(source, ast, node, e, change, current);
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
  if (ast.language === 'vhdl') return validateVhdlEdits(source, edits);
  const allowed: { start: number; end: number; kind: GraphChange['kind']; scalars?: string[] }[] =
    [];
  for (const scope of Object.values(ast.library))
    for (const e of expressions(scope).values()) {
      if (e.kind === 'op') allowed.push({ start: e.tokenStart, end: e.tokenEnd, kind: 'operator' });
      if (e.kind === 'literal') allowed.push({ start: e.start, end: e.end, kind: 'literal' });
      if (e.kind === 'slice') allowed.push({ start: e.rangeStart, end: e.rangeEnd, kind: 'slice' });
      if (e.kind === 'mux' && e.condition.kind === 'ref')
        allowed.push({
          start: e.condition.start,
          end: e.condition.end,
          kind: 'selector',
          scalars: scope.nets.filter((n) => n.width === 1).map((n) => n.name),
        });
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
    else if (span.kind === 'selector' && !span.scalars?.includes(edit.text))
      throw new Error('Invalid scalar selector.');
  }
  if (
    JSON.stringify(
      Object.values(ast.library).map((m) => [
        m.assigns.map((a) => shape(a.expr)),
        m.instances.map((i) => i.ports.map((p) => shape(p.expr))),
      ]),
    ) !==
    JSON.stringify(
      Object.values(parse(operatorOnly).library).map((m) => [
        m.assigns.map((a) => shape(a.expr)),
        m.instances.map((i) => i.ports.map((p) => shape(p.expr))),
      ]),
    )
  )
    throw new Error('Operator changes precedence grouping.');
  let next = source;
  for (const e of [...edits].sort((a, b) => b.start - a.start))
    next = next.slice(0, e.start) + e.text + next.slice(e.end);
  project(parse(next));
}
