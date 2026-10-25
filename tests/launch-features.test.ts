// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, project } from '../packages/verilog/index.js';
import { simulate, type SimulationState } from '../packages/verilog/simulation.js';
import { autoLayout } from '../packages/core/auto-layout.js';
import {
  planTransaction,
  validateConstructionProof,
  sourceActionEdits,
} from '../packages/verilog/construction.js';
import type { SourceAction } from '../packages/protocol/index.js';
const hierarchy = readFileSync('fixtures/clocked-hierarchy.sv', 'utf8');
const counter = readFileSync('fixtures/clocked-counter.vhd', 'utf8');
test('clocked hierarchy isolates instance registers and advances a pipeline simultaneously', () => {
  const graph = project(parse(hierarchy, 'pipeline'));
  assert.equal(graph.sequential, true);
  assert.equal(graph.clocks?.[0].signal, 'clk');
  assert.equal(Object.keys(autoLayout(graph)).length, graph.nodes.length);
  let state: SimulationState | undefined;
  const sample = (clk: string, reset = '0', data = '4') => {
    const r = simulate(hierarchy, 'pipeline', { clk, reset, en: '1', data }, state);
    state = r.state;
    return r.signals;
  };
  sample('0', '1');
  sample('0');
  const a = sample('1');
  assert.equal(a.first.value, '0x05');
  assert.equal(a.second.value, '0x01');
  sample('0');
  const b = sample('1');
  assert.equal(b.second.value, '0x50');
  assert.equal(b['a.q'].value, '0x05');
  assert.equal(b['b.q'].value, '0x50');
});
test('register feedback across instances is valid but combinational feedthrough cycles are rejected', () => {
  const source = hierarchy.replace('.d(data)', '.d(second)');
  assert.doesNotThrow(() => parse(source, 'pipeline'));
  const bad = source
    .replace('always_ff @(posedge clk or posedge reset) begin', 'always_comb begin')
    .replace(/q <=/g, 'q =')
    .replace("if (reset) q = 8'd0;", "if (reset) q = 8'd0;");
  assert.throws(() => parse(bad, 'pipeline'));
});
test('ordered combinational blocks freeze intermediate assignment widths and support case/defaults', () => {
  const source = `module m(input [7:0] a,b,input [1:0] op,output reg [7:0] y);reg [3:0] temp;
 always @* begin temp=a+b;y=8'd0;case(op) 0:begin y=temp+8'd1;end 1,2:y=a^b;default:y=b;endcase end endmodule`;
  assert.equal(simulate(source, 'm', { a: '15', b: '1', op: '0' }).signals.y.value, '0x01');
  assert.equal(simulate(source, 'm', { a: '15', b: '1', op: '2' }).signals.y.value, '0x0e');
  assert.equal(simulate(source, 'm', { a: '15', b: '1', op: 'x' }).signals.y.value, '0x01');
  assert.throws(
    () => parse(source.replace("y=8'd0;", '').replace('default:y=b;', '')),
    /Incomplete/,
  );
});
test('VHDL rising/falling edge processes preserve holds and asynchronous reset', () => {
  for (const falling of [false, true]) {
    const source = falling ? counter.replace('rising_edge', 'falling_edge') : counter;
    let state: SimulationState | undefined;
    const sample = (clk: string, reset = '0', en = '1') => {
      const r = simulate(source, 'clocked_counter', { clk, reset, en }, state);
      state = r.state;
      return r.signals.q.value;
    };
    const inactive = falling ? '1' : '0',
      active = falling ? '0' : '1';
    assert.equal(sample(inactive), '0bxxxxxxxx');
    assert.equal(sample(inactive, '1'), '0x00');
    sample(inactive);
    assert.equal(sample(active), '0x01');
    assert.equal(sample(active), '0x01');
    sample(inactive);
    assert.equal(sample(active, '0', '0'), '0x01');
    assert.equal(sample(active, '1'), '0x00');
  }
});
test('VHDL edge functions reject unknown-to-active clock transitions', () => {
  let r = simulate(counter, 'clocked_counter', { clk: '0', reset: '1', en: '1' });
  r = simulate(counter, 'clocked_counter', { clk: 'x', reset: '0', en: '1' }, r.state);
  r = simulate(counter, 'clocked_counter', { clk: '1', reset: '0', en: '1' }, r.state);
  assert.equal(r.signals.q.value, '0x00');
});
test('graph creates and rewires register D/clock/reset with replayable native transactions', () => {
  const sources = [
    `module m(input clk,reset,otherclk,otherreset,input [7:0] a,b,output [7:0] y);endmodule`,
    `library ieee;use ieee.std_logic_1164.all;use ieee.numeric_std.all;entity m is port(clk,reset,otherclk,otherreset:in std_logic;a,b:in unsigned(7 downto 0);y:out unsigned(7 downto 0));end entity;architecture rtl of m is begin end architecture;`,
  ];
  for (const source of sources) {
    const actions: SourceAction[] = [
      {
        kind: 'create',
        component: 'register',
        name: 'q',
        width: 8,
        clock: 'clk',
        reset: 'reset',
        source: 'a',
        resetActive: '0',
      },
      { kind: 'connect', source: 'm/net/b', target: 'm/register/q', port: 'port:D' },
      { kind: 'connect', source: 'm/net/otherclk', target: 'm/register/q', port: 'port:clock' },
      { kind: 'connect', source: 'm/net/otherreset', target: 'm/register/q', port: 'port:reset' },
      { kind: 'connect', source: 'm/net/q', target: 'm/net/y', port: 'left' },
    ];
    const draft = planTransaction(source, actions);
    validateConstructionProof(source, draft.edits(), actions);
    let r = simulate(draft.text, 'm', {
      clk: '0',
      reset: '1',
      otherclk: '0',
      otherreset: '0',
      a: '1',
      b: '7',
    });
    assert.equal(r.signals.y.value, '0x00');
    r = simulate(
      draft.text,
      'm',
      { clk: '0', reset: '1', otherclk: '1', otherreset: '1', a: '1', b: '7' },
      r.state,
    );
    assert.equal(r.signals.y.value, '0x07');
    const graph = project(parse(draft.text));
    assert.equal(graph.nodes.find((n) => n.register)?.editableRegister, true);
    assert.throws(
      () =>
        sourceActionEdits(draft.text, {
          kind: 'connect',
          source: 'm/net/a',
          target: 'm/register/q',
          port: 'port:clock',
        }),
      /scalar/,
    );
  }
});

test('generated child clock edges settle after parent registers commit', () => {
  const source = `module leaf(input clk,reset,output reg q);always @(posedge clk or posedge reset) if(reset)q<=1'b0;else q<=~q;endmodule
 module m(input clk,reset,output first,second);leaf a(.clk(clk),.reset(reset),.q(first));leaf b(.clk(first),.reset(reset),.q(second));endmodule`;
  let r = simulate(source, 'm', { clk: '0', reset: '1' });
  r = simulate(source, 'm', { clk: '0', reset: '0' }, r.state);
  r = simulate(source, 'm', { clk: '1', reset: '0' }, r.state);
  assert.equal(r.signals.first.value, '1');
  assert.equal(r.signals.second.value, '1');
});
test('mixed signed case choices are refused with an actionable selector diagnostic', () => {
  assert.throws(
    () =>
      parse(
        `module m(input signed[3:0] s,output reg y);always_comb case($unsigned(s))8'd255:y=1'b1;default:y=1'b0;endcase endmodule`,
      ),
    /unsigned selector wire/,
  );
});
