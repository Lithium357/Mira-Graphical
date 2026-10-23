// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, project, graphPatch, validateEditableEdits } from '../packages/verilog/index.js';
import { simulate } from '../packages/verilog/simulation.js';
import {
  planTransaction,
  copyComponents,
  validateConstructionProof,
} from '../packages/verilog/construction.js';
import type { SourceAction } from '../packages/protocol/index.js';
const source = readFileSync('fixtures/hierarchy.v', 'utf8');
test('hierarchy and concatenations project named sockets and drive result nets', () => {
  const ast = parse(source),
    graph = project(ast);
  assert.equal(Object.keys(ast.library).length, 2);
  assert.equal(graph.library!.length, 2);
  const instance = graph.nodes.find((n) => n.kind === 'instance')!;
  assert.equal(instance.childModule, 'arithmetic');
  assert.deepEqual(
    instance.inputPorts?.map((p) => p.name),
    ['port:a', 'port:b'],
  );
  assert.equal(instance.outputPorts![0].signal, 'sum');
  assert(!graph.nodes.find((n) => n.label === 'sum')!.undriven);
  assert.equal(graph.nodes.find((n) => n.kind === 'concat')!.width, 16);
  assert.equal(parse(source, 'arithmetic').name, 'arithmetic');
});
test('hierarchy rejects missing definitions, recursion, duplicate ports and output driver conflicts', () => {
  for (const text of [
    source.replace('arithmetic add_stage', 'missing add_stage'),
    source.replace('.b(b)', '.a(b)'),
    source.replace('.result(sum)', '.result(a)'),
    source.replace('    assign joined', '    assign sum = a;\n    assign joined'),
  ])
    assert.throws(() => parse(text));
  assert.throws(
    () => parse('module m(input a,output y);m recursive(.a(a),.y(y));endmodule'),
    /Recursive/,
  );
  assert.throws(() => parse(source + source), /Duplicate module/);
});
test('diagnostics distinguish truncation, extension, undriven outputs and unused inputs', () => {
  const graph = project(
    parse(
      'module m(input [7:0] a,input spare,output [3:0] y,output floating,output [15:0] wide);assign y=a;assign wide=a;endmodule',
    ),
  );
  for (const code of ['truncation', 'extension', 'undriven', 'unused'])
    assert(graph.issues!.some((i) => i.code === code));
});
test('construct joins and split ascending or descending buses without changing their ordering', () => {
  const text = 'module m(input [0:7] a,input [7:0] b);endmodule';
  const draft = planTransaction(text, [
    { kind: 'create', component: 'concat', name: 'joined', width: 16, parts: ['a', 'b'] },
    { kind: 'create', component: 'split', name: 'parts', width: 4, source: 'a' },
  ]);
  assert(draft.text.includes('assign joined = {a, b};'));
  assert(draft.text.includes('assign parts_0 = a[4:7];'));
  assert(draft.text.includes('assign parts_1 = a[0:3];'));
  assert.throws(
    () =>
      planTransaction(text, [
        { kind: 'create', component: 'split', name: 'bad', width: 3, source: 'b' },
      ]),
    /divisible/,
  );
});
test('rewire and zero individual concatenation parts with exact span proofs', () => {
  const actions: SourceAction[] = [
    {
      kind: 'connect',
      source: 'workbench/net/b',
      target: 'workbench/assign/joined/expr/concat',
      port: 'part:0',
    },
    { kind: 'zero', target: 'workbench/assign/joined/expr/concat', port: 'part:1' },
  ];
  const draft = planTransaction(source, actions);
  assert(draft.text.includes("{b, 8'd0}"));
  validateConstructionProof(source, draft.edits(), actions);
});
test('module-scoped construction and token patches leave the parent source unchanged', () => {
  const actions: SourceAction[] = [
    {
      kind: 'create',
      scope: 'arithmetic',
      component: 'operation',
      name: 'product',
      width: 8,
      operator: '*',
    },
    {
      kind: 'connect',
      scope: 'arithmetic',
      source: 'arithmetic/net/a',
      target: 'arithmetic/assign/product/expr',
      port: 'left',
    },
  ];
  const draft = planTransaction(source, actions);
  assert.equal(
    draft.text.slice(0, source.indexOf('module arithmetic')),
    source.slice(0, source.indexOf('module arithmetic')),
  );
  validateConstructionProof(source, draft.edits(), actions);
  const graph = project(parse(source, 'arithmetic')),
    op = graph.nodes.find((n) => n.kind === 'op')!;
  const patch = graphPatch(source, graph, op.id, { kind: 'operator', value: '*' });
  validateEditableEdits(source, [patch]);
  assert.equal(source.slice(patch.start, patch.end), '+');
});
test('create a reusable definition and instantiate it with safe zero inputs and named outputs', () => {
  let text = planTransaction(source, [{ kind: 'module', name: 'blank' }]).text;
  assert(parse(text).library.blank);
  text = planTransaction(text, [
    { kind: 'create', component: 'instance', name: 'second', moduleName: 'arithmetic', width: 1 },
    {
      kind: 'connect',
      source: 'workbench/net/b',
      target: 'workbench/instance/second',
      port: 'port:a',
    },
  ]).text;
  assert(text.includes("arithmetic second (.a(b), .b(8'd0), .result(second_result));"));
  assert(project(parse(text)).nodes.find((n) => n.label === 'second_result')?.undriven === false);
});
test('copy/paste remaps internal wires and ports while retaining external dependencies', () => {
  const graph = project(parse(source)),
    instance = graph.nodes.find((n) => n.kind === 'instance')!;
  const items = copyComponents(source, graph, [instance.id]);
  const draft = planTransaction(source, [{ kind: 'paste', items }]);
  assert(draft.text.includes('wire [7:0] sum_copy1;'));
  assert(draft.text.includes('arithmetic add_stage_copy1 (.a(a), .b(b), .result(sum_copy1));'));
  const ports = copyComponents(source, graph, [graph.nodes.find((n) => n.label === 'a')!.id]);
  const next = planTransaction(source, [{ kind: 'paste', items: ports }]);
  assert.equal(parse(next.text).nets.find((n) => n.name === 'a_copy1')?.direction, 'input');
});
test('clipboard fragments cannot inject statements, comments or undeclared dependencies', () => {
  for (const expression of ['a;assign result=b', 'a /* copied */', 'missing', 'a), .b(b)'])
    assert.throws(() =>
      planTransaction(source, [{ kind: 'paste', items: [{ name: 'p', width: 8, expression }] }]),
    );
  const text = "module m(input [7:0] hAA,output [7:0] y);assign y=8'hAA;endmodule",
    graph = project(parse(text));
  const items = copyComponents(
    text,
    graph,
    graph.nodes.filter((n) => ['hAA', 'y'].includes(n.label)).map((n) => n.id),
  );
  assert(
    planTransaction(text, [{ kind: 'paste', items }]).text.includes("assign y_copy1 = 8'hAA;"),
  );
});
test('simulate hierarchy, concatenations, muxes and unsigned overflow', () => {
  const result = simulate(source, 'workbench', { a: '0xff', b: '2', select: '1' });
  assert.equal(result.signals.joined.value, '0xff02');
  assert.equal(result.signals.result.value, '0x01');
  assert.equal(result.signals['add_stage.result'].value, '0x01');
  assert.equal(result.nodes['workbench/assign/joined/expr/concat'], '0xff02');
});
test('assignment context retains arithmetic carry and product bits before output truncation', () => {
  const text =
    'module m(input [7:0] a,b,output [15:0] sum,product,output [3:0] low);assign sum=a+b;assign product=a*b;assign low=a+b;endmodule';
  const result = simulate(text, 'm', { a: '255', b: '255' });
  assert.equal(result.signals.sum.value, '0x01fe');
  assert.equal(result.signals.product.value, '0xfe01');
  assert.equal(result.signals.low.value, '0xe');
});
test('unknown bits propagate through mux, bitwise logic and undriven declarations', () => {
  const text =
    "module m(input [3:0] a, input s,output [3:0] y,z,merged,output floating);assign y=a & 4'b0000;assign z=a | 4'b1111;assign merged=s ? 4'b1010 : 4'b1000;endmodule";
  const result = simulate(text, 'm', { a: 'x', s: 'x' });
  assert.equal(result.signals.y.value, '0x0');
  assert.equal(result.signals.z.value, '0xf');
  assert.equal(result.signals.merged.value, '0b10x0');
  assert.equal(result.signals.floating.value, 'x');
});
test('simulation slices ascending ranges and bounds inputs and expanded widths', () => {
  const text =
    'module m(input [0:7] a,output [3:0] high,low);assign high=a[0:3];assign low=a[4:7];endmodule';
  const result = simulate(text, 'm', { a: '0xab' });
  assert.equal(result.signals.high.value, '0xa');
  assert.equal(result.signals.low.value, '0xb');
  for (const inputs of [
    { a: '256' },
    { a: '-1' },
    { missing: '1' },
    { a: '0bxxxxxxxxx' },
  ] as Record<string, string>[])
    assert.throws(() => simulate(text, 'm', inputs));
  assert.throws(() => simulate('module m(input [5000:0] a);endmodule', 'm', {}), /widths/);
});

test('token validation uses the selector namespace of the edited module', () => {
  const text =
    'module first(input [7:0] a,input s,output [7:0] y);assign y=s?a:a;endmodule\nmodule second(input a,output y);assign y=a;endmodule';
  const start = text.indexOf('s?a');
  assert.throws(
    () => validateEditableEdits(text, [{ start, end: start + 1, text: 'a' }]),
    /scalar/,
  );
});
test('module import preserves internal comments and refuses duplicate definitions', () => {
  const target = 'module target();endmodule',
    definitions = [source];
  const draft = planTransaction(target, [{ kind: 'import', definitions }]);
  assert(draft.text.startsWith(target));
  assert(draft.text.includes('// Reusable child'));
  assert.equal(project(parse(draft.text)).library!.length, 3);
  assert.throws(() => planTransaction(source, [{ kind: 'import', definitions }]), /already exists/);
});
test('names matching object prototypes remain normal module and signal names', () => {
  const text =
    'module constructor(input toString,output valueOf);assign valueOf=toString;endmodule';
  const name: string = 'valueOf';
  assert.equal(simulate(text, 'constructor', {}).signals[name].value, '0');
});

test('clipboard keeps ascending declaration indices and original expression comments', () => {
  const text = 'module m(input [0:7] a,output [3:0] y);assign y=a /* keep here */ [0:3];endmodule',
    graph = project(parse(text));
  const items = copyComponents(
    text,
    graph,
    graph.nodes.filter((n) => n.kind === 'input' || n.kind === 'slice').map((n) => n.id),
  );
  const draft = planTransaction(text, [{ kind: 'paste', items }]);
  assert(draft.text.includes('input wire [0:7] a_copy1'));
  assert(draft.text.includes('a_copy1   [0:3]'));
  assert(draft.text.includes('a /* keep here */ [0:3]'));
  assert.equal(
    simulate(draft.text, 'm', { a: '0xab', a_copy1: '0xcd' }).signals.y_copy1.value,
    '0xc',
  );
});
test('projection uses arithmetic destination context and refuses unsized concatenation operands', () => {
  const graph = project(parse('module m(input [7:0] a,b,output [15:0] y);assign y=a+b;endmodule'));
  assert.equal(graph.nodes.find((n) => n.kind === 'op')!.width, 16);
  assert.throws(
    () => parse('module m(input a,output [1:0] y);assign y={a,1};endmodule'),
    /explicitly sized/,
  );
});
