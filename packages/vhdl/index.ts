// SPDX-License-Identifier: GPL-3.0-only
import type { Edit, GraphChange, Operator } from '../protocol/index.js';
import {
  children,
  expressions,
  expressionSpan,
  parse,
  project,
  shape,
  validateLibrary,
  type Expr,
  type Module,
  type Net,
  type Node,
} from '../verilog/index.js';
import { literalWidth } from '../verilog/literals.js';
import { lowerStatements, registerInputs, type Statement } from '../verilog/procedural.js';

export type VhdlType = 'std_logic' | 'std_logic_vector' | 'unsigned';
export type Token = { image: string; start: number; end: number };
export const isVhdl = (source: string) =>
  /^(?:library|use|entity|architecture)\b/i.test(
    source.replace(/--[^\r\n]*|\/\*[\s\S]*?\*\//g, ' ').trimStart(),
  );
const reserved = new Set(
  'abs access after alias all and architecture array assert assume assume_guarantee attribute begin block body buffer bus case component configuration constant context cover default disconnect downto else elsif end entity exit fair file for force function generate generic group guarded if impure in inertial inout is label library linkage literal loop map mod nand new next nor not null of on open or others out package parameter port postponed procedure process property protected pure range record register reject release rem report restrict restrict_guarantee return rol ror select sequence severity shared signal sla sll sra srl strong subtype then to transport type unaffected units until use variable vmode vprop vunit wait when while with xnor xor'.split(
    ' ',
  ),
);
export function assertVhdlName(name: string) {
  if (
    typeof name !== 'string' ||
    name.length > 128 ||
    !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/i.test(name) ||
    reserved.has(name.toLowerCase())
  )
    throw new Error(
      'Use a VHDL basic identifier: start with a letter, no doubled/trailing underscores or reserved words (maximum 128 characters).',
    );
}
function error(message: string, start: number, end: number): never {
  throw Object.assign(new Error(message), { start, end });
}
export function tokenizeVhdl(source: string): Token[] {
  if (source.length > 1_000_000) error('Source exceeds 1 million UTF-16 units.', 0, source.length);
  const result: Token[] = [];
  const re =
    /\s+|--[^\r\n]*|\/\*[\s\S]*?\*\/|[box]?"[0-9a-f_]+"|'[01]'|<=|=>|[a-z][a-z0-9_]*|[0-9][0-9_]*|[(),:;.=+*&'\-]/iy;
  let offset = 0;
  while (offset < source.length) {
    re.lastIndex = offset;
    const match = re.exec(source);
    if (!match) error('Unsupported VHDL token.', offset, offset + 1);
    const text = match[0];
    offset = re.lastIndex;
    if (!/^\s|^--|^\/\*/.test(text))
      result.push({ image: text.toLowerCase(), start: match.index, end: offset });
    if (result.length > 32768) error('Document exceeds 32768 tokens.', 0, source.length);
  }
  return result;
}
const opMap: Record<string, Operator> = {
  '+': '+',
  '-': '-',
  '*': '*',
  and: '&',
  or: '|',
  xor: '^',
};
export const vhdlOperator = (op: Operator): string => {
  const value = (
    { '&': 'and', '|': 'or', '^': 'xor', '+': '+', '-': '-', '*': '*' } as Partial<
      Record<Operator, string>
    >
  )[op];
  if (!value) throw new Error('This operator is not supported in the VHDL subset.');
  return value;
};
export const nativeRange = (msb: number, lsb: number, bit = false) =>
  bit ? `(${msb})` : `(${msb} ${msb >= lsb ? 'downto' : 'to'} ${lsb})`;
export function nativeLiteral(canonical: string, type: VhdlType = 'unsigned'): string {
  const width = literalWidth(canonical);
  let value: bigint;
  if (/^'[01]$/.test(canonical)) value = BigInt(canonical[1]);
  else {
    const parts = canonical.replaceAll('_', '').split("'");
    value =
      parts.length === 1
        ? BigInt(parts[0])
        : BigInt(
            ({ b: '0b', o: '0o', h: '0x', d: '' } as Record<string, string>)[
              parts[1][0].toLowerCase()
            ] + parts[1].slice(1),
          );
  }
  if (type === 'std_logic') {
    if (width !== 1 || value > 1n) throw new Error('A std_logic literal must be one bit.');
    return `'${value}'`;
  }
  if (type === 'unsigned' && value <= 2147483647n) return `to_unsigned(${value}, ${width})`;
  const bits = value.toString(2).padStart(width, '0');
  return type === 'unsigned' ? `unsigned'("${bits}")` : `"${bits}"`;
}
export function literalInput(text: string, type: VhdlType): string {
  try {
    literalWidth(text);
    return nativeLiteral(text, type);
  } catch {
    if (
      /^(?:'[01]'|[box]?"[0-9a-f_]+"|to_unsigned\([0-9]+, *[0-9]+\)|unsigned'\("[01_]+"\))$/i.test(
        text,
      )
    )
      return text;
    throw new Error(
      'Enter a sized graph literal or a native VHDL bit/bit-string/to_unsigned literal.',
    );
  }
}

export function parseVhdl(source: string, selected?: string): Module {
  const tokens = tokenizeVhdl(source);
  let i = 0,
    nesting = 0;
  const library: Record<string, Module> = Object.create(null);
  const entities = new Map<
    string,
    {
      nets: Net[];
      start: number;
      end: number;
      endStart: number;
      portClose: number;
      lastPortEnd: number;
      imports: Set<string>;
    }
  >();
  let imports = new Set<string>();
  const peek = () => tokens[i]?.image;
  const fail = (message: string): never =>
    error(message, tokens[i]?.start ?? source.length, tokens[i]?.end ?? source.length);
  const take = (word?: string): Token => {
    if (!tokens[i] || (word && peek() !== word))
      fail(`Expected ${word ?? 'token'}, found ${peek() ?? 'end of source'}.`);
    return tokens[i++];
  };
  const name = () => {
    const t = take();
    try {
      assertVhdlName(t.image);
    } catch (e) {
      error(String(e), t.start, t.end);
    }
    return t.image;
  };
  const integer = () => {
    const t = take();
    if (!/^[0-9][0-9_]*$/.test(t.image)) fail('Expected an unsigned fixed integer.');
    const n = Number(t.image.replaceAll('_', ''));
    if (!Number.isSafeInteger(n) || n > 2147483647)
      fail('Integer exceeds the supported 31-bit range.');
    return n;
  };
  const range = () => {
    take('(');
    const msb = integer();
    let lsb = msb,
      bit = true;
    if (['to', 'downto'].includes(peek())) {
      const direction = take().image;
      lsb = integer();
      bit = false;
      if (direction === 'to' ? msb > lsb : msb < lsb)
        fail('Null or reversed ranges are unsupported.');
    }
    take(')');
    return { msb, lsb, width: Math.abs(msb - lsb) + 1, bit };
  };
  const netType = (context: Set<string>) => {
    const nativeType = take().image as VhdlType;
    if (!['std_logic', 'std_logic_vector', 'unsigned'].includes(nativeType))
      fail('Supported VHDL types are std_logic, std_logic_vector and numeric_std unsigned.');
    if (!context.has(nativeType === 'unsigned' ? 'numeric_std' : 'std_logic_1164'))
      fail(
        `Import ieee.${nativeType === 'unsigned' ? 'numeric_std' : 'std_logic_1164'}.all before using this type.`,
      );
    const bounds = nativeType === 'std_logic' ? { msb: 0, lsb: 0, width: 1 } : range();
    if (nativeType !== 'std_logic' && 'bit' in bounds && bounds.bit)
      fail('Array declarations need to/downto bounds.');
    if (bounds.width > 4096) fail('Signal widths are limited to 4096 bits.');
    return { ...bounds, nativeType };
  };
  function expression(min = 0): Expr {
    if (++nesting > 128) fail('Expression nesting exceeds 128 levels.');
    let left: Expr;
    const first = tokens[i];
    if (peek() === '(') {
      take();
      left = expression();
      const close = take(')');
      left = { ...left, outerStart: first.start, outerEnd: close.end };
    } else if (/^'[01]'$/.test(peek() ?? '')) {
      const t = take();
      left = {
        kind: 'literal',
        value: `1'b${t.image[1]}`,
        start: t.start,
        end: t.end,
        nativeType: 'std_logic',
      };
    } else if (/^[box]?"/.test(peek() ?? '')) {
      const t = take(),
        m = /^([box]?)"([0-9a-f_]+)"$/.exec(t.image)!;
      const base = m[1] || 'b',
        digits = m[2].replaceAll('_', ''),
        width = digits.length * { b: 1, o: 3, x: 4 }[base]!;
      const value = `${width}'${base === 'x' ? 'h' : base}${digits}`;
      literalWidth(value);
      left = { kind: 'literal', value, start: t.start, end: t.end };
    } else if (['unsigned', 'std_logic_vector', 'resize', 'to_unsigned'].includes(peek())) {
      const conversion = take().image,
        qualified = peek() === "'";
      if (qualified && !['unsigned', 'std_logic_vector'].includes(conversion))
        fail('Only array type names can qualify an expression.');
      // Qualified array literals preserve their type without inventing an HDL conversion.
      if (peek() === '(') take();
      else if (peek() === "'") {
        take();
        take('(');
      } else fail('Expected a conversion argument.');
      if (conversion === 'to_unsigned') {
        const n = integer();
        take(',');
        const width = integer();
        const end = take(')').end;
        const value = `${width}'d${n}`;
        literalWidth(value);
        left = { kind: 'literal', value, start: first.start, end, nativeType: 'unsigned' };
      } else {
        const value = expression();
        let resultWidth: number | undefined;
        if (conversion === 'resize') {
          take(',');
          resultWidth = integer();
          if (resultWidth < 1 || resultWidth > 4096) fail('Resize width must be 1–4096 bits.');
        }
        const end = take(')').end;
        left = {
          kind: 'convert',
          conversion: conversion as 'unsigned' | 'std_logic_vector' | 'resize',
          value,
          resultWidth,
          qualified,
          start: first.start,
          end,
        };
      }
    } else {
      const value = name();
      left = { kind: 'ref', value, start: first.start, end: tokens[i - 1].end };
      if (peek() === '(') {
        const rangeStart = tokens[i].start,
          bounds = range();
        left = {
          kind: 'slice',
          value,
          ...bounds,
          start: first.start,
          end: tokens[i - 1].end,
          rangeStart,
          rangeEnd: tokens[i - 1].end,
        };
      }
    }
    const precedence: Record<string, number> = {
      and: 1,
      or: 1,
      xor: 1,
      '+': 4,
      '-': 4,
      '&': 4,
      '*': 5,
    };
    while (peek() && (precedence[peek()] ?? -1) >= min) {
      const token = take(),
        right = expression(precedence[token.image] + 1),
        start = expressionSpan(left).start,
        end = expressionSpan(right).end;
      if (token.image === '&') {
        const parts =
          left.kind === 'concat' && left.outerStart === undefined
            ? [...left.parts, right]
            : [left, right];
        if (parts.length > 64) fail('Limit: 64 concatenation parts.');
        left = { kind: 'concat', parts, start, end };
      } else {
        if (
          ['and', 'or', 'xor'].includes(token.image) &&
          left.kind === 'op' &&
          ['&', '|', '^'].includes(left.op) &&
          left.op !== opMap[token.image] &&
          left.outerStart === undefined
        )
          fail('Parenthesize mixed VHDL logical operators explicitly.');
        left = {
          kind: 'op',
          op: opMap[token.image],
          left,
          right,
          start,
          end,
          tokenStart: token.start,
          tokenEnd: token.end,
        };
      }
    }
    if (min === 0 && peek() === 'when') {
      take();
      const condition = conditionExpr();
      take('else');
      const falsy = expression();
      left = {
        kind: 'mux',
        condition,
        truthy: left,
        falsy,
        start: expressionSpan(left).start,
        end: expressionSpan(falsy).end,
      };
    }
    nesting--;
    return left;
  }
  function conditionExpr(): Expr {
    const c = expression(6);
    take('=');
    const bit = take().image;
    if (bit !== "'1'" && bit !== "'0'") fail("Use a scalar selector = '1' or '0'.");
    if (!['ref', 'slice', 'literal'].includes(c.kind)) fail("Use a scalar selector = '1'.");
    return bit === "'1'"
      ? c
      : {
          kind: 'unary',
          op: '!',
          value: c,
          start: c.start,
          end: tokens[i - 1].end,
          tokenStart: c.start,
          tokenEnd: c.start,
          synthetic: true,
        };
  }
  const closing = (kind: string, unit: string) => {
    const start = take('end').start;
    if (peek() === kind) take();
    if (peek() !== ';' && name() !== unit) fail('End name does not match its design unit.');
    return { start, end: take(';').end };
  };
  while (i < tokens.length) {
    if (peek() === 'library') {
      take();
      do {
        const lib = name();
        if (!['ieee', 'std', 'work'].includes(lib))
          fail('Only ieee/std/work libraries are supported.');
        if (peek() !== ',') break;
        take();
      } while (true);
      take(';');
      continue;
    }
    if (peek() === 'use') {
      take();
      take('ieee');
      take('.');
      const pkg = take().image;
      take('.');
      take('all');
      take(';');
      if (!['std_logic_1164', 'numeric_std'].includes(pkg))
        fail('Only ieee.std_logic_1164 and ieee.numeric_std are supported.');
      imports.add(pkg);
      continue;
    }
    if (peek() === 'entity') {
      const start = take().start,
        entity = name();
      take('is');
      if (entities.has(entity)) fail('Duplicate entity.');
      const nets: Net[] = [];
      let portClose = -1,
        lastPortEnd = -1;
      if (peek() === 'port') {
        take();
        take('(');
        if (peek() === ')') fail('Omit the port clause for an entity with no ports.');
        do {
          const names = [name()];
          while (peek() === ',') {
            take();
            names.push(name());
          }
          take(':');
          const direction = take().image;
          if (!['in', 'out'].includes(direction)) fail('Only in/out ports are supported.');
          const type = netType(imports);
          for (const n of names)
            nets.push({ name: n, direction: direction === 'in' ? 'input' : 'output', ...type });
          lastPortEnd = tokens[i - 1].end;
          if (peek() !== ';') break;
          take();
          if (peek() === ')') fail('A trailing port semicolon is unsupported.');
        } while (true);
        portClose = take(')').start;
        take(';');
      }
      const end = closing('entity', entity);
      entities.set(entity, {
        nets,
        start,
        end: end.end,
        endStart: end.start,
        portClose,
        lastPortEnd,
        imports: new Set(imports),
      });
      imports = new Set();
      continue;
    }
    if (peek() !== 'architecture') fail('Expected an entity or architecture definition.');
    const tokenStart = i,
      architectureStart = take().start,
      architecture = name();
    take('of');
    const entity = name();
    take('is');
    const definition =
      entities.get(entity) ??
      fail('An architecture needs its entity declaration in the same shared file.');
    if (!definition) fail('An architecture needs its entity declaration in the same shared file.');
    if (library[entity])
      fail(
        'Multiple architectures for one entity are unsupported; share a single selected architecture.',
      );
    const context = new Set([...definition.imports, ...imports]);
    imports = new Set();
    const nets = structuredClone(definition.nets),
      assigns: Module['assigns'] = [],
      instances: Module['instances'] = [];
    while (peek() === 'signal') {
      const start = take().start,
        names = [name()];
      while (peek() === ',') {
        take();
        names.push(name());
      }
      take(':');
      const type = netType(context),
        end = take(';').end;
      for (const n of names)
        nets.push({
          name: n,
          direction: 'wire',
          ...type,
          declarationStart: start,
          declarationEnd: end,
        });
    }
    const declarationsEnd = take('begin').start;
    const assignment = () => {
      const start = tokens[i].start,
        target = name();
      take('<=');
      const expr = expression();
      const end = take(';').end;
      return { target, expr, start, end };
    };
    const process = (label?: string) => {
      const processStart = take('process').start;
      take('(');
      const sensitivity: string[] = [];
      const sensitivityTokens: Token[] = [];
      do {
        const token = take();
        sensitivity.push(token.image);
        sensitivityTokens.push(token);
        if (peek() !== ',') break;
        take();
      } while (true);
      take(')');
      if (peek() === 'is') take();
      take('begin');
      const finish = () => {
        take('end');
        take('process');
        if (label && peek() !== ';' && name() !== label) fail('Process end label mismatch.');
        take(';');
      };
      if (sensitivity[0] !== 'all') {
        let level = 0;
        const empty = (): Statement => ({ kind: 'block', items: [] });
        const block = (): Statement => {
          const items: Statement[] = [];
          while (!['end', 'else', 'elsif', 'when'].includes(peek())) items.push(statement());
          return { kind: 'block', items };
        };
        const conditional = (): Statement => {
          take();
          const condition = conditionExpr();
          take('then');
          const yes = block();
          let no = empty();
          if (peek() === 'elsif') no = conditional();
          else if (peek() === 'else') {
            take();
            no = block();
          }
          return { kind: 'if', condition, yes, no };
        };
        const statement = (): Statement => {
          if (++level > 128) fail('VHDL clocked statement nesting exceeds 128.');
          let result: Statement;
          if (peek() === 'null') {
            take();
            take(';');
            result = empty();
          } else if (peek() === 'if') {
            result = conditional();
            take('end');
            take('if');
            take(';');
          } else if (peek() === 'case') {
            take();
            const selector = expression();
            take('is');
            let fallback = empty();
            let seenDefault = false;
            const arms: { condition: Expr; body: Statement }[] = [];
            while (peek() === 'when') {
              if (seenDefault) fail('others must be the final case alternative.');
              take();
              if (peek() === 'others') {
                if (seenDefault) fail('Duplicate others branch.');
                seenDefault = true;
                take();
                take('=>');
                fallback = block();
                continue;
              }
              const label = expression();
              if (label.kind !== 'literal') fail('VHDL case choices must be literal bit strings.');
              take('=>');
              arms.push({
                condition: {
                  kind: 'op',
                  op: '===',
                  left: selector,
                  right: label,
                  start: selector.start,
                  end: label.end,
                  tokenStart: selector.start,
                  tokenEnd: selector.start,
                  synthetic: true,
                },
                body: block(),
              });
              if (arms.length > 128) fail('VHDL case exceeds 128 arms.');
            }
            take('end');
            take('case');
            take(';');
            result = arms.reduceRight<Statement>(
              (no, a) => ({ kind: 'if', condition: a.condition, yes: a.body, no }),
              fallback,
            );
          } else {
            const a = assignment();
            result = { kind: 'assign', target: a.target, value: a.expr };
          }
          level--;
          return result;
        };
        const edge = () => {
          const kind = take();
          if (!['rising_edge', 'falling_edge'].includes(kind.image))
            fail('Use rising_edge/falling_edge on a scalar input clock.');
          take('(');
          const token = tokens[i],
            signal = name();
          take(')');
          return {
            signal,
            start: token.start,
            end: token.end,
            edge: kind.image === 'rising_edge' ? ('posedge' as const) : ('negedge' as const),
            strict: true,
          };
        };
        take('if');
        let clock: ReturnType<typeof edge>,
          reset: { signal: string; edge: 'posedge' | 'negedge'; level: '0' | '1' } | undefined,
          body: Statement;
        if (['rising_edge', 'falling_edge'].includes(peek())) {
          clock = edge();
          take('then');
          body = block();
        } else {
          const condition = conditionExpr();
          const signal =
            condition.kind === 'ref'
              ? condition.value
              : condition.kind === 'unary' && condition.value.kind === 'ref'
                ? condition.value.value
                : fail('Reset must be a scalar input.');
          reset = {
            signal,
            edge: condition.kind === 'unary' ? 'negedge' : 'posedge',
            level: condition.kind === 'unary' ? '0' : '1',
          };
          take('then');
          const yes = block();
          take('elsif');
          clock = edge();
          take('then');
          const no = block();
          body = { kind: 'if', condition, yes, no };
        }
        take('end');
        take('if');
        take(';');
        finish();
        const events: NonNullable<Module['assigns'][number]['events']> = [
          clock,
          ...(reset ? [reset] : []),
        ];
        for (const e of events) {
          const token = sensitivityTokens.find((t) => t.image === e.signal);
          if (token) {
            if (e === clock) {
              e.sensitivityStart = token.start;
              e.sensitivityEnd = token.end;
            } else {
              e.start = token.start;
              e.end = token.end;
            }
          }
        }
        if (
          sensitivity.length !== events.length ||
          new Set(sensitivity).size !== sensitivity.length ||
          events.some(
            (e) =>
              !sensitivity.includes(e.signal) ||
              !nets.some(
                (n) =>
                  n.name === e.signal && n.direction === 'input' && n.nativeType === 'std_logic',
              ),
          )
        )
          fail(
            'Clocked process sensitivity must list exactly its scalar input clock and optional asynchronous reset.',
          );
        const end = tokens[i - 1].end;
        for (const [target, value] of lowerStatements(body, nets, true, processStart, end))
          assigns.push({
            target,
            expr: value,
            start: processStart,
            end,
            events,
            registerInputs: registerInputs(body, events),
          });
        return;
      }
      if (sensitivity.length !== 1) fail('process(all) cannot contain other sensitivity items.');
      while (peek() !== 'end') {
        if (peek() === 'null') {
          take();
          take(';');
          continue;
        }
        if (peek() === 'if') {
          const start = take().start,
            condition = conditionExpr();
          take('then');
          const truthy = assignment();
          take('else');
          const falsy = assignment();
          take('end');
          take('if');
          const end = take(';').end;
          if (truthy.target !== falsy.target)
            fail('Combinational if/else must drive the same signal on both paths.');
          assigns.push({
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
        } else assigns.push(assignment());
      }
      finish();
    };
    while (peek() !== 'end') {
      if (peek() === 'process') {
        process();
        continue;
      }
      if (tokens[i + 1]?.image === ':') {
        const start = tokens[i].start,
          instance = name();
        take(':');
        if (peek() === 'process') {
          process(instance);
          continue;
        }
        take('entity');
        take('work');
        take('.');
        const module = name();
        if (peek() === '(') fail('Explicit instance architecture selection is unsupported.');
        take('port');
        take('map');
        take('(');
        const ports: Module['instances'][number]['ports'] = [];
        while (peek() !== ')') {
          const port = name();
          take('=>');
          ports.push({ name: port, expr: expression() });
          if (peek() !== ',') break;
          take();
        }
        take(')');
        instances.push({ name: instance, module, ports, start, end: take(';').end });
      } else assigns.push(assignment());
    }
    const end = closing('architecture', architecture);
    if (i - tokenStart > 4096) fail('Architecture exceeds 4096 tokens.');
    const ast: Module = {
      language: 'vhdl',
      name: entity,
      start: definition.start,
      end: end.end,
      nets,
      assigns,
      instances,
      library: {},
      portClose: definition.portClose,
      lastPortEnd: definition.lastPortEnd,
      portCount: definition.nets.length,
      endmoduleStart: end.start,
      vhdl: {
        entityStart: definition.start,
        entityEnd: definition.end,
        entityEndStart: definition.endStart,
        architectureStart,
        architectureEnd: end.end,
        architecture,
        declarationsEnd,
      },
    };
    validateVhdlModule(ast, context);
    library[entity] = ast;
    if (Object.keys(library).length > 64) fail('Limit: 64 entities per document.');
  }
  if (!Object.keys(library).length || entities.size !== Object.keys(library).length)
    fail('Each entity needs exactly one architecture in this shared file.');
  // Validate binding types after all entity definitions are available.
  for (const ast of Object.values(library)) {
    ast.library = library;
    for (const inst of ast.instances) {
      const child = library[inst.module];
      if (!child) continue;
      for (const p of inst.ports) {
        const port = child.nets.find((n) => n.name === p.name && n.direction !== 'wire');
        if (port) {
          const actual = inferVhdl(p.expr, ast, port.nativeType);
          if (actual.width !== port.width || actual.type !== port.nativeType)
            error(
              'Instance binding type/width does not match its named port.',
              p.expr.start,
              p.expr.end,
            );
        }
      }
    }
  }
  return validateLibrary(source, library, selected?.toLowerCase());
}

export function inferVhdl(
  e: Expr,
  ast: Module,
  hint?: VhdlType,
): { type: VhdlType; width: number } {
  let result: { type: VhdlType; width: number };
  const bad = (message: string): never => error(message, e.start, e.end);
  if (
    (e.kind !== 'mux' && children(e).some(([, c]) => c.kind === 'mux' && !c.procedural)) ||
    (e.kind === 'mux' && !e.procedural && (e.outerStart !== undefined || e.truthy.kind === 'mux'))
  )
    bad('Use conditional assignments at the assignment root, not nested conditional expressions.');
  if (e.kind === 'ref' || e.kind === 'slice') {
    const n = ast.nets.find((n) => n.name === e.value) ?? bad(`Undeclared VHDL signal ${e.value}.`);
    if (e.kind === 'slice') {
      if (
        n.nativeType === 'std_logic' ||
        Math.min(e.msb, e.lsb) < Math.min(n.msb, n.lsb) ||
        Math.max(e.msb, e.lsb) > Math.max(n.msb, n.lsb) ||
        (e.msb - e.lsb) * (n.msb - n.lsb) < 0
      )
        bad('Slice is out of bounds or reverses the declared direction.');
      result = { type: e.bit ? 'std_logic' : n.nativeType!, width: Math.abs(e.msb - e.lsb) + 1 };
    } else result = { type: n.nativeType!, width: n.width };
  } else if (e.kind === 'literal')
    result = {
      type: e.nativeType ?? (hint === 'unsigned' ? 'unsigned' : 'std_logic_vector'),
      width: literalWidth(e.value),
    };
  else if (e.kind === 'convert') {
    if (e.conversion === 'signed')
      throw new Error('Signed Verilog casts are not VHDL conversions.');
    const inner = inferVhdl(
      e.value,
      ast,
      e.conversion === 'resize' ? 'unsigned' : e.qualified ? e.conversion : undefined,
    );
    if (e.qualified && inner.type !== e.conversion)
      bad('A qualified expression must already have its qualified type.');
    if (
      !e.qualified &&
      e.conversion !== 'resize' &&
      e.value.kind === 'concat' &&
      !e.value.parts.some(
        (p) =>
          p.nativeType !== 'std_logic' && (p.kind !== 'literal' || p.nativeType === 'unsigned'),
      )
    )
      bad(
        "Qualify scalar/literal concatenations with unsigned'(...) or std_logic_vector'(...) to resolve their array type.",
      );
    if (
      !e.qualified &&
      e.conversion !== 'resize' &&
      e.value.kind === 'literal' &&
      e.value.nativeType !== 'unsigned'
    )
      bad(
        "Qualify array literals with unsigned'(...) or std_logic_vector'(...) instead of casting them.",
      );
    if (inner.type === 'std_logic')
      bad('Array conversions need an unsigned or std_logic_vector operand.');
    if (e.conversion === 'resize' && inner.type !== 'unsigned')
      bad('resize requires an unsigned operand.');
    result = {
      type: e.conversion === 'resize' ? 'unsigned' : e.conversion,
      width: e.resultWidth ?? inner.width,
    };
  } else if (e.kind === 'concat') {
    const parts = e.parts.map((p) => inferVhdl(p, ast, hint));
    const arrays = parts.filter((p) => p.type !== 'std_logic');
    const type = arrays[0]?.type ?? (hint === 'unsigned' ? 'unsigned' : 'std_logic_vector');
    if (arrays.some((p) => p.type !== type))
      bad('Convert concatenation operands to the same array type.');
    result = { type, width: parts.reduce((w, p) => w + p.width, 0) };
  } else if (e.kind === 'mux') {
    const condition = inferVhdl(e.condition, ast, 'std_logic'),
      a = inferVhdl(e.truthy, ast, hint),
      b = inferVhdl(e.falsy, ast, a.type);
    if (condition.type !== 'std_logic' || condition.width !== 1)
      bad("A conditional assignment requires a std_logic selector = '1'.");
    if (a.type !== b.type || a.width !== b.width)
      bad('Conditional branches need identical types and widths.');
    result = a;
  } else if (e.kind === 'unary') {
    const value = inferVhdl(e.value, ast, 'std_logic');
    if (e.op !== '!' || !e.synthetic || value.type !== 'std_logic')
      bad('Unsupported VHDL unary expression.');
    result = { type: 'std_logic', width: 1 };
  } else {
    if (e.synthetic && e.op === '===') {
      const a = inferVhdl(e.left, ast, hint),
        b = inferVhdl(e.right, ast, a.type);
      if (a.type !== b.type || a.width !== b.width) bad('Case choice type/width mismatch.');
      e.nativeType = 'std_logic';
      e.nativeWidth = 1;
      return { type: 'std_logic', width: 1 };
    }
    const arithmetic = ['+', '-', '*'].includes(e.op),
      a = inferVhdl(e.left, ast, arithmetic ? 'unsigned' : hint),
      b = inferVhdl(e.right, ast, a.type);
    if (a.type !== b.type || (arithmetic && a.type !== 'unsigned'))
      bad(
        'Arithmetic requires numeric_std unsigned operands; use explicit unsigned(...) conversions.',
      );
    if (!arithmetic && a.width !== b.width)
      bad('Bitwise operands need matching widths; use explicit resize.');
    result = { type: a.type, width: e.op === '*' ? a.width + b.width : Math.max(a.width, b.width) };
  }
  if (result.width < 1 || result.width > 4096) bad('Expression width must be 1–4096 bits.');
  e.nativeType = result.type;
  e.nativeWidth = result.width;
  return result;
}
function validateVhdlModule(ast: Module, context: Set<string>) {
  const names = new Set<string>(),
    driven = new Set<string>();
  for (const n of ast.nets) {
    if (names.has(n.name))
      error(
        'Duplicate case-insensitive declaration.',
        n.declarationStart ?? ast.start,
        n.declarationEnd ?? ast.end,
      );
    names.add(n.name);
  }
  for (const inst of ast.instances) {
    if (names.has(inst.name)) error('Duplicate signal or instance.', inst.start, inst.end);
    names.add(inst.name);
  }
  for (const a of ast.assigns) {
    const target = ast.nets.find((n) => n.name === a.target);
    if (!target || target.direction === 'input' || driven.has(a.target))
      error('Assignments need a distinct declared non-input target.', a.start, a.end);
    driven.add(a.target);
    const inferred = inferVhdl(a.expr, ast, target.nativeType);
    if (inferred.type !== target.nativeType || inferred.width !== target.width)
      error(
        'Assignment type/width mismatch. Use unsigned/std_logic_vector conversions and explicit resize.',
        a.expr.start,
        a.expr.end,
      );
  }
  const numeric = (e: Expr): boolean =>
    (e.kind === 'literal' && e.nativeType === 'unsigned') ||
    (e.kind === 'convert' && ['unsigned', 'resize'].includes(e.conversion)) ||
    (e.kind === 'op' && ['+', '-', '*'].includes(e.op)) ||
    children(e).some(([, c]) => numeric(c));
  if (
    !context.has('numeric_std') &&
    (ast.assigns.some((a) => numeric(a.expr)) ||
      ast.instances.some((i) => i.ports.some((p) => numeric(p.expr))))
  )
    error('Import ieee.numeric_std.all for unsigned arithmetic/conversions.', ast.start, ast.end);
}

export function exportVhdlModule(source: string, ast: Module): string {
  const m = ast.vhdl!;
  return `library ieee;\nuse ieee.std_logic_1164.all;\nuse ieee.numeric_std.all;\n${source.slice(m.entityStart, m.entityEnd)}\n${source.slice(m.architectureStart, m.architectureEnd)}`;
}
export function vhdlTokenEdit(
  source: string,
  ast: Module,
  node: Node,
  e: Expr | undefined,
  change: GraphChange,
  current: Node | undefined,
): Edit {
  let edit: Edit;
  if (change.kind === 'literal' && e?.kind === 'literal' && node.kind === 'literal') {
    if (e.value !== node.label) throw new Error('Literal changed in the live buffer.');
    edit = { start: e.start, end: e.end, text: literalInput(change.value, e.nativeType!) };
  } else if (change.kind === 'slice' && e?.kind === 'slice' && current?.label === node.label) {
    const match = /^\[([0-9]+)(?::([0-9]+))?\]$/.exec(change.value);
    if (!match) throw new Error('Use [bit] or [left:right] in the graph inspector.');
    edit = {
      start: e.rangeStart,
      end: e.rangeEnd,
      text: nativeRange(Number(match[1]), Number(match[2] ?? match[1]), match[2] === undefined),
    };
  } else if (
    change.kind === 'selector' &&
    e?.kind === 'mux' &&
    e.condition.kind === 'ref' &&
    current?.operandSignature === node.operandSignature
  ) {
    const name = change.value.toLowerCase();
    if (!ast.nets.some((n) => n.name === name && n.nativeType === 'std_logic'))
      throw new Error('Choose a declared std_logic selector.');
    edit = { start: e.condition.start, end: e.condition.end, text: name };
  } else throw new Error('This VHDL component does not support that token edit.');
  validateVhdlEdits(source, [edit]);
  return edit;
}
export function validateVhdlEdits(source: string, edits: Edit[]) {
  const ast = parseVhdl(source),
    allowed = new Map<string, { kind: string; expr: Expr; scope: Module }>();
  for (const scope of Object.values(ast.library))
    for (const e of expressions(scope).values()) {
      if (e.kind === 'op')
        allowed.set(`${e.tokenStart}:${e.tokenEnd}`, { kind: 'op', expr: e, scope });
      if (e.kind === 'literal')
        allowed.set(`${e.start}:${e.end}`, { kind: 'literal', expr: e, scope });
      if (e.kind === 'slice')
        allowed.set(`${e.rangeStart}:${e.rangeEnd}`, { kind: 'slice', expr: e, scope });
      if (e.kind === 'mux' && e.condition.kind === 'ref')
        allowed.set(`${e.condition.start}:${e.condition.end}`, {
          kind: 'selector',
          expr: e,
          scope,
        });
    }
  let operatorOnly = source,
    next = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    const span = allowed.get(`${edit.start}:${edit.end}`);
    if (!span) throw new Error('Patch is outside a supported VHDL token span.');
    if (span.kind === 'op') {
      if (!Object.values(opMap).some((op) => vhdlOperator(op) === edit.text))
        throw new Error('Invalid VHDL operator.');
      operatorOnly = operatorOnly.slice(0, edit.start) + edit.text + operatorOnly.slice(edit.end);
    }
    if (
      span.kind === 'selector' &&
      !span.scope.nets.some(
        (n) => n.name === edit.text.toLowerCase() && n.nativeType === 'std_logic',
      )
    )
      throw new Error('Invalid std_logic selector.');
    if (span.kind === 'slice' && !/^\([0-9]+(?: (?:to|downto) [0-9]+)?\)$/.test(edit.text))
      throw new Error('Invalid VHDL slice.');
    if (
      span.kind === 'literal' &&
      !/^(?:'[01]'|[box]?"[0-9a-f_]+"|unsigned'\("[01_]+"\)|to_unsigned\([0-9]+, *[0-9]+\))$/i.test(
        edit.text,
      )
    )
      throw new Error('Invalid VHDL binary/unsigned literal.');
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  }
  const shapes = (m: Module) =>
    JSON.stringify(
      Object.values(m.library).map((n) => [
        n.assigns.map((a) => shape(a.expr)),
        n.instances.map((i) => i.ports.map((p) => shape(p.expr))),
      ]),
    );
  if (shapes(ast) !== shapes(parseVhdl(operatorOnly)))
    throw new Error('Operator changes precedence grouping.');
  project(parseVhdl(next));
}
