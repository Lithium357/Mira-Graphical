// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLivePatch } from '../extensions/vscode/patch.js';
import { hash } from '../packages/core/index.js';
test('extension patch adapter modifies an unsaved buffer with guarded UTF-16 edits', async () => {
  let text = '// 🙂\r\nmodule m(input a,b,output sum);assign sum = a + b;endmodule';
  let version = 7;
  let calls = 0;
  const start = text.indexOf('+');
  const buffer = {
    text: () => text,
    version: () => version,
    apply: async (edits: any[]) => {
      calls++;
      for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);
      version++;
      return true;
    },
  };
  const p = {
    baseVersion: version,
    baseHash: hash(text),
    edits: [{ start, end: start + 1, text: '*' }],
  };
  assert((await applyLivePatch(buffer, p, hash)).ok);
  assert.equal(text, '// 🙂\r\nmodule m(input a,b,output sum);assign sum = a * b;endmodule');
  assert(!(await applyLivePatch(buffer, p, hash)).ok);
  assert.equal(calls, 1);
});
test('extension rejects whole-document, overlapping and non-operator edits', async () => {
  const text = 'a + b';
  let calls = 0;
  const doc = {
    text: () => text,
    version: () => 1,
    apply: async () => {
      calls++;
      return true;
    },
  };
  for (const edits of [
    [{ start: 0, end: 5, text: '*' }],
    [
      { start: 2, end: 3, text: '*' },
      { start: 2, end: 3, text: '-' },
    ],
    [{ start: 2, end: 3, text: 'arbitrary' }],
  ])
    assert(!(await applyLivePatch(doc, { baseVersion: 1, baseHash: hash(text), edits }, hash)).ok);
  assert.equal(calls, 0);
});
