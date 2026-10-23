// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, project } from '../packages/verilog/index.js';
import { PatchDraft } from '../packages/verilog/patches.js';
import {
  sourceActionEdits,
  planTransaction,
  validateConstructionProof,
} from '../packages/verilog/construction.js';
import type { SourceAction } from '../packages/protocol/index.js';
const source = readFileSync('fixtures/adder.v', 'utf8');
const step = (text: string, action: SourceAction) => {
  const d = new PatchDraft(text);
  d.apply(sourceActionEdits(text, action));
  return d.text;
};
test('piece table composes nested edits into minimal original spans', () => {
  const d = new PatchDraft('abc def ghi');
  d.apply([{ start: 4, end: 7, text: 'XYZ' }]);
  d.apply([{ start: 5, end: 6, text: '!' }]);
  assert.equal(d.text, 'abc X!Z ghi');
  assert.deepEqual(d.edits(), [{ start: 4, end: 7, text: 'X!Z' }]);
  const undo = d.clone();
  undo.apply([{ start: 4, end: 7, text: 'def' }]);
  assert.deepEqual(undo.edits(), []);
});
test('create every supported component from an empty module with exact local insertions', () => {
  let text = 'module blank();\r\nendmodule\r\n';
  for (const action of [
    { kind: 'create', component: 'input', name: 'a', width: 8 },
    { kind: 'create', component: 'output', name: 'y', width: 8 },
    { kind: 'create', component: 'operation', name: 'product', width: 8, operator: '*' },
    { kind: 'create', component: 'constant', name: 'constant', width: 8, value: "8'h0F" },
    { kind: 'create', component: 'mux', name: 'choice', width: 8 },
    { kind: 'create', component: 'slice', name: 'low', width: 4, source: 'a', range: '[3:0]' },
    { kind: 'create', component: 'wire', name: 'spare', width: 8 },
  ] as SourceAction[]) {
    text = step(text, action);
    project(parse(text));
  }
  assert(text.includes("assign product = 8'd0 * 8'd0;"));
  assert(!text.replaceAll('\r\n', '').includes('\n'));
  assert.equal(parse(text).nets.length, 7);
});
test('port insertion preserves comments and inherited declarations', () => {
  const text =
    'module m(\n    input wire a, b, // both inputs\n    output y // output comment\n);\nassign y=a;\nendmodule';
  const next = step(text, { kind: 'create', component: 'input', name: 'c', width: 4 });
  assert(next.includes('output y, // output comment'));
  assert(next.includes('input wire a, b, // both inputs'));
  assert.equal(parse(next).nets.find((n) => n.name === 'b')!.direction, 'input');
  assert.equal(parse(next).nets.find((n) => n.name === 'c')!.width, 4);
});
test('wire new operations and outputs; replay proves a compound patch', () => {
  const actions: SourceAction[] = [
    { kind: 'create', component: 'operation', name: 'product', width: 8, operator: '*' },
    { kind: 'connect', source: 'adder/net/a', target: 'adder/assign/product/expr', port: 'left' },
    { kind: 'connect', source: 'adder/net/b', target: 'adder/assign/product/expr', port: 'right' },
    { kind: 'connect', source: 'adder/assign/product/expr', target: 'adder/net/sum', port: 'left' },
  ];
  const draft = planTransaction(source, actions);
  assert(draft.text.includes('assign product = a * b;'));
  assert(draft.text.includes('assign sum = product;'));
  assert(draft.text.includes('// Preserve this comment.'));
  assert(draft.edits().every((e) => e.end - e.start < source.length / 2));
  validateConstructionProof(source, draft.edits(), actions);
  assert.throws(
    () =>
      validateConstructionProof(
        source,
        [{ start: 0, end: source.length, text: draft.text }],
        actions,
      ),
    /match/,
  );
});
test('rewiring uses parentheses-inclusive spans and refuses comment loss', () => {
  const text = source.replace('a + b', '(a + b) * (a + b)');
  const next = step(text, {
    kind: 'connect',
    source: 'adder/net/a',
    target: 'adder/assign/sum/expr',
    port: 'right',
  });
  assert(next.includes('(a + b) * a'));
  assert.throws(
    () =>
      step(text.replace('(a + b)', '(a /* keep */ + b)'), {
        kind: 'connect',
        source: 'adder/net/a',
        target: 'adder/assign/sum/expr',
        port: 'left',
      }),
    /comment/,
  );
});
test('cycles, bad names, duplicate nets, bad ports and output feedback are refused', () => {
  for (const name of ['a', 'if', 'or', 'hello;endmodule'])
    assert.throws(() => step(source, { kind: 'create', component: 'wire', name, width: 8 }));
  assert.throws(
    () =>
      step(source, {
        kind: 'connect',
        source: 'adder/net/sum',
        target: 'adder/assign/sum/expr',
        port: 'left',
      }),
    /cycles/,
  );
  assert.throws(
    () =>
      step(source, { kind: 'connect', source: 'adder/net/b', target: 'adder/net/a', port: 'left' }),
    /Inputs/,
  );
  assert.throws(
    () =>
      step(source, {
        kind: 'connect',
        source: 'adder/net/a',
        target: 'adder/assign/sum/expr',
        port: 'select',
      }),
    /socket/,
  );
});
test('disconnect drivers leaves visibly undriven nets; deleting live results is refused', () => {
  let text = step(source, {
    kind: 'create',
    component: 'operation',
    name: 'product',
    width: 8,
    operator: '*',
  });
  text = step(text, {
    kind: 'connect',
    source: 'adder/net/product',
    target: 'adder/assign/sum/expr',
    port: 'left',
  });
  assert.throws(() => step(text, { kind: 'remove', target: 'adder/net/product' }), /still wired/);
  const next = step(text, { kind: 'disconnect', target: 'adder/net/product' });
  assert(project(parse(next)).nodes.find((n) => n.label === 'product')!.undriven);
  const unused = step(source, {
    kind: 'create',
    component: 'operation',
    name: 'unused',
    width: 8,
    operator: '*',
  });
  const deleted = step(unused, { kind: 'remove', target: 'adder/assign/unused/expr' });
  assert(!parse(deleted).nets.some((n) => n.name === 'unused'));
  assert.equal(parse(deleted).assigns.length, 1);
});
test('explicit input tie-offs preserve valid source and reject destructive shared-declaration deletion', () => {
  const next = step(source, { kind: 'zero', target: 'adder/assign/sum/expr', port: 'right' });
  assert(next.includes("a + 8'd0"));
  assert.throws(
    () => step('module m();wire a,b;endmodule', { kind: 'remove', target: 'm/net/a' }),
    /shares/,
  );
});

test('mux wiring enforces scalar selectors and fixed slices retain their bounds', () => {
  const text = 'module m(input [7:0] a,input s,output [7:0] y);assign y=a;endmodule';
  const created = step(text, { kind: 'create', component: 'mux', name: 'choice', width: 8 });
  assert.throws(
    () =>
      step(created, {
        kind: 'connect',
        source: 'm/net/a',
        target: 'm/assign/choice/expr/mux',
        port: 'select',
      }),
    /scalar/,
  );
  const wired = step(created, {
    kind: 'connect',
    source: 'm/net/s',
    target: 'm/assign/choice/expr/mux',
    port: 'select',
  });
  assert(wired.includes("s ? 8'd0 : 8'd0"));
  assert.throws(
    () => step(wired, { kind: 'zero', target: 'm/assign/choice/expr/mux', port: 'bad' as any }),
    /socket/,
  );
  assert.throws(
    () =>
      step(text, {
        kind: 'create',
        component: 'slice',
        name: 'invalid',
        width: 8,
        source: 'a',
        range: '[8:0]',
      }),
    /out of range/,
  );
});
