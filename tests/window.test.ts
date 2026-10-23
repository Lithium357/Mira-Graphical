// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreBounds } from '../apps/graph/window-state.js';
const primary = { x: 0, y: 0, width: 1920, height: 1040 },
  secondary = { x: -1920, y: 0, width: 1920, height: 1080 };
test('window stays on a connected second monitor', () => {
  const b = { x: -1700, y: 90, width: 1200, height: 800, maximized: false };
  assert.deepEqual(restoreBounds(b, [primary, secondary]), b);
});
test('window recovers onto a visible display when a monitor disconnects', () => {
  const b = restoreBounds({ x: -1700, y: 90, width: 1200, height: 800, maximized: true }, [
    primary,
  ]);
  assert.equal(b.x, 0);
  assert.equal(b.maximized, true);
  assert(b.y! >= 0 && b.y! + b.height! <= 1040);
});
test('corrupt and oversized window data is bounded safely', () => {
  assert.deepEqual(restoreBounds({ x: NaN, y: 0, width: 900, height: 600 }, [primary]), {});
  const b = restoreBounds({ x: 99999, y: -99999, width: 99999, height: 99999 }, [primary]);
  assert.deepEqual(b, { ...primary, maximized: false });
});
