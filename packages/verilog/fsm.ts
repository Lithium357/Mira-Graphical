// SPDX-License-Identifier: GPL-3.0-only
import { expressionWidth, type Expr, type Module } from './index.js';

export type StateMachine = {
  register: string;
  clock: string;
  edge: string;
  states: { name: string; value: string }[];
  transitions: { from: string; to: string; condition: string }[];
  detail?: string;
};
const number = (value: string) => {
  const match = /^\d+'([bodh])([0-9a-f_]+)$/i.exec(value);
  return match
    ? BigInt(
        ({ b: '0b', o: '0o', d: '', h: '0x' }[match[1].toLowerCase()] ?? '') +
          match[2].replaceAll('_', ''),
      )
    : BigInt(value);
};
function label(e: Expr, depth = 0): string {
  if (depth > 12) throw new Error('Transition condition exceeds the diagram display limits.');
  const value = renderLabel(e, depth);
  if (value.length > 1024) throw new Error('Transition condition exceeds 1024 display characters.');
  return value;
}
function renderLabel(e: Expr, depth: number): string {
  const text = (c: Expr) => label(c, depth + 1);
  if (e.kind === 'ref' || e.kind === 'slice') return e.value;
  if (e.kind === 'literal') return e.constantName ?? e.value;
  if (e.kind === 'unary') return `${e.op}(${text(e.value)})`;
  if (e.kind === 'op') return `(${text(e.left)} ${e.op === '===' ? '==' : e.op} ${text(e.right)})`;
  if (e.kind === 'convert') return text(e.value);
  if (e.kind === 'concat') return '{' + e.parts.map(text).join(', ') + '}';
  return `(${text(e.condition)} ? ${text(e.truthy)} : ${text(e.falsy)})`;
}
/** A conservative derived view of enum register drivers, including explicit reset and hold paths. */
export function stateMachines(ast: Module): StateMachine[] {
  let totalVisits = 0,
    totalStates = 0,
    totalTransitions = 0;
  return ast.assigns
    .filter((a) => a.events && ast.nets.find((n) => n.name === a.target)?.enumType)
    .map((driver) => {
      const type = ast.nets.find((n) => n.name === driver.target)!.enumType;
      const members = ast.enumMembers?.filter((m) => m.enumType === type) ?? [];
      const machine: StateMachine = {
        register: driver.target,
        clock: driver.events![0].signal,
        edge: driver.events![0].edge,
        states: members.map((m) => ({ name: m.name, value: m.value })),
        transitions: [],
      };
      totalStates += machine.states.length;
      if (totalStates > 1024 || totalVisits > 65536 || totalTransitions >= 2048) {
        machine.states = [];
        machine.detail = 'State view exceeds the module display limits.';
        return machine;
      }
      let budget = 0;
      for (const current of members) {
        const known = (e: Expr): bigint | undefined => {
          if (e.kind === 'ref' && e.value === driver.target) return number(current.value);
          if (e.kind === 'literal') return number(e.value);
          if (e.kind === 'unary') {
            const v = known(e.value);
            return v === undefined ? undefined : e.op === '!' ? BigInt(!v) : undefined;
          }
          if (e.kind === 'op') {
            if (['==', '===', '!=', '!=='].includes(e.op)) {
              const width = expressionWidth(e.left, ast.nets);
              // Leave mixed-width/sign coercions in the guard instead of guessing their truth.
              if (
                expressionWidth(e.right, ast.nets) !== width ||
                e.caseLabels?.some((c) => expressionWidth(c, ast.nets) !== width)
              )
                return;
            }
            const a = known(e.left),
              b = known(e.right);
            if (a === undefined || b === undefined) return;
            if (['==', '==='].includes(e.op)) return BigInt(a === b);
            if (['!=', '!=='].includes(e.op)) return BigInt(a !== b);
            if (e.op === '||') return BigInt(!!a || !!b);
            if (e.op === '&&') return BigInt(!!a && !!b);
          }
        };
        const visit = (e: Expr, guards: string[], refs: Set<string>, depth = 0): void => {
          if (
            ++totalVisits > 65536 ||
            ++budget > 16384 ||
            depth > 128 ||
            machine.transitions.length >= 512 ||
            totalTransitions >= 2048
          )
            throw new Error('State diagram exceeds its display limits.');
          if (e.kind === 'convert' && e.synthetic) return visit(e.value, guards, refs, depth + 1);
          if (e.kind === 'mux') {
            const condition = known(e.condition);
            if (condition !== undefined)
              return visit(condition ? e.truthy : e.falsy, guards, refs, depth + 1);
            const text = label(e.condition);
            visit(e.truthy, [...guards, text], refs, depth + 1);
            visit(e.falsy, [...guards, `!(${text})`], refs, depth + 1);
            return;
          }
          let target: string | undefined;
          if (e.kind === 'literal')
            target = members.find((m) => number(m.value) === number(e.value))?.name;
          if (e.kind === 'ref') {
            if (e.value === driver.target) target = current.name;
            else {
              const next = ast.assigns.find((a) => a.target === e.value && !a.events);
              if (next && !refs.has(e.value))
                return visit(next.expr, guards, new Set([...refs, e.value]), depth + 1);
            }
          }
          if (!target)
            throw new Error(
              'This enum register depends on another state register or an unsupported transition expression.',
            );
          const condition = guards.join(' && ') || 'always';
          if (condition.length > 4096)
            throw new Error('Combined transition condition exceeds the diagram display limits.');
          if (
            !machine.transitions.some(
              (t) => t.from === current.name && t.to === target && t.condition === condition,
            )
          ) {
            machine.transitions.push({ from: current.name, to: target, condition });
            totalTransitions++;
          }
        };
        try {
          visit(driver.expr, [], new Set());
        } catch (e) {
          machine.detail = String((e as Error).message);
          machine.transitions = [];
          break;
        }
      }
      return machine;
    });
}
