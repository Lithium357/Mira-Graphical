// SPDX-License-Identifier: GPL-3.0-only
import { build as bundle } from 'esbuild';
import { build, Platform, Arch } from 'electron-builder';
import {
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
if (process.platform !== 'win32') throw new Error('Build the Windows installer on Windows.');
const root = process.cwd(),
  manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const installerConfig = JSON.parse(readFileSync('build/windows-installer.json', 'utf8'));
// Electron's official entry point initializes its pinned binary when pnpm's store lacks it.
const electronDist = dirname(createRequire(import.meta.url)('electron'));
if (
  readFileSync(join(electronDist, 'version'), 'utf8').trim() !== manifest.devDependencies.electron
)
  throw new Error('Electron runtime version does not match the locked Windows build.');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const changes = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
  encoding: 'utf8',
}).trim();
if (changes)
  throw new Error(
    `Windows release packaging requires a clean checkout so the included source matches the application. Commit changes first:\n${changes}`,
  );
const stage = resolve('dist/windows-stage'),
  output = resolve('dist/windows');
if (existsSync(stage)) {
  const actual = realpathSync(stage),
    within = relative(realpathSync(root), actual);
  if (
    lstatSync(stage).isSymbolicLink() ||
    lstatSync(resolve('dist')).isSymbolicLink() ||
    within !== join('dist', 'windows-stage') ||
    isAbsolute(within)
  )
    throw new Error('Refusing to replace an unexpected Windows staging directory.');
  rmSync(actual, { recursive: true, force: true });
}
mkdirSync(stage, { recursive: true });
mkdirSync(output, { recursive: true });
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'mira-graphical',
      productName: 'Mira Graphical',
      version: manifest.version,
      description: 'Verilog, SystemVerilog and VHDL circuit workbench',
      author: 'Mason Turlington',
      license: 'GPL-3.0-only',
      type: 'module',
      main: 'dist/apps/graph/main.js',
    },
    null,
    2,
  ),
);
await bundle({
  entryPoints: ['apps/graph/main.ts'],
  outfile: join(stage, 'dist/apps/graph/main.js'),
  platform: 'node',
  format: 'esm',
  bundle: true,
  external: ['electron'],
  target: 'node24',
  define: { 'process.env.MIRA_SMOKE_BUILD': '"false"' },
  minifySyntax: true,
  banner: {
    js: 'import { createRequire as __miraCreateRequire } from "node:module"; const require = __miraCreateRequire(import.meta.url);',
  },
});
const runtime = readFileSync(join(stage, 'dist/apps/graph/main.js'), 'utf8');
if (runtime.includes('DESKTOP SMOKE PASSED') || runtime.includes('VS CODE SMOKE PASS'))
  throw new Error('Development smoke code leaked into the app bundle.');
cpSync('dist/apps/graph/preload.cjs', join(stage, 'dist/apps/graph/preload.cjs'));
cpSync('apps/graph/dist', join(stage, 'apps/graph/dist'), { recursive: true });
cpSync('LICENSE', join(stage, 'LICENSE'));
cpSync('build/mira.ico', join(stage, 'icon.ico'));
cpSync('docs/THIRD_PARTY_NOTICES.txt', join(stage, 'THIRD_PARTY_NOTICES.txt'));
// Clean CI builds ship the corresponding source for this exact revision.
execFileSync('git', [
  'archive',
  '--format=zip',
  `--output=${join(output, 'Mira-Graphical-Source.zip')}`,
  'HEAD',
]);
const artifacts = await build({
  targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
  publish: 'never',
  config: {
    appId: installerConfig.appId,
    productName: 'Mira Graphical',
    executableName: 'Mira Graphical',
    directories: { app: stage, output, buildResources: resolve('build') },
    electronVersion: manifest.devDependencies.electron,
    electronDist,
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    forceCodeSigning: false,
    files: [
      'package.json',
      'dist/apps/graph/**',
      'apps/graph/dist/**',
      'LICENSE',
      'icon.ico',
      'THIRD_PARTY_NOTICES.txt',
    ],
    extraResources: [
      {
        from: `dist/packages/mira-graphical-${manifest.version}.vsix`,
        to: 'companion/mira-graphical.vsix',
      },
      { from: join(output, 'Mira-Graphical-Source.zip'), to: 'Mira-Graphical-Source.zip' },
      { from: 'LICENSE', to: 'LICENSE.txt' },
      { from: 'docs/THIRD_PARTY_NOTICES.txt', to: 'THIRD_PARTY_NOTICES.txt' },
    ],
    win: {
      target: 'nsis',
      signExecutable: false,
      icon: resolve('build/mira.ico'),
      verifyUpdateCodeSignature: false,
      artifactName: 'Mira-Graphical-Setup-${version}-x64.exe',
    },
    nsis: {
      guid: installerConfig.guid,
      include: resolve('build/installer.nsh'),
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'Mira Graphical',
      runAfterFinish: true,
      deleteAppDataOnUninstall: false,
      license: resolve('LICENSE'),
    },
  },
});
const installer = artifacts.find((path) => path.endsWith('.exe'));
if (!installer || !existsSync(installer)) throw new Error('Installer was not created.');
const inventory = [installer, join(output, 'Mira-Graphical-Source.zip')].map((path) => ({
  file: path.slice(output.length + 1),
  bytes: readFileSync(path).length,
  sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
}));
writeFileSync(
  join(output, 'manifest.json'),
  JSON.stringify(
    {
      version: manifest.version,
      revision,
      dirty: !!changes,
      platform: 'win32-x64',
      signed: false,
      files: inventory,
    },
    null,
    2,
  ),
);
writeFileSync(
  join(output, 'SHA256SUMS'),
  inventory.map((f) => `${f.sha256}  ${f.file}`).join('\n') + '\n',
);
console.log(`Windows installer: ${installer}`);
