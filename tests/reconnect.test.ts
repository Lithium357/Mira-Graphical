// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RetryLoop } from '../extensions/vscode/retry.js';
import { locateDiagnostic } from '../packages/core/diagnostics.js';
import { readFileSync } from 'node:fs';
import { APP_VERSION } from '../packages/protocol/version.js';
test('desktop and companion handshakes use the packaged release version', () => {
  for (const path of ['package.json', 'extensions/vscode/package.json'])
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, APP_VERSION);
});
test('reconnect uses capped backoff, avoids parallel attempts, and stops on explicit disconnect', async () => {
  const tasks: { fn: () => Promise<void>; delay: number; cancelled?: boolean }[] = [];
  const time = {
    set: ((fn: () => Promise<void>, delay: number) => {
      const t = { fn, delay };
      tasks.push(t);
      return t;
    }) as any,
    clear: ((t: any) => (t.cancelled = true)) as any,
  };
  let attempts = 0;
  const retry = new RetryLoop(
    async () => {
      attempts++;
      throw new Error('offline');
    },
    () => {},
    time,
  );
  retry.enable();
  retry.retry();
  retry.retry();
  assert.equal(tasks.length, 1);
  for (let i = 0; i < 6; i++) await tasks[i].fn();
  assert.deepEqual(
    tasks.map((t) => t.delay),
    [1000, 2000, 4000, 8000, 15000, 15000, 15000],
  );
  assert.equal(attempts, 6);
  retry.stop();
  assert.equal(tasks.at(-1)?.cancelled, true);
  await tasks.at(-1)!.fn();
  assert.equal(attempts, 6);
});
test('a stopped in-flight retry cannot restart itself or prevent a new generation', async () => {
  const jobs: (() => Promise<void>)[] = [];
  let reject: (error: Error) => void = () => {};
  const loop = new RetryLoop(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
    () => {},
    {
      set: ((fn: any) => {
        jobs.push(fn);
        return jobs.length;
      }) as any,
      clear: (() => {}) as any,
    },
  );
  loop.enable();
  loop.retry();
  const first = jobs[0]();
  loop.stop();
  loop.enable();
  loop.retry();
  assert.equal(jobs.length, 2);
  reject(new Error('obsolete'));
  await first;
  assert.equal(jobs.length, 2);
  loop.stop();
});
test('diagnostics identify the source module and UTF-16 line/column through CRLF and comments', () => {
  const source =
    '// module fake 🙂\r\nmodule first();endmodule\r\nmodule second();\r\n assign y = ?;\r\nendmodule';
  const start = source.indexOf('?'),
    d = locateDiagnostic(source, { message: 'bad expression', start, end: start + 1 });
  assert.equal(d.module, 'second');
  assert.equal(d.line, 4);
  assert.equal(d.column, 13);
  assert.equal(d.start, start);
});
