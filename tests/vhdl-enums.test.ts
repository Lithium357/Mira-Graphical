// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, project, validateEditableEdits } from '../packages/verilog/index.js';
import { simulate, type SimulationState } from '../packages/verilog/simulation.js';

const source = readFileSync('fixtures/enum-fsm.vhd', 'utf8');
test('VHDL enum FSMs execute named case choices, defaults, reset and holds', () => {
  const ast = parse(source);
  assert.equal(ast.enumMembers?.length, 3);
  assert(project(ast).nodes.some((n) => n.label === 'running' && !n.editable));
  const initial = simulate(source, 'enum_fsm', { clk: '0', reset: '0', start: '0', finish: '0' });
  assert.equal(initial.signals.state.value, '0x0');
  const undriven = source.replace(
    'signal state, next_state : state_t;',
    'signal state, next_state, unused_state : state_t;',
  );
  assert.equal(
    simulate(undriven, 'enum_fsm', { clk: '0', reset: '0', start: '0', finish: '0' }).signals
      .unused_state.value,
    '0x0',
  );
  let state: SimulationState | undefined;
  for (const [clk, reset, start, finish, busy, done] of [
    ['0', '1', '0', '0', '0', '0'],
    ['0', '0', '1', '0', '0', '0'],
    ['1', '0', '1', '0', '1', '0'],
    ['0', '0', '1', '0', '1', '0'],
    ['1', '0', '1', '0', '1', '0'],
    ['0', '0', '1', '1', '1', '0'],
    ['1', '0', '1', '1', '0', '1'],
    ['0', '0', '0', '0', '0', '1'],
    ['1', '0', '0', '0', '0', '0'],
  ]) {
    const result = simulate(source, ast.name, { clk, reset, start, finish }, state);
    state = result.state;
    assert.equal(result.signals.busy.value, busy);
    assert.equal(result.signals.done.value, done);
  }
});
test('VHDL enums refuse duplicate names, numeric coercions, slices and conversions', () => {
  for (const invalid of [
    source.replace('(idle, running, finished)', '(idle, IDLE)'),
    source.replace('next_state <= running;', 'next_state <= "01";'),
    source.replace('next_state <= running;', 'next_state <= state(0);'),
    source.replace('next_state <= running;', 'next_state <= std_logic_vector(state);'),
    source.replace('signal state, next_state', 'signal idle, state, next_state'),
    source
      .replace('type state_t', 'type other_t is (a, b, c);\n type state_t')
      .replace('next_state <= running;', 'next_state <= a;'),
  ])
    assert.throws(() => parse(invalid));
  const start = source.indexOf('next_state <= running;') + 'next_state <= '.length;
  assert.throws(() => validateEditableEdits(source, [{ start, end: start + 7, text: '"01"' }]));
});
