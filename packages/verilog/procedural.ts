// SPDX-License-Identifier: GPL-3.0-only
import { children, type Expr, type Net, type Module } from './index.js';

export function registerInputs(
  body: Statement,
  events: NonNullable<Module['assigns'][number]['events']>,
): Module['assigns'][number]['registerInputs'] {
  const unwrap = (s: Statement): Statement =>
    s.kind === 'block' && s.items.length === 1 ? unwrap(s.items[0]) : s;
  let s = unwrap(body);
  let reset: Expr | undefined;
  if (s.kind === 'if') {
    const a = unwrap(s.yes),
      b = unwrap(s.no),
      c = s.condition;
    const ref =
      c.kind === 'ref' ? c : c.kind === 'unary' && c.value.kind === 'ref' ? c.value : undefined;
    if (!ref || a.kind !== 'assign' || b.kind !== 'assign' || a.target !== b.target) return;
    reset = ref;
    s = b;
  }
  if (s.kind !== 'assign' || events[0]?.start === undefined || events[0]?.end === undefined) return;
  return {
    clockSensitivity:
      events[0].sensitivityStart !== undefined
        ? { start: events[0].sensitivityStart, end: events[0].sensitivityEnd! }
        : undefined,
    data: { start: s.value.outerStart ?? s.value.start, end: s.value.outerEnd ?? s.value.end },
    clock: { start: events[0].start, end: events[0].end },
    reset: reset ? { start: reset.start, end: reset.end } : undefined,
  };
}
export type Statement = (
  | { kind: 'assign'; target: string; value: Expr }
  | { kind: 'block'; items: Statement[] }
  | { kind: 'if'; condition: Expr; yes: Statement; no: Statement }
) & { start?: number; end?: number };

/** Lower ordered blocking or simultaneous nonblocking statements to guarded drivers. */
export function lowerStatements(
  body: Statement,
  nets: Net[],
  clocked: boolean,
  start: number,
  end: number,
): Map<string, Expr> {
  const targets = new Set<string>();
  const collect = (s: Statement): void => {
    if (s.kind === 'assign') targets.add(s.target);
    else if (s.kind === 'block') s.items.forEach(collect);
    else {
      collect(s.yes);
      collect(s.no);
    }
  };
  collect(body);
  const hold = (name: string): Expr => ({
    kind: 'ref',
    value: name,
    start,
    end: start,
    synthetic: true,
  });
  let budget = 0;
  const read = (e: Expr, values: Map<string, Expr>, depth = 0): Expr => {
    if (++budget > 32768 || depth > 128)
      throw new Error('Expanded procedural expressions exceed supported limits.');
    if (!clocked && (e.kind === 'ref' || e.kind === 'slice') && targets.has(e.value)) {
      const value = values.get(e.value);
      if (!value)
        throw Object.assign(
          new Error(
            `Procedural read of ${e.value} before assignment; latch/order dependency is unsupported.`,
          ),
          { start: e.start, end: e.end },
        );
      if (e.kind === 'slice')
        throw Object.assign(
          new Error('Slicing an ordered temporary is unsupported; use a separate continuous wire.'),
          { start: e.start, end: e.end },
        );
      const n = nets.find((n) => n.name === e.value)!;
      return {
        kind: 'convert',
        conversion: 'resize',
        resultWidth: n.width,
        signed: n.signed,
        value,
        start: e.start,
        end: e.end,
        synthetic: true,
      };
    }
    if (e.kind === 'op')
      return {
        ...e,
        left: read(e.left, values, depth + 1),
        right: read(e.right, values, depth + 1),
      };
    if (e.kind === 'unary' || e.kind === 'convert')
      return { ...e, value: read(e.value, values, depth + 1) };
    if (e.kind === 'concat') return { ...e, parts: e.parts.map((p) => read(p, values, depth + 1)) };
    if (e.kind === 'mux')
      return {
        ...e,
        condition: read(e.condition, values, depth + 1),
        truthy: read(e.truthy, values, depth + 1),
        falsy: read(e.falsy, values, depth + 1),
      };
    return e;
  };
  const execute = (s: Statement, values: Map<string, Expr>, depth = 0): void => {
    if (depth > 128) throw new Error('Procedural statement nesting exceeds 128.');
    if (s.kind === 'assign') values.set(s.target, read(s.value, values));
    else if (s.kind === 'block') for (const item of s.items) execute(item, values, depth + 1);
    else {
      const condition = read(s.condition, values),
        a = new Map(values),
        b = new Map(values);
      execute(s.yes, a, depth + 1);
      execute(s.no, b, depth + 1);
      for (const name of new Set([...a.keys(), ...b.keys()])) {
        const t = a.get(name) ?? (clocked ? hold(name) : undefined),
          f = b.get(name) ?? (clocked ? hold(name) : undefined);
        if (!t || !f)
          throw Object.assign(
            new Error(
              `Incomplete combinational assignment to ${name}; add a default or else branch.`,
            ),
            { start: condition.start, end: condition.end },
          );
        values.set(
          name,
          t === f
            ? t
            : {
                kind: 'mux',
                procedural: true,
                condition,
                truthy: t,
                falsy: f,
                start: condition.start,
                end,
              },
        );
      }
    }
  };
  const values = new Map<string, Expr>();
  execute(body, values);
  let count = 0;
  const bounded = (e: Expr, depth = 0): void => {
    if (++count > 8192 || depth > 256)
      throw new Error('Expanded procedural graph exceeds 8192 expressions/256 levels.');
    for (const [, c] of children(e)) bounded(c, depth + 1);
  };
  for (const e of values.values()) bounded(e);
  return values;
}
