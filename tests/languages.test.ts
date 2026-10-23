// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, project, graphPatch, validateEditableEdits } from '../packages/verilog/index.js';
import { simulate } from '../packages/verilog/simulation.js';
import {
  sourceActionEdits,
  planTransaction,
  validateConstructionProof,
  copyComponents,
} from '../packages/verilog/construction.js';
import { PatchDraft } from '../packages/verilog/patches.js';
import { exportVhdlModule } from '../packages/vhdl/index.js';
import type { SourceAction } from '../packages/protocol/index.js';
import { Session, hash } from '../packages/core/index.js';
import { applyLivePatch } from '../extensions/vscode/patch.js';
const apply = (source: string, action: SourceAction) => {
  const draft = new PatchDraft(source);
  draft.apply(sourceActionEdits(source, action));
  return draft.text;
};
const sv = readFileSync('fixtures/hierarchy.sv', 'utf8'),
  vhdl = readFileSync('fixtures/hierarchy.vhd', 'utf8');

test('VHDL created multiplication selects the operand operation inside its result resize', () => {
  let job = () => {};
  const session = new Session(
    'file:///hierarchy.vhdl',
    1,
    vhdl,
    { publish() {}, patch() {}, recover() {}, persist() {} },
    {
      now: () => 15000,
      set(fn) {
        job = fn;
        return 1;
      },
      clear() {},
    },
  );
  job();
  session.selectModule('arithmetic');
  const created = session.circuitAction({
    kind: 'create',
    component: 'operation',
    name: 'Probe',
    width: 8,
    operator: '*',
  });
  assert(created.selectedId);
  assert.equal(
    session.state.previewGraph!.nodes.find((n) => n.id === created.selectedId)!.kind,
    'op',
  );
  for (const [name, port] of [
    ['a', 'left'],
    ['b', 'right'],
  ] as const)
    session.circuitAction({
      kind: 'connect',
      source: session.state.previewGraph!.nodes.find((n) => n.label === name)!.id,
      target: created.selectedId,
      port,
    });
  assert.equal(session.simulate({ a: '255', b: '2' }).signals.probe.value, '0xfe');
  session.discardGraphChanges();
});

test('native VHDL literal editing and guarded live-buffer construction reject forged proofs', async () => {
  let text = '-- unsaved 🧪\r\n' + vhdl;
  const transaction: SourceAction[] = [
    {
      kind: 'create',
      scope: 'arithmetic',
      component: 'constant',
      name: 'fixed',
      width: 8,
      value: 'x"A5"',
    },
  ];
  const draft = planTransaction(text, transaction);
  const patch = { baseVersion: 7, baseHash: hash(text), edits: draft.edits(), transaction };
  let calls = 0;
  const doc = {
    text: () => text,
    version: () => 7,
    apply: async (edits: import('../packages/protocol/index.js').Edit[]) => {
      calls++;
      for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);
      return true;
    },
  };
  assert(!(await applyLivePatch(doc, { ...patch, transaction: [] }, hash)).ok);
  assert.equal(calls, 0);
  assert((await applyLivePatch(doc, patch, hash)).ok);
  const graph = project(parse(text, 'arithmetic'));
  const constant = graph.nodes.find((n) => n.assignmentTarget === 'fixed')!;
  const edit = graphPatch(text, graph, constant.id, { kind: 'literal', value: 'x"2A"' });
  validateEditableEdits(text, [edit]);
  text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  assert.equal(simulate(text, 'arithmetic', { a: '1', b: '2' }).signals.fixed.value, '0x2a');
});

test('VHDL rejects function qualification that is not native type qualification', () => {
  assert.throws(() => parse(vhdl.replace('a + b', "to_unsigned'(3, 8)")), /qualify/);
  assert.throws(() => parse(vhdl.replace('a + b', "(a when '1' = '1' else b)")), /conditional/);
});

test('native procedural mux drivers can be replaced by a direct wire without leaving branch syntax', () => {
  for (const source of [sv, vhdl]) {
    const wired = apply(source, {
      kind: 'connect',
      scope: 'workbench',
      source: 'workbench/net/b',
      target: 'workbench/net/result',
      port: 'left',
    });
    assert.equal(
      simulate(wired, 'workbench', { a: '9', b: '3', select_b: '1' }).signals.result.value,
      '0x03',
    );
    const graph = project(parse(source, 'workbench'));
    const mux = graph.nodes.find((n) => n.kind === 'mux' && n.assignmentTarget === 'result')!;
    const tied = apply(source, { kind: 'zero', scope: 'workbench', target: mux.key });
    assert.equal(
      simulate(tied, 'workbench', { a: '9', b: '3', select_b: '1' }).signals.result.value,
      '0x00',
    );
  }
});
test('SystemVerilog logic, always_comb and named hierarchy project and simulate', () => {
  assert.equal(parse(sv).language, 'systemverilog');
  assert(project(parse(sv, 'workbench')).nodes.some((n) => n.kind === 'instance'));
  const result = simulate(sv, 'workbench', { a: '2', b: '3', select_b: '1' });
  assert.equal(result.signals.result.value, '0x05');
  assert.equal(result.signals.joined.value, '0x0203');
});
test('VHDL entities, unsigned arithmetic, concatenation, processes and hierarchy simulate', () => {
  assert.equal(parse(vhdl).language, 'vhdl');
  const result = simulate(vhdl, 'workbench', { a: '255', b: '2', select_b: '1' });
  assert.equal(result.signals.result.value, '0x01');
  assert.equal(result.signals.product.value, '0x01fe');
  assert.equal(result.signals.joined.value, '0xff02');
});
test('VHDL operator patches use native spans and editor-side validation', () => {
  const graph = project(parse(vhdl, 'arithmetic')),
    op = graph.nodes.find((n) => n.kind === 'op')!;
  const edit = graphPatch(vhdl, graph, op.id, { kind: 'operator', value: '-' });
  assert.equal(vhdl.slice(edit.start, edit.end), '+');
  validateEditableEdits(vhdl, [edit]);
});
test('SystemVerilog fill literals receive context but concatenations stay self-determined', () => {
  const source = `module fills(input logic a, output logic [7:0] ones, zeroes, output logic [1:0] pair); assign ones = '1; assign zeroes = '0; assign pair = {'1, a}; endmodule`;
  const result = simulate(source, 'fills', { a: '0' });
  assert.equal(result.signals.ones.value, '0xff');
  assert.equal(result.signals.zeroes.value, '0x00');
  assert.equal(result.signals.pair.value, '0x2');
});
test('SystemVerilog rejects latches, clocked blocks, multiple drivers and procedural read-order dependencies', () => {
  for (const body of [
    'always_ff result = a;',
    'always_comb if (a) result = b;',
    'always_comb begin result = a; result = b; end',
    'always_comb begin temp = a; result = temp; end',
  ]) {
    assert.throws(() =>
      parse(`module m(input logic a,b, output logic result); logic temp; ${body} endmodule`),
    );
  }
  assert.throws(() =>
    parse('module m(input logic a, output wire y); always_comb y = a; endmodule'),
  );
});
test('SystemVerilog procedural muxes can be copied as expressions and rewired with replay proofs', () => {
  let source = sv;
  const graph = project(parse(source, 'workbench')),
    mux = graph.nodes.find((n) => n.kind === 'mux')!;
  const items = copyComponents(source, graph, [mux.id]);
  assert(!items[0].expression!.includes(';'));
  source = apply(source, { kind: 'paste', scope: 'workbench', items });
  assert(parse(source, 'workbench').nets.some((n) => n.name === 'result_copy1'));
  const draft = planTransaction(sv, [
    {
      kind: 'change',
      scope: 'arithmetic',
      target: 'arithmetic/assign/result/expr',
      change: { kind: 'operator', value: '*' },
    },
  ]);
  validateConstructionProof(sv, draft.edits(), [
    {
      kind: 'change',
      scope: 'arithmetic',
      target: 'arithmetic/assign/result/expr',
      change: { kind: 'operator', value: '*' },
    },
  ]);
  assert.equal(simulate(draft.text, 'arithmetic', { a: '2', b: '3' }).signals.result.value, '0x06');
});
test('VHDL names are case-insensitive and duplicate/signed/clocked/incomplete designs are rejected', () => {
  assert.equal(
    parse(vhdl.replace('result <= a + b', 'RESULT <= A + B'), 'ARITHMETIC').name,
    'arithmetic',
  );
  assert.throws(() => parse(vhdl.replace('signal sum :', 'signal A :')));
  assert.throws(() => parse(vhdl.replaceAll('unsigned(', 'signed(')));
  assert.throws(() => parse(vhdl.replace('process(all)', 'process(select_b)')));
  assert.throws(() => parse(vhdl.replace('else\n            result <= a;', '')));
  assert.throws(() => parse(vhdl.replace('end entity arithmetic;', 'end entity wrong;')));
});
test('VHDL arithmetic widths, casts, resize and ascending slices follow native rules', () => {
  const source = `library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
entity m is port(a,b:in std_logic_vector(0 to 7); y:out unsigned(7 downto 0); p:out unsigned(15 downto 0); bit_value:out std_logic; chunk:out std_logic_vector(0 to 3)); end entity;
architecture rtl of m is begin
y <= resize(unsigned(a) * unsigned(b), 8); p <= unsigned(a) * unsigned(b); bit_value <= a(0); chunk <= a(0 to 3);
end architecture;`;
  const result = simulate(source, 'm', { a: '129', b: '3' });
  assert.equal(result.signals.y.value, '0x83');
  assert.equal(result.signals.p.value, '0x0183');
  assert.equal(result.signals.bit_value.value, '1');
  assert.equal(result.signals.chunk.value, '0x8');
  assert(project(parse(source)).nodes.some((n) => n.kind === 'convert' && n.label === 'RESIZE'));
  assert.throws(
    () =>
      parse(source.replace('resize(unsigned(a) * unsigned(b), 8)', 'unsigned(a) * unsigned(b)')),
    /width/,
  );
  assert.throws(() => parse(source.replace('unsigned(a) * unsigned(b)', 'a * b')), /unsigned/);
  assert.throws(() => parse(source.replace('a(0 to 3)', 'a(3 downto 0)')), /direction|bounds/);
  assert.throws(() => parse(source.replace('unsigned(a)', 'unsigned("00000001")')), /Qualify/);
});
test('VHDL construction emits declarations, ports, operations, joins, slices and split statements in native syntax', () => {
  let source = vhdl;
  const actions: SourceAction[] = [
    {
      kind: 'create',
      scope: 'workbench',
      component: 'operation',
      name: 'new_sum',
      width: 8,
      operator: '+',
    },
    {
      kind: 'create',
      scope: 'workbench',
      component: 'constant',
      name: 'constant_value',
      width: 8,
      value: "8'h2A",
    },
    {
      kind: 'create',
      scope: 'workbench',
      component: 'concat',
      name: 'joined_again',
      width: 16,
      parts: ['a', 'b'],
    },
    {
      kind: 'create',
      scope: 'workbench',
      component: 'slice',
      name: 'low_bits',
      width: 4,
      source: 'a',
      range: '[3:0]',
    },
    {
      kind: 'create',
      scope: 'workbench',
      component: 'split',
      name: 'parts',
      width: 4,
      source: 'a',
    },
    { kind: 'create', scope: 'workbench', component: 'input', name: 'extra_input', width: 1 },
    { kind: 'create', scope: 'workbench', component: 'output', name: 'extra_output', width: 8 },
    { kind: 'create', scope: 'workbench', component: 'mux', name: 'selected_value', width: 8 },
    {
      kind: 'connect',
      scope: 'workbench',
      source: 'workbench/net/a',
      target: 'workbench/assign/new_sum/expr',
      port: 'left',
    },
    {
      kind: 'connect',
      scope: 'workbench',
      source: 'workbench/net/b',
      target: 'workbench/assign/new_sum/expr',
      port: 'right',
    },
  ];
  const draft = planTransaction(source, actions);
  validateConstructionProof(source, draft.edits(), actions);
  source = draft.text;
  assert(source.includes('signal new_sum : unsigned(7 downto 0);'));
  assert(source.includes('extra_input : in std_logic'));
  assert(!source.includes('assign new_sum'));
  const result = simulate(source, 'workbench', {
    a: '18',
    b: '3',
    select_b: '0',
    extra_input: '1',
  });
  assert.equal(result.signals.new_sum.value, '0x15');
  assert.equal(result.signals.parts_0.value, '0x2');
  assert.equal(result.signals.parts_1.value, '0x1');
  assert.equal(result.signals.constant_value.value, '0x2a');
});
test('VHDL reusable entity creation, instance ports, native clipboard and same-language imports work', () => {
  let source = apply(vhdl, { kind: 'module', name: 'blank' });
  source = apply(source, {
    kind: 'create',
    scope: 'blank',
    component: 'input',
    name: 'a',
    width: 8,
  });
  source = apply(source, {
    kind: 'create',
    scope: 'blank',
    component: 'output',
    name: 'result',
    width: 8,
  });
  source = apply(source, {
    kind: 'connect',
    scope: 'blank',
    source: 'blank/net/a',
    target: 'blank/net/result',
    port: 'left',
  });
  source = apply(source, {
    kind: 'create',
    scope: 'workbench',
    component: 'instance',
    name: 'another',
    width: 8,
    moduleName: 'arithmetic',
  });
  const graph = project(parse(source, 'workbench')),
    instance = graph.nodes.find((n) => n.label === 'another')!;
  const items = copyComponents(source, graph, [instance.id]);
  source = apply(source, { kind: 'paste', scope: 'workbench', items });
  assert(parse(source, 'workbench').instances.some((i) => i.name === 'another_copy1'));
  assert.equal(simulate(source, 'blank', { a: '3' }).signals.result.value, '0x03');
  const imported = exportVhdlModule(source, parse(source, 'blank'));
  assert.equal(parse(imported).name, 'blank');
  const base = `library ieee; use ieee.std_logic_1164.all; entity main is end; architecture rtl of main is begin end;`;
  assert(parse(apply(base, { kind: 'import', definitions: [imported] })).library.blank);
  assert.throws(() => apply(base, { kind: 'import', definitions: [sv] }), /Mixed-language|VHDL/);
});
test('VHDL clipboard and editable spans reject injection and preserve comments/UTF-16 offsets', () => {
  const source = vhdl.replace('-- Preserve', '-- 🧪 Preserve').replaceAll('\n', '\r\n');
  const graph = project(parse(source, 'arithmetic')),
    op = graph.nodes.find((n) => n.kind === 'op')!;
  const edit = graphPatch(source, graph, op.id, { kind: 'operator', value: '-' });
  assert.equal(source.slice(edit.start, edit.end), '+');
  validateEditableEdits(source, [edit]);
  assert.throws(() =>
    validateEditableEdits(source, [
      { start: edit.start, end: edit.end, text: '- b; result <= a +' },
    ]),
  );
  assert.throws(
    () =>
      apply(source, {
        kind: 'paste',
        items: [{ name: 'x', width: 8, language: 'vhdl', expression: 'a; result <= b' }],
      }),
    /statements/,
  );
  assert.throws(
    () => apply(source, { kind: 'paste', items: [{ name: 'x', width: 8, expression: 'a' }] }),
    /HDL family/,
  );
  const commented = source.replace('a + b', 'a + -- keep me\r\n b');
  assert.throws(
    () =>
      apply(commented, {
        kind: 'disconnect',
        scope: 'arithmetic',
        target: 'arithmetic/net/result',
      }),
    /comment/,
  );
});
