// SPDX-License-Identifier: GPL-3.0-only
import { createVSIX, listFiles, PackageManager } from '@vscode/vsce';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
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
writeFileSync(
  'dist/packages/manifest.json',
  JSON.stringify(
    { version: manifest.version, package: packagePath, files, signing: false },
    null,
    2,
  ),
);
console.log(`Verified VSIX file list: ${packagePath}`);
