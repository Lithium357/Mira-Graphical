// SPDX-License-Identifier: GPL-3.0-only
import { createVSIX, listFiles, PackageManager } from '@vscode/vsce';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const cwd = resolve('extensions/vscode');
const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
const files = await listFiles({ cwd, packageManager: PackageManager.None });
const expected = new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.txt',
  'dist/extension.cjs',
]);
if (
  files.length !== expected.size ||
  files.some((file) => !expected.has(file.replaceAll('\\', '/')))
)
  throw new Error(`Unexpected VSIX contents: ${files.join(', ')}`);
mkdirSync('dist/packages', { recursive: true });
const packagePath = resolve(`dist/packages/mira-graphical-${manifest.version}.vsix`);
await createVSIX({ cwd, packagePath, dependencies: false, githubBranch: 'main' });
const name = `mira-graphical-${manifest.version}.vsix`;
const bytes = readFileSync(packagePath);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const changes = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
  encoding: 'utf8',
}).trim();
const dirty = !!changes;
if (process.env.CI && dirty) throw new Error(`CI packaging requires a clean checkout:\n${changes}`);
writeFileSync(
  'dist/packages/manifest.json',
  JSON.stringify(
    {
      schemaVersion: 1,
      version: manifest.version,
      revision,
      dirty,
      package: name,
      bytes: bytes.length,
      sha256,
      files,
      signing: false,
      node: process.version,
    },
    null,
    2,
  ),
);
const manifestHash = createHash('sha256')
  .update(readFileSync('dist/packages/manifest.json'))
  .digest('hex');
writeFileSync('dist/packages/SHA256SUMS', `${sha256}  ${name}\n${manifestHash}  manifest.json\n`);
console.log(`Verified VSIX file list: ${packagePath}`);
