// SPDX-License-Identifier: GPL-3.0-only
import { build as bundle } from 'esbuild';
import { build as vite } from 'vite';
import { copyFileSync, existsSync } from 'node:fs';
await bundle({
  entryPoints: ['packages/lsp/cli.ts'],
  outfile: 'dist/editors/mira-lsp.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
});
await bundle({
  entryPoints: ['extensions/vscode/extension.ts'],
  outfile: 'extensions/vscode/dist/extension.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
});
await bundle({
  entryPoints: ['extensions/vscode/smoke.ts'],
  outfile: 'extensions/vscode/dist/smoke.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
});
await bundle({
  entryPoints: ['apps/graph/preload.ts'],
  outfile: 'dist/apps/graph/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});
await vite({
  root: 'apps/graph',
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
  logLevel: 'warn',
});
copyFileSync('LICENSE', 'extensions/vscode/LICENSE');
const notices = process.env.MIRA_NOTICES_FILE ?? 'docs/THIRD_PARTY_NOTICES.txt';
if (existsSync(notices)) copyFileSync(notices, 'extensions/vscode/THIRD_PARTY_NOTICES.txt');
