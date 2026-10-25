// SPDX-License-Identifier: GPL-3.0-only
import type { Expr, Module } from './index.js';

export function mapExpression(e: Expr, ref: (name: string) => string): Expr {
  if (e.kind === 'ref' || e.kind === 'slice') return { ...e, value: ref(e.value) };
  if (e.kind === 'convert' || e.kind === 'unary')
    return { ...e, value: mapExpression(e.value, ref) };
  if (e.kind === 'concat') return { ...e, parts: e.parts.map((p) => mapExpression(p, ref)) };
  if (e.kind === 'op')
    return { ...e, left: mapExpression(e.left, ref), right: mapExpression(e.right, ref) };
  if (e.kind === 'mux')
    return {
      ...e,
      condition: mapExpression(e.condition, ref),
      truthy: mapExpression(e.truthy, ref),
      falsy: mapExpression(e.falsy, ref),
    };
  return { ...e };
}
/** Elaborate independent instance state before evaluating any clock events. */
export function elaborate(root: Module): Module {
  const flat: Module = { ...root, nets: [], assigns: [], instances: [] };
  function visit(ast: Module, path: string) {
    const ref = (n: string) => path + n;
    for (const n of ast.nets)
      flat.nets.push({ ...n, name: ref(n.name), direction: path ? 'wire' : n.direction });
    if (flat.nets.length > 4096) throw new Error('Elaborated circuit exceeds 4096 signals.');
    for (const a of ast.assigns)
      flat.assigns.push({
        ...a,
        target: ref(a.target),
        expr: mapExpression(a.expr, ref),
        events: a.events?.map((e) => ({ ...e, signal: ref(e.signal) })),
      });
    for (const inst of ast.instances) {
      const child = ast.library[inst.module],
        childPath = path + inst.name + '.';
      visit(child, childPath);
      for (const port of child.nets.filter((n) => n.direction !== 'wire')) {
        const binding = inst.ports.find((p) => p.name === port.name)!.expr;
        flat.assigns.push(
          port.direction === 'input'
            ? {
                target: childPath + port.name,
                expr: mapExpression(binding, ref),
                start: inst.start,
                end: inst.end,
              }
            : {
                target: ref((binding as Extract<Expr, { kind: 'ref' }>).value),
                expr: {
                  kind: 'ref',
                  value: childPath + port.name,
                  signed: port.signed,
                  start: binding.start,
                  end: binding.end,
                },
                start: inst.start,
                end: inst.end,
              },
        );
      }
    }
  }
  visit(root, '');
  return flat;
}
export function hasRegisters(ast: Module): boolean {
  return (
    ast.assigns.some((a) => !!a.events) ||
    ast.instances.some((i) => hasRegisters(ast.library[i.module]))
  );
}

/** Trace child event ports through simple bindings for top-level clock buttons. */
export function clocksFor(ast: Module): { signal: string; edge: 'posedge' | 'negedge' }[] {
  const clocks = ast.assigns.filter((a) => a.events).map((a) => a.events![0]);
  for (const inst of ast.instances)
    for (const c of clocksFor(ast.library[inst.module])) {
      const binding = inst.ports.find((p) => p.name === c.signal)?.expr;
      if (binding?.kind === 'ref') clocks.push({ ...c, signal: binding.value });
    }
  return [
    ...new Map(
      clocks
        .filter((c) =>
          ast.nets.some((n) => n.name === c.signal && n.direction === 'input' && n.width === 1),
        )
        .map((c) => [`${c.signal}:${c.edge}`, { signal: c.signal, edge: c.edge }]),
    ).values(),
  ];
}
