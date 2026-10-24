// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, project, operatorPatch, validateEditableEdits } from '../packages/verilog/index.js';
import { simulate } from '../packages/verilog/simulation.js';
import {
  copyComponents,
  planTransaction,
  validateConstructionProof,
} from '../packages/verilog/construction.js';

const source = (expr: string, outputWidth = 16) =>
  `module m(input [15:0] a,b,input s,output [${outputWidth - 1}:0] y);assign y=${expr};endmodule`;
const run = (expr: string, a = '32768', b = '1', width = 16) =>
  simulate(source(expr, width), 'm', { a, b, s: '0' }).signals.y.value;

test('signed casts compare two-complement values and preserve unsigned comparisons', () => {
  assert.equal(run('$signed(a) >= $signed(b)'), '0x0000');
  assert.equal(run('$signed(a) <= $signed(b)'), '0x0001');
  assert.equal(run('$signed(a) < $signed(b)', '65535', '32768'), '0x0000');
  assert.equal(run('$signed(a) >= b'), '0x0001');
  assert.equal(run('$signed(a) == $signed(b)', '65535', '65535'), '0x0001');
  assert.equal(run('$signed(a)', '32768', '0', 32), '0xffff8000');
  assert.equal(run('$unsigned($signed(a))', '32768', '0', 32), '0x00008000');
});

test('arithmetic shifts match signedness, assignment width, and unknown sign bits', () => {
  assert.equal(run('$signed(a) >>> b'), '0xc000');
  assert.equal(run('a >>> b'), '0x4000');
  assert.equal(run('$signed(a) >> b'), '0x4000');
  assert.equal(run('$signed(a) >>> b', '32768', '16'), '0xffff');
  assert.equal(run('$signed(a) >>> b', '32768', '65535'), '0xffff');
  assert.equal(run('$signed(a) >>> b', '32767', '16'), '0x0000');
  assert.equal(run('$signed(a) >>> b', '32768', '1', 32), '0xffffc000');
  assert.equal(run('$signed(a) >>> b', '0b1x00', '1'), '0b00000000000001x0'); // input is zero padded to 16 bits
  assert.equal(run('$signed(a) >>> b', '0bx000000000000001', '16'), '0bxxxxxxxxxxxxxxxx');
  assert.equal(run('$signed(a) >>> b', '32768', 'x'), '0bxxxxxxxxxxxxxxxx');
});

test('unsigned mux coercion is visible and cast barriers isolate the signed shift', () => {
  const text = source("s ? 16'b0 : ($signed(a) >>> b)");
  assert.equal(run("s ? 16'b0 : ($signed(a) >>> b)"), '0x4000');
  assert.equal(run("s ? 16'b0 : $unsigned($signed(a) >>> b)"), '0xc000');
  const graph = project(parse(text));
  const shift = graph.nodes.find((n) => n.op === '>>>')!;
  assert.equal(shift.signed, false);
  assert(graph.issues!.some((i) => i.nodeKey === shift.key && i.code === 'unsigned-shift'));
  assert.equal(simulate(text, 'm', { a: '32768', b: '1', s: '0' }).nodes[shift.key], '0x4000');
  const isolated = project(parse(source("s ? 16'b0 : $unsigned($signed(a) >>> b)")));
  assert.equal(isolated.nodes.find((n) => n.op === '>>>')!.signed, true);
  assert(!isolated.issues!.some((i) => i.code === 'unsigned-shift'));
});

test('signed casts have one rewiring socket and survive clipboard and guarded operator edits', () => {
  const text = source('$signed(a) >>> b');
  const graph = project(parse(text));
  const cast = graph.nodes.find((n) => n.kind === 'convert')!;
  const b = graph.nodes.find((n) => n.label === 'b')!;
  const actions = [
    { kind: 'connect' as const, target: cast.key, source: b.key, port: 'left' as const },
  ];
  const draft = planTransaction(text, actions);
  validateConstructionProof(text, draft.edits(), actions);
  assert(draft.text.includes('$signed(b) >>> b'));
  assert.throws(() => planTransaction(text, [{ ...actions[0], port: 'right' }]), /socket/);
  const shift = graph.nodes.find((n) => n.op === '>>>')!;
  const patch = operatorPatch(text, graph, shift.id, '>>');
  validateEditableEdits(text, [patch]);
  assert.throws(
    () => operatorPatch(text.replace('$signed', '$unsigned'), graph, shift.id, '>>'),
    /Operands changed/,
  );
  const items = copyComponents(text, graph, [graph.nodes.find((n) => n.label === 'y')!.id]);
  const copied = planTransaction(text, [{ kind: 'paste', items }]).text;
  assert.equal(
    simulate(copied, 'm', { a: '32768', b: '1', s: '0' }).signals.y_copy1.value,
    '0xc000',
  );
  assert.throws(() => parse(source('$signed(a,b)')), /Expected/);
  assert.throws(() => parse(source('$display(a)')), /Unsupported token/);
  assert.throws(() => parse(source('$signedBad(a)')), /Unsupported token/);
});

test('SystemVerilog procedural copies preserve signed cast boundaries', () => {
  const text = `module m(input logic [7:0] a,b,input logic s,output logic [7:0] y);
    always_comb begin if(s) y=$signed(a) >>> b; else y=$unsigned($signed(a) >>> b); end
    endmodule`;
  const graph = project(parse(text));
  const items = copyComponents(text, graph, [
    graph.nodes.find((n) => n.assignmentTarget === 'y')!.id,
  ]);
  const copied = planTransaction(text, [{ kind: 'paste', items }]).text;
  for (const s of ['0', '1', 'x']) {
    const result = simulate(copied, 'm', { a: '128', b: '1', s });
    assert.equal(result.signals.y.value, '0xc0');
    assert.equal(result.signals.y_copy1.value, result.signals.y.value);
  }
  const wide = text.replace('[7:0] y', '[15:0] y');
  const wideGraph = project(parse(wide));
  const wideCopy = planTransaction(wide, [
    {
      kind: 'paste',
      items: copyComponents(wide, wideGraph, [
        wideGraph.nodes.find((n) => n.assignmentTarget === 'y')!.id,
      ]),
    },
  ]).text;
  for (const s of ['0', '1', 'x']) {
    const result = simulate(wideCopy, 'm', { a: '128', b: '1', s });
    assert.equal(result.signals.y.value, s === '1' ? '0xffc0' : '0x00c0');
    assert.equal(result.signals.y_copy1.value, result.signals.y.value);
    const partial = simulate(wideCopy, 'm', { a: '0b1x000000', b: '1', s });
    assert.equal(partial.signals.y_copy1.value, partial.signals.y.value);
    assert(!/^0bx+$/.test(partial.signals.y.value));
  }
});

test('reported three signed ALU arms project and retain the last valid module interface', () => {
  const text = readFileSync('fixtures/alu-int16-signed.v', 'utf8');
  for (const source of [text, text.replaceAll('wire', 'logic')]) {
    const graph = project(parse(source, 'ALU_INT16'));
    assert.equal(graph.nodes.filter((n) => n.kind === 'mux').length, 16);
    assert.equal(graph.nodes.filter((n) => n.kind === 'convert').length, 5);
    assert.equal(
      simulate(source, 'ALU_INT16', { OPc: '32768', OPd: '1', opcode: '5' }).signals.result.value,
      '0x0000',
    );
    assert.equal(
      simulate(source, 'ALU_INT16', { OPc: '32768', OPd: '1', opcode: '6' }).signals.result.value,
      '0x0001',
    );
    assert.equal(
      simulate(source, 'ALU_INT16', { OPc: '32768', OPd: '1', opcode: '7' }).signals.result.value,
      '0x4000',
    );
  }
});

test('procedural arms keep assignment width independent of the other branch', () => {
  const text = `module m(input logic [7:0] a,b,input logic s,output logic [7:0] y);
    always_comb begin if(s) y=$signed(a)>>b;else y=32'd0;end
    endmodule`;
  const graph = project(parse(text));
  assert.equal(graph.nodes.find((n) => n.op === '>>')!.width, 8);
  const items = copyComponents(text, graph, [
    graph.nodes.find((n) => n.assignmentTarget === 'y')!.id,
  ]);
  const copied = planTransaction(text, [{ kind: 'paste', items }]).text;
  for (const s of ['0', '1', 'x']) {
    const result = simulate(copied, 'm', { a: '128', b: '9', s });
    assert.equal(result.signals.y.value, '0x00');
    assert.equal(result.signals.y_copy1.value, result.signals.y.value);
  }
});
