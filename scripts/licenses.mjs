// SPDX-License-Identifier: GPL-3.0-only
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  realpathSync,
  mkdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, dirname, resolve } from 'node:path';
const seen = new Set();
const packages = [];
function find(name, from) {
  let dir = from;
  while (true) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const up = dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}
function visit(path, runtime = false) {
  const actual = realpathSync(path);
  if (seen.has(actual)) return;
  seen.add(actual);
  const file = join(actual, 'package.json');
  if (!existsSync(file)) return;
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  if (!pkg.name || !pkg.version) return;
  const license = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'UNKNOWN');
  const files = readdirSync(actual).filter((n) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(n));
  packages.push({
    runtime,
    name: pkg.name,
    version: pkg.version,
    license,
    files: files.map((n) => join(actual, n)),
  });
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    const dep = find(name, actual);
    if (dep) visit(dep, runtime);
  }
}
const root = JSON.parse(readFileSync('package.json', 'utf8'));
for (const name of Object.keys(root.dependencies ?? {})) {
  const path = find(name, resolve('.'));
  if (path) visit(path, true);
}
for (const name of Object.keys(root.devDependencies ?? {})) {
  const path = find(name, resolve('.'));
  if (path) visit(path, false);
}
packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const permitted = new Set([
  'Artistic-2.0',
  'BlueOak-1.0.0',
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'Python-2.0',
  '(MIT OR Apache-2.0)',
  '(MIT AND Zlib)',
  'MPL-2.0',
  '(MIT OR GPL-3.0-or-later)',
  '(MIT OR CC0-1.0)',
]);
// The official VSIX packager brings a Microsoft-licensed helper. It is not a runtime
// dependency, is never shipped in the VSIX/app, and its build/signing script is disabled.
// Pin the exact reviewed license text; never treat arbitrary custom licenses as permitted.
const developmentHelper = (p) =>
  !p.runtime &&
  p.license === 'SEE LICENSE IN LICENSE.txt' &&
  ((p.name === '@vscode/vsce-sign' && p.version === '2.1.0') ||
    (/^@vscode\/vsce-sign-(?:win32|darwin|linux|alpine)-/.test(p.name) && p.version === '2.0.6')) &&
  p.files.some(
    (file) =>
      createHash('sha256').update(readFileSync(file)).digest('hex') ===
      '80780388a077c74609a5fc7ee1cc3d382740a5e48d87f7aac5a20cbddef3e91c',
  );
const unknown = packages.filter((p) => !permitted.has(p.license) && !developmentHelper(p));
mkdirSync('docs', { recursive: true });
writeFileSync(
  'docs/third-party-licenses.json',
  JSON.stringify(
    packages.map((p) => ({
      ...p,
      files: p.files.map((f) => relative(process.cwd(), f).replaceAll('\\', '/')),
    })),
    null,
    2,
  ) + '\n',
);
let notices =
  'Mira Graphical third-party notices\nGenerated from installed, locked dependency metadata. Original project code: GPL-3.0-only.\n\n';
for (const p of packages) {
  notices += `\n${'='.repeat(72)}\n${p.name}@${p.version} — ${p.license}\n`;
  for (const file of p.files)
    try {
      notices += `\n${readFileSync(file, 'utf8')}\n`;
    } catch {}
}
writeFileSync('docs/THIRD_PARTY_NOTICES.txt', notices);
console.log(
  `${packages.length} installed package versions audited; ${unknown.length} licenses need review; ${packages.filter(developmentHelper).length} reviewed development-only Microsoft helpers (not distributed).`,
);
if (unknown.length) {
  console.error(unknown.map((p) => `${p.name}: ${p.license}`).join('\n'));
  process.exitCode = 1;
}
