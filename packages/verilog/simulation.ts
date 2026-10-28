// SPDX-License-Identifier: GPL-3.0-only
import {
  parse,
  expressions,
  expressionWidth,
  expressionSigned,
  type Expr,
  type Module,
} from './index.js';
import { isComparison } from '../protocol/index.js';
import { literalWidth } from './literals.js';
import { elaborate } from './elaboration.js';
type Bits = { width: number; value: bigint; known: bigint };
export type Simulation = {
  signals: Record<string, { width: number; value: string }>;
  nodes: Record<string, string>;
  state?: SimulationState;
};
export type SimulationState = { registers: Record<string, string>; events: Record<string, string> };
const mask = (width: number) => {
  if (!Number.isSafeInteger(width) || width < 1 || width > 4096)
    throw new Error('Simulation widths must be 1–4096 bits.');
  return (1n << BigInt(width)) - 1n;
};
const known = (width: number, value: bigint): Bits => ({
  width,
  value: value & mask(width),
  known: mask(width),
});
const unknown = (width: number): Bits => ({ width, value: 0n, known: 0n });
function resize(bits: Bits, width: number, signed = false): Bits {
  const m = mask(width),
    extended = width > bits.width ? m ^ mask(bits.width) : 0n;
  const sign = 1n << BigInt(bits.width - 1);
  return {
    width,
    value: (bits.value | (signed && bits.value & sign ? extended : 0n)) & m,
    known: (bits.known | (!signed || bits.known & sign ? extended : 0n)) & m,
  };
}
function literal(text: string): Bits {
  const width = literalWidth(text),
    parts = text.replaceAll('_', '').split("'");
  if (parts.length === 1) return known(width, BigInt(parts[0]));
  const base = parts[1][0].toLowerCase(),
    digits = parts[1].slice(1);
  return known(
    width,
    BigInt(({ b: '0b', o: '0o', h: '0x', d: '' } as Record<string, string>)[base] + digits),
  );
}
function input(text: unknown, width: number): Bits {
  if (typeof text !== 'string' || text.length > 8192)
    throw new Error('Enter an unsigned decimal, 0x hex, 0b binary, or x input.');
  text = text.trim();
  if (text === 'x') return unknown(width);
  if (typeof text === 'string' && /^0b[01x]+$/i.test(text)) {
    const digits = text.slice(2).toLowerCase();
    if (digits.length > width) throw new Error('Input exceeds its declared width.');
    let value = 0n,
      k = 0n;
    for (const digit of digits) {
      value = (value << 1n) | BigInt(digit === '1');
      k = (k << 1n) | BigInt(digit !== 'x');
    }
    return resize({ width: digits.length, value, known: k }, width);
  }
  if (typeof text !== 'string' || !/^(?:[0-9]+|0x[0-9a-f]+|0b[01]+)$/i.test(text))
    throw new Error('Invalid unsigned simulation input.');
  const value = BigInt(text);
  if (value > mask(width)) throw new Error(`Input exceeds ${width} bits.`);
  return known(width, value);
}
function format(bits: Bits): string {
  if (bits.known === mask(bits.width))
    return bits.width === 1
      ? String(bits.value)
      : '0x' + bits.value.toString(16).padStart(Math.ceil(bits.width / 4), '0');
  let result = '';
  for (let i = bits.width - 1; i >= 0; i--)
    result += bits.known & (1n << BigInt(i)) ? (bits.value & (1n << BigInt(i)) ? '1' : '0') : 'x';
  return bits.width === 1 ? result : '0b' + result;
}
/** Sampled zero-delay evaluator. Register updates commit after old-state evaluation. */
export function simulate(
  source: string,
  selected: string,
  inputs: Record<string, string>,
  previous?: SimulationState,
): Simulation {
  return simulateModule(parse(source, selected), inputs, previous);
}
export function simulateModule(
  ast: Module,
  inputs: Record<string, string>,
  previous?: SimulationState,
): Simulation {
  const root = elaborate(ast);
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs))
    throw new Error('Invalid input vector.');
  const inputNames = root.nets.filter((n) => n.direction === 'input').map((n) => n.name);
  if (Object.keys(inputs).some((n) => !inputNames.includes(n)))
    throw new Error('Input vector contains an unknown port.');
  const signals: Simulation['signals'] = Object.create(null),
    nodes: Simulation['nodes'] = Object.create(null);
  let signalCount = 0;
  let registers = Object.assign(Object.create(null), previous?.registers);
  // Native VHDL enumeration signals start at the leftmost literal, without a reset event.
  if (ast.language === 'vhdl')
    for (const n of root.nets) {
      if (!n.enumType || Object.hasOwn(registers, n.name)) continue;
      const member = Object.values(ast.library)
        .flatMap((m) => m.enumMembers ?? [])
        .find((m) => m.enumType === n.enumType);
      if (member) registers[n.name] = format(literal(member.value));
    }
  let advancing = true;
  let next: Record<string, string> = Object.assign(Object.create(null), registers);
  let events: Record<string, string> = Object.create(null);
  let priorEvents = previous?.events ?? Object.create(null);
  let triggeredAny = false;
  const truth = (bits: Bits) =>
    bits.value & bits.known ? 1 : bits.known === mask(bits.width) ? 0 : -1;
  function evaluate(ast: Module, bindings: Record<string, Bits>, path: string): Map<string, Bits> {
    const values = new Map<string, Bits>(),
      active = new Set<string>(),
      instances = new Map<string, Map<string, Bits>>();
    const net = (name: string): Bits => {
      if (values.has(name)) return values.get(name)!;
      if (active.has(name)) throw new Error('Combinational simulation cycle.');
      active.add(name);
      const declaration = ast.nets.find((n) => n.name === name)!;
      mask(declaration.width);
      let result: Bits;
      if (declaration.direction === 'input') result = bindings[name] ?? unknown(declaration.width);
      else {
        const driver = ast.assigns.find((a) => a.target === name);
        if (driver?.events)
          result = input(
            Object.hasOwn(registers, path + name) ? registers[path + name] : 'x',
            declaration.width,
          );
        else if (driver) result = expression(driver.expr, declaration.width);
        else {
          const inst = ast.instances.find((i) =>
            i.ports.some(
              (p) =>
                p.expr.kind === 'ref' &&
                p.expr.value === name &&
                ast.library[i.module].nets.some(
                  (n) => n.name === p.name && n.direction === 'output',
                ),
            ),
          );
          if (inst) {
            if (!instances.has(inst.name)) {
              const child = ast.library[inst.module],
                childInputs: Record<string, Bits> = Object.create(null);
              for (const port of child.nets.filter((n) => n.direction === 'input'))
                childInputs[port.name] = resize(
                  expression(inst.ports.find((p) => p.name === port.name)!.expr, port.width),
                  port.width,
                );
              instances.set(inst.name, evaluate(child, childInputs, path + inst.name + '.'));
            }
            const port = inst.ports.find(
              (p) => p.expr.kind === 'ref' && p.expr.value === name,
            )!.name;
            result = instances.get(inst.name)!.get(port)!;
          } else
            result =
              ast.language === 'vhdl' &&
              declaration.enumType &&
              Object.hasOwn(registers, path + name)
                ? input(registers[path + name], declaration.width)
                : unknown(declaration.width);
        }
      }
      result = resize(result, declaration.width);
      values.set(name, result);
      active.delete(name);
      return result;
    };
    const width = (e: Expr): number => expressionWidth(e, ast.nets);
    const evaluated = new Map<Expr, Bits>();
    function expression(e: Expr, context = 0, signedContext?: boolean): Bits {
      const result = evaluateExpression(e, context, signedContext);
      evaluated.set(e, result);
      return result;
    }
    function evaluateExpression(e: Expr, context = 0, signedContext?: boolean): Bits {
      if (ast.language === 'vhdl') context = 0;
      const signed = signedContext ?? expressionSigned(e);
      if (e.kind === 'convert' && e.conversion === 'resize' && ast.language !== 'vhdl') {
        const fixed = resize(expression(e.value, e.resultWidth), e.resultWidth!);
        return resize(fixed, Math.max(context, e.resultWidth!), signed);
      }
      if (e.kind === 'convert')
        return ast.language === 'vhdl'
          ? resize(expression(e.value), width(e))
          : resize(expression(e.value), Math.max(context, width(e)), signed);
      if (e.kind === 'ref') return resize(net(e.value), Math.max(context, width(e)), signed);
      if (e.kind === 'literal')
        return /^'[01]$/.test(e.value)
          ? known(Math.max(1, context), e.value === "'1" ? mask(Math.max(1, context)) : 0n)
          : resize(literal(e.value), Math.max(context, width(e)), signed);
      if (e.kind === 'slice') {
        const declaration = ast.nets.find((n) => n.name === e.value)!,
          base = net(e.value),
          shift = Math.abs(e.lsb - declaration.lsb),
          w = width(e);
        return resize(
          {
            width: w,
            value: (base.value >> BigInt(shift)) & mask(w),
            known: (base.known >> BigInt(shift)) & mask(w),
          },
          Math.max(context, w),
          signed,
        );
      }
      if (e.kind === 'concat') {
        let value = 0n,
          k = 0n,
          w = 0;
        for (const part of Array.from({ length: e.repeat ?? 1 }, () => e.parts).flat()) {
          const bits = expression(part);
          w += bits.width;
          mask(w);
          value = (value << BigInt(bits.width)) | bits.value;
          k = (k << BigInt(bits.width)) | bits.known;
        }
        return resize({ width: w, value, known: k }, Math.max(context, w), signed);
      }
      if (e.kind === 'unary') {
        if (e.op === '!') {
          const t = truth(expression(e.value));
          return resize(t === -1 ? unknown(1) : known(1, BigInt(!t)), Math.max(1, context));
        }
        const w = Math.max(width(e), context),
          a = resize(expression(e.value, w, signed), w, signed);
        return { width: w, value: ~a.value & mask(w), known: a.known };
      }
      if (e.kind === 'op' && (e.op === '&&' || e.op === '||')) {
        const a = truth(expression(e.left)),
          b = truth(expression(e.right));
        const t =
          e.op === '&&'
            ? a === 0 || b === 0
              ? 0
              : a === 1 && b === 1
                ? 1
                : -1
            : a === 1 || b === 1
              ? 1
              : a === 0 && b === 0
                ? 0
                : -1;
        return resize(t === -1 ? unknown(1) : known(1, BigInt(t)), Math.max(context, 1));
      }
      if (e.kind === 'op' && isComparison(e.op)) {
        const w = Math.max(width(e.left), width(e.right), ...(e.caseLabels ?? []).map(width)),
          m = mask(w);
        const operandSigned =
          expressionSigned(e.left) &&
          expressionSigned(e.right) &&
          (e.caseLabels ?? []).every(expressionSigned);
        const a = resize(expression(e.left, w, operandSigned), w, operandSigned),
          b = resize(expression(e.right, w, operandSigned), w, operandSigned);
        const mismatch = ((a.value ^ b.value) & a.known & b.known) !== 0n;
        if (e.op === '===' || e.op === '!==') {
          const equal = a.known === b.known && ((a.value ^ b.value) & a.known) === 0n;
          return known(1, BigInt(e.op === '===' ? equal : !equal));
        }
        if (e.op === '==' || e.op === '!=') {
          if (mismatch) return known(1, BigInt(e.op === '!='));
          if (a.known !== m || b.known !== m) return unknown(1);
          return known(1, BigInt(e.op === '=='));
        }
        if (a.known !== m || b.known !== m) return unknown(1);
        const integer = (bits: Bits) =>
          operandSigned && bits.value & (1n << BigInt(w - 1))
            ? bits.value - (1n << BigInt(w))
            : bits.value;
        const av = integer(a),
          bv = integer(b);
        return known(
          1,
          BigInt(
            e.op === '<' ? av < bv : e.op === '<=' ? av <= bv : e.op === '>' ? av > bv : av >= bv,
          ),
        );
      }
      const w = Math.max(width(e), context),
        m = mask(w);
      if (e.kind === 'mux') {
        const muxWidth = e.procedural && context ? context : w;
        const truthySigned = e.procedural ? expressionSigned(e.truthy) : signed;
        const falsySigned = e.procedural ? expressionSigned(e.falsy) : signed;
        const condition = expression(e.condition),
          truthy = resize(expression(e.truthy, muxWidth, truthySigned), muxWidth, truthySigned),
          falsy = resize(expression(e.falsy, muxWidth, falsySigned), muxWidth, falsySigned);
        if (condition.value & condition.known) return truthy;
        if (condition.known === mask(condition.width) || e.procedural) return falsy;
        return {
          width: w,
          value: truthy.value,
          known: truthy.known & falsy.known & ~(truthy.value ^ falsy.value) & m,
        };
      }
      if (e.op === '<<' || e.op === '>>' || e.op === '>>>') {
        const a = resize(expression(e.left, w, signed), w, signed),
          b = expression(e.right);
        if (b.known !== mask(b.width)) return unknown(w);
        const n = b.value >= BigInt(w) ? BigInt(w) : b.value;
        if (e.op === '<<')
          return {
            width: w,
            value: (a.value << n) & m,
            known: ((a.known << n) | ((1n << n) - 1n)) & m,
          };
        const fill = m ^ (m >> n);
        const sign = 1n << BigInt(w - 1);
        const arithmetic = e.op === '>>>' && signed;
        return {
          width: w,
          value: (a.value >> n) | (arithmetic && a.value & sign ? fill : 0n),
          known: (a.known >> n) | (!arithmetic || a.known & sign ? fill : 0n),
        };
      }
      const a = resize(expression(e.left, w, signed), w, signed),
        b = resize(expression(e.right, w, signed), w, signed);
      if (e.op === '&') {
        const zeros = (a.known & ~a.value) | (b.known & ~b.value);
        return { width: w, value: a.value & b.value, known: (a.known & b.known) | zeros };
      }
      if (e.op === '|') {
        const ones = (a.known & a.value) | (b.known & b.value);
        return { width: w, value: a.value | b.value, known: (a.known & b.known) | ones };
      }
      if (e.op === '^') return { width: w, value: a.value ^ b.value, known: a.known & b.known };
      if (a.known !== m || b.known !== m) return unknown(w);
      return known(
        w,
        e.op === '+' ? a.value + b.value : e.op === '-' ? a.value - b.value : a.value * b.value,
      );
    }
    for (const declaration of ast.nets) {
      if (++signalCount > 4096)
        throw new Error('Simulation supports at most 4096 expanded signals.');
      const result = net(declaration.name);
      signals[path + declaration.name] = { width: result.width, value: format(result) };
      if (!path) nodes[`${ast.name}/net/${declaration.name}`] = format(result);
      if (!path && ast.assigns.some((a) => a.target === declaration.name && a.events))
        nodes[`${ast.name}/register/${declaration.name}`] = format(result);
    }
    if (advancing)
      for (const driver of ast.assigns.filter((a) => a.events)) {
        let triggered = false;
        for (const event of driver.events!) {
          const key = path + event.signal;
          const now = format(net(event.signal)),
            before = Object.hasOwn(priorEvents, key) ? priorEvents[key] : 'x';
          events[key] = now;
          triggered ||= event.level
            ? before !== now && now === event.level
            : event.strict
              ? event.edge === 'posedge'
                ? before === '0' && now === '1'
                : before === '1' && now === '0'
              : event.edge === 'posedge'
                ? (before === '0' && now !== '0') || (before !== '1' && now === '1')
                : (before === '1' && now !== '1') || (before !== '0' && now === '0');
        }
        if (triggered) triggeredAny = true;
        if (triggered)
          next[path + driver.target] = format(
            resize(
              expression(driver.expr, ast.nets.find((n) => n.name === driver.target)!.width),
              ast.nets.find((n) => n.name === driver.target)!.width,
            ),
          );
      }
    if (!path)
      for (const [key, e] of expressions(ast)) {
        const target = ast.assigns.find(
          (a) => `${ast.name}/assign/${a.target}/expr` === key,
        )?.target;
        const result =
          evaluated.get(e) ??
          expression(e, target ? ast.nets.find((n) => n.name === target)!.width : 0);
        nodes[
          key +
            (e.kind === 'literal'
              ? '/literal'
              : e.kind === 'slice'
                ? '/slice'
                : e.kind === 'mux'
                  ? '/mux'
                  : e.kind === 'concat'
                    ? '/concat'
                    : '')
        ] = format(result);
      }
    return values;
  }
  const bindings: Record<string, Bits> = Object.create(null);
  for (const declaration of root.nets.filter((n) => n.direction === 'input'))
    bindings[declaration.name] = input(
      Object.hasOwn(inputs, declaration.name) ? inputs[declaration.name] : '0',
      declaration.width,
    );
  if (!root.assigns.some((a) => a.events)) {
    evaluate(root, bindings, '');
    return { signals, nodes };
  }
  for (let delta = 0; delta < 64; delta++) {
    triggeredAny = false;
    signalCount = 0;
    next = Object.assign(Object.create(null), registers);
    events = Object.create(null);
    evaluate(root, bindings, '');
    if (!triggeredAny) return { signals, nodes, state: { registers, events } };
    registers = next;
    priorEvents = events;
  }
  throw new Error('Clock/reset network did not settle within 64 delta cycles.');
}
