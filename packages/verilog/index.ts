// SPDX-License-Identifier: GPL-3.0-only
import { Lexer, createToken, type IToken } from 'chevrotain';
import { randomUUID } from 'node:crypto';
import {
  operators,
  isComparison,
  type Operator,
  type Edit,
  type GraphChange,
} from '../protocol/index.js';
import { literalWidth } from './literals.js';
import { elaborate, hasRegisters, clocksFor } from './elaboration.js';
import { lowerStatements, registerInputs, type Statement } from './procedural.js';
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
const SystemCast = createToken({ name: 'SystemCast', pattern: /\$(?:signed|unsigned)\b/ });
const Fill = createToken({ name: 'Fill', pattern: /'[01]/ });
const Based = createToken({ name: 'Based', pattern: /[0-9][0-9_]*'[bBoOdDhH][0-9a-fA-FxXzZ_]+/ });
const SizedCast = createToken({ name: 'SizedCast', pattern: /[0-9][0-9_]*'(?=\()/ });
const Integer = createToken({ name: 'Integer', pattern: /[0-9][0-9_]*/ });
const Symbol = createToken({
  name: 'Symbol',
  pattern: />>>|===|!==|&&|\|\||<<|>>|==|!=|<=|>=|[{}()[\]:?;,.=+*\-&|^~<>!@]/,
});
const lexer = new Lexer(
  [WS, Comment, SystemCast, Identifier, Fill, Based, SizedCast, Integer, Symbol],
  {
    ensureOptimizations: false,
  },
);
export type Diagnostic = {
  message: string;
  start: number;
  end: number;
  line?: number;
  column?: number;
  module?: string;
};
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
      conversion: 'signed' | 'unsigned' | 'std_logic_vector' | 'resize';
      value: Expr;
      resultWidth?: number;
      qualified?: boolean;
      start: number;
      end: number;
    }
  | { kind: 'concat'; parts: Expr[]; repeat?: number; start: number; end: number }
  | { kind: 'ref'; value: string; start: number; end: number }
  | { kind: 'literal'; value: string; start: number; end: number }
  | {
      kind: 'unary';
      op: '~' | '!';
      value: Expr;
      start: number;
      end: number;
      tokenStart: number;
      tokenEnd: number;
    }
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
  | {
      kind: 'mux';
      condition: Expr;
      truthy: Expr;
      falsy: Expr;
      start: number;
      end: number;
      procedural?: boolean;
    }
) & {
  constantName?: string;
  enumType?: string;
  signed?: boolean;
  synthetic?: boolean;
  caseLabels?: Expr[];
  outerStart?: number;
  outerEnd?: number;
  nativeType?: 'std_logic' | 'std_logic_vector' | 'unsigned';
  nativeWidth?: number;
};
export type Net = {
  enumType?: string;
  signed?: boolean;
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
  if (e.kind === 'unary') return [['V', e.value]];
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
  enumNames?: string[];
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
  assigns: {
    target: string;
    expr: Expr;
    start: number;
    end: number;
    structured?: boolean;
    registerInputs?: {
      clockSensitivity?: { start: number; end: number };
      data: { start: number; end: number };
      clock: { start: number; end: number };
      reset?: { start: number; end: number };
    };
    events?: {
      signal: string;
      edge: 'posedge' | 'negedge';
      strict?: boolean;
      level?: '0' | '1';
      start?: number;
      end?: number;
      sensitivityStart?: number;
      sensitivityEnd?: number;
    }[];
  }[];
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
const precedence: Record<string, number> = {
  '||': -1,
  '&&': 0,
  '|': 1,
  '^': 2,
  '&': 3,
  '==': 4,
  '!=': 4,
  '===': 4,
  '!==': 4,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  '<<': 6,
  '>>': 6,
  '>>>': 6,
  '+': 7,
  '-': 7,
  '*': 8,
};
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
    if (ast.instances.length) project(elaborate(ast));
    project(ast);
  }
  const ast = selected ? library[selected] : Object.values(library)[0];
  if (!ast) throw new Error(`Module ${selected} no longer exists.`);
  return ast;
}
function parseSingle(source: string, tokens: IToken[]): Module {
  let i = 0;
  let recursion = 0;
  type EnumBase = { width: number; msb: number; lsb: number; signed: boolean; id: string };
  const enumTypes = new Map<string, EnumBase>();
  const enumMembers = new Map<string, { value: string; signed: boolean; enumType: string }>();
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
  function expr(min = -1): Expr {
    if (++recursion > 128) fail('Expression nesting exceeds 128 levels.');
    let left: Expr;
    if (tokens[i]?.tokenType === SizedCast) {
      const t = take(),
        resultWidth = Number(t.image.slice(0, -1).replaceAll('_', ''));
      if (resultWidth < 1 || resultWidth > 4096) fail('Size casts must be 1–4096 bits.');
      take('(');
      const value = expr();
      const end = take(')').endOffset! + 1;
      left = {
        kind: 'convert',
        conversion: 'resize',
        value,
        resultWidth,
        start: t.startOffset,
        end,
      };
    } else if (tokens[i]?.tokenType === SystemCast) {
      const token = take();
      take('(');
      const value = expr();
      const close = take(')');
      left = {
        kind: 'convert',
        conversion: token.image === '$signed' ? 'signed' : 'unsigned',
        value,
        start: token.startOffset,
        end: close.endOffset! + 1,
      };
    } else if (peek() === '~' || peek() === '!') {
      const token = take();
      const value = expr(9);
      left = {
        kind: 'unary',
        op: token.image as '~' | '!',
        value,
        start: token.startOffset,
        end: expressionSpan(value).end,
        tokenStart: token.startOffset,
        tokenEnd: token.endOffset! + 1,
      };
    } else if (peek() === '{') {
      const open = take('{');
      let repeat: number | undefined;
      if (tokens[i]?.tokenType === Integer && tokens[i + 1]?.image === '{') {
        repeat = integer();
        if (repeat < 1 || repeat > 4096) fail('Replication count must be 1–4096.');
        take('{');
      }
      const parts: Expr[] = [];
      do {
        parts.push(expr());
        if (peek() !== ',') break;
        take(',');
      } while (true);
      if (repeat !== undefined) take('}');
      const end = take('}').endOffset! + 1;
      if (parts.length < 1 || parts.length > 64) fail('Concatenation needs 1–64 parts.');
      left = { kind: 'concat', parts, repeat, start: open.startOffset, end };
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
        const member = enumMembers.get(value);
        if (member) left = { ...left, ...member, kind: 'literal', constantName: value };
        if (peek() === '[') {
          if (member) fail('Slicing enum constants is unsupported.');
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
    while (peek() && (precedence[peek()] ?? -2) >= min) {
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
    if (min === -1 && peek() === '?') {
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
  let portSigned = false;
  while (peek() !== ')') {
    if (peek() === 'input' || peek() === 'output') {
      direction = take().image as 'input' | 'output';
      if (['wire', 'logic', 'reg'].includes(peek())) portType = take().image;
      else portType = 'wire';
      portSigned = peek() === 'signed';
      if (peek() === 'unsigned' || peek() === 'signed') take();
      portWidth = width();
    }
    if (!direction) fail('Only ANSI input/output ports are supported.');
    nets.push({
      name: name(),
      direction: direction!,
      netType: portType,
      signed: portSigned,
      ...portWidth,
    });
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
  const freshEnumName = () => {
    const token = tokens[i],
      value = name();
    if (
      enumTypes.has(value) ||
      enumMembers.has(value) ||
      nets.some((n) => n.name === value) ||
      instances.some((n) => n.name === value)
    )
      throw new ParseError(
        `Duplicate declaration ${value}.`,
        token.startOffset,
        token.endOffset! + 1,
      );
    return value;
  };
  const enumAssignment = (target: string, value: Expr) => {
    const type = nets.find((n) => n.name === target)?.enumType;
    if (!type) return;
    const matches = (e: Expr): boolean =>
      e.kind === 'mux'
        ? matches(e.truthy) && matches(e.falsy)
        : e.kind === 'ref'
          ? nets.find((n) => n.name === e.value)?.enumType === type
          : e.kind === 'literal' && e.enumType === type;
    if (!matches(value))
      throw new ParseError(
        `Assign ${target} from a member or variable of the same enum type; enum casts are unsupported.`,
        value.start,
        value.end,
      );
  };
  const enumVariables = (base: EnumBase, start: number) => {
    const first = nets.length;
    do {
      const { id, ...range } = base;
      nets.push({
        ...range,
        enumType: id,
        name: freshEnumName(),
        direction: 'wire',
        netType: 'logic',
      });
      if (peek() !== ',') break;
      take(',');
    } while (true);
    const end = take(';').endOffset! + 1;
    for (const net of nets.slice(first)) {
      net.declarationStart = start;
      net.declarationEnd = end;
    }
  };
  const enumDeclaration = () => {
    const start = tokens[i].startOffset;
    const typedef = peek() === 'typedef';
    if (typedef) take('typedef');
    take('enum');
    let packed = { width: 32, msb: 31, lsb: 0 },
      signed = true;
    if (['logic', 'reg', 'int'].includes(peek())) {
      const base = take().image;
      signed = base === 'int';
      if (['signed', 'unsigned'].includes(peek())) signed = take().image === 'signed';
      if (base === 'int') {
        if (peek() === '[') fail('Packed dimensions on int enums are unsupported.');
      } else packed = width();
    }
    if (packed.width > 4096) fail('Enum width must be 1–4096 bits.');
    const id = `enum@${start}`;
    take('{');
    let next = 0n;
    const used = new Set<string>();
    const memberNames: string[] = [];
    do {
      const token = tokens[i],
        member = freshEnumName();
      let value = next;
      if (peek() === '=') {
        take('=');
        const negative = peek() === '-';
        if (negative) take('-');
        const literal = tokens[i];
        if (![Integer, Based].includes(literal?.tokenType))
          fail('Enum encodings require decimal or sized literal constants.');
        take();
        try {
          literalWidth(literal.image);
        } catch (error) {
          throw new ParseError(String(error), literal.startOffset, literal.endOffset! + 1);
        }
        const parts = literal.image.replaceAll('_', '').split("'");
        if (negative && parts.length !== 1)
          fail('Negative enum encodings require decimal integers.');
        if (parts.length > 1 && Number(parts[0]) !== packed.width)
          fail('Sized enum encodings must match the enum base width.');
        value =
          parts.length === 1
            ? BigInt(parts[0])
            : BigInt(
                ({ b: '0b', o: '0o', h: '0x', d: '' } as Record<string, string>)[
                  parts[1][0].toLowerCase()
                ] + parts[1].slice(1),
              );
        if (negative) value = -value;
        // Sized values are bit patterns; interpret their sign in the declared base.
        if (parts.length > 1 && signed && value >= 1n << BigInt(packed.width - 1))
          value -= 1n << BigInt(packed.width);
      }
      const min = signed ? -(1n << BigInt(packed.width - 1)) : 0n;
      const max = (1n << BigInt(packed.width - (signed ? 1 : 0))) - 1n;
      if (value < min || value > max)
        throw new ParseError(
          'Enum encoding overflows its base type.',
          token.startOffset,
          token.endOffset! + 1,
        );
      const bits = BigInt.asUintN(packed.width, value).toString();
      if (used.has(bits))
        throw new ParseError('Duplicate enum encoding.', token.startOffset, token.endOffset! + 1);
      used.add(bits);
      enumMembers.set(member, { value: `${packed.width}'d${bits}`, signed, enumType: id });
      memberNames.push(member);
      if (memberNames.length > 128) fail('Enum exceeds 128 members.');
      next = value + 1n;
      if (peek() !== ',') break;
      take(',');
    } while (peek() !== '}');
    take('}');
    const base: EnumBase = { ...packed, signed, id };
    if (typedef) {
      const type = freshEnumName();
      enumTypes.set(type, base);
      take(';');
    } else enumVariables(base, start);
  };
  while (peek() !== 'endmodule') {
    if (peek() === 'typedef' || peek() === 'enum') {
      enumDeclaration();
    } else if (enumTypes.has(peek())) {
      const token = take();
      enumVariables(enumTypes.get(token.image)!, token.startOffset);
    } else if (['wire', 'logic', 'reg'].includes(peek())) {
      const start = take().startOffset,
        first = nets.length;
      const netType = tokens[i - 1].image;
      const signed = peek() === 'signed';
      if (peek() === 'unsigned' || peek() === 'signed') take();
      const w = width();
      do {
        nets.push({ name: name(), direction: 'wire', netType, signed, ...w });
        if (peek() !== ',') break;
        take(',');
      } while (true);
      const end = take(';').endOffset! + 1;
      for (const net of nets.slice(first)) {
        net.declarationStart = start;
        net.declarationEnd = end;
      }
    } else if (['always', 'always_ff', 'always_comb'].includes(peek())) {
      const processToken = take(),
        start = processToken.startOffset;
      let events: Module['assigns'][number]['events'];
      if (processToken.image !== 'always_comb') {
        take('@');
        const wrapped = peek() === '(';
        if (wrapped) take();
        if (peek() === '*') {
          if (processToken.image === 'always_ff') fail('always_ff needs an edge control.');
          take();
        } else {
          events = [];
          do {
            if (!['posedge', 'negedge'].includes(peek()))
              fail('Unsupported event control: use @* or scalar posedge/negedge inputs.');
            const edge = take().image as 'posedge' | 'negedge',
              signalToken = tokens[i],
              signal = name();
            if (!nets.some((n) => n.name === signal && n.direction === 'input' && n.width === 1))
              fail('Clock/reset controls must be scalar inputs.');
            if (events.some((e) => e.signal === signal)) fail('Duplicate event control.');
            events.push({
              signal,
              edge,
              start: signalToken.startOffset,
              end: signalToken.endOffset! + 1,
            });
            if (peek() !== 'or' && peek() !== ',') break;
            take();
          } while (events.length < 2);
        }
        if (wrapped) take(')');
      }
      let nesting = 0;
      const empty = (): Statement => ({ kind: 'block', items: [] });
      const statement = (): Statement => {
        if (++nesting > 128) fail('Procedural statement nesting exceeds 128.');
        const statementStart = tokens[i]?.startOffset ?? source.length;
        let result: Statement;
        if (peek() === ';') {
          take();
          result = empty();
        } else if (peek() === 'begin') {
          take();
          const items: Statement[] = [];
          while (peek() !== 'end') items.push(statement());
          take('end');
          result = { kind: 'block', items };
        } else if (peek() === 'if') {
          take();
          take('(');
          const condition = expr();
          take(')');
          const yes = statement();
          let no = empty();
          if (peek() === 'else') {
            take();
            no = statement();
          }
          result = { kind: 'if', condition, yes, no };
        } else if (peek() === 'case') {
          take();
          take('(');
          const selector = expr();
          take(')');
          const labels: Expr[] = [];
          const arms: { condition: Expr; body: Statement }[] = [];
          let fallback = empty(),
            defaultSeen = false;
          while (peek() !== 'endcase') {
            if (peek() === 'default') {
              if (defaultSeen) fail('Duplicate case default.');
              defaultSeen = true;
              take();
              if (peek() === ':') take();
              fallback = statement();
              continue;
            }
            let condition: Expr | undefined;
            do {
              const label = expr();
              labels.push(label);
              if (label.kind !== 'literal') fail('Case labels must be literal constants.');
              const equal: Expr = {
                kind: 'op',
                op: '===',
                left: selector,
                right: label,
                caseLabels: labels,
                start: selector.start,
                end: label.end,
                tokenStart: selector.start,
                tokenEnd: selector.start,
                synthetic: true,
              };
              condition = condition
                ? {
                    kind: 'op',
                    op: '||',
                    left: condition,
                    right: equal,
                    start: selector.start,
                    end: label.end,
                    tokenStart: selector.start,
                    tokenEnd: selector.start,
                    synthetic: true,
                  }
                : equal;
              if (peek() !== ',') break;
              take();
            } while (true);
            take(':');
            arms.push({ condition: condition!, body: statement() });
            if (arms.length > 128) fail('Case exceeds 128 arms.');
          }
          take('endcase');
          result = arms.reduceRight<Statement>(
            (no, arm) => ({ kind: 'if', condition: arm.condition, yes: arm.body, no }),
            fallback,
          );
        } else {
          const target = name();
          if (
            !nets.some(
              (n) =>
                n.name === target &&
                n.direction !== 'input' &&
                ['reg', 'logic'].includes(n.netType ?? ''),
            )
          )
            fail('Procedural targets must be declared reg or logic.');
          take(events ? '<=' : '=');
          const value = expr();
          enumAssignment(target, value);
          take(';');
          result = { kind: 'assign', target, value };
        }
        nesting--;
        return { ...result, start: statementStart, end: tokens[i - 1].endOffset! + 1 };
      };
      const body = statement(),
        end = tokens[i - 1].endOffset! + 1;
      const values = lowerStatements(body, nets, !!events, start, end);
      const top = body.kind === 'block' ? body.items : [body];
      for (const [target, value] of values) {
        const owner =
          top.length === 1 ? top[0] : top.find((s) => s.kind === 'assign' && s.target === target);
        const structured =
          !owner ||
          (values.size > 1 && owner.kind !== 'assign') ||
          (owner.kind === 'if' && !/^if\b/.test(source.slice(owner.start ?? start))) ||
          (top.length > 1 && owner.kind !== 'assign');
        assigns.push({
          target,
          expr: value,
          start: events ? start : (owner?.start ?? start),
          end: events ? end : (owner?.end ?? end),
          events,
          structured,
          registerInputs: events && values.size === 1 ? registerInputs(body, events) : undefined,
        });
      }
    } else if (peek() === 'assign') {
      const start = take().startOffset;
      const target = name();
      take('=');
      const expression = expr();
      enumAssignment(target, expression);
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
    instances.some(
      (n) =>
        nets.some((net) => net.name === n.name) || enumMembers.has(n.name) || enumTypes.has(n.name),
    )
  )
    fail('Duplicate instance or signal name.');
  const declared = new Map<string, Net>();
  for (const net of nets) {
    if (declared.has(net.name) || enumMembers.has(net.name) || enumTypes.has(net.name))
      fail(`Duplicate declaration ${net.name}.`);
    declared.set(net.name, net);
  }
  const driven = new Set<string>();
  let expressionCount = 0;
  const bounded = (e: Expr, depth = 0): void => {
    if (++expressionCount > 8192 || depth > 256)
      throw new ParseError(
        'Expanded clocked/ordinary expressions exceed the bounded graph limit.',
        e.start,
        e.end,
      );
    for (const [, child] of children(e)) bounded(child, depth + 1);
  };
  for (const a of assigns) bounded(a.expr);
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
      if (e.kind === 'ref') e.signed = declared.get(e.value)?.signed;
      const signedSource = (node: Expr): boolean =>
        (node.kind === 'ref' && !!node.signed) ||
        (node.kind === 'convert' && node.conversion === 'signed') ||
        children(node).some(([, c]) => signedSource(c));
      if (
        e.kind === 'op' &&
        e.caseLabels &&
        signedSource(e.left) &&
        e.caseLabels.some((l) => !expressionSigned(l))
      )
        throw new ParseError(
          'Mixed signed case selectors and unsigned choices are unsupported; use a declared unsigned selector wire.',
          e.left.start,
          e.left.end,
        );
      if (e.kind === 'convert' && e.conversion === 'resize' && !e.synthetic)
        e.signed = expressionSigned(e.value);
      if (e.kind === 'concat' && expressionWidth(e, nets) > 4096)
        throw new ParseError('Concatenation/replication exceeds 4096 bits.', e.start, e.end);
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
    enumNames: [...enumTypes.keys(), ...enumMembers.keys()],
    language: tokens.some(
      (t) => ['logic', 'always_comb', 'always_ff'].includes(t.image) || t.tokenType === Fill,
    )
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
  eventControl?: string;
  signed?: boolean;
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
    | 'register'
    | 'convert';
  register?: boolean;
  sequentialInstance?: boolean;
  editable?: boolean;
  editableRegister?: boolean;
  width?: number;
  op?: Operator;
  operands?: string[];
  operandWidths?: number[];
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
  clocks?: { signal: string; edge: 'posedge' | 'negedge' }[];
  sequential?: boolean;
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
  '<<': 'SHL',
  '>>': 'SHR',
  '>>>': 'ASHR',
  '==': 'EQ',
  '!=': 'NE',
  '===': 'CASE EQ',
  '!==': 'CASE NE',
  '<': 'LT',
  '<=': 'LE',
  '>': 'GT',
  '>=': 'GE',
  '~': 'NOT',
  '!': 'LOGICAL NOT',
  '&&': 'LOGICAL AND',
  '||': 'LOGICAL OR',
};
/** Unsigned Verilog self-determined width; VHDL widths come from its typed frontend. */
export function expressionWidth(e: Expr, nets: Net[]): number {
  if (e.nativeWidth !== undefined) return e.nativeWidth;
  const width = (child: Expr) => expressionWidth(child, nets);
  if (e.kind === 'convert') return e.resultWidth ?? width(e.value);
  if (e.kind === 'unary') return e.op === '!' ? 1 : width(e.value);
  if (e.kind === 'ref') return nets.find((n) => n.name === e.value)!.width;
  if (e.kind === 'slice') return Math.abs(e.msb - e.lsb) + 1;
  if (e.kind === 'literal') return literalWidth(e.value);
  if (e.kind === 'concat') return (e.repeat ?? 1) * e.parts.reduce((sum, p) => sum + width(p), 0);
  if (e.kind === 'mux') return Math.max(width(e.truthy), width(e.falsy));
  if (isComparison(e.op) || e.op === '&&' || e.op === '||') return 1;
  if (e.op === '<<' || e.op === '>>' || e.op === '>>>') return width(e.left);
  return Math.max(width(e.left), width(e.right));
}
/** Self-determined Verilog type, including declared nets and explicit casts. */
export function expressionSigned(e: Expr): boolean {
  if (e.nativeType) return false;
  if (e.kind === 'ref') return e.signed ?? false;
  if (e.kind === 'convert')
    return e.conversion === 'signed' || (e.conversion === 'resize' && !!e.signed);
  if (e.kind === 'literal') return e.signed ?? /^[0-9][0-9_]*$/.test(e.value);
  if (e.kind === 'unary') return e.op !== '!' && expressionSigned(e.value);
  if (e.kind === 'mux')
    return !e.procedural && expressionSigned(e.truthy) && expressionSigned(e.falsy);
  if (e.kind !== 'op' || isComparison(e.op) || e.op === '&&' || e.op === '||') return false;
  return (
    expressionSigned(e.left) && (['<<', '>>', '>>>'].includes(e.op) || expressionSigned(e.right))
  );
}
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
        signed: n.signed,
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
  const widthOf = (e: Expr): number => expressionWidth(e, ast.nets);
  function visit(e: Expr, key: string, context = 0, signedContext?: boolean): Node {
    if (ast.language === 'vhdl') context = 0;
    const signed = signedContext ?? expressionSigned(e);
    if (e.kind === 'unary') {
      const w = Math.max(context, widthOf(e));
      const child = visit(
        e.value,
        key + '/V',
        e.op === '!' ? 0 : w,
        e.op === '!' ? undefined : signed,
      );
      const node = add(key, {
        kind: 'op',
        expressionKey: key,
        label: opNames[e.op],
        editable: !e.synthetic,
        op: e.op,
        signed,
        width: w,
        operands: [child.label],
        operandWidths: [child.width!],
        operandSignature: semantic(e.value),
      });
      connect(child, node, 'left');
      return node;
    }
    if (e.kind === 'convert') {
      const child = visit(
        e.value,
        `${key}/V`,
        ast.language !== 'vhdl' && e.conversion === 'resize' ? e.resultWidth : undefined,
      );
      const node = add(key, {
        kind: 'convert',
        label: e.conversion.toUpperCase(),
        expressionKey: key,
        width: ast.language === 'vhdl' ? widthOf(e) : Math.max(context, widthOf(e)),
        signed: ast.language === 'vhdl' ? undefined : signed,
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
        label: e.constantName ?? e.value,
        editable: e.constantName ? false : undefined,
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
        label: e.repeat ? `REPEAT ×${e.repeat}` : 'JOIN',
        expressionKey: key,
        operands: parts.map((p) => p.label),
        width: widthOf(e),
        inputPorts: parts.map((p, i) => ({ name: `part:${i}`, width: p.width! })),
      });
      parts.forEach((p, i) => connect(p, node, `part:${i}`));
      return node;
    }
    if (e.kind === 'mux') {
      const w = e.procedural && context ? context : Math.max(context, widthOf(e));
      const c = visit(e.condition, `${key}/C`),
        t = visit(e.truthy, `${key}/T`, w, e.procedural ? undefined : signed),
        f = visit(e.falsy, `${key}/F`, w, e.procedural ? undefined : signed);
      const n = add(`${key}/mux`, {
        kind: 'mux',
        label: 'MUX',
        signed,
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
    const logical = e.op === '&&' || e.op === '||';
    const comparison = isComparison(e.op),
      shift = e.op === '<<' || e.op === '>>' || e.op === '>>>';
    const w = comparison || logical ? 1 : Math.max(context, widthOf(e));
    const operandWidth = comparison
      ? Math.max(widthOf(e.left), widthOf(e.right), ...(e.caseLabels ?? []).map(widthOf))
      : w;
    const rightWidth = shift || logical ? widthOf(e.right) : operandWidth;
    const operandSigned = comparison
      ? expressionSigned(e.left) &&
        expressionSigned(e.right) &&
        (e.caseLabels ?? []).every(expressionSigned)
      : signed;
    const l = visit(
      e.left,
      key + '/L',
      logical ? 0 : operandWidth,
      logical ? undefined : operandSigned,
    );
    const r = visit(
      e.right,
      key + '/R',
      logical ? 0 : rightWidth,
      shift || logical ? undefined : operandSigned,
    );
    const n = add(key, {
      kind: 'op',
      expressionKey: key,
      editable: !e.synthetic,
      label: opNames[e.op],
      op: e.op,
      signed: comparison ? operandSigned : signed,
      operands: [l.label, r.label],
      operandWidths: logical ? [l.width!, r.width!] : [operandWidth, rightWidth],
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
      sequentialInstance: hasRegisters(child),
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
    if (a.events) {
      const reg = add(`${ast.name}/register/${a.target}`, {
        kind: 'register',
        register: true,
        sourceNet: a.target,
        assignmentTarget: a.target,
        editableRegister: !!a.registerInputs,
        label: a.target,
        eventControl: a.events.map((e) => `${e.edge} ${e.signal}`).join(' / '),
        width: nets.get(a.target)!.width,
        inputPorts: [
          { name: 'port:D', width: nets.get(a.target)!.width! },
          ...a.events.map((e, i) => ({ name: i === 0 ? 'port:clock' : 'port:reset', width: 1 })),
        ],
        outputPorts: [{ name: 'Q', width: nets.get(a.target)!.width!, signal: a.target }],
      });
      connect(root, reg, 'port:D');
      for (const [i, e] of a.events.entries())
        connect(nets.get(e.signal)!, reg, i === 0 ? 'port:clock' : 'port:reset');
      connect(reg, nets.get(a.target)!, 'left');
      edges.at(-1)!.sourceHandle = 'out:Q';
    } else connect(root, nets.get(a.target)!, 'left');
  }
  const incoming = new Map(
    nodes.map((n) => [
      n.id,
      n.register || n.sequentialInstance
        ? []
        : edges.filter((e) => e.target === n.id).map((e) => e.source),
    ]),
  );
  const depths = new Map<string, number>();
  const active = new Set<string>();
  function depth(id: string): number {
    if (depths.has(id)) return depths.get(id)!;
    if (active.has(id))
      throw new ParseError(
        'Combinational cycles are unsupported (' +
          ast.name +
          ': ' +
          nodes.find((n) => n.id === id)?.label +
          ').',
        ast.start,
        ast.start + 1,
      );
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
    if (node.op === '>>>' && !node.signed)
      warn(
        node,
        'unsigned-shift',
        'Arithmetic right shift has an unsigned operand in this expression and fills with zero. To isolate a signed shift from an unsigned mux arm, use $unsigned($signed(value) >>> amount).',
      );
    if (node.undriven) warn(node, 'undriven', `${node.label} has no driver.`);
    if (['wire', 'input'].includes(node.kind) && !edges.some((e) => e.source === node.id))
      warn(node, 'unused', `${node.label} is unused.`);
    for (const edge of edges.filter((e) => e.target === node.id)) {
      const from = nodes.find((n) => n.id === edge.source)!;
      const expected =
        node.kind === 'mux' && edge.targetHandle === 'select'
          ? 1
          : node.kind === 'instance' || node.kind === 'register' || node.kind === 'concat'
            ? node.inputPorts?.find((p) => p.name === edge.targetHandle)?.width
            : (node.operandWidths?.[edge.targetHandle === 'right' ? 1 : 0] ?? node.width);
      const actual =
        from.kind === 'instance' || from.kind === 'register'
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
          `${from.sourceNet ?? from.label}: ${actual} -> ${expected} bits at ${node.label} (${actual > expected ? 'high bits discarded' : node.kind === 'convert' && node.signed ? 'sign extended' : 'zero extended'}).`,
        );
    }
  }
  return {
    sequential: hasRegisters(ast),
    clocks: clocksFor(ast),
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
  if (e.kind === 'unary') return 'unary(' + shape(e.value) + ')';
  if (e.kind === 'convert') return `${e.conversion}:${e.resultWidth ?? ''}(${shape(e.value)})`;
  if (e.kind === 'concat') return `concat:${e.repeat ?? 1}(${e.parts.map(shape).join(',')})`;
  return e.kind === 'mux'
    ? `${e.procedural ? 'ifmux' : 'mux'}(${shape(e.condition)},${shape(e.truthy)},${shape(e.falsy)})`
    : e.kind === 'op'
      ? `(${shape(e.left)},${shape(e.right)})`
      : e.kind === 'slice'
        ? `slice:${e.value}:${e.msb}:${e.lsb}`
        : `${e.kind}:${e.value}`;
}
function semantic(e: Expr): string {
  if (e.kind === 'unary') return e.op + '(' + semantic(e.value) + ')';
  if (e.kind === 'convert') return `${e.conversion}:${e.resultWidth ?? ''}(${semantic(e.value)})`;
  if (e.kind === 'concat') return `concat:${e.repeat ?? 1}(${e.parts.map(semantic).join(',')})`;
  return e.kind === 'mux'
    ? `${e.procedural ? 'ifmux' : 'mux'}(${semantic(e.condition)},${semantic(e.truthy)},${semantic(e.falsy)})`
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
  if (e?.synthetic)
    throw new Error('Generated control logic is edited through its source statement.');
  if (e?.kind !== 'op' && e?.kind !== 'unary')
    throw new Error('Operation no longer exists in the live source.');
  if ((e.kind === 'unary') !== (op === '~' || op === '!'))
    throw new Error(
      'Unary and binary operations have different input counts. Create a new component instead.',
    );
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
    if (e.constantName) throw new Error('Edit named enum encodings in their HDL declaration.');
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
      if (!e.synthetic && (e.kind === 'op' || e.kind === 'unary'))
        allowed.push({ start: e.tokenStart, end: e.tokenEnd, kind: 'operator' });
      if (e.kind === 'literal' && !e.constantName)
        allowed.push({ start: e.start, end: e.end, kind: 'literal' });
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
