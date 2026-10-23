// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  Session,
  type Clock,
  type State,
  type Recovery,
  type Layout,
} from '../packages/core/index.js';
import { parse, project, operatorPatch } from '../packages/verilog/index.js';
import { validateMessage } from '../packages/protocol/index.js';
const source = readFileSync('fixtures/adder.v', 'utf8');
class FakeClock implements Clock {
  t = 0;
  n = 0;
  jobs = new Map<number, { at: number; fn: () => void }>();
  now = () => this.t;
  set(fn: () => void, ms: number) {
    const id = ++this.n;
    this.jobs.set(id, { at: this.t + ms, fn });
    return id;
  }
  clear(id: unknown) {
    this.jobs.delete(id as number);
  }
  tick(ms: number) {
    const end = this.t + ms;
    while (true) {
      const next = [...this.jobs]
        .filter(([, j]) => j.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.t = next[1].at;
      this.jobs.delete(next[0]);
      next[1].fn();
    }
    this.t = end;
  }
}
function setup(layout?: Layout) {
  const time = new FakeClock();
  const states: State[] = [];
  const patches: any[] = [];
  const recovery: Recovery[] = [];
  const s = new Session(
    'file:///adder.v',
    1,
    source,
    {
      publish: (s) => states.push(s),
      patch: (p) => patches.push(p),
      recover: (r) => recovery.push(r),
      persist() {},
    },
    time,
    layout,
  );
  return {
    s,
    time,
    states,
    patches,
    recovery,
    op: () => s.state.graph!.nodes.find((n) => n.kind === 'op')!,
  };
}
test('protocol rejects malformed / unknown versions', () => {
  assert(!validateMessage({ type: 'hello', protocolVersion: 2 }));
  assert(
    !validateMessage({ type: 'document.change', uri: 'x', version: -1, text: 'x', origin: 'user' }),
  );
});
test('adder projection: operands, bus widths, ADD, output', () => {
  const g = project(parse(source));
  assert.equal(g.nodes.length, 4);
  assert.equal(g.edges.length, 3);
  assert.equal(g.nodes.find((n) => n.kind === 'op')?.op, '+');
  assert(g.nodes.every((n) => n.width === 8));
});
test('minimal patch preserves comments, CRLF and UTF-16 offsets', () => {
  const text = '// 🙂\r\n' + source.replaceAll('\n', '\r\n');
  const g = project(parse(text));
  const p = operatorPatch(text, g, g.nodes.find((n) => n.kind === 'op')!.id, '*');
  assert.equal(text.slice(p.start, p.end), '+');
  assert.equal(p.end - p.start, 1);
  assert.equal(text.slice(0, p.start) + p.text + text.slice(p.end), text.replace('a + b', 'a * b'));
});
test('precedence, parentheses, duplicate operators and comment tokens', () => {
  const text = source.replace('a + b', '(a + b) * (a + b) /* + ignored */');
  const g = project(parse(text));
  assert.equal(g.nodes.filter((n) => n.kind === 'op').length, 3);
  const nodes = g.nodes.filter((n) => n.op === '+');
  const p = operatorPatch(text, g, nodes[1].id, '-');
  assert.equal(
    text.slice(0, p.start) + p.text + text.slice(p.end),
    text.replace('(a + b) /*', '(a - b) /*'),
  );
});
test('reject precedence changes that would regroup surrounding expression', () => {
  const text = source.replace('a + b', 'a + b * a');
  const g = project(parse(text));
  assert.throws(
    () => operatorPatch(text, g, g.nodes.find((n) => n.op === '*')!.id, '|'),
    /precedence/,
  );
});
test('bounded invalid and unsupported syntax, undeclared and cycles', () => {
  for (const text of [
    readFileSync('fixtures/invalid.v', 'utf8'),
    readFileSync('fixtures/unsupported.v', 'utf8'),
    source.replace('a + b', 'unknown + b'),
  ])
    assert.throws(() => parse(text));
  assert.throws(() => project(parse(source.replace('a + b', 'sum + b'))), /cycles/);
});
test('15 second debounce resets at 0, 10 and 20 seconds', () => {
  const { s, time } = setup();
  time.tick(10000);
  s.userText(2, source);
  time.tick(10000);
  s.userText(3, source.replace('+', '-'));
  time.tick(14999);
  assert.equal(s.state.graph, undefined);
  time.tick(1);
  assert.equal(s.state.graph!.nodes.find((n) => n.kind === 'op')!.op, '-');
});
test('unsaved text updates and invalid source retains last valid graph', () => {
  const { s, time } = setup();
  time.tick(15000);
  const g = s.state.graph;
  s.userText(2, source.replace('a + b', 'a +'));
  time.tick(15000);
  assert.equal(s.state.status, 'Invalid source');
  assert.equal(s.state.graph, g);
  assert(s.state.diagnostics.length);
});
test('graph to source awaits acknowledgement and prevents echo', () => {
  const { s, time, patches, op } = setup();
  time.tick(15000);
  s.graphEdit(op().id, '*');
  time.tick(14999);
  assert.equal(patches.length, 0);
  time.tick(1);
  const p = patches[0];
  assert.equal(p.edits[0].text, '*');
  const text = source.replace('a + b', 'a * b');
  assert(!s.patchResult('forged', true, 2, text));
  assert(s.patchResult(p.patchId, true, 2, text));
  time.tick(60000);
  assert.equal(patches.length, 1);
  assert.equal(s.state.status, 'Synced');
});
test('last semantic graph edit safely rebases onto newer text with recovery', () => {
  const { s, time, patches, recovery, op } = setup();
  time.tick(15000);
  s.userText(2, '// new comment\n' + source.replace('+', '-'));
  time.tick(7000);
  s.graphEdit(op().id, '*');
  time.tick(4000);
  s.move(op().id, 99, 55);
  time.tick(14999);
  assert.equal(patches.length, 0);
  time.tick(1);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].baseVersion, 2);
  assert(recovery[0].text.includes('a - b'));
});
test('text wins graph edits; layout does not change authority', () => {
  const { s, time, patches, recovery, op } = setup();
  time.tick(15000);
  s.graphEdit(op().id, '*');
  s.userText(2, source.replace('+', '-'));
  s.move(op().id, 50, 70);
  time.tick(15000);
  assert.equal(op().op, '-');
  assert.equal(patches.length, 0);
  assert.equal(recovery.length, 1);
});
test('layout persistence, formatting/operator identity and committed remove/recreate', () => {
  const { s, time, patches, op } = setup();
  time.tick(15000);
  const id = op().id;
  s.move(id, 998, 777);
  time.tick(15000);
  assert.equal(patches.length, 0);
  s.userText(2, '\n' + source.replace('+', '*'));
  time.tick(15000);
  assert.equal(op().id, id);
  assert.equal(s.state.layout.nodes[id].x, 998);
  const restarted = setup(structuredClone(s.state.layout));
  restarted.time.tick(15000);
  assert.equal(restarted.op().id, id);
  assert.equal(restarted.s.state.layout.nodes[id].y, 777);
  s.userText(3, source.replace('a + b', 'a'));
  time.tick(15000);
  assert(!s.state.layout.nodes[id]);
  s.userText(4, source);
  time.tick(15000);
  assert.notEqual(op().id, id);
});
test('source rename allocates a new net identity', () => {
  const a = project(parse(source));
  const b = project(parse(source.replaceAll(/\ba\b/g, 'renamed')), a);
  assert(!b.nodes.some((n) => n.id === a.nodes.find((n) => n.label === 'a')!.id));
});
test('revision mismatch, stale ACK and disconnect preserve buffers', () => {
  const { s, time, patches, op, recovery } = setup();
  time.tick(15000);
  s.graphEdit(op().id, '*');
  time.tick(15000);
  s.userText(3, source.replace('+', '-'));
  s.patchResult(patches[0].patchId, true, 2, source.replace('+', '*'));
  assert.equal(s.state.status, 'Conflict');
  assert(s.text.includes('a - b'));
  s.disconnect();
  time.tick(60000);
  assert.equal(s.state.status, 'Disconnected');
  assert(recovery.length);
});
test('patch acknowledgment timeout becomes a visible recoverable conflict', () => {
  const { s, time, op, recovery } = setup();
  time.tick(15000);
  s.graphEdit(op().id, '*');
  time.tick(25000);
  assert.equal(s.state.status, 'Conflict');
  assert(recovery.length);
});
test('multiple sessions debounce independently', () => {
  const a = setup(),
    b = setup();
  a.time.tick(15000);
  assert(a.s.state.graph);
  assert(!b.s.state.graph);
  b.time.tick(15000);
  a.s.userText(2, source.replace('+', '-'));
  a.time.tick(15000);
  assert.equal(b.op().op, '+');
});
test('reverting a pending graph edit produces no redundant source patch', () => {
  const { s, time, op, patches } = setup();
  time.tick(15000);
  s.graphEdit(op().id, '*');
  s.graphEdit(op().id, '+');
  time.tick(15000);
  assert.equal(patches.length, 0);
  assert.equal(s.state.status, 'Synced');
});
test('graph edit refuses changed live operands and invalid source', () => {
  const { s, time, op } = setup();
  time.tick(15000);
  s.userText(2, source.replace('a + b', 'b + a'));
  assert.throws(() => s.graphEdit(op().id, '*'), /Operands changed/);
  s.userText(3, source.replace('a + b', 'a +'));
  assert.throws(() => s.graphEdit(op().id, '*'));
});
test('layout activity cannot cancel a patch acknowledgement timeout or clear a conflict', () => {
  const { s, time, op, patches } = setup();
  time.tick(15000);
  s.graphEdit(op().id, '*');
  time.tick(15000);
  s.move(op().id, 200, 300);
  time.tick(10000);
  assert.equal(s.state.status, 'Conflict');
  s.move(op().id, 220, 300);
  time.tick(60000);
  assert.equal(s.state.status, 'Conflict');
  assert.throws(() => s.graphEdit(op().id, '-'), /conflict/);
  assert.equal(patches.length, 1);
});
test('late ACK cannot overwrite newer text even after layout activity', () => {
  const { s, time, op, patches } = setup();
  time.tick(15000);
  s.graphEdit(op().id, '*');
  time.tick(15000);
  s.userText(3, source.replace('+', '-'));
  s.move(op().id, 200, 300);
  s.patchResult(patches[0].patchId, true, 2, source.replace('+', '*'));
  time.tick(60000);
  assert.equal(s.state.status, 'Conflict');
  assert(s.text.includes('a - b'));
  assert.equal(patches.length, 1);
});
test('deep operand changes cannot be mistaken for unchanged operand labels', () => {
  const text = source.replace('a + b', '(a + b) + (a + b)');
  const g = project(parse(text));
  const root = g.nodes.find((n) => n.key.endsWith('/expr'))!;
  assert.throws(
    () => operatorPatch(text.replace('(a + b)', '(b + a)'), g, root.id, '-'),
    /Operands changed/,
  );
});
test('operation replaced by literal and recreated loses the old identity', () => {
  const a = project(parse(source));
  const op = a.nodes.find((n) => n.kind === 'op')!;
  const b = project(parse(source.replace('a + b', '1')), a);
  assert(!b.nodes.some((n) => n.id === op.id));
  const c = project(parse(source), b);
  assert.notEqual(c.nodes.find((n) => n.kind === 'op')!.id, op.id);
});

test('construction preview, history, composed patch and ACK preserve new identity and manual placement', () => {
  const { s, time, patches } = setup();
  time.tick(15000);
  const committed = s.state.graph;
  const { selectedId } = s.circuitAction({
    kind: 'create',
    component: 'operation',
    name: 'product',
    width: 8,
    operator: '*',
  });
  assert(selectedId);
  assert.equal(s.state.graph, committed);
  assert(s.state.previewGraph!.nodes.some((n) => n.id === selectedId));
  s.constructionHistory('undo');
  assert(!s.state.previewGraph!.nodes.some((n) => n.id === selectedId));
  s.constructionHistory('redo');
  const input = s.state.previewGraph!.nodes.find((n) => n.label === 'a')!;
  s.circuitAction({ kind: 'connect', source: input.id, target: selectedId, port: 'left' });
  s.move(selectedId, 999, 444);
  time.tick(14999);
  assert.equal(patches.length, 0);
  time.tick(1);
  const p = patches[0];
  assert.equal(p.transaction.length, 2);
  let text = source;
  for (const e of p.edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  assert(text.includes("assign product = a * 8'd0;"));
  assert.throws(() => s.constructionHistory('undo'));
  assert(s.patchResult(p.patchId, true, 2, text));
  assert(s.state.graph!.nodes.some((n) => n.id === selectedId));
  assert.equal(s.state.layout.nodes[selectedId].x, 999);
});
test('source changes supersede structural drafts with recoverable preview; discard never patches source', () => {
  const { s, time, patches, recovery } = setup();
  time.tick(15000);
  s.circuitAction({ kind: 'create', component: 'wire', name: 'spare', width: 8 });
  s.discardGraphChanges();
  time.tick(15000);
  assert.equal(patches.length, 0);
  assert(recovery.at(-1)!.previewText!.includes('wire [7:0] spare;'));
  s.circuitAction({ kind: 'create', component: 'wire', name: 'later', width: 8 });
  s.userText(2, source.replace('a + b', 'a +'));
  assert(!s.state.previewGraph);
  assert(recovery.at(-1)!.previewText!.includes('later'));
  assert.throws(() =>
    s.circuitAction({ kind: 'create', component: 'wire', name: 'blocked', width: 1 }),
  );
  time.tick(15000);
  assert.equal(s.state.status, 'Invalid source');
  assert.equal(patches.length, 0);
});

test('disconnect saves a structural-only draft for recovery without replaying a patch', () => {
  const { s, time, patches, recovery } = setup();
  time.tick(15000);
  s.circuitAction({ kind: 'create', component: 'wire', name: 'offline', width: 8 });
  s.disconnect();
  time.tick(60000);
  assert.equal(patches.length, 0);
  assert(recovery.at(-1)!.previewText!.includes('offline'));
  assert.equal(s.state.canConstruct, false);
});

test('module navigation preserves identities, placement and scoped patches without changing source', () => {
  const text = readFileSync('fixtures/hierarchy.v', 'utf8'),
    time = new FakeClock(),
    patches: any[] = [];
  const s = new Session(
    'file:///hierarchy.v',
    1,
    text,
    { publish() {}, patch: (p) => patches.push(p), recover() {}, persist() {} },
    time,
  );
  time.tick(15000);
  const top = s.state.graph!.nodes.find((n) => n.kind === 'instance')!;
  s.move(top.id, 123, 456);
  s.selectModule('arithmetic');
  const op = s.state.graph!.nodes.find((n) => n.kind === 'op')!;
  s.move(op.id, 800, 300);
  s.selectModule('workbench');
  assert.equal(s.state.graph!.nodes.find((n) => n.kind === 'instance')!.id, top.id);
  assert.equal(s.state.layout.nodes[top.id].x, 123);
  s.selectModule('arithmetic');
  assert.equal(s.state.graph!.nodes.find((n) => n.kind === 'op')!.id, op.id);
  assert.equal(s.state.layout.nodes[op.id].x, 800);
  s.graphEdit(op.id, '*');
  assert.throws(() => s.selectModule('workbench'), /pending/);
  time.tick(15000);
  const patch = patches[0];
  assert.equal(patch.transaction[0].scope, 'arithmetic');
  let next = text;
  for (const e of patch.edits) next = next.slice(0, e.start) + e.text + next.slice(e.end);
  assert.equal(next, text.replace('a + b', 'a * b'));
  assert(s.patchResult(patch.patchId, true, 2, next));
  assert.equal(s.state.graph!.module, 'arithmetic');
});
test('simulation and copy are read-only while duplicate batches remain reversible', () => {
  const { s, time, patches, op } = setup();
  time.tick(15000);
  assert.equal(s.simulate({ a: '10', b: '20' }).signals.sum.value, '0x1e');
  const items = s.copy([op().id]);
  assert.equal(items.length, 1);
  assert.equal(patches.length, 0);
  s.circuitAction({ kind: 'paste', items });
  assert(s.state.previewGraph!.nodes.some((n) => n.label === 'sum_copy1'));
  s.constructionHistory('undo');
  time.tick(15000);
  assert.equal(patches.length, 0);
  assert.equal(s.text, source);
});
test('exporting and importing explicit shared definitions produces a self-contained guarded patch', () => {
  const text = readFileSync('fixtures/hierarchy.v', 'utf8'),
    time = new FakeClock(),
    patches: any[] = [];
  const hooks = { publish() {}, patch: (p: any) => patches.push(p), recover() {}, persist() {} };
  const from = new Session('file:///hierarchy.v', 1, text, hooks, time),
    to = new Session('file:///target.v', 1, 'module target();endmodule', hooks, time);
  time.tick(15000);
  const definitions = from.exportModules('workbench');
  assert.equal(definitions.length, 2);
  to.circuitAction({ kind: 'import', definitions });
  assert(to.state.previewGraph!.library!.some((m) => m.name === 'arithmetic'));
  time.tick(15000);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].transaction[0].kind, 'import');
  from.userText(2, text + '\n');
  assert.throws(() => from.exportModules('workbench'), /Wait/);
});
