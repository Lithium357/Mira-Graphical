// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, project, operatorPatch } from '../packages/verilog/index.js';
import { simulate, type SimulationState } from '../packages/verilog/simulation.js';
import { autoLayout, nodeHeight } from '../packages/core/auto-layout.js';
import {
  sourceActionEdits,
  copyComponents,
  planTransaction,
  validateConstructionProof,
} from '../packages/verilog/construction.js';

const design = readFileSync('fixtures/alu-int16-clocked.v', 'utf8');
const counter = `module counter(input clk,reset,en,output reg [7:0] q,output reg [7:0] old);
always @(posedge clk or posedge reset) begin
 if(reset) begin q<=8'd0;old<=8'd0;end
 else if(en) begin q<=q+8'd1;old<=q;end
end endmodule`;

test('clocked feedback projects register boundaries and lays out without overlaps', () => {
  const ast = parse(design, 'INT16_MUL');
  assert.equal(Object.keys(ast.library).length, 3);
  const graph = project(ast),
    positions = autoLayout(graph);
  assert.equal(graph.sequential, true);
  assert.equal(graph.nodes.filter((n) => n.register).length, 7);
  assert.deepEqual(graph.clocks, [{ signal: 'clk', edge: 'posedge' }]);
  assert.equal(Object.keys(positions).length, graph.nodes.length);
  const alu = project(parse(design, 'ALU_INT16'));
  assert.equal(alu.sequential, false);
  assert.ok(alu.nodes.some((n) => n.label === 'REPEAT ×16'));
  for (const node of graph.nodes) assert.ok(Number.isFinite(positions[node.id].x));
  for (const [i, a] of graph.nodes.entries())
    for (const b of graph.nodes.slice(i + 1)) {
      const p = positions[a.id],
        q = positions[b.id];
      assert.ok(
        p.x + 172 <= q.x ||
          q.x + 172 <= p.x ||
          p.y + nodeHeight(a) <= q.y ||
          q.y + nodeHeight(b) <= p.y,
        `${a.key} overlaps ${b.key}`,
      );
    }
});

test('nonblocking assignments read old values, hold state, and reset asynchronously', () => {
  let state: SimulationState | undefined;
  const run = (clk: string, reset = '0', en = '1') => {
    const r = simulate(counter, 'counter', { clk, reset, en }, state);
    state = r.state;
    return r.signals;
  };
  assert.equal(run('0').q.value, '0bxxxxxxxx');
  assert.equal(run('0', '1').q.value, '0x00');
  assert.equal(run('0').q.value, '0x00');
  assert.equal(run('1').q.value, '0x01');
  assert.equal(run('1').q.value, '0x01');
  run('0');
  const second = run('1');
  assert.equal(second.q.value, '0x02');
  assert.equal(second.old.value, '0x01');
  run('0');
  assert.equal(run('1', '0', '0').q.value, '0x02');
  assert.equal(run('1', '1').q.value, '0x00');
});

test('last scheduled assignment wins and unknown if conditions take else', () => {
  const source = `module m(input clk,s,output reg [3:0] q);always @(negedge clk) begin q<=4'd1;if(s) q<=4'd2;q<=q+4'd1;end endmodule`;
  const initial: SimulationState = { registers: { q: '5' }, events: { clk: '1' } };
  assert.equal(simulate(source, 'm', { clk: '0', s: 'x' }, initial).signals.q.value, '0x6');
  const conditional = source.replace("q<=q+4'd1;", '');
  assert.equal(simulate(conditional, 'm', { clk: '0', s: 'x' }, initial).signals.q.value, '0x1');
});

test('reported iterative multiplier completes signed/unsigned operations after 16 clocks', () => {
  for (const signed of [false, true])
    for (const [a, b] of [
      [0, 9],
      [1, 65535],
      [32768, 65535],
      [65535, 65535],
      [123, 456],
      [32767, 32767],
    ]) {
      let state: SimulationState | undefined;
      const vector = {
        clk: '0',
        reset: '1',
        start: '0',
        signed_mode: String(+signed),
        OPm: String(a),
        OPn: String(b),
      };
      const run = () => {
        const r = simulate(design, 'INT16_MUL', vector, state);
        state = r.state;
        return r.signals;
      };
      const step = () => {
        vector.clk = '0';
        run();
        vector.clk = '1';
        return run();
      };
      run();
      vector.reset = '0';
      vector.start = '1';
      assert.equal(step().busy.value, '1');
      vector.start = '0';
      for (let i = 0; i < 15; i++) assert.equal(step().busy.value, '1');
      const result = step();
      const value = (n: number) => BigInt(signed && n >= 32768 ? n - 65536 : n);
      const expected = BigInt.asUintN(32, value(a) * value(b));
      assert.equal(
        result.result.value,
        '0x' + expected.toString(16).padStart(8, '0'),
        `${signed}:${a}*${b}`,
      );
      assert.equal(result.busy.value, '0');
      assert.equal(result.done.value, '1');
      assert.equal(step().done.value, '0');
      assert.equal(run().result.value, result.result.value);
    }
});

test('logical operators, signed nets and replication preserve widths and unknown bits', () => {
  const source = `module m(input [3:0] a,b,output [3:0] inv,output both,either,output [15:0] ext,output [7:0] repeated);
wire signed [3:0] s;assign s=a;assign inv=!a;assign both=a&&b;assign either=a||b;
assign ext=s;assign repeated={4{a[1:0]}};endmodule`;
  const r = simulate(source, 'm', { a: '0b10x1', b: '0' }).signals;
  assert.equal(r.inv.value, '0x0');
  assert.equal(r.both.value, '0');
  assert.equal(r.either.value, '1');
  assert.equal(r.ext.value, '0b11111111111110x1');
  assert.equal(r.repeated.value, '0bx1x1x1x1');
  assert.throws(() => parse(source.replace('{4{a[1:0]}}', '{4096{a}}')), /4096/);
});

test('unsupported clock forms and unsafe graph edits are refused without altering source', () => {
  for (const statement of [
    'always @(clk) q<=1;',
    'always @(posedge clk) q=1;',
    'always @(posedge clk) q[0]<=1;',
  ])
    assert.throws(() => parse(`module m(input clk,output reg q);${statement}endmodule`));
  const graph = project(parse(counter));
  assert.throws(
    () => sourceActionEdits(counter, { kind: 'create', component: 'wire', name: 'w', width: 1 }),
    /HDL editor/,
  );
  assert.throws(
    () => copyComponents(counter, graph, [graph.nodes.find((n) => n.label === 'q')!.id]),
    /Clocked registers/,
  );
  assert.throws(
    () => operatorPatch(counter, graph, graph.nodes.find((n) => n.op === '+')!.id, '-'),
    /HDL editor/,
  );
});

test('signed declarations and replicated expressions survive clipboard/proof replay', () => {
  const source = `module m(input signed [3:0] a,output [7:0] y);wire signed [3:0] s;assign s=a;assign y=s;endmodule`;
  const graph = project(parse(source));
  const items = copyComponents(
    source,
    graph,
    graph.nodes.filter((n) => ['a', 's', 'y'].includes(n.label)).map((n) => n.id),
  );
  const actions = [{ kind: 'paste' as const, items }];
  const result = planTransaction(source, actions);
  validateConstructionProof(source, result.edits(), actions);
  assert.equal(simulate(result.text, 'm', { a: '8', a_copy1: '8' }).signals.y_copy1.value, '0xf8');
});

test('separate clocked processes commit together and prototype-like names retain state', () => {
  const source = `module m(input constructor,reset,output reg [3:0] __proto__,output reg [3:0] old);
  always @(posedge constructor or posedge reset) if(reset) __proto__<=4'd0;else __proto__<=__proto__+4'd1;
  always @(posedge constructor or posedge reset) if(reset) old<=4'd0;else old<=__proto__;
  endmodule`;
  let state: SimulationState | undefined;
  const sample = (constructor: string, reset = '0') => {
    const r = simulate(source, 'm', { constructor, reset }, state);
    state = r.state;
    return r.signals;
  };
  assert.equal(sample('0').__proto__.value, '0bxxxx');
  sample('0', '1');
  sample('0');
  sample('1');
  sample('0');
  const result = sample('1');
  assert.equal(result.__proto__.value, '0x2');
  assert.equal(result.old.value, '0x1');
});
