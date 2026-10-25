// SPDX-License-Identifier: GPL-3.0-only
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  createWriteStream,
  readdirSync,
  existsSync,
} from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runTests, runVSCodeCommand } from '@vscode/test-electron';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { SyncService } from '../packages/core/service.js';
import { SmokeStateWriter } from './smoke-state.js';
const root = process.cwd();
const output = join(root, 'test-results');
mkdirSync(output, { recursive: true });
const stamp = Date.now();
const workspace = join(output, `smoke-workspace-${stamp}`);
mkdirSync(workspace);
const smokeStates = new SmokeStateWriter(join(workspace, '.hdlgraph'));
function writeSmokeState(name: string, value: unknown) {
  smokeStates.write(name, value);
}
for (const name of ['adder', 'combinational', 'hierarchy'])
  writeFileSync(join(workspace, `${name}.v`), readFileSync(`fixtures/${name}.v`));
for (const ext of ['sv', 'vhd', 'vhdl'])
  writeFileSync(
    join(workspace, `hierarchy.${ext}`),
    readFileSync(`fixtures/hierarchy.${ext === 'vhdl' ? 'vhd' : ext}`),
  );
writeFileSync(
  join(workspace, 'hierarchy.signed.v'),
  readFileSync('fixtures/hierarchy.v', 'utf8').replace('a + b', '$signed(a) >>> b'),
);
writeFileSync(
  join(workspace, 'register.sv'),
  'module register_workbench(input clk,reset,input [7:0] d,output [7:0] y);endmodule',
);
const electron = createRequire(import.meta.url)('electron') as string;
async function launch(exe: string, args: string[], env = process.env) {
  return await new Promise<void>((ok, fail) => {
    const child = spawn(exe, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error('Smoke process exceeded 360 seconds'));
    }, 360000);
    child.on('error', (e) => {
      clearTimeout(timer);
      fail(e);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? ok() : fail(new Error(`Smoke process exited ${code}`));
    });
  });
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
await launch(process.execPath, ['scripts/package-extension.mjs'], env);
const packageInventory = JSON.parse(readFileSync('dist/packages/manifest.json', 'utf8'));
assert.equal(packageInventory.version, JSON.parse(readFileSync('package.json', 'utf8')).version);
assert.equal(packageInventory.package, `mira-graphical-${packageInventory.version}.vsix`);
const packageBytes = readFileSync(join('dist/packages', packageInventory.package));
assert.equal(packageInventory.bytes, packageBytes.length);
assert.equal(packageInventory.sha256, createHash('sha256').update(packageBytes).digest('hex'));
for (const line of readFileSync('dist/packages/SHA256SUMS', 'utf8').trim().split('\n')) {
  const [expected, name] = line.split('  ');
  assert(/^[a-f0-9]{64}$/.test(expected));
  assert([packageInventory.package, 'manifest.json'].includes(name));
  assert.equal(
    createHash('sha256')
      .update(readFileSync(join('dist/packages', name)))
      .digest('hex'),
    expected,
  );
}
if (!process.argv.includes('--editor-only'))
  await launch(electron, ['.', '--smoke', `--workspace=${workspace}`], env);
const installed = join(output, `vsix-installed-${stamp}`),
  profile = join(output, `vsix-profile-${stamp}`);
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
await runVSCodeCommand(
  [
    '--install-extension',
    join(root, `dist/packages/mira-graphical-${version}.vsix`),
    '--extensions-dir',
    installed,
    '--user-data-dir',
    profile,
    '--force',
  ],
  { spawn: { env, windowsHide: true } },
);
const listed = await runVSCodeCommand(
  [
    '--list-extensions',
    '--show-versions',
    '--extensions-dir',
    installed,
    '--user-data-dir',
    profile,
  ],
  { spawn: { env, windowsHide: true } },
);
assert(
  listed.stdout.includes(`mira-graphical.mira-graphical@${version}`),
  'VSIX must install in isolated VS Code',
);
const packageDirectory = join(
  installed,
  readdirSync(installed, { withFileTypes: true }).find(
    (d) => d.isDirectory() && d.name.startsWith('mira-graphical.mira-graphical-'),
  )!.name,
);
let restoredOperatorId: string | undefined;
for (let pass = 0; pass < 2; pass++) {
  const service = new SyncService(workspace);
  await service.ready();
  const languageEdited = new Set<string>();
  let registerEdited = false;
  let reconnectRequest: { uri: string; version: number; text: string } | undefined;
  let reconnectPending = false;
  let edited = false,
    comboEdited = false,
    hierarchyEdited = false;
  const unsubscribe = service.subscribe((states) => {
    writeSmokeState(
      'smoke-states.json',
      states.map((s) => ({
        uri: s.uri,
        version: s.version,
        status: s.status,
        diagnostics: s.diagnostics,
        detail: s.detail,
      })),
    );
    for (const s of states) {
      if (['Invalid source', 'Unsupported construct', 'Conflict'].includes(s.status))
        console.error(
          'Editor smoke state:',
          JSON.stringify({
            uri: s.uri,
            version: s.version,
            status: s.status,
            diagnostics: s.diagnostics,
            detail: s.detail,
          }),
        );
      if (reconnectRequest && s.uri === reconnectRequest.uri) {
        if (s.status === 'Pending') reconnectPending = true;
        if (reconnectPending && s.status === 'Synced') {
          assert.equal(service.sessions.get(s.uri)!.text, reconnectRequest.text);
          assert.equal(s.version, reconnectRequest.version);
          writeSmokeState('reconnect-result-' + pass + '.json', { passed: true });
          reconnectRequest = undefined;
        }
      }
      if (s.uri.endsWith('register.sv') && !registerEdited && s.status === 'Synced' && s.graph) {
        registerEdited = true;
        const q = service.circuitAction(s.uri, {
          kind: 'create',
          component: 'register',
          name: 'q',
          width: 8,
          clock: 'clk',
          reset: 'reset',
          source: 'd',
        }).selectedId!;
        service.circuitAction(s.uri, {
          kind: 'connect',
          source: q,
          target: s.graph.nodes.find((n) => n.label === 'y')!.id,
          port: 'left',
        });
        service.simulate(s.uri, { clk: '0', reset: '1', d: '7' });
        assert.equal(
          service.simulate(s.uri, { clk: '1', reset: '0', d: '7' }).signals.y.value,
          '0x07',
        );
      }
      if (
        /hierarchy\.(sv|vhd|vhdl|signed\.v)$/.test(s.uri) &&
        !languageEdited.has(s.uri) &&
        s.status === 'Synced' &&
        s.graph
      ) {
        languageEdited.add(s.uri);
        service.selectModule(s.uri, 'arithmetic');
        const graph = service.states.get(s.uri)!.graph!;
        service.graphEdit(
          s.uri,
          graph.nodes.find((n) => n.kind === 'op')!.id,
          s.uri.endsWith('signed.v') ? '>>' : s.uri.endsWith('.sv') ? '<<' : '-',
        );
        service.circuitAction(s.uri, {
          kind: 'create',
          component: 'concat',
          name: 'pair',
          width: 16,
          parts: ['a', 'b'],
        });
        assert.equal(
          service.simulate(s.uri, { a: '9', b: '3' }).signals.result.value,
          s.uri.endsWith('signed.v') ? '0x01' : s.uri.endsWith('.sv') ? '0x48' : '0x06',
        );
      }
      if (s.uri.endsWith('adder.v')) {
        if (s.status === 'Invalid source' || s.status === 'Unsupported construct')
          console.error('Editor smoke service diagnostic:', JSON.stringify(s.diagnostics));
        writeSmokeState('smoke-state.json', {
          version: s.version,
          status: s.status,
          op: s.graph?.nodes.find((n) => n.kind === 'op')?.op,
          diagnostics: s.diagnostics,
        });
        if (!edited && s.status === 'Synced' && s.graph) {
          edited = true;
          const op = s.graph.nodes.find((n) => n.kind === 'op')!;
          assert.equal(op.op, '-', 'Graph must reflect the unsaved operator');
          assert(service.sessions.get(s.uri)!.text.includes('unsaved smoke checkpoint'));
          if (pass === 0) restoredOperatorId = op.id;
          else {
            assert.equal(
              op.id,
              restoredOperatorId,
              'Operator identity must survive service/editor restart',
            );
            assert.equal(
              s.layout.nodes[op.id].x,
              430,
              'Manual position must survive service/editor restart',
            );
          }
          service.move(s.uri, op.id, 430, 180);
          service.graphEdit(s.uri, op.id, '*');
        }
      } else if (
        s.uri.endsWith('combinational.v') &&
        !comboEdited &&
        s.status === 'Synced' &&
        s.graph
      ) {
        comboEdited = true;
        for (const [kind, value] of [
          ['literal', "8'h2A"],
          ['slice', '[3:0]'],
          ['selector', 'select_b'],
        ] as const) {
          const n = s.graph.nodes.find((n) => n.kind === (kind === 'selector' ? 'mux' : kind))!;
          service.graphChange(s.uri, n.id, { kind, value });
        }
        const product = service.circuitAction(s.uri, {
          kind: 'create',
          component: 'operation',
          name: 'product',
          width: 8,
          operator: '*',
        }).selectedId!;
        for (const [name, port] of [
          ['a', 'left'],
          ['b', 'right'],
        ] as const)
          service.circuitAction(s.uri, {
            kind: 'connect',
            source: s.graph.nodes.find((n) => n.label === name)!.id,
            target: product,
            port,
          });
      } else if (
        s.uri.endsWith('hierarchy.v') &&
        !hierarchyEdited &&
        s.status === 'Synced' &&
        s.graph
      ) {
        hierarchyEdited = true;
        service.selectModule(s.uri, 'arithmetic');
        const graph = service.states.get(s.uri)!.graph!,
          op = graph.nodes.find((n) => n.kind === 'op')!;
        service.graphEdit(s.uri, op.id, '*');
        service.circuitAction(s.uri, {
          kind: 'create',
          component: 'concat',
          name: 'pair',
          width: 16,
          parts: ['a', 'b'],
        });
        service.circuitAction(s.uri, { kind: 'paste', items: service.copy(s.uri, [op.id]) });
        assert.equal(service.simulate(s.uri, { a: '2', b: '3' }).signals.result.value, '0x06');
      }
    }
  });
  try {
    const userData = join(output, `vscode-user-${stamp}-${pass}`);
    mkdirSync(join(userData, 'User'), { recursive: true });
    writeFileSync(
      join(userData, 'User/settings.json'),
      JSON.stringify({
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'extensions.autoUpdate': false,
        'workbench.startupEditor': 'none',
      }),
    );
    const log = createWriteStream(join(output, `vscode-smoke-${pass}.log`));
    const recoveryRequest = join(workspace, '.hdlgraph', `recovery-request-${pass}.json`);
    let handledReconnect = false;
    let handledRecovery = '',
      recoveryError: unknown;
    const recoveryTimer = setInterval(() => {
      try {
        const reconnectPath = join(workspace, '.hdlgraph', 'reconnect-request-' + pass + '.json');
        if (!handledReconnect && existsSync(reconnectPath)) {
          reconnectRequest = JSON.parse(readFileSync(reconnectPath, 'utf8'));
          handledReconnect = true;
          for (const client of service.server.clients) client.close(1012, 'Smoke reconnect');
        }
        if (!existsSync(recoveryRequest)) return;
        const request = JSON.parse(readFileSync(recoveryRequest, 'utf8'));
        if (request.phase === handledRecovery) return;
        handledRecovery = request.phase;
        const id = service.recovery.archive({
          at: new Date().toISOString(),
          reason: 'Editor recovery smoke',
          uri: request.uri,
          version: 1,
          text: request.text,
          previewText: request.preview,
          graphEdits: [],
        });
        service.openRecovery(id, request.phase === 'compare', request.phase === 'compare');
      } catch (error) {
        if (error instanceof SyntaxError) return;
        recoveryError = error;
      }
    }, 50);
    try {
      await runTests({
        vscodeExecutablePath: process.env.MIRA_CODE_EXE,
        extensionDevelopmentPath: pass === 1 ? packageDirectory : join(root, 'extensions/vscode'),
        extensionTestsPath: join(root, 'extensions/vscode/dist/smoke.cjs'),
        extensionTestsEnv: { ...env, MIRA_SMOKE_PASS: String(pass) },
        stdout: log,
        stderr: log,
        launchArgs: [
          workspace,
          `--user-data-dir=${userData}`,
          `--extensions-dir=${join(output, 'vscode-extensions')}`,
          '--disable-extensions',
          '--disable-workspace-trust',
          '--skip-welcome',
          '--skip-release-notes',
          '--disable-updates',
        ],
      });
    } finally {
      clearInterval(recoveryTimer);
      log.end();
    }
    assert.equal(recoveryError, undefined);
    const result = JSON.parse(
      readFileSync(join(workspace, '.hdlgraph/vscode-smoke-result.json'), 'utf8'),
    );
    if (!result.passed) throw new Error('VS Code smoke did not pass');
    assert.equal(result.pass, String(pass));
    writeFileSync(
      join(output, 'vscode-smoke.json'),
      JSON.stringify(
        { ...result, restartedEditorAndService: pass === 1, installedVsix: pass === 1 },
        null,
        2,
      ),
    );
    console.log(
      `VS CODE SMOKE PASS ${pass + 1}: unsaved buffer, minimal patches, native undo, disk unchanged${pass ? ' · restart and persisted identity verified' : ''}.`,
    );
  } finally {
    // The editor has exited and assertions are complete; teardown must not rewrite its watched files.
    unsubscribe();
    await service.close();
  }
}
