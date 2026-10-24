// SPDX-License-Identifier: GPL-3.0-only
// Generated lane datapath exercises supported HDL at project scale; it is not an external-project compatibility claim.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { SyncService } from '../packages/core/service.js';
import type { Clock } from '../packages/core/index.js';
import type { Operator } from '../packages/protocol/index.js';
class TestClock implements Clock {
  t = 0;
  next = 0;
  jobs = new Map<number, { at: number; fn: () => void }>();
  now = () => this.t;
  set(fn: () => void, delay: number) {
    const id = ++this.next;
    this.jobs.set(id, { at: this.t + delay, fn });
    return id;
  }
  clear(id: unknown) {
    this.jobs.delete(id as number);
  }
  tick() {
    const end = this.t + 15000;
    for (;;) {
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
const option = (name: string, fallback: number, max: number) => {
  const value = Number(
    process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback,
  );
  assert(Number.isInteger(value) && value >= 1 && value <= max, `Invalid ${name}`);
  return value;
};
const cycles = option('cycles', 30, 1000),
  lanes = option('lanes', 64, 64);
const width = lanes * 8;
function source(language: string) {
  const names = Array.from({ length: lanes }, (_, i) => `lane_${i}`);
  if (language === 'vhd')
    return `library ieee;\nuse ieee.std_logic_1164.all;\nuse ieee.numeric_std.all;\nentity packet_transform is\nport (data : in unsigned(${width - 1} downto 0); key : in unsigned(7 downto 0); enabled : in std_logic; result : out unsigned(${width - 1} downto 0));\nend entity;\narchitecture rtl of packet_transform is\n${names.map((n) => `signal ${n} : unsigned(7 downto 0);`).join('\n')}\nbegin\n${names.map((n, i) => `${n} <= data(${i * 8 + 7} downto ${i * 8}) xor key;`).join('\n')}\nresult <= ${[...names].reverse().join(' & ')} when enabled = '1' else data;\nend architecture;\n`;
  const type = language === 'sv' ? 'logic' : 'wire';
  return `module packet_transform(input ${type} [${width - 1}:0] data, input ${type} [7:0] key, input ${type} enabled, output ${type} [${width - 1}:0] result);\n${names.map((n, i) => `${type} [7:0] ${n};\nassign ${n} = data[${i * 8 + 7}:${i * 8}] ^ key;`).join('\n')}\nassign result = enabled ? {${[...names].reverse().join(', ')}} : data;\nendmodule\n`;
}
async function until(check: () => boolean) {
  const start = Date.now();
  while (!check()) {
    assert(Date.now() - start < 10000, 'Soak event timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const workspace = resolve('test-results/soak', `${Date.now()}-${process.pid}`);
mkdirSync(workspace, { recursive: true });
const clock = new TestClock(),
  service = new SyncService(workspace, clock),
  started = performance.now();
const config = await service.ready(),
  results = [];
let peakRSS = process.memoryUsage().rss;
try {
  for (const language of ['v', 'sv', 'vhd']) {
    const path = join(workspace, `packet.${language}`),
      uri = pathToFileURL(path).href,
      original = source(language);
    writeFileSync(path, original);
    let text = original,
      version = 1,
      patches = 0,
      ws: WebSocket | undefined,
      protocolError = '';
    const connect = async () => {
      ws = new WebSocket(`ws://127.0.0.1:${config.port}`);
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'error') protocolError = m.error;
        if (m.type === 'document.applyPatch') {
          assert.equal(m.baseVersion, version);
          for (const e of m.edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);
          version++;
          patches++;
          ws!.send(
            JSON.stringify({
              type: 'document.patchResult',
              uri,
              patchId: m.patchId,
              ok: true,
              currentVersion: version,
              text,
            }),
          );
        }
      });
      await once(ws, 'open');
      ws.send(
        JSON.stringify({
          ...config,
          type: 'hello',
          editor: 'vscode',
          capabilities: ['recovery-review'],
        }),
      );
      await until(() => service.editorConnected);
      ws.send(JSON.stringify({ type: 'document.open', uri, version, text }));
      await until(() => service.states.get(uri)?.status === 'Pending');
      clock.tick();
      assert.equal(
        service.states.get(uri)?.status,
        'Synced',
        JSON.stringify(service.states.get(uri)?.diagnostics),
      );
    };
    await connect();
    const nodes = service.states.get(uri)!.graph!.nodes.length;
    assert(nodes > lanes * 2);
    let reconnects = 0;
    for (let i = 0; i < cycles; i++) {
      const session = service.sessions.get(uri)!;
      const node = session.state.graph!.nodes.find(
        (n) => n.kind === 'op' && n.key.includes('/assign/lane_0/'),
      )!;
      assert(node, 'First lane operator exists');
      const op: Operator = i % 2 ? '^' : '|';
      service.graphChange(uri, node.id, { kind: 'operator', value: op });
      clock.tick();
      await until(() => session.state.status === 'Synced');
      assert.equal(patches, i + 1);
      assert.equal(session.text, text);
      const data = BigInt(i + 1) * 0x123456789abcdefn,
        key = BigInt((i * 17 + 3) & 255);
      let expected = 0n;
      for (let lane = 0; lane < lanes; lane++) {
        const input = (data >> BigInt(lane * 8)) & 255n;
        expected |= (lane === 0 && op === '|' ? input | key : input ^ key) << BigInt(lane * 8);
      }
      const result = service.simulate(uri, {
        data: String(data & ((1n << BigInt(width)) - 1n)),
        key: String(key),
        enabled: '1',
      });
      assert.equal(BigInt(result.signals.result.value), expected);
      assert.equal(
        service.simulate(uri, { data: '17', key: '3', enabled: '0' }).signals.result.value,
        `0x${'11'.padStart(width / 4, '0')}`,
      );
      assert.equal(protocolError, '');
      peakRSS = Math.max(peakRSS, process.memoryUsage().rss);
      if ((i + 1) % 10 === 0) {
        ws!.close();
        await once(ws!, 'close');
        await until(() => !service.editorConnected);
        await connect();
        reconnects++;
      }
    }
    assert.equal(readFileSync(path, 'utf8'), original, 'Live edits never save the source');
    const checkpoint = service.recovery.list().find((e) => e.uri === uri && e.checkpoint)!;
    assert.equal(service.recovery.read(checkpoint.id).text, text);
    ws!.close();
    await once(ws!, 'close');
    await until(() => !service.editorConnected);
    results.push({
      language,
      nodes,
      cycles,
      patches,
      reconnects,
      sourceBytes: Buffer.byteLength(original),
    });
    console.log(JSON.stringify(results.at(-1)));
  }
} finally {
  await service.close();
}
const report = {
  cycles,
  lanes,
  results,
  elapsedSeconds: (performance.now() - started) / 1000,
  peakRSSMiB: peakRSS / 1024 / 1024,
  debounce: 'virtual 15-second clock; real sockets, parsing, proofs, journal and simulation',
};
writeFileSync('test-results/project-soak.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
