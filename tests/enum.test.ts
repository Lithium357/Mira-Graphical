// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, project, graphPatch, validateEditableEdits } from '../packages/verilog/index.js';
import { simulate, type SimulationState } from '../packages/verilog/simulation.js';
import {
  copyComponents,
  planTransaction,
  validateConstructionProof,
} from '../packages/verilog/construction.js';

const fsm = readFileSync('fixtures/enum-fsm.sv', 'utf8');
test('enum FSMs preserve named states and execute reset, transitions, holds and outputs', () => {
  const ast = parse(fsm),
    graph = project(ast);
  assert.equal(ast.nets.find((n) => n.name === 'state')?.width, 2);
  for (const label of ['IDLE', 'RUN', 'DONE']) {
    const constants = graph.nodes.filter((n) => n.label === label);
    assert(constants.length > 0);
    assert(constants.every((n) => n.kind === 'literal' && n.editable === false && n.width === 2));
  }
  let state: SimulationState | undefined;
  const sample = (
    clk: string,
    reset: string,
    start: string,
    finish: string,
    code: string,
    busy: string,
    done: string,
  ) => {
    const r = simulate(fsm, 'enum_fsm', { clk, reset, start, finish }, state);
    state = r.state;
    assert.equal(r.signals.state_code.value, code);
    assert.equal(r.signals.busy.value, busy);
    assert.equal(r.signals.done.value, done);
  };
  sample('0', '1', '0', '0', '0x0', '0', '0');
  sample('0', '0', '1', '0', '0x0', '0', '0');
  sample('1', '0', '1', '0', '0x1', '1', '0');
  sample('0', '0', '1', '0', '0x1', '1', '0');
  sample('1', '0', '1', '0', '0x1', '1', '0');
  sample('0', '0', '1', '1', '0x1', '1', '0');
  sample('1', '0', '1', '1', '0x3', '0', '1');
  sample('0', '0', '0', '0', '0x3', '0', '1');
  sample('1', '0', '0', '0', '0x0', '0', '0');
  sample('1', '1', '1', '1', '0x0', '0', '0');
});

test('default int enums, explicit signed encodings and copied constants preserve sign extension', () => {
  for (const declaration of [
    'typedef enum { NEG=-1, ZERO, POS } mode_t; mode_t mode;',
    "enum logic signed [1:0] { NEG=2'b11, ZERO, POS } mode;",
  ]) {
    const source = `module m(input clk,reset,output wire [63:0] y);${declaration} always_ff @(posedge clk or posedge reset) if(reset)mode<=NEG;else mode<=ZERO;assign y=NEG;endmodule`;
    assert.equal(
      simulate(source, 'm', { clk: '0', reset: '1' }).signals.y.value,
      '0xffffffffffffffff',
    );
    const graph = project(parse(source));
    const items = copyComponents(source, graph, [graph.nodes.find((n) => n.kind === 'output')!.id]);
    const draft = planTransaction(source, [{ kind: 'paste', items }]);
    validateConstructionProof(source, draft.edits(), [{ kind: 'paste', items }]);
    assert.equal(
      simulate(draft.text, 'm', { clk: '0', reset: '1' }).signals.y_copy1.value,
      '0xffffffffffffffff',
    );
  }
});

test('enum types and members are scoped per module, including prototype-like names', () => {
  const source = `module a(output [1:0] y);typedef enum logic[1:0]{constructor=1,toString}__proto__;assign y=toString;endmodule
module b(output [2:0] y);typedef enum logic[2:0]{constructor=4,toString}__proto__;assign y=toString;endmodule`;
  assert.equal(simulate(source, 'a', {}).signals.y.value, '0x2');
  assert.equal(simulate(source, 'b', {}).signals.y.value, '0x5');
});

test('named case choices and enum registers retain independent instance state', () => {
  const source = `module child(input clk,reset,go,output wire [1:0] code);
    enum logic[1:0] {IDLE,RUN,DONE} state;
    always_ff @(posedge clk or posedge reset)
      if(reset) state<=IDLE; else case(state)
        IDLE,RUN: if(go) state<=DONE;
        DONE: state<=IDLE;
        default: state<=IDLE;
      endcase
    assign code=state; endmodule
    module top(input clk,reset,go,output [1:0] a,b);
      child first(.clk(clk),.reset(reset),.go(go),.code(a));
      child second(.clk(clk),.reset(reset),.go(1'b0),.code(b)); endmodule`;
  let state: SimulationState | undefined;
  for (const [clk, reset, a, b] of [
    ['0', '1', '0x0', '0x0'],
    ['0', '0', '0x0', '0x0'],
    ['1', '0', '0x2', '0x0'],
    ['0', '0', '0x2', '0x0'],
    ['1', '0', '0x0', '0x0'],
  ]) {
    const result = simulate(source, 'top', { clk, reset, go: '1' }, state);
    state = result.state;
    assert.equal(result.signals.a.value, a);
    assert.equal(result.signals.b.value, b);
  }
});

test('enum declarations reject overflowing, duplicate, unknown and mismatched encodings', () => {
  for (const declaration of [
    'typedef enum logic[0:0]{A,B,C} t;',
    'typedef enum logic[1:0]{A=4} t;',
    'typedef enum logic[1:0]{A=0,B=0} t;',
    "typedef enum logic[1:0]{A=3'b001} t;",
    "typedef enum logic[1:0]{A=2'bxx} t;",
    'typedef enum logic[1:0]{A=-1} t;',
    'typedef enum logic[1:0]{A,A} t;',
    'typedef enum logic[4096:0]{A} t;',
    'typedef enum bit[1:0]{A} t;',
  ])
    assert.throws(() => parse(`module m();${declaration}endmodule`), /./, declaration);
});

test('enum assignments reject numeric coercions and unrelated enum types', () => {
  for (const rhs of ["2'd0", 'OTHER', 'raw', 'state+1']) {
    const source = `module m(input clk,input [1:0] raw);typedef enum logic[1:0]{IDLE,RUN} t;t state;typedef enum logic[1:0]{OTHER} u;always_ff @(posedge clk)state<=${rhs};endmodule`;
    assert.throws(() => parse(source), /same enum type/);
  }
  assert.doesNotThrow(() =>
    parse(fsm.replace('state <= next_state', 'state <= start ? RUN : IDLE')),
  );
});

test('named enum uses are immutable graph tokens and names cannot be reused by construction', () => {
  const graph = project(parse(fsm)),
    named = graph.nodes.find((n) => n.label === 'IDLE')!;
  assert.throws(() => graphPatch(fsm, graph, named.id, { kind: 'literal', value: "2'd2" }), /enum/);
  const offset = fsm.indexOf('state <= IDLE') + 'state <= '.length;
  assert.throws(
    () => validateEditableEdits(fsm, [{ start: offset, end: offset + 4, text: "2'd2" }]),
    /supported editable/,
  );
  assert.throws(
    () => planTransaction(fsm, [{ kind: 'create', component: 'wire', name: 'RUN', width: 2 }]),
    /already exists/,
  );
  assert.throws(
    () => parse(fsm.replace('state_t state, next_state;', 'state_t state, next_state; wire IDLE;')),
    /Duplicate/,
  );
});
