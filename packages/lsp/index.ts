// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync, lstatSync } from 'node:fs';
import { resolve, relative, isAbsolute, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { applyLivePatch } from '../editor/patch.js';
import { APP_VERSION } from '../protocol/version.js';
import {
  MAX_MESSAGE_BYTES,
  type EditorMessage,
  type ServiceMessage,
  type Edit,
} from '../protocol/index.js';
import { offsetAt, positionAt, type RpcMessage } from './rpc.js';
type Document = { text: string; version: number; revision: number };
type Pending = { expected: string; response?: boolean; done: (ok: boolean) => void };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export class LspCompanion {
  private workspace?: string;
  private documents = new Map<string, Document>();
  private socket?: WebSocket;
  private authenticated = false;
  private timer?: ReturnType<typeof setTimeout>;
  private initialized = false;
  private started = false;
  private lastLog?: string;
  private stopped = false;
  private readOnly = true;
  private editorName = 'LSP editor';
  private sequence = 0;
  private requests = new Map<number, (result: any) => void>();
  private pending = new Map<string, Pending>();
  constructor(
    private send: (message: RpcMessage) => void,
    private exit: (code: number) => void,
  ) {}
  private log(message: string) {
    if (this.lastLog === message) return;
    this.lastLog = message;
    this.send({ jsonrpc: '2.0', method: 'window/logMessage', params: { type: 3, message } });
  }
  private forward(message: EditorMessage) {
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES)
      throw new Error('HDL buffer exceeds the editor protocol size limit');
    if (this.authenticated && this.socket?.readyState === WebSocket.OPEN) this.socket.send(text);
  }
  private uri(value: unknown) {
    if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid document URI');
    const url = new URL(value);
    if (url.protocol !== 'file:' || url.host)
      throw new Error('Only local file buffers are supported');
    const file = fileURLToPath(url),
      within = relative(this.workspace!, file);
    if (
      !within ||
      within.startsWith('..') ||
      isAbsolute(within) ||
      !['.v', '.sv', '.vhd', '.vhdl'].includes(extname(file).toLowerCase())
    )
      throw new Error('Share an HDL buffer inside the selected workspace');
    return pathToFileURL(resolve(file)).href;
  }
  private connect() {
    if (this.stopped || !this.workspace) return;
    try {
      const descriptor = join(this.workspace, '.hdlgraph', 'connection.json');
      if (
        lstatSync(join(this.workspace, '.hdlgraph')).isSymbolicLink() ||
        lstatSync(descriptor).isSymbolicLink() ||
        lstatSync(descriptor).size > 8192
      )
        throw new Error('Unsafe connection descriptor');
      const config = JSON.parse(readFileSync(descriptor, 'utf8'));
      const configURL = new URL(config.workspace);
      const configuredRoot = resolve(fileURLToPath(configURL));
      const matchingRoot =
        process.platform === 'win32'
          ? configuredRoot.toLowerCase() === this.workspace.toLowerCase()
          : configuredRoot === this.workspace;
      if (
        config.protocolVersion !== 1 ||
        configURL.protocol !== 'file:' ||
        configURL.host ||
        !matchingRoot ||
        !Number.isInteger(config.port) ||
        config.port < 1 ||
        config.port > 65535 ||
        typeof config.token !== 'string' ||
        !/^[a-f0-9]{64}$/.test(config.token)
      )
        throw new Error('Invalid workspace connection descriptor');
      const socket = (this.socket = new WebSocket(`ws://127.0.0.1:${config.port}`, {
        maxPayload: MAX_MESSAGE_BYTES,
        perMessageDeflate: false,
      }));
      const timeout = setTimeout(() => socket.terminate(), 4000);
      socket.on('open', () =>
        socket.send(
          JSON.stringify({
            ...config,
            type: 'hello',
            editor: 'lsp',
            displayName: this.editorName,
            version: APP_VERSION,
            capabilities: this.readOnly ? ['view-only'] : [],
          }),
        ),
      );
      socket.on('message', (bytes) => {
        if (socket !== this.socket) return;
        try {
          const message = JSON.parse(bytes.toString()) as ServiceMessage;
          if (message.type === 'hello.ok') {
            clearTimeout(timeout);
            this.authenticated = true;
            for (const [uri, doc] of this.documents)
              this.forward({ type: 'document.open', uri, version: doc.revision, text: doc.text });
            this.log(
              `Connected to Mira Graphical${this.readOnly ? ' (live viewing only: client cannot apply versioned edits)' : ''}.`,
            );
          } else if (message.type === 'document.applyPatch') void this.patch(message);
          else if (message.type === 'error') this.log(message.error);
          else if (
            message.type === 'status' &&
            ['Invalid source', 'Unsupported construct', 'Conflict'].includes(message.status)
          )
            this.log(`${message.status}: ${message.detail ?? message.uri}`);
        } catch (error) {
          this.log(String(error));
        }
      });
      socket.on('error', () => {});
      socket.on('close', () => {
        clearTimeout(timeout);
        if (socket !== this.socket) return;
        this.authenticated = false;
        for (const p of this.pending.values()) p.done(false);
        this.retry();
      });
    } catch {
      this.log(
        'Waiting for Mira Graphical in the selected project folder. Start Mira or check the LSP project root.',
      );
      this.retry();
    }
  }
  private retry() {
    if (!this.stopped) this.timer = setTimeout(() => this.connect(), 1500);
  }
  async receive(message: RpcMessage) {
    if (!message.method) {
      if (typeof message.id === 'number') {
        this.requests.get(message.id)?.(message.error ? undefined : message.result);
        this.requests.delete(message.id);
      }
      return;
    }
    const reply = (result: unknown) => {
      if (message.id !== undefined) this.send({ jsonrpc: '2.0', id: message.id, result });
    };
    try {
      const p = message.params;
      if (message.method === 'initialize') {
        if (this.initialized) throw new Error('Already initialized');
        const root =
          p?.rootUri ??
          p?.workspaceFolders?.[0]?.uri ??
          (p?.rootPath ? pathToFileURL(resolve(p.rootPath)).href : undefined);
        if (typeof root !== 'string' || new URL(root).protocol !== 'file:' || new URL(root).host)
          throw new Error('Select one local project folder matching Mira');
        this.workspace = resolve(fileURLToPath(root));
        if (!lstatSync(this.workspace).isDirectory())
          throw new Error('Workspace is not a directory');
        this.initialized = true;
        this.readOnly =
          p?.initializationOptions?.readOnly === true ||
          p?.capabilities?.workspace?.applyEdit !== true ||
          p?.capabilities?.workspace?.workspaceEdit?.documentChanges !== true;
        this.editorName =
          String(p?.clientInfo?.name ?? 'LSP editor')
            .replace(/[\x00-\x1f\x7f]/g, '')
            .slice(0, 64) || 'LSP editor';
        reply({
          capabilities: {
            positionEncoding: 'utf-16',
            textDocumentSync: { openClose: true, change: 1, save: false },
          },
          serverInfo: { name: 'Mira Graphical companion', version: APP_VERSION },
        });
        return;
      }
      if (!this.initialized) throw new Error('Initialize the LSP companion first');
      if (message.method === 'initialized') {
        if (this.started) return;
        this.started = true;
        this.connect();
        return;
      }
      if (message.method === 'shutdown') {
        this.close();
        reply(null);
        return;
      }
      if (message.method === 'exit') {
        const clean = this.stopped;
        this.close();
        this.exit(clean ? 0 : 1);
        return;
      }
      if (this.stopped) throw new Error('Companion is shut down');
      if (message.method === 'textDocument/didOpen') {
        const uri = this.uri(p?.textDocument?.uri),
          doc = p.textDocument;
        if (
          typeof doc.text !== 'string' ||
          !Number.isSafeInteger(doc.version) ||
          doc.version < 0 ||
          Buffer.byteLength(doc.text) > 1_000_000
        )
          throw new Error('Invalid or oversized HDL buffer');
        const revision = (this.documents.get(uri)?.revision ?? 0) + 1;
        this.documents.set(uri, { text: doc.text, version: doc.version, revision });
        this.forward({ type: 'document.open', uri, version: revision, text: doc.text });
        return;
      }
      if (message.method === 'textDocument/didChange') {
        const uri = this.uri(p?.textDocument?.uri),
          doc = this.documents.get(uri);
        if (
          !doc ||
          !Number.isSafeInteger(p.textDocument.version) ||
          p.textDocument.version <= doc.version ||
          !Array.isArray(p.contentChanges) ||
          !p.contentChanges.length ||
          p.contentChanges.length > 256
        )
          throw new Error('Invalid live buffer revision');
        let text = doc.text;
        for (const change of p.contentChanges) {
          if (typeof change.text !== 'string') throw new Error('Invalid buffer change');
          if (change.range) {
            const start = offsetAt(text, change.range.start),
              end = offsetAt(text, change.range.end);
            if (end < start) throw new Error('Reversed source range');
            text = text.slice(0, start) + change.text + text.slice(end);
          } else text = change.text;
          if (Buffer.byteLength(text) > 1_000_000) throw new Error('HDL buffer too large');
        }
        doc.text = text;
        doc.version = p.textDocument.version;
        doc.revision++;
        const pending = this.pending.get(uri);
        if (pending) {
          if (pending.response && text === pending.expected) pending.done(true);
        } else
          this.forward({
            type: 'document.change',
            uri,
            version: doc.revision,
            text,
            origin: 'user',
          });
        return;
      }
      if (message.method === 'textDocument/didClose') {
        const uri = this.uri(p?.textDocument?.uri);
        this.pending.get(uri)?.done(false);
        this.documents.delete(uri);
        this.forward({ type: 'document.close', uri });
        return;
      }
      if (
        [
          'textDocument/didSave',
          '$/cancelRequest',
          '$/setTrace',
          'workspace/didChangeConfiguration',
        ].includes(message.method)
      )
        return;
      if (message.id !== undefined)
        this.send({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32601,
            message: 'Mira provides HDL graph synchronization, not completion or formatting',
          },
        });
    } catch (error) {
      if (message.id !== undefined)
        this.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32602, message: String(error) },
        });
      else this.log(String(error));
    }
  }
  private async patch(p: Extract<ServiceMessage, { type: 'document.applyPatch' }>) {
    const doc = this.documents.get(p.uri),
      socket = this.socket;
    if (!doc || this.readOnly || this.pending.has(p.uri) || !this.authenticated) return;
    const result = await applyLivePatch(
      {
        version: () => doc.revision,
        text: () => doc.text,
        apply: (edits: Edit[]) => {
          const original = doc.text,
            expected = edits.reduce(
              (text, e) => text.slice(0, e.start) + e.text + text.slice(e.end),
              original,
            );
          return new Promise<boolean>((resolvePatch) => {
            const id = ++this.sequence;
            const timer = setTimeout(() => done(false), 7500);
            const done = (ok: boolean) => {
              clearTimeout(timer);
              this.requests.delete(id);
              this.pending.delete(p.uri);
              resolvePatch(ok);
            };
            const pending: Pending = { expected, done };
            this.pending.set(p.uri, pending);
            this.requests.set(id, (response) => {
              pending.response = response?.applied === true;
              if (!pending.response) done(false);
              else if (doc.text === expected) done(true);
            });
            this.send({
              jsonrpc: '2.0',
              id,
              method: 'workspace/applyEdit',
              params: {
                label: 'Mira circuit edit',
                edit: {
                  documentChanges: [
                    {
                      textDocument: { uri: p.uri, version: doc.version },
                      edits: edits.map((e) => ({
                        range: {
                          start: positionAt(original, e.start),
                          end: positionAt(original, e.end),
                        },
                        newText: e.text,
                      })),
                    },
                  ],
                },
              },
            });
          });
        },
      },
      p,
      hash,
    );
    if (socket === this.socket && this.authenticated)
      this.forward({ type: 'document.patchResult', uri: p.uri, patchId: p.patchId, ...result });
  }
  close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const p of this.pending.values()) p.done(false);
    this.authenticated = false;
    this.socket?.terminate();
  }
}
