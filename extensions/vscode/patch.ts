// SPDX-License-Identifier: GPL-3.0-only
import type { Edit } from '../../packages/protocol/index.js';
import { validateEditableEdits } from '../../packages/verilog/index.js';
export interface LiveBuffer {
  version(): number;
  text(): string;
  apply(edits: Edit[]): Promise<boolean>;
}
export async function applyLivePatch(
  doc: LiveBuffer,
  p: { baseVersion: number; baseHash: string; edits: Edit[] },
  hash: (text: string) => string,
) {
  const fail = (error: string) => ({
    ok: false,
    currentVersion: doc.version(),
    text: doc.text(),
    error,
  });
  const original = doc.text();
  if (doc.version() !== p.baseVersion || hash(original) !== p.baseHash)
    return fail('Live buffer revision or hash mismatch.');
  if (!Array.isArray(p.edits) || !p.edits.length || p.edits.length > 256)
    return fail('Invalid patch.');
  const edits = [...p.edits].sort((a, b) => b.start - a.start);
  let bound = original.length;
  for (const e of edits) {
    if (
      !Number.isInteger(e.start) ||
      !Number.isInteger(e.end) ||
      e.start < 0 ||
      e.end <= e.start ||
      e.end > bound ||
      typeof e.text !== 'string' ||
      e.text.length > 8192
    )
      return fail('Invalid or overlapping editable span.');
    bound = e.start;
  }
  try {
    validateEditableEdits(original, edits);
  } catch (error) {
    return fail(String(error));
  }
  const expected = edits.reduce(
    (text, e) => text.slice(0, e.start) + e.text + text.slice(e.end),
    original,
  );
  const applied = await doc.apply(edits);
  if (!applied || doc.text() !== expected)
    return fail('Patch failed or buffer changed concurrently.');
  return { ok: true, currentVersion: doc.version(), text: doc.text() };
}
