// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, resolve, relative } from 'node:path';
const output = resolve('test-results'),
  root = resolve(`test-results/installer-${Date.now()}`);
mkdirSync(root, { recursive: true });
const env = { ...process.env };
const installerConfig = JSON.parse(readFileSync('build/windows-installer.json', 'utf8'));
delete env.ELECTRON_RUN_AS_NODE;
async function launch(executable, args, timeout = 120000, expectedCode = 0) {
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
      code === expectedCode
        ? ok()
        : fail(new Error(`${executable} exited ${code}; expected ${expectedCode}`));
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
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const psQuote = (value) => "'" + value.replaceAll("'", "''") + "'";
function powershell(script) {
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { encoding: 'utf8', windowsHide: true },
  ).trim();
}
function installedInfo() {
  const base = `HKCU:\\Software\\${installerConfig.guid}`;
  const key = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${installerConfig.guid}`;
  return JSON.parse(
    powershell(
      `$a=Get-ItemProperty -LiteralPath ${psQuote(base)} -ErrorAction SilentlyContinue; $u=Get-ItemProperty -LiteralPath ${psQuote(key)} -ErrorAction SilentlyContinue; $entries=@(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -like 'Mira Graphical*'}); [pscustomobject]@{version=$u.DisplayVersion;location=$a.InstallLocation;entries=$entries.Count} | ConvertTo-Json -Compress`,
    ),
  );
}
// Only a disposable CI runner may exercise per-user registry/shortcut installation and removal.
if (process.env.CI) {
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const installed = join(root, 'custom install location');
  assert(!relative(root, installed).startsWith('..'));
  assert.equal(
    installedInfo().entries,
    0,
    'Upgrade testing requires a clean disposable user profile',
  );
  const baseline = installerConfig.upgradeBaseline;
  const baselineFile = join(root, `baseline-${baseline.version}.exe`);
  const response = await fetch(baseline.url);
  assert(response.ok && response.body, `Could not download upgrade baseline: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(baselineFile));
  assert.equal(
    digest(baselineFile),
    baseline.sha256,
    'Upgrade baseline must match the published tested installer',
  );
  const setup = resolve(`dist/windows/Mira-Graphical-Setup-${version}-x64.exe`);
  const executable = join(installed, 'Mira Graphical.exe');
  await launch(baselineFile, ['/S', `/D=${installed}`]);
  try {
    assert.deepEqual(installedInfo(), {
      version: baseline.version,
      location: installed,
      entries: 1,
    });
    reports.baseline = await check(executable, 'baseline-project');
    const project = join(root, 'preserved-project');
    const profile = join(process.env.APPDATA, 'Mira Graphical');
    mkdirSync(join(project, '.hdlgraph'), { recursive: true });
    mkdirSync(profile, { recursive: true });
    const protectedFiles = [
      join(project, 'design.v'),
      join(project, '.hdlgraph', 'recovery-upgrade.json'),
      join(profile, 'installer-upgrade-sentinel.txt'),
    ];
    for (const file of protectedFiles) writeFileSync(file, 'preserve through upgrade and repair');
    const assertPreserved = () =>
      protectedFiles.forEach((file) =>
        assert.equal(readFileSync(file, 'utf8'), 'preserve through upgrade and repair'),
      );
    const obsolete = join(installed, 'obsolete-upgrade-sentinel.txt');
    writeFileSync(obsolete, 'old application file');
    const before = digest(executable);
    await launch('powershell.exe', [
      '-NoProfile',
      '-File',
      resolve('scripts/installer-prompt-check.ps1'),
      '-Installer',
      setup,
      '-OldVersion',
      baseline.version,
      '-NewVersion',
      version,
      '-InstallLocation',
      installed,
    ]);
    assert.equal(installedInfo().version, baseline.version);
    assert.equal(
      digest(executable),
      before,
      'Declining replacement must leave the installed app unchanged',
    );
    assert(existsSync(obsolete));
    reports.cancelledReplacement = true;
    // No /D: discovery must retain the older custom location rather than install a second copy.
    await launch(setup, ['/S']);
    assert.deepEqual(installedInfo(), { version, location: installed, entries: 1 });
    assert(!existsSync(obsolete), 'Upgrade must remove old application files');
    assertPreserved();
    reports.installed = await check(executable, 'installed-project');
    assert.equal(
      digest(join(installed, 'resources', 'app.asar')),
      digest(join(unpacked, 'resources', 'app.asar')),
      'Installed runtime must be the new bundle',
    );
    const binaryVersion = powershell(
      `(Get-Item -LiteralPath ${psQuote(executable)}).VersionInfo.ProductVersion`,
    );
    assert.equal(
      binaryVersion.match(/^\d+\.\d+\.\d+/)?.[0],
      version,
      'Installed EXE must report the new version',
    );
    reports.upgrade = {
      from: baseline.version,
      to: version,
      sameLocation: true,
      singleEntry: true,
      dataPreserved: true,
      oldFilesRemoved: true,
    };
    writeFileSync(obsolete, 'old repair file');
    await launch(setup, ['/S']);
    assert.deepEqual(installedInfo(), { version, location: installed, entries: 1 });
    assert(!existsSync(obsolete));
    assertPreserved();
    reports.repair = await check(executable, 'repaired-project');
    assert.equal(
      digest(join(installed, 'resources', 'app.asar')),
      digest(join(unpacked, 'resources', 'app.asar')),
    );
    const versionKey = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${installerConfig.guid}`;
    const currentDigest = digest(executable);
    try {
      // Exercise the compiled downgrade guard without building or publishing a fake future release.
      powershell(
        `Set-ItemProperty -LiteralPath ${psQuote(versionKey)} -Name DisplayVersion -Value '99.0.0'`,
      );
      await launch(setup, ['/S'], 120000, 1638);
      assert.equal(installedInfo().version, '99.0.0');
      assert.equal(digest(executable), currentDigest);
      assertPreserved();
      reports.downgradeBlocked = true;
    } finally {
      powershell(
        `Set-ItemProperty -LiteralPath ${psQuote(versionKey)} -Name DisplayVersion -Value ${psQuote(version)}`,
      );
    }
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
  assert.equal(installedInfo().entries, 0, 'Uninstall must remove the single app registration');
  // Also preserve the original fresh-install path after exercising the upgrade policy.
  const fresh = join(root, 'fresh install');
  assert(!relative(root, fresh).startsWith('..'));
  await launch(setup, ['/S', `/D=${fresh}`]);
  try {
    assert.deepEqual(installedInfo(), { version, location: fresh, entries: 1 });
    reports.fresh = await check(join(fresh, 'Mira Graphical.exe'), 'fresh-project');
  } finally {
    await launch(join(fresh, 'Uninstall Mira Graphical.exe'), ['/S']);
  }
  const freshUninstallStart = Date.now();
  while (existsSync(join(fresh, 'Mira Graphical.exe')) && Date.now() - freshUninstallStart < 15000)
    await new Promise((r) => setTimeout(r, 100));
  assert(!existsSync(join(fresh, 'Mira Graphical.exe')));
  assert.equal(installedInfo().entries, 0);
}
writeFileSync(join(output, 'installer-smoke.json'), JSON.stringify(reports, null, 2));
console.log(JSON.stringify(reports));
