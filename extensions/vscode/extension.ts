// SPDX-License-Identifier: GPL-3.0-only
import * as vscode from 'vscode';
import { WebSocket } from 'ws';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { EditorMessage, ServiceMessage } from '../../packages/protocol/index.js';
import { applyLivePatch } from './patch.js';
let socket: WebSocket | undefined;
const shared = new Set<string>();
const applying = new Map<string, { expected: string; observed: boolean }>();
let status: vscode.StatusBarItem;
let log: vscode.OutputChannel;
let connectedWorkspace: string | undefined;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function send(m: EditorMessage) {
  if (socket?.readyState !== WebSocket.OPEN)
    throw new Error('Disconnected. Start the graph desktop app, then connect again.');
  socket.send(JSON.stringify(m));
}
function disconnect() {
  socket?.close();
  socket = undefined;
  shared.clear();
  connectedWorkspace = undefined;
  if (status) status.text = '$(debug-disconnect) RTL Graph: Disconnected';
}
async function connect(folder: vscode.WorkspaceFolder) {
  disconnect();
  const bytes = await vscode.workspace.fs.readFile(
    vscode.Uri.joinPath(folder.uri, '.hdlgraph', 'connection.json'),
  );
  const config = JSON.parse(Buffer.from(bytes).toString('utf8'));
  const normalize = (s: string) =>
    process.platform === 'win32' ? resolve(s).toLowerCase() : resolve(s);
  if (
    config.protocolVersion !== 1 ||
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535 ||
    typeof config.token !== 'string' ||
    normalize(fileURLToPath(config.workspace)) !== normalize(folder.uri.fsPath)
  )
    throw new Error('Invalid connection descriptor. Start the graph app for this workspace.');
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}`, {
    maxPayload: 2 * 1024 * 1024,
    perMessageDeflate: false,
  });
  socket = ws;
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => {
      ws.close();
      fail(new Error('Local connection timed out'));
    }, 4000);
    ws.once('error', (e) => {
      clearTimeout(timer);
      fail(e);
    });
    ws.on('message', (b) => {
      const msg = JSON.parse(b.toString()) as ServiceMessage;
      if (msg.type === 'hello.ok') {
        clearTimeout(timer);
        connectedWorkspace = folder.uri.toString();
        status.text = '$(circuit-board) RTL Graph: Connected';
        ok();
      } else if (msg.type === 'error') {
        log.appendLine(msg.error);
        void vscode.window.showWarningMessage(msg.error);
      } else if (msg.type === 'status') {
        status.text = `$(circuit-board) RTL Graph: ${msg.status}`;
        status.tooltip = msg.detail ?? msg.uri;
      } else if (msg.type === 'document.applyPatch')
        void patch(msg).catch((e) => {
          log.appendLine(String(e));
          void vscode.window.showErrorMessage(`RTL Graph: ${String(e)}`);
        });
    });
    ws.once('open', () =>
      ws.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: 1,
          token: config.token,
          workspace: config.workspace,
          editor: 'vscode',
        }),
      ),
    );
    ws.on('close', () => {
      clearTimeout(timer);
      if (socket === ws) {
        shared.clear();
        connectedWorkspace = undefined;
        socket = undefined;
        status.text = '$(debug-disconnect) RTL Graph: Disconnected';
      }
      fail(new Error('Local service disconnected. Reconnect and reopen the current module.'));
    });
  });
}
async function patch(p: Extract<ServiceMessage, { type: 'document.applyPatch' }>) {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === p.uri);
  if (!doc || !shared.has(p.uri)) {
    if (doc)
      send({
        type: 'document.patchResult',
        uri: p.uri,
        patchId: p.patchId,
        ok: false,
        currentVersion: doc.version,
        text: doc.getText(),
        error: 'Document not shared',
      });
    return;
  }
  const result = await applyLivePatch(
    {
      version: () => doc.version,
      text: () => doc.getText(),
      apply: async (edits) => {
        const expected = edits.reduce(
          (text, e) => text.slice(0, e.start) + e.text + text.slice(e.end),
          doc.getText(),
        );
        applying.set(p.uri, { expected, observed: false });
        // showTextDocument is unnecessary: WorkspaceEdit targets the explicit live URI.
        const change = new vscode.WorkspaceEdit();
        for (const e of edits)
          change.replace(
            doc.uri,
            new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)),
            e.text,
          );
        try {
          return await vscode.workspace.applyEdit(change);
        } finally {
          applying.delete(p.uri);
        }
      },
    },
    p,
    sha,
  );
  send({ type: 'document.patchResult', uri: p.uri, patchId: p.patchId, ...result });
}
export function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel('Mira Graphical');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.command = 'mira.status';
  status.text = '$(debug-disconnect) RTL Graph: Disconnected';
  status.show();
  const safely = (f: () => Promise<unknown>) => () =>
    f().catch((e) => vscode.window.showErrorMessage(`RTL Graph: ${String(e)}`));
  context.subscriptions.push(
    status,
    log,
    { dispose: disconnect },
    vscode.commands.registerCommand(
      'mira.open',
      safely(async () => {
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before connecting.');
        const doc = vscode.window.activeTextEditor?.document;
        if (!doc || !doc.uri.path.endsWith('.v')) throw new Error('Open a .v document first.');
        const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
        if (!folder) throw new Error('Open the containing workspace folder first.');
        if (socket?.readyState !== WebSocket.OPEN || connectedWorkspace !== folder.uri.toString())
          await connect(folder);
        shared.add(doc.uri.toString());
        send({
          type: 'document.open',
          uri: doc.uri.toString(),
          version: doc.version,
          text: doc.getText(),
        });
      }),
    ),
    vscode.commands.registerCommand(
      'mira.connect',
      safely(async () => {
        if (socket) {
          disconnect();
          return;
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) throw new Error('Open a workspace folder.');
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before connecting.');
        await connect(folder);
      }),
    ),
    vscode.commands.registerCommand('mira.status', () => {
      log.show();
      void vscode.window.showInformationMessage(status.text.replace(/\$\([^)]*\) /, ''));
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const uri = event.document.uri.toString();
      if (!shared.has(uri) || !event.contentChanges.length) return;
      const text = event.document.getText();
      const pending = applying.get(uri);
      if (pending && !pending.observed && text === pending.expected) {
        pending.observed = true;
        return;
      }
      try {
        send({
          type: 'document.change',
          uri,
          version: event.document.version,
          text,
          origin: 'user',
        });
      } catch (e) {
        log.appendLine(String(e));
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const uri = doc.uri.toString();
      if (shared.delete(uri) && socket?.readyState === WebSocket.OPEN)
        send({ type: 'document.close', uri });
    }),
  );
}
export function deactivate() {
  disconnect();
}
