// SPDX-License-Identifier: GPL-3.0-only
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, createWriteStream } from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runTests } from '@vscode/test-electron';
import { createRequire } from 'node:module';
import { SyncService } from '../packages/core/service.js';
const root = process.cwd();
const output = join(root, 'test-results');
mkdirSync(output, { recursive: true });
const stamp = Date.now();
const workspace = join(output, `smoke-workspace-${stamp}`);
mkdirSync(workspace);
for (const name of ['adder', 'combinational'])
  writeFileSync(join(workspace, `${name}.v`), readFileSync(`fixtures/${name}.v`));
const electron = createRequire(import.meta.url)('electron') as string;
async function launch(exe: string, args: string[], env = process.env) {
  return await new Promise<void>((ok, fail) => {
    const child = spawn(exe, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error('Smoke process exceeded 120 seconds'));
    }, 120000);
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
await launch(electron, ['.', '--smoke', `--workspace=${workspace}`], env);
let restoredOperatorId: string | undefined;
for (let pass = 0; pass < 2; pass++) {
  const service = new SyncService(workspace);
  await service.ready();
  let edited = false,
    comboEdited = false;
  service.subscribe((states) => {
    for (const s of states) {
      if (s.uri.endsWith('adder.v')) {
        writeFileSync(
          join(workspace, '.hdlgraph', 'smoke-state.json'),
          JSON.stringify({
            version: s.version,
            status: s.status,
            op: s.graph?.nodes.find((n) => n.kind === 'op')?.op,
          }),
        );
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
      } else if (!comboEdited && s.status === 'Synced' && s.graph) {
        comboEdited = true;
        for (const [kind, value] of [
          ['literal', "8'h2A"],
          ['slice', '[3:0]'],
          ['selector', 'select_b'],
        ] as const) {
          const n = s.graph.nodes.find((n) => n.kind === (kind === 'selector' ? 'mux' : kind))!;
          service.graphChange(s.uri, n.id, { kind, value });
        }
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
    try {
      await runTests({
        vscodeExecutablePath: process.env.MIRA_CODE_EXE,
        extensionDevelopmentPath: join(root, 'extensions/vscode'),
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
      log.end();
    }
    const result = JSON.parse(
      readFileSync(join(workspace, '.hdlgraph/vscode-smoke-result.json'), 'utf8'),
    );
    if (!result.passed) throw new Error('VS Code smoke did not pass');
    assert.equal(result.pass, String(pass));
    writeFileSync(
      join(output, 'vscode-smoke.json'),
      JSON.stringify({ ...result, restartedEditorAndService: pass === 1 }, null, 2),
    );
    console.log(
      `VS CODE SMOKE PASS ${pass + 1}: unsaved buffer, minimal patches, native undo, disk unchanged${pass ? ' · restart and persisted identity verified' : ''}.`,
    );
  } finally {
    await service.close();
  }
}
