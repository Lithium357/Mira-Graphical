// SPDX-License-Identifier: GPL-3.0-only
import { parse, expressions, type Expr, type Module } from './index.js';
import { literalWidth } from './literals.js';
type Bits = { width: number; value: bigint; known: bigint };
export type Simulation = {
  signals: Record<string, { width: number; value: string }>;
  nodes: Record<string, string>;
};
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
function resize(bits: Bits, width: number): Bits {
  const m = mask(width),
    extended = width > bits.width ? m ^ mask(bits.width) : 0n;
  return { width, value: bits.value & m, known: (bits.known | extended) & m };
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
/** Zero-delay unsigned combinational evaluator. Unknown bits never silently become zeros. */
export function simulate(
  source: string,
  selected: string,
  inputs: Record<string, string>,
): Simulation {
  const root = parse(source, selected);
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs))
    throw new Error('Invalid input vector.');
  const inputNames = root.nets.filter((n) => n.direction === 'input').map((n) => n.name);
  if (Object.keys(inputs).some((n) => !inputNames.includes(n)))
    throw new Error('Input vector contains an unknown port.');
  const signals: Simulation['signals'] = Object.create(null),
    nodes: Simulation['nodes'] = Object.create(null);
  let signalCount = 0;
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
        if (driver) result = expression(driver.expr, declaration.width);
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
          } else result = unknown(declaration.width);
        }
      }
      result = resize(result, declaration.width);
      values.set(name, result);
      active.delete(name);
      return result;
    };
    const width = (e: Expr): number =>
      e.kind === 'convert'
        ? (e.resultWidth ?? width(e.value))
        : (e.nativeWidth ??
          (e.kind === 'ref'
            ? ast.nets.find((n) => n.name === e.value)!.width
            : e.kind === 'slice'
              ? Math.abs(e.msb - e.lsb) + 1
              : e.kind === 'literal'
                ? literalWidth(e.value)
                : e.kind === 'concat'
                  ? e.parts.reduce((sum, p) => sum + width(p), 0)
                  : e.kind === 'mux'
                    ? Math.max(width(e.truthy), width(e.falsy))
                    : Math.max(width(e.left), width(e.right))));
    function expression(e: Expr, context = 0): Bits {
      if (ast.language === 'vhdl') context = 0;
      if (e.kind === 'convert') return resize(expression(e.value), width(e));
      if (e.kind === 'ref') return net(e.value);
      if (e.kind === 'literal')
        return /^'[01]$/.test(e.value)
          ? known(Math.max(1, context), e.value === "'1" ? mask(Math.max(1, context)) : 0n)
          : literal(e.value);
      if (e.kind === 'slice') {
        const declaration = ast.nets.find((n) => n.name === e.value)!,
          base = net(e.value),
          shift = Math.abs(e.lsb - declaration.lsb),
          w = width(e);
        return {
          width: w,
          value: (base.value >> BigInt(shift)) & mask(w),
          known: (base.known >> BigInt(shift)) & mask(w),
        };
      }
      if (e.kind === 'concat') {
        let value = 0n,
          k = 0n,
          w = 0;
        for (const part of e.parts) {
          const bits = expression(part);
          w += bits.width;
          mask(w);
          value = (value << BigInt(bits.width)) | bits.value;
          k = (k << BigInt(bits.width)) | bits.known;
        }
        return { width: w, value, known: k };
      }
      const w = Math.max(width(e), context),
        m = mask(w);
      if (e.kind === 'mux') {
        const condition = expression(e.condition),
          truthy = resize(expression(e.truthy, w), w),
          falsy = resize(expression(e.falsy, w), w);
        if (condition.value & condition.known) return truthy;
        if (condition.known === mask(condition.width)) return falsy;
        return {
          width: w,
          value: truthy.value,
          known: truthy.known & falsy.known & ~(truthy.value ^ falsy.value) & m,
        };
      }
      const a = resize(expression(e.left, w), w),
        b = resize(expression(e.right, w), w);
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
      if (++signalCount > 512) throw new Error('Simulation supports at most 512 expanded signals.');
      const result = net(declaration.name);
      signals[path + declaration.name] = { width: result.width, value: format(result) };
      if (!path) nodes[`${ast.name}/net/${declaration.name}`] = format(result);
    }
    if (!path)
      for (const [key, e] of expressions(ast)) {
        const target = ast.assigns.find(
          (a) => `${ast.name}/assign/${a.target}/expr` === key,
        )?.target;
        const result = expression(e, target ? ast.nets.find((n) => n.name === target)!.width : 0);
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
  evaluate(root, bindings, '');
  return { signals, nodes };
}
