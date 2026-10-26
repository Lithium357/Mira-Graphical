// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RpcStream } from './rpc.js';
import { APP_VERSION } from '../protocol/version.js';
export async function checkLspBundle(executable: string, resources: string, workspace: string) {
  const file = join(resources, 'editors/mira-lsp.cjs');
  assert(existsSync(file));
  assert(
    existsSync(
      join(
        resources,
        process.platform === 'win32' ? 'editors/mira-lsp.cmd' : 'editors/mira-lsp.sh',
      ),
    ),
  );
  await new Promise<void>((ok, fail) => {
    const child = spawn(executable, [file, '--stdio'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let initialized = false,
      stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error('Packaged LSP companion timed out: ' + stderr));
    }, 8000);
    child.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.stderr.on('data', (b) => {
      stderr = (stderr + b.toString()).slice(-16384);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 && initialized
        ? ok()
        : fail(new Error(`Packaged LSP companion failed (${code}): ${stderr}`));
    });
    const rpc = new RpcStream(
      child.stdout,
      child.stdin,
      (m) => {
        try {
          if (m.id === 1) {
            assert.equal(m.result?.serverInfo.version, APP_VERSION);
            assert.equal(m.result?.capabilities.positionEncoding, 'utf-16');
            initialized = true;
            rpc.send({ jsonrpc: '2.0', id: 2, method: 'shutdown' });
          } else if (m.id === 2) {
            rpc.send({ jsonrpc: '2.0', method: 'exit' });
            child.stdin.end();
          }
        } catch (error) {
          child.kill();
          clearTimeout(timer);
          fail(error);
        }
      },
      (error) => {
        child.kill();
        clearTimeout(timer);
        fail(error);
      },
    );
    rpc.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { rootUri: pathToFileURL(workspace).href, capabilities: {} },
    });
  });
}
