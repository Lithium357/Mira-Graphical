// SPDX-License-Identifier: GPL-3.0-only
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const snapshots = (directory: string) =>
  readdirSync(directory)
    .filter((name) => /^\d{9}\.json$/.test(name))
    .sort();
/** Immutable test messages avoid replacing files while Windows editor readers hold them. */
export class SmokeStateWriter {
  private sequences = new Map<string, number>();
  constructor(private root: string) {}
  write(channel: string, value: unknown) {
    const directory = join(this.root, channel);
    mkdirSync(directory, { recursive: true });
    const previous =
      this.sequences.get(channel) ?? Number(snapshots(directory).at(-1)?.slice(0, 9) ?? 0);
    const sequence = previous + 1;
    this.sequences.set(channel, sequence);
    writeFileSync(
      join(directory, String(sequence).padStart(9, '0') + '.json'),
      JSON.stringify(value),
      { flag: 'wx' },
    );
  }
}
export function readSmokeState(root: string, channel: string): any {
  const directory = join(root, channel);
  let lastError: unknown = new Error('No smoke state published: ' + channel);
  for (const file of snapshots(directory).reverse()) {
    try {
      return JSON.parse(readFileSync(join(directory, file), 'utf8'));
    } catch (error) {
      if (
        !(error instanceof SyntaxError) &&
        !['EACCES', 'EPERM', 'EBUSY', 'ENOENT'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error;
      lastError = error;
    }
  }
  throw lastError;
}
