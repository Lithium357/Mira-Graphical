// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
const output = resolve('test-results'),
  root = resolve(`test-results/installer-${Date.now()}`);
mkdirSync(root, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
async function launch(executable, args, timeout = 120000) {
  await new Promise((ok, fail) => {
    const child = spawn(executable, args, { env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error('Installer smoke timed out'));
    }, timeout);
    child.once('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? ok() : fail(new Error(`${executable} exited ${code}`));
    });
  });
}
async function check(executable, name) {
  const workspace = join(root, name);
  mkdirSync(workspace);
  await launch(executable, ['--package-check', `--workspace=${workspace}`], 45000);
  const report = JSON.parse(readFileSync(join(workspace, 'package-check.json'), 'utf8'));
  assert(
    report.passed && report.packaged && report.preloadIPC && report.renderer && report.simulation,
  );
  return report;
}
const unpacked = resolve('dist/windows/win-unpacked');
for (const file of [
  'LICENSE.electron.txt',
  'LICENSES.chromium.html',
  'resources/LICENSE.txt',
  'resources/THIRD_PARTY_NOTICES.txt',
  'resources/Mira-Graphical-Source.zip',
  'resources/companion/mira-graphical.vsix',
])
  assert(existsSync(join(unpacked, file)), `Missing distribution file: ${file}`);
const reports = { unpacked: await check(join(unpacked, 'Mira Graphical.exe'), 'unpacked') };
// Only a disposable CI runner may exercise per-user registry/shortcut installation and removal.
if (process.env.CI) {
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const installed = join(root, 'installed');
  assert(!relative(root, installed).startsWith('..'));
  await launch(resolve(`dist/windows/Mira-Graphical-Setup-${version}-x64.exe`), [
    '/S',
    `/D=${installed}`,
  ]);
  try {
    reports.installed = await check(join(installed, 'Mira Graphical.exe'), 'installed-project');
  } finally {
    await launch(join(installed, 'Uninstall Mira Graphical.exe'), ['/S']);
  }
  const started = Date.now();
  while (existsSync(join(installed, 'Mira Graphical.exe')) && Date.now() - started < 15000)
    await new Promise((r) => setTimeout(r, 100));
  assert(
    !existsSync(join(installed, 'Mira Graphical.exe')),
    'Uninstall left the application executable',
  );
  reports.uninstalled = true;
}
writeFileSync(join(output, 'installer-smoke.json'), JSON.stringify(reports, null, 2));
console.log(JSON.stringify(reports));
