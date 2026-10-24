// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { RecoveryStore } from '../packages/core/recovery.js';
test(
  'hard-killing a process with an unflushed construction draft preserves both live buffer and draft',
  { timeout: 30000 },
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'mira-hard-kill-'));
    mkdirSync(join(workspace, '.hdlgraph'));
    const original = readFileSync('fixtures/adder.v', 'utf8');
    writeFileSync(join(workspace, 'source.v'), original);
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', resolve('tests/helpers/recovery-child.ts'), workspace],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let output = '',
      errors = '';
    child.stderr.on('data', (data) => {
      errors += data;
    });
    const exited = once(child, 'exit');
    try {
      await new Promise<void>((ok, fail) => {
        const timeout = setTimeout(() => fail(new Error(`Checkpoint timeout: ${errors}`)), 20000);
        child.stdout.on('data', (data) => {
          output += data;
          if (output.includes('CHECKPOINT_READY')) {
            clearTimeout(timeout);
            ok();
          }
        });
        child.once('error', (e) => {
          clearTimeout(timeout);
          fail(e);
        });
        child.once('exit', () => {
          clearTimeout(timeout);
          fail(new Error(`Premature exit: ${errors}`));
        });
      });
      assert(child.kill('SIGKILL'));
      await exited;
      const restarted = new RecoveryStore(join(workspace, '.hdlgraph'), workspace);
      const entries = restarted.list();
      assert.equal(entries.length, 1);
      const snapshot = restarted.read(entries[0].id);
      assert.equal(snapshot.version, 3);
      assert.equal(snapshot.text, '// unsaved buffer\n' + original);
      assert(snapshot.previewText?.includes('assign pending_sum'));
      assert.equal(snapshot.graphActions?.length, 1);
      assert.equal(readFileSync(join(workspace, 'source.v'), 'utf8'), original);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
      assert.equal(dirname(resolve(workspace)), resolve(tmpdir()));
      assert(workspace.includes('mira-hard-kill-'));
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);
