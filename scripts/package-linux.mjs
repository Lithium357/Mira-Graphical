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
import { resolve, join, relative, isAbsolute, dirname, basename } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

if (process.platform !== 'linux' || process.arch !== 'x64')
  throw new Error('Build the Debian amd64 package on x64 Linux.');
const root = process.cwd();
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const changes = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
  encoding: 'utf8',
}).trim();
if (changes)
  throw new Error(
    `Debian packaging requires a clean checkout so included source matches the app:\n${changes}`,
  );
const electronDist = dirname(createRequire(import.meta.url)('electron'));
if (
  readFileSync(join(electronDist, 'version'), 'utf8').trim() !== manifest.devDependencies.electron
)
  throw new Error('Electron runtime does not match the locked Linux build.');
const stage = resolve('dist/linux-stage'),
  output = resolve('dist/linux');
if (existsSync(stage)) {
  const actual = realpathSync(stage),
    within = relative(realpathSync(root), actual);
  if (
    lstatSync(stage).isSymbolicLink() ||
    lstatSync(resolve('dist')).isSymbolicLink() ||
    within !== join('dist', 'linux-stage') ||
    isAbsolute(within)
  )
    throw new Error('Refusing to replace an unexpected Linux staging directory.');
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
      author: { name: 'Mason Turlington', email: 'Lithium357@users.noreply.github.com' },
      homepage: 'https://github.com/Lithium357/Mira-Graphical',
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
  throw new Error('Development smoke code leaked into the Linux app.');
cpSync('dist/apps/graph/preload.cjs', join(stage, 'dist/apps/graph/preload.cjs'));
cpSync('apps/graph/dist', join(stage, 'apps/graph/dist'), { recursive: true });
cpSync('LICENSE', join(stage, 'LICENSE'));
cpSync('build/mira.png', join(stage, 'icon.png'));
const notices = 'dist/linux-licenses/THIRD_PARTY_NOTICES.txt';
cpSync(notices, join(stage, 'THIRD_PARTY_NOTICES.txt'));
execFileSync('git', [
  'archive',
  '--format=zip',
  `--output=${join(output, 'Mira-Graphical-Source.zip')}`,
  'HEAD',
]);
const artifacts = await build({
  targets: Platform.LINUX.createTarget(['deb'], Arch.x64),
  publish: 'never',
  config: {
    appId: 'com.lithium357.miragraphical',
    productName: 'Mira Graphical',
    executableName: 'mira-graphical',
    directories: { app: stage, output, buildResources: resolve('build') },
    electronVersion: manifest.devDependencies.electron,
    electronDist,
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    files: [
      'package.json',
      'dist/apps/graph/**',
      'apps/graph/dist/**',
      'LICENSE',
      'icon.png',
      'THIRD_PARTY_NOTICES.txt',
    ],
    extraResources: [
      { from: 'dist/editors/mira-lsp.cjs', to: 'editors/mira-lsp.cjs' },
      { from: 'build/editors/mira-lsp.sh', to: 'editors/mira-lsp.sh' },
      { from: 'docs/editors.md', to: 'editors/README.md' },
      {
        from: `dist/packages/mira-graphical-${manifest.version}.vsix`,
        to: 'companion/mira-graphical.vsix',
      },
      { from: join(output, 'Mira-Graphical-Source.zip'), to: 'Mira-Graphical-Source.zip' },
      { from: 'LICENSE', to: 'LICENSE.txt' },
      { from: notices, to: 'THIRD_PARTY_NOTICES.txt' },
    ],
    linux: {
      target: 'deb',
      category: 'Development',
      icon: resolve('build/mira.png'),
      artifactName: 'Mira-Graphical-${version}-amd64.deb',
      desktop: {
        entry: {
          Name: 'Mira Graphical',
          Comment: 'Build and explore HDL circuits',
          StartupWMClass: 'mira-graphical',
        },
      },
    },
    deb: {
      packageName: 'mira-graphical',
      priority: 'optional',
      depends: [
        'libc6 (>= 2.36)',
        'libstdc++6',
        'libgtk-3-0 | libgtk-3-0t64',
        'libnss3',
        'libasound2 | libasound2t64',
        'libgbm1',
        'libx11-xcb1',
        'libxss1',
        'libxtst6',
        'libatspi2.0-0 | libatspi2.0-0t64',
        'libnotify4',
        'xdg-utils',
        'libsecret-1-0',
        'libuuid1',
      ],
    },
  },
});
const deb = artifacts.find((p) => p.endsWith('.deb'));
if (!deb || !existsSync(deb)) throw new Error('Debian package was not created.');
const inventory = [deb, join(output, 'Mira-Graphical-Source.zip')].map((file) => ({
  file: basename(file),
  bytes: readFileSync(file).length,
  sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
}));
writeFileSync(
  join(output, 'manifest.json'),
  JSON.stringify(
    {
      version: manifest.version,
      revision,
      dirty: false,
      platform: 'linux-x64',
      format: 'deb',
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
console.log(`Debian package: ${deb}`);
