// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, openSync, readFileSync, writeFileSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { SmokeStateWriter, readSmokeState } from '../scripts/smoke-state.js';
test('editor smoke snapshots keep open reader data and survive incomplete publication', () => {
  const root = mkdtempSync(join(tmpdir(), 'mira-smoke-state-'));
  assert.equal(
    dirname(root),
    resolve(tmpdir()),
    'Cleanup target stays inside the temporary test directory',
  );
  let held: number | undefined;
  try {
    const writer = new SmokeStateWriter(root);
    writer.write('states.json', { version: 1, status: 'Applying' });
    const first = join(root, 'states.json', '000000001.json');
    held = openSync(first, 'r');
    writer.write('states.json', { version: 2, status: 'Synced' });
    assert.deepEqual(readSmokeState(root, 'states.json'), { version: 2, status: 'Synced' });
    assert.deepEqual(JSON.parse(readFileSync(held, 'utf8')), { version: 1, status: 'Applying' });
    new SmokeStateWriter(root).write('states.json', { version: 3, status: 'Pending' });
    assert.equal(readSmokeState(root, 'states.json').version, 3);
    writeFileSync(join(root, 'states.json', '000000004.json'), '{');
    assert.equal(
      readSmokeState(root, 'states.json').version,
      3,
      'Reader ignores a snapshot still being written',
    );
    writeFileSync(
      join(root, 'states.json', '000000004.json'),
      JSON.stringify({ version: 4, status: 'Synced' }),
    );
    assert.equal(readSmokeState(root, 'states.json').version, 4);
  } finally {
    if (held !== undefined) closeSync(held);
    rmSync(root, { recursive: true, force: true });
  }
});
