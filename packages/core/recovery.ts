// SPDX-License-Identifier: GPL-3.0-only
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Recovery } from './index.js';

const limit = 12 * 1024 * 1024;
const validId = /^(?:recovery-[0-9]+-[0-9a-f-]{36}|checkpoint-[0-9a-f]{64})\.json$/;
export type RecoveryEntry = {
  id: string;
  at: string;
  bytes: number;
  checkpoint: boolean;
  uri?: string;
  reason?: string;
};
/** Local source snapshots are inert data; opening one never replays its saved actions. */
export type RecoverySnapshot = Recovery & { snapshotHash: string };
export const recoveryFingerprint = (snapshot: Recovery) =>
  createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
export class RecoveryStore {
  private initialized = new Set<string>();
  constructor(
    readonly directory: string,
    private workspace: string,
  ) {}
  private checkDirectory() {
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Recovery directory must be a regular workspace directory.');
  }
  private path(id: string) {
    this.checkDirectory();
    if (!validId.test(id)) throw new Error('Invalid recovery identifier.');
    return join(this.directory, id);
  }
  private validate(value: unknown): Recovery {
    if (!value || typeof value !== 'object') throw new Error('Invalid recovery file.');
    const r = value as Recovery;
    if (
      typeof r.uri !== 'string' ||
      r.uri.length > 8192 ||
      typeof r.text !== 'string' ||
      r.text.length > 1_000_000 ||
      (r.previewText !== undefined &&
        (typeof r.previewText !== 'string' || r.previewText.length > 1_000_000)) ||
      typeof r.reason !== 'string' ||
      r.reason.length > 2000 ||
      typeof r.at !== 'string' ||
      !Number.isFinite(Date.parse(r.at)) ||
      !Number.isSafeInteger(r.version) ||
      r.version < 0 ||
      !Array.isArray(r.graphEdits)
    )
      throw new Error('Unsupported recovery data.');
    const url = new URL(r.uri),
      rel = relative(this.workspace, fileURLToPath(url));
    if (url.protocol !== 'file:' || url.host || !rel || rel.startsWith('..') || isAbsolute(rel))
      throw new Error('Recovery document is outside this workspace.');
    return r;
  }
  read(id: string): Recovery {
    const path = this.path(id),
      stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
      throw new Error('Recovery must be a regular file within the size limit.');
    return this.validate(JSON.parse(readFileSync(path, 'utf8')));
  }
  inspect(id: string): RecoverySnapshot {
    const saved = this.read(id);
    return { ...saved, snapshotHash: recoveryFingerprint(saved) };
  }
  list(): RecoveryEntry[] {
    this.checkDirectory();
    const entries = readdirSync(this.directory)
      .filter((id) => validId.test(id))
      .flatMap((id) => {
        try {
          const stat = lstatSync(this.path(id));
          return stat.isFile() && !stat.isSymbolicLink()
            ? [
                {
                  id,
                  at: stat.mtime.toISOString(),
                  bytes: stat.size,
                  checkpoint: id.startsWith('checkpoint-'),
                },
              ]
            : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
      .slice(0, 100);
    let remaining = 8 * 1024 * 1024;
    return entries.map((entry) => {
      if (entry.bytes > remaining) return entry;
      remaining -= entry.bytes;
      try {
        const r = this.read(entry.id);
        return { ...entry, uri: r.uri, reason: r.reason };
      } catch {
        return entry;
      }
    });
  }
  private write(id: string, value: Recovery) {
    this.validate(value);
    const path = this.path(id),
      text = JSON.stringify(value, null, 2);
    if (Buffer.byteLength(text) > limit) throw new Error('Recovery exceeds the size limit.');
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new Error('Recovery files must not be symbolic links.');
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  archive(value: Recovery) {
    const id = `recovery-${Date.now()}-${randomUUID()}.json`;
    this.write(id, value);
    return id;
  }
  checkpoint(value: Recovery) {
    const id = `checkpoint-${createHash('sha256').update(value.uri).digest('hex')}.json`;
    if (!this.initialized.has(id)) {
      if (existsSync(this.path(id))) {
        const previous = this.read(id);
        if (
          previous.text !== value.text ||
          previous.previewText !== value.previewText ||
          JSON.stringify([previous.graphEdits, previous.graphActions]) !==
            JSON.stringify([value.graphEdits, value.graphActions])
        )
          this.archive({
            ...previous,
            reason: 'Previous session checkpoint: ' + previous.reason.slice(0, 1900),
          });
      }
      this.initialized.add(id);
    }
    this.write(id, value);
  }
}
