// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { SyncService } from '../packages/core/service.js';
const seconds = Number(process.argv.find((a) => a.startsWith('--seconds='))?.slice(10) ?? 120);
assert(Number.isFinite(seconds) && seconds >= 30 && seconds <= 3600);
const workspace = resolve('test-results', 'acceptance-' + Date.now());
mkdirSync(workspace, { recursive: true });
const specs = [
  { file: 'multiplier.v', fixture: 'alu-int16-clocked.v', module: 'INT16_MUL' },
  { file: 'pipeline.sv', fixture: 'clocked-hierarchy.sv', module: 'pipeline' },
  { file: 'counter.vhd', fixture: 'clocked-counter.vhd', module: 'clocked_counter' },
];
const docs = specs.map((s) => ({
  ...s,
  text: readFileSync(join('fixtures', s.fixture), 'utf8'),
  uri: pathToFileURL(join(workspace, s.file)).href,
  version: 1,
}));
for (const d of docs) writeFileSync(join(workspace, d.file), d.text);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let service = new SyncService(workspace);
let ws: WebSocket | undefined;
let samples = 0,
  edits = 0,
  peakRSS = process.memoryUsage().rss;
try {
  const config = await service.ready();
  ws = new WebSocket(`ws://127.0.0.1:${config.port}`);
  await new Promise<void>((ok, fail) => {
    ws!.once('open', ok);
    ws!.once('error', fail);
  });
  ws.send(JSON.stringify({ ...config, type: 'hello', editor: 'vscode' }));
  for (const d of docs)
    ws.send(
      JSON.stringify({ type: 'document.open', uri: d.uri, version: d.version, text: d.text }),
    );
  const initial = Date.now();
  while (docs.some((d) => service.states.get(d.uri)?.status !== 'Synced')) {
    assert(Date.now() - initial < 20000, 'Initial sources failed to synchronize');
    await sleep(100);
  }
  for (const d of docs) service.selectModule(d.uri, d.module);
  const started = Date.now();
  let nextEdit = started + 20000,
    iteration = 0;
  while (Date.now() - started < seconds * 1000) {
    for (const [index, d] of docs.entries()) {
      const state = service.states.get(d.uri)!;
      assert.notEqual(state.status, 'Invalid source');
      assert.notEqual(state.status, 'Unsupported construct');
      if (state.status !== 'Synced') continue;
      const clk = String(iteration % 2),
        reset = iteration % 43 === 0 ? '1' : '0';
      const inputs: Record<string, string> = { clk, reset };
      if (index === 0)
        Object.assign(inputs, {
          start: iteration % 37 === 1 ? '1' : '0',
          signed_mode: '1',
          OPm: String((iteration * 257) & 65535),
          OPn: '3',
        });
      else if (index === 1) Object.assign(inputs, { en: '1', data: String(iteration & 255) });
      else inputs.en = '1';
      const result = service.simulate(d.uri, inputs);
      assert(Object.keys(result.signals).length > 0);
      samples++;
    }
    if (Date.now() >= nextEdit) {
      for (const d of docs) {
        d.version++;
        ws.send(
          JSON.stringify({
            type: 'document.change',
            uri: d.uri,
            version: d.version,
            origin: 'user',
            text:
              (d.file.endsWith('vhd') ? '--' : '//') +
              ' acceptance revision ' +
              d.version +
              '\n' +
              d.text,
          }),
        );
        edits++;
      }
      nextEdit += 40000;
    }
    peakRSS = Math.max(peakRSS, process.memoryUsage().rss);
    assert(peakRSS < 768 * 1024 * 1024, 'Acceptance process exceeded 768 MiB');
    iteration++;
    await sleep(100);
  }
  for (const d of docs)
    assert.equal(
      readFileSync(join(workspace, d.file), 'utf8'),
      d.text,
      'Unsaved edits must not write source',
    );
  ws.close();
  await service.close();
  service = new SyncService(workspace);
  await service.ready();
  const recovery = service.recovery.list();
  assert(recovery.length >= 3, 'Recovery history must survive service restart');
  const report = {
    passed: true,
    seconds: (Date.now() - started) / 1000,
    samples,
    edits,
    peakRSSMiB: peakRSS / 1048576,
    languages: 3,
    realDebounce: true,
    sourceUnchanged: true,
    recoveryRestart: true,
    humanAcceptance: false,
  };
  writeFileSync('test-results/release-acceptance.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  ws?.close();
  await service.close();
}
