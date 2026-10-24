// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, project, operatorPatch, validateEditableEdits } from '../packages/verilog/index.js';
import { simulate } from '../packages/verilog/simulation.js';
import {
  planTransaction,
  copyComponents,
  validateConstructionProof,
} from '../packages/verilog/construction.js';
import { operators, isComparison, type Operator } from '../packages/protocol/index.js';
const source = readFileSync('fixtures/alu-int16.v', 'utf8');
const apply = (s: string, e: { start: number; end: number; text: string }) =>
  s.slice(0, e.start) + e.text + s.slice(e.end);

test('user INT16 ALU projects every operation with scalar comparison selectors', () => {
  for (const text of [source, source.replaceAll('wire', 'logic')]) {
    const graph = project(parse(text, 'ALU_INT16'));
    assert.equal(graph.nodes.filter((n) => n.kind === 'mux').length, 13);
    for (const op of operators.filter((op) => !['<', '>', '>>>', '===', '!=='].includes(op)))
      assert(
        graph.nodes.some((n) => n.op === op),
        op,
      );
    for (const n of graph.nodes.filter((n) => n.op && isComparison(n.op))) {
      assert.equal(n.width, 1);
      assert.equal(n.operandWidths?.length, 2);
    }
    assert(!graph.issues?.some((i) => i.code === 'selector-width'));
    const not = graph.nodes.find((n) => n.op === '~')!;
    assert.equal(graph.edges.filter((e) => e.target === not.id).length, 1);
    assert(project(parse(text, 'ALU_FP16')).issues?.some((i) => i.code === 'undriven'));
  }
});

test('all ALU opcodes match an independent unsigned integer oracle', () => {
  for (const [a, b] of [
    [0, 0],
    [1, 1],
    [65535, 1],
    [32768, 15],
    [0x1234, 0xabcd],
    [255, 16],
    [65535, 65535],
  ]) {
    for (let opcode = 0; opcode < 16; opcode++) {
      const expected: Record<number, number> = {
        0: a + b,
        1: a - b,
        2: a & b,
        3: a ^ b,
        4: a | b,
        8: b >= 16 ? 0 : a * 2 ** b,
        9: b >= 16 ? 0 : Math.floor(a / 2 ** b),
        10: a * b,
        11: Number(a === b),
        12: ~a,
        13: Number(a !== b),
        14: Number(a >= b),
        15: Number(a <= b),
      };
      const result = simulate(source, 'ALU_INT16', {
        OPc: String(a),
        OPd: String(b),
        opcode: String(opcode),
      });
      assert.equal(
        BigInt(result.signals.result.value),
        BigInt((expected[opcode] ?? 0) & 65535),
        `${a}, ${b}, opcode ${opcode}`,
      );
    }
  }
});

test('Verilog precedence, context widths and unknown masks survive new operators', () => {
  const run = (expr: string, a = '15', b = '1', bits = 16) =>
    simulate(
      `module m(input [3:0] a,input [7:0] b,output [${bits - 1}:0] y);assign y=${expr};endmodule`,
      'm',
      { a, b },
    ).signals.y.value;
  assert.equal(run('a << 1 + 1'), '0x003c');
  assert.equal(run('~a'), '0xfff0');
  assert.equal(run('(a+b)==b', '15', '255'), '0x0000');
  assert.equal(run('(a+b)==b', '0', '255'), '0x0001');
  assert.equal(run("a << (b+8'd1)", '15', '255'), '0x000f');
  assert.equal(run("a & b == 8'd1"), '0x0001');
  assert.equal(run('a << b', 'x', '16'), '0x0000');
  assert.equal(run('~a', '0b1x00', '0', 4), '0b0x11');
  assert.equal(run('a << b', '0b1x00', '1', 4), '0bx000');
  assert.equal(run('a >> b', '0b1x00', '1', 4), '0b01x0');
  assert.equal(run('a == b', '0b1x00', '0', 1), '0');
  assert.equal(run('a == b', '0b0x00', '0', 1), 'x');
  assert.equal(run('a < b', 'x', '0', 1), 'x');
  assert.equal(run('a << b', '15', 'x', 4), '0bxxxx');
});

test('new operators construct, rewire, copy and produce independently replayable proofs', () => {
  let text = 'module m(input [7:0] a,b,output [7:0] y);assign y=a;endmodule';
  for (const [i, operator] of operators.entries()) {
    const actions = [
      {
        kind: 'create' as const,
        component: 'operation' as const,
        name: `op_${i}`,
        width: 8,
        operator,
      },
    ];
    const draft = planTransaction(text, actions);
    validateConstructionProof(text, draft.edits(), actions);
    text = draft.text;
  }
  let graph = project(parse(text));
  const not = graph.nodes.find((n) => n.op === '~')!,
    a = graph.nodes.find((n) => n.label === 'a')!;
  text = planTransaction(text, [
    { kind: 'connect', scope: 'm', target: not.key, source: a.key, port: 'left' },
  ]).text;
  assert.throws(
    () =>
      planTransaction(text, [
        { kind: 'connect', scope: 'm', target: not.key, source: a.key, port: 'right' },
      ]),
    /socket/,
  );
  graph = project(parse(text));
  const items = copyComponents(text, graph, [graph.nodes.find((n) => n.op === '~')!.id]);
  text = planTransaction(text, [{ kind: 'paste', scope: 'm', items }]).text;
  assert.equal(
    simulate(text, 'm', { a: '15', b: '0' }).signals[`${not.assignmentTarget}_copy1`].value,
    '0xf0',
  );
});

test('multi-character token edits preserve source and reject arity or precedence changes', () => {
  const text = 'module m(input [7:0] a,b,output y);assign y=(a <= b); // preserve\nendmodule';
  const graph = project(parse(text)),
    node = graph.nodes.find((n) => n.op === '<=')!;
  const edit = operatorPatch(text, graph, node.id, '!=');
  validateEditableEdits(text, [edit]);
  assert.equal(apply(text, edit), text.replace('<=', '!='));
  assert.throws(() => operatorPatch(text, graph, node.id, '~'), /input counts/);
  const precedence = 'module m(input [7:0] a,b,output y);assign y=a + b << a;endmodule';
  const g = project(parse(precedence));
  assert.throws(
    () => operatorPatch(precedence, g, g.nodes.find((n) => n.op === '<<')!.id, '*'),
    /precedence/,
  );
  const vhdl = readFileSync('fixtures/hierarchy.vhd', 'utf8');
  const vg = project(parse(vhdl));
  assert.throws(
    () => operatorPatch(vhdl, vg, vg.nodes.find((n) => n.op)!.id, '<<' as Operator),
    /VHDL/,
  );
});
