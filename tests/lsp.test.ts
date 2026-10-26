// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RpcStream, offsetAt, positionAt, type RpcMessage } from '../packages/lsp/rpc.js';
import { LspCompanion } from '../packages/lsp/index.js';
import { SyncService } from '../packages/core/service.js';
import type { Clock } from '../packages/core/index.js';
const wait = async (check: () => boolean) => {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('LSP event timed out');
};
test('LSP reconnects to a restarted desktop using fresh unsaved snapshots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mira-lsp-reconnect-'));
  let service = new SyncService(root);
  await service.ready();
  const messages: RpcMessage[] = [];
  const lsp = new LspCompanion(
    (m) => messages.push(m),
    () => {},
  );
  const uri = pathToFileURL(join(root, 'live.v')).href;
  const notify = (method: string, params: any) => lsp.receive({ jsonrpc: '2.0', method, params });
  try {
    await lsp.receive({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        rootUri: pathToFileURL(root).href,
        capabilities: { workspace: { applyEdit: true, workspaceEdit: { documentChanges: true } } },
      },
    });
    await notify('initialized', {});
    await notify('textDocument/didOpen', {
      textDocument: { uri, version: 1, text: 'module m();endmodule' },
    });
    await wait(() => service.sessions.has(uri));
    await service.close();
    await notify('textDocument/didChange', {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: '// offline unsaved edit\nmodule m();endmodule' }],
    });
    service = new SyncService(root);
    await service.ready();
    await wait(() => service.sessions.has(uri));
    assert.equal(service.sessions.get(uri)!.text, '// offline unsaved edit\nmodule m();endmodule');
    assert(!messages.some((m) => m.method === 'workspace/applyEdit'));
    await notify('textDocument/didOpen', {
      textDocument: {
        uri: pathToFileURL(join(root, '..', 'outside.v')).href,
        version: 1,
        text: 'module bad();endmodule',
      },
    });
    assert.equal(service.sessions.size, 1);
    assert(
      messages.some((m) => m.method === 'window/logMessage' && m.params.message.includes('inside')),
    );
  } finally {
    lsp.close();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('LSP framing preserves split/coalesced UTF-8 messages and refuses oversized or ambiguous frames', () => {
  const input = new PassThrough(),
    output = new PassThrough(),
    messages: RpcMessage[] = [],
    failures: Error[] = [];
  const rpc = new RpcStream(
    input,
    output,
    (m) => messages.push(m),
    (e) => failures.push(e),
  );
  const frame = (method: string) => {
    const b = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params: '🙂' }));
    return Buffer.concat([Buffer.from(`Content-Length: ${b.length}\r\n\r\n`), b]);
  };
  const bytes = Buffer.concat([frame('one'), frame('two')]);
  for (const byte of bytes) input.write(Buffer.from([byte]));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].params, '🙂');
  assert.equal(failures.length, 0);
  rpc.send({ jsonrpc: '2.0', id: 1, result: '🙂' });
  assert(output.read().includes(Buffer.from('🙂')));
  input.write('Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}');
  assert.equal(failures.length, 1);
  for (const frame of [
    'Content-Length: 99999999\r\n\r\n',
    'Content-Length: -1\r\n\r\n',
    'x'.repeat(8193),
  ]) {
    const i = new PassThrough();
    let refused = false;
    new RpcStream(
      i,
      new PassThrough(),
      () => {},
      () => {
        refused = true;
      },
    );
    i.write(frame);
    assert(refused);
  }
});
test('LSP UTF-16 positions preserve Unicode, CRLF and reject invalid ranges', () => {
  const text = '// 🙂\r\nassign x = a + b;\r\n';
  assert.equal(offsetAt(text, { line: 0, character: 5 }), 5);
  assert.throws(() => offsetAt(text, { line: 0, character: 4 }), /surrogate/);
  const plus = text.indexOf('+');
  assert.equal(offsetAt(text, positionAt(text, plus)), plus);
  assert.throws(() => offsetAt(text, { line: 3, character: 0 }), /outside/);
  assert.throws(() => offsetAt(text, { line: 0, character: 6 }), /outside/);
});

for (const readOnly of [false, true])
  test(`LSP live buffers, ${readOnly ? 'read-only client guards' : 'native edit acknowledgment and Undo'}, without disk writes`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'mira-lsp-'));
    let now = 0;
    const jobs = new Map<number, { at: number; fn: () => void }>();
    let next = 0;
    const clock: Clock = {
      now: () => now,
      set: (fn, ms) => {
        const id = ++next;
        jobs.set(id, { at: now + ms, fn });
        return id;
      },
      clear: (id) => {
        jobs.delete(id as number);
      },
    };
    const tick = (ms: number) => {
      now += ms;
      for (const [id, job] of [...jobs])
        if (job.at <= now) {
          jobs.delete(id);
          job.fn();
        }
    };
    const service = new SyncService(root, clock);
    await service.ready();
    const messages: RpcMessage[] = [];
    const lsp = new LspCompanion(
      (m) => messages.push(m),
      () => {},
    );
    const uri = pathToFileURL(join(root, 'adder.sv')).href;
    const disk = 'module adder(input [7:0] a,b,output [7:0] y);assign y=a+b;endmodule\r\n';
    writeFileSync(join(root, 'adder.sv'), disk);
    const live = '// unsaved 🙂\r\n' + disk;
    const notify = async (method: string, params: any) =>
      lsp.receive({ jsonrpc: '2.0', method, params });
    try {
      await lsp.receive({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          rootUri: pathToFileURL(root).href,
          clientInfo: { name: readOnly ? 'NppLspClient' : 'Neovim' },
          capabilities: {
            workspace: { applyEdit: !readOnly, workspaceEdit: { documentChanges: !readOnly } },
          },
        },
      });
      await notify('initialized', {});
      await notify('textDocument/didOpen', { textDocument: { uri, version: 0, text: live } });
      await wait(() => service.sessions.has(uri));
      tick(15000);
      await wait(() => service.states.get(uri)?.status === 'Synced');
      assert.equal(service.editorName, readOnly ? 'NppLspClient' : 'Neovim');
      const op = service.states.get(uri)!.graph!.nodes.find((n) => n.kind === 'op')!;
      assert.equal(service.states.get(uri)!.readOnly, readOnly);
      if (readOnly) {
        assert.equal(service.states.get(uri)!.canConstruct, false);
        assert.throws(() => service.graphEdit(uri, op.id, '*'), /viewing only/);
        assert.throws(
          () =>
            service.circuitAction(uri, { kind: 'create', component: 'wire', width: 1, name: 'q' }),
          /viewing only/,
        );
        assert.equal(service.simulate(uri, { a: '2', b: '3' }).signals.y.value, '0x05');
        service.selectModule(uri, 'adder');
      } else {
        service.graphEdit(uri, op.id, '*');
        tick(15000);
        await wait(() => messages.some((m) => m.method === 'workspace/applyEdit'));
        const edit = messages.find((m) => m.method === 'workspace/applyEdit')!;
        assert.equal(edit.params.edit.documentChanges[0].textDocument.version, 0);
        assert.equal(edit.params.edit.documentChanges[0].edits.length, 1);
        const e = edit.params.edit.documentChanges[0].edits[0];
        assert.equal(e.range.start.line, 1);
        assert.equal(e.newText, '*');
        const updated = live.replace('a+b', 'a*b');
        // The response alone is insufficient: the actual changed buffer must arrive too.
        await lsp.receive({ jsonrpc: '2.0', id: edit.id, result: { applied: true } });
        assert.equal(service.states.get(uri)!.status, 'Applying');
        await notify('textDocument/didChange', {
          textDocument: { uri, version: 1 },
          contentChanges: [{ text: updated }],
        });
        await wait(() => service.states.get(uri)?.status === 'Synced');
        assert.equal(service.states.get(uri)!.graph!.nodes.find((n) => n.kind === 'op')!.op, '*');
        await notify('textDocument/didChange', {
          textDocument: { uri, version: 2 },
          contentChanges: [{ text: live }],
        });
        await wait(() => service.states.get(uri)?.version === 3);
        tick(15000);
        assert.equal(service.states.get(uri)!.graph!.nodes.find((n) => n.kind === 'op')!.op, '+');
        service.graphEdit(uri, op.id, '-');
        tick(15000);
        await wait(() => messages.filter((m) => m.method === 'workspace/applyEdit').length === 2);
        const refused = messages.filter((m) => m.method === 'workspace/applyEdit')[1];
        await lsp.receive({ jsonrpc: '2.0', id: refused.id, result: { applied: false } });
        await wait(() => service.states.get(uri)?.status === 'Conflict');
        assert(service.recovery.list().length > 0);
      }
      assert.equal(readFileSync(join(root, 'adder.sv'), 'utf8'), disk);
      await notify('textDocument/didClose', { textDocument: { uri } });
      await wait(() => !service.states.has(uri));
    } finally {
      lsp.close();
      await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
