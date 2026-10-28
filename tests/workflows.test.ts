// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { parse } from '../packages/verilog/index.js';
import { stateMachines } from '../packages/verilog/fsm.js';
import { runSimulationTest, validateSimulationTest } from '../packages/verilog/test-vectors.js';
import { SyncService } from '../packages/core/service.js';
import type { Clock } from '../packages/core/index.js';

const sv = readFileSync('fixtures/enum-fsm.sv', 'utf8'),
  vhdl = readFileSync('fixtures/enum-fsm.vhd', 'utf8');
test('derived FSMs resolve next-state case trees, holds, reset and named encodings', () => {
  for (const [source, idle, running, finished] of [
    [sv, 'IDLE', 'RUN', 'DONE'],
    [vhdl, 'idle', 'running', 'finished'],
  ]) {
    const [machine] = stateMachines(parse(source));
    assert.equal(machine.detail, undefined);
    assert.equal(machine.states.length, 3);
    assert(
      machine.transitions.some(
        (t) => t.from === idle && t.to === running && t.condition.includes('start'),
      ),
    );
    assert(
      machine.transitions.some(
        (t) => t.from === running && t.to === finished && t.condition.includes('finish'),
      ),
    );
    assert(machine.transitions.some((t) => t.from === running && t.to === running));
    assert(
      machine.transitions.some(
        (t) => t.from === finished && t.to === idle && t.condition === 'reset',
      ),
    );
    assert(machine.transitions.every((t) => !t.condition.includes('state ==')));
  }
});
test('state views preserve mixed-width signed guards instead of pruning valid transitions', () => {
  const ast = parse(`module signed_states(input clk);
    typedef enum logic signed[1:0]{NEG=2'b11,ZERO=2'b00} t; t state;
    typedef enum logic signed[63:0]{WNEG=64'hffffffffffffffff} w;
    always_ff @(posedge clk) if(state==WNEG)state<=ZERO;else state<=NEG;
    endmodule`);
  const [machine] = stateMachines(ast);
  assert.equal(machine.detail, undefined);
  assert(
    machine.transitions.some(
      (t) => t.from === 'NEG' && t.to === 'ZERO' && t.condition.includes('WNEG'),
    ),
  );
});
test('saved tests compare exact known/unknown bits, isolate state and reject stale interfaces', () => {
  const ast = parse(sv),
    input = {
      schemaVersion: 1,
      name: 'start',
      module: ast.name,
      vectors: [
        {
          inputs: { clk: '0', reset: '1', start: '0', finish: '0' },
          expect: { busy: '0', done: '0', state_code: '0b00' },
        },
        { inputs: { clk: '0', reset: '0', start: '1', finish: '0' }, expect: {} },
        {
          inputs: { clk: '1', reset: '0', start: '1', finish: '0' },
          expect: { busy: '1', state_code: '1' },
        },
      ],
    };
  assert.deepEqual(runSimulationTest(ast, input), {
    passed: true,
    samples: 3,
    assertions: 5,
    failures: [],
  });
  assert(runSimulationTest(ast, input).passed, 'Each run starts with its own state');
  const fail = structuredClone(input);
  fail.vectors[2].expect.busy = '0';
  assert.deepEqual(runSimulationTest(ast, fail).failures, [
    { sample: 3, signal: 'busy', expected: '0', actual: '1' },
  ]);
  const bad = structuredClone(input);
  bad.vectors[0].expect.state_code = '4';
  assert.throws(() => runSimulationTest(ast, bad), /width/);
  assert.throws(() => runSimulationTest(ast, { ...input, module: 'missing' }), /module/);
  const missing = structuredClone(input);
  delete (missing.vectors[0].inputs as Record<string, string>).finish;
  assert.throws(() => runSimulationTest(ast, missing), /every input/);
  assert.throws(
    () => validateSimulationTest({ ...input, vectors: Array(129).fill(input.vectors[0]) }),
    /128/,
  );
  assert.throws(
    () => validateSimulationTest({ ...input, vectors: [{ inputs: {}, expect: {} }] }),
    /expected/,
  );
  const unknown = parse('module unknowns(input a,output b);endmodule');
  assert(
    runSimulationTest(unknown, {
      schemaVersion: 1,
      name: 'unknown',
      module: 'unknowns',
      vectors: [{ inputs: { a: '0' }, expect: { b: 'x' } }],
    }).passed,
  );
  assert(
    !runSimulationTest(unknown, {
      schemaVersion: 1,
      name: 'unknown',
      module: 'unknowns',
      vectors: [{ inputs: { a: '0' }, expect: { b: '0' } }],
    }).passed,
  );
});
test('multi-file projects use live buffers, invalidate on dependency changes and persist explicit selections', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mira-project-tests-'));
  const jobs = new Map<number, () => void>();
  let id = 0;
  const clock: Clock = {
    now: () => 0,
    set: (fn) => {
      jobs.set(++id, fn);
      return id;
    },
    clear: (n) => {
      jobs.delete(n as number);
    },
  };
  const flush = () => {
    for (const [id, fn] of [...jobs]) {
      jobs.delete(id);
      fn();
    }
  };
  let service = new SyncService(root, clock);
  let ws: WebSocket | undefined;
  const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.fail('Protocol timeout');
  };
  const connect = async () => {
    const config = await service.ready(false);
    ws = new WebSocket(`ws://127.0.0.1:${config.port}`);
    await new Promise((r) => ws!.once('open', r));
    ws.send(JSON.stringify({ type: 'hello', ...config, editor: 'vscode' }));
    await wait(() => service.editorConnected);
  };
  const parent = pathToFileURL(join(root, 'parent.v')).href,
    child = pathToFileURL(join(root, 'child.v')).href;
  const top = 'module parent(input a,b,output y);child u(.a(a),.b(b),.y(y));endmodule';
  const sub = 'module child(input a,b,output y);assign y=a&b;endmodule';
  const open = async (uri: string, text: string) => {
    ws!.send(JSON.stringify({ type: 'document.open', uri, text, version: 1 }));
    await wait(() => service.sessions.has(uri));
    flush();
  };
  try {
    await connect();
    await open(parent, top);
    await open(child, sub);
    assert.equal(service.states.get(parent)?.status, 'Invalid source');
    assert.throws(() => service.linkProject(parent, ['file:///outside.v']), /explicitly shared/);
    service.linkProject(parent, [child]);
    flush();
    assert.equal(service.states.get(parent)?.status, 'Synced');
    assert.equal(service.states.get(parent)?.readOnly, true);
    assert.equal(service.simulate(parent, { a: '1', b: '0' }).signals.y.value, '0');
    assert.throws(
      () => service.circuitAction(parent, { kind: 'wire', name: 'extra', width: 1 } as any),
      /viewing/,
    );
    const test = {
      schemaVersion: 1,
      name: 'AND inputs',
      module: 'parent',
      vectors: [{ inputs: { a: '1', b: '0' }, expect: { y: '0' } }],
    };
    service.saveTest(parent, test);
    assert(service.sessions.get(parent)!.runTest(test).passed);
    ws!.send(
      JSON.stringify({
        type: 'document.change',
        uri: child,
        version: 2,
        text: sub.replace('&', '|'),
        origin: 'user',
      }),
    );
    await wait(() => service.sessions.get(child)?.state.version === 2);
    assert.equal(service.states.get(parent)?.status, 'Pending');
    assert.throws(() => service.simulate(parent, { a: '1', b: '0' }), /Wait/);
    flush();
    assert.equal(service.simulate(parent, { a: '1', b: '0' }).signals.y.value, '1');
    assert(!service.sessions.get(parent)!.runTest(test).passed);
    const invalid = sub.replace('&', '#');
    ws!.send(
      JSON.stringify({
        type: 'document.change',
        uri: child,
        version: 3,
        text: invalid,
        origin: 'user',
      }),
    );
    await wait(() => service.sessions.get(child)?.state.version === 3);
    flush();
    assert.equal(service.states.get(parent)?.diagnostics[0].uri, child);
    assert.equal(service.states.get(parent)?.diagnostics[0].start, invalid.indexOf('#'));
    ws!.send(JSON.stringify({ type: 'document.close', uri: child }));
    await wait(() => !service.sessions.has(child));
    flush();
    assert.equal(service.states.get(parent)?.status, 'Invalid source');
    assert.deepEqual(service.states.get(parent)?.projectSources, [child]);
    await open(child, sub);
    assert.equal(service.states.get(parent)?.status, 'Synced');
    assert(
      !existsSync(join(root, 'parent.v')) && !existsSync(join(root, 'child.v')),
      'No source file writes',
    );
    await service.close();
    service = new SyncService(root, clock);
    await connect();
    await open(parent, top);
    assert.equal(
      service.states.get(parent)?.status,
      'Invalid source',
      'Restored links wait for explicit sharing',
    );
    await open(child, sub);
    assert.equal(service.states.get(parent)?.status, 'Synced');
    assert.equal(service.listTests(parent)[0].name, 'AND inputs');
    assert.deepEqual(service.deleteTest(parent, 'AND inputs', 'parent'), []);
    service.linkProject(parent, []);
    flush();
    assert.equal(service.states.get(parent)?.readOnly, false);
  } finally {
    ws?.terminate();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
