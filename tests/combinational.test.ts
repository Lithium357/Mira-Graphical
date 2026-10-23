// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parse,
  project,
  graphPatch,
  operatorPatch,
  validateEditableEdits,
} from '../packages/verilog/index.js';
import { literalWidth } from '../packages/verilog/literals.js';
import { applyLivePatch } from '../extensions/vscode/patch.js';
import { hash, Session, type Clock } from '../packages/core/index.js';
const source = readFileSync('fixtures/combinational.v', 'utf8');
const apply = (source: string, e: { start: number; end: number; text: string }) =>
  source.slice(0, e.start) + e.text + source.slice(e.end);
test('sized unsigned literals decode bases and widths without losing source spelling', () => {
  for (const [text, width] of [
    ["8'hFF", 8],
    ["4'b10_10", 4],
    ["6'o77", 6],
    ["12'd1_234", 12],
    ['1_024', 32],
  ] as const)
    assert.equal(literalWidth(text), width);
  for (const text of ["2'b12", "8'hXX", "4'shF", "0'h0", "4'hFF", "999999999999'd0"])
    assert.throws(() => literalWidth(text));
});
test('mux/slices/constants project the complete combinational fixture', () => {
  const g = project(parse(source));
  assert.equal(g.nodes.filter((n) => n.kind === 'mux').length, 1);
  assert.equal(g.nodes.filter((n) => n.kind === 'slice')[0].width, 8);
  assert.equal(g.nodes.filter((n) => n.kind === 'literal').length, 2);
  const mux = g.nodes.find((n) => n.kind === 'mux')!;
  assert.equal(g.edges.filter((e) => e.target === mux.id).length, 3);
  assert.equal(mux.width, 8);
});
test('ternary is right associative and lower precedence than arithmetic and bitwise', () => {
  const e = parse('module m(input a,b,c,output y);assign y=a?b:c?a|b:c;endmodule').assigns[0].expr;
  assert.equal(e.kind, 'mux');
  if (e.kind === 'mux') {
    assert.equal(e.falsy.kind, 'mux');
    if (e.falsy.kind === 'mux') assert.equal(e.falsy.truthy.kind, 'op');
  }
});
test('out-of-range and reversed slices refuse projection with exact range spans', () => {
  for (const range of ['[8:0]', '[0:7]', '[9]'])
    assert.throws(() => parse(source.replace('a[7:0]', `a${range}`)), /range|direction/);
  const ascending = 'module m(input [0:7] a,output [0:3] y);assign y=a[0:3];endmodule';
  assert.equal(project(parse(ascending)).nodes.find((n) => n.kind === 'slice')!.width, 4);
});
for (const kind of ['literal', 'slice', 'selector'] as const)
  test(`${kind} graph edit preserves unrelated source and survives reparse with stable identity`, () => {
    const g = project(parse(source));
    const node = g.nodes.find((n) => n.kind === (kind === 'selector' ? 'mux' : kind))!;
    const value = kind === 'literal' ? "8'h2A" : kind === 'slice' ? '[3:0]' : 'select_b';
    const p = graphPatch(source, g, node.id, { kind, value });
    const next = apply(source, p);
    assert(next.includes('// Branch comments'));
    const after = project(parse(next), g);
    assert(after.nodes.some((n) => n.id === node.id));
    assert.equal(
      next,
      kind === 'literal'
        ? source.replace("8'h0F", value)
        : kind === 'slice'
          ? source.replace('[7:0] +', value + ' +')
          : source.replace('= select_a ?', '= select_b ?'),
    );
  });
test('operator changes within mux arms and slices remain exact token patches', () => {
  const g = project(parse(source));
  const op = g.nodes.find((n) => n.op === '+')!;
  const p = operatorPatch(source, g, op.id, '-');
  assert.equal(p.end - p.start, 1);
  assert.equal(apply(source, p), source.replace(' + ', ' - '));
});
test('editor independently accepts valid literal/range/selector patches and rejects injection', async () => {
  let text = source,
    version = 1;
  const doc = {
    text: () => text,
    version: () => version,
    apply: async (edits: any[]) => {
      for (const e of edits) text = apply(text, e);
      version++;
      return true;
    },
  };
  for (const [kind, value] of [
    ['literal', "8'h2A"],
    ['slice', '[3:0]'],
    ['selector', 'select_b'],
  ] as const) {
    const g = project(parse(text));
    const n = g.nodes.find((n) => n.kind === (kind === 'selector' ? 'mux' : kind))!;
    const p = graphPatch(text, g, n.id, { kind, value });
    assert(
      (await applyLivePatch(doc, { baseVersion: version, baseHash: hash(text), edits: [p] }, hash))
        .ok,
    );
  }
  assert.throws(() =>
    validateEditableEdits(source, [{ start: 0, end: source.length, text: source }]),
  );
  assert.throws(() =>
    validateEditableEdits(source, [
      { start: source.indexOf("8'h0F"), end: source.indexOf("8'h0F") + 5, text: '0;endmodule' },
    ]),
  );
});
test('constant graph changes obey debounce and commit only on editor acknowledgment', () => {
  let now = 0;
  const jobs = new Map<number, () => void>();
  let id = 0;
  const clock: Clock = {
    now: () => now,
    set: (f) => {
      jobs.set(++id, f);
      return id;
    },
    clear: (i) => {
      jobs.delete(i as number);
    },
  };
  const patches: any[] = [];
  const s = new Session(
    'file:///combo.v',
    1,
    source,
    { publish() {}, persist() {}, recover() {}, patch: (p) => patches.push(p) },
    clock,
  );
  now = 15000;
  const initial = jobs.get(1)!;
  jobs.delete(1);
  initial();
  const literal = s.state.graph!.nodes.find((n) => n.kind === 'literal')!;
  s.graphChange(literal.id, { kind: 'literal', value: "8'h2A" });
  assert.equal(patches.length, 0);
  assert.equal(s.state.pendingEdits![literal.id].value, "8'h2A");
  now += 15000;
  const [job, fn] = [...jobs][0];
  jobs.delete(job);
  fn();
  const p = patches[0];
  assert(s.patchResult(p.patchId, true, 2, apply(source, p.edits[0])));
  assert.equal(s.state.status, 'Synced');
  assert(s.text.includes("8'h2A"));
});
