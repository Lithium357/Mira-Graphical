// SPDX-License-Identifier: GPL-3.0-only
import type { Edit } from '../protocol/index.js';
type Piece = { start: number; end: number } | { text: string };
/** Compose local edits without turning a construction session into a document rewrite. */
export class PatchDraft {
  private pieces: Piece[];
  constructor(
    readonly base: string,
    pieces?: Piece[],
  ) {
    this.pieces = pieces ? structuredClone(pieces) : [{ start: 0, end: base.length }];
  }
  clone() {
    return new PatchDraft(this.base, this.pieces);
  }
  get text() {
    return this.pieces
      .map((p) => ('text' in p ? p.text : this.base.slice(p.start, p.end)))
      .join('');
  }
  private slice(start: number, end: number) {
    const result: Piece[] = [];
    let cursor = 0;
    for (const p of this.pieces) {
      const length = 'text' in p ? p.text.length : p.end - p.start;
      const a = Math.max(start, cursor),
        b = Math.min(end, cursor + length);
      if (a < b)
        result.push(
          'text' in p
            ? { text: p.text.slice(a - cursor, b - cursor) }
            : { start: p.start + a - cursor, end: p.start + b - cursor },
        );
      cursor += length;
    }
    return result;
  }
  apply(edits: Edit[]) {
    let bound = this.text.length;
    for (const e of [...edits].sort((a, b) => b.start - a.start)) {
      if (
        !Number.isSafeInteger(e.start) ||
        !Number.isSafeInteger(e.end) ||
        e.start < 0 ||
        e.end < e.start ||
        e.end > bound ||
        typeof e.text !== 'string'
      )
        throw new Error('Invalid or overlapping construction spans.');
      const length = this.text.length;
      this.pieces = [
        ...this.slice(0, e.start),
        ...(e.text ? [{ text: e.text }] : []),
        ...this.slice(e.end, length),
      ];
      bound = e.start;
    }
  }
  edits(): Edit[] {
    const edits: Edit[] = [];
    let cursor = 0,
      text = '';
    for (const p of this.pieces) {
      if ('text' in p) {
        text += p.text;
        continue;
      }
      if (p.start < cursor) throw new Error('Construction reordered original source.');
      if (p.start > cursor || text) {
        edits.push({ start: cursor, end: p.start, text });
        text = '';
      }
      cursor = p.end;
    }
    if (cursor < this.base.length || text)
      edits.push({ start: cursor, end: this.base.length, text });
    return edits
      .filter((e) => this.base.slice(e.start, e.end) !== e.text)
      .sort((a, b) => b.start - a.start);
  }
}
