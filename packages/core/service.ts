// SPDX-License-Identifier: GPL-3.0-only
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  lstatSync,
  unlinkSync,
} from 'node:fs';
import { resolve, relative, isAbsolute, join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Session, hash, type State, type Layout, type Clock, type Viewport } from './index.js';
import { RecoveryStore, recoveryFingerprint } from './recovery.js';
import {
  MAX_MESSAGE_BYTES,
  validateMessage,
  type Operator,
  type GraphChange,
  type CircuitAction,
  type ServiceMessage,
} from '../protocol/index.js';
export function loadLayout(path: string): Layout | undefined {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  if (text.length > 2_000_000) throw new Error('Layout file exceeds size limit.');
  const v = JSON.parse(text) as Layout;
  const record = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);
  if (
    !record(v) ||
    v.schemaVersion !== 1 ||
    !record(v.nodes) ||
    !record(v.identities) ||
    Object.keys(v.nodes).length > 32768
  )
    throw new Error('Unsupported layout schema.');
  for (const p of Object.values(v.nodes))
    if (
      !record(p) ||
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.y) ||
      typeof p.manuallyPlaced !== 'boolean'
    )
      throw new Error('Invalid stored coordinates.');
  for (const id of Object.values(v.identities))
    if (typeof id !== 'string') throw new Error('Invalid stored identity.');
  if (
    v.viewport &&
    (!record(v.viewport) ||
      ![v.viewport.x, v.viewport.y, v.viewport.zoom].every(Number.isFinite) ||
      v.viewport.zoom < 0.25 ||
      v.viewport.zoom > 2)
  )
    throw new Error('Invalid stored viewport.');
  if (v.viewports) {
    if (!record(v.viewports) || Object.keys(v.viewports).length > 64)
      throw new Error('Invalid module viewports.');
    for (const p of Object.values(v.viewports))
      if (!record(p) || ![p.x, p.y, p.zoom].every(Number.isFinite) || p.zoom < 0.25 || p.zoom > 2)
        throw new Error('Invalid module viewport.');
  }
  return v;
}
export class SyncService {
  readonly sessions = new Map<string, Session>();
  readonly states = new Map<string, State>();
  readonly token = randomBytes(32).toString('hex');
  readonly workspace: string;
  readonly metadata: string;
  readonly recovery: RecoveryStore;
  readonly server: WebSocketServer;
  private editor?: WebSocket;
  private editorRecovery = false;
  get editorConnected() {
    return this.editor?.readyState === WebSocket.OPEN;
  }
  private owners = new Map<string, WebSocket>();
  private listeners = new Set<(states: State[]) => void>();
  private descriptor?: string;
  constructor(
    workspace: string,
    private clock?: Clock,
  ) {
    this.workspace = resolve(workspace);
    this.metadata = join(this.workspace, '.hdlgraph');
    if (existsSync(this.metadata) && lstatSync(this.metadata).isSymbolicLink())
      throw new Error('.hdlgraph must not be a symbolic link.');
    mkdirSync(this.metadata, { recursive: true });
    this.recovery = new RecoveryStore(this.metadata, this.workspace);
    this.server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    this.server.on('connection', (socket, req) => {
      if (req.headers.origin) {
        socket.close(1008, 'Browser clients are not allowed');
        return;
      }
      let authenticated = false;
      const timeout = setTimeout(() => socket.close(1008, 'Authentication required'), 3000);
      socket.on('error', () => {});
      socket.on('message', (raw) => {
        try {
          const msg: unknown = JSON.parse(raw.toString());
          if (!validateMessage(msg)) throw new Error('Invalid protocol message.');
          if (!authenticated) {
            if (
              msg.type !== 'hello' ||
              msg.workspace !== pathToFileURL(this.workspace).href ||
              !this.tokenEqual(msg.token) ||
              (this.editor && this.editor !== socket)
            )
              throw new Error('Authentication failed or another editor is connected.');
            authenticated = true;
            clearTimeout(timeout);
            this.editor = socket;
            this.editorRecovery = msg.capabilities?.includes('recovery-review') ?? false;
            this.send(socket, { type: 'hello.ok', protocolVersion: 1 });
            return;
          }
          if (msg.type === 'hello') throw new Error('Already authenticated.');
          this.checkURI(msg.uri);
          if (msg.type === 'document.open') {
            if (this.sessions.has(msg.uri)) this.sessions.get(msg.uri)!.close();
            let layout: Layout | undefined;
            try {
              layout = loadLayout(this.layoutPath(msg.uri));
            } catch (e) {
              this.send(socket, { type: 'error', error: `Layout not loaded: ${String(e)}` });
            }
            this.owners.set(msg.uri, socket);
            const session = new Session(
              msg.uri,
              msg.version,
              msg.text,
              {
                checkpoint: (r) => this.recovery.checkpoint(r),
                publish: (state) => {
                  this.states.set(state.uri, state);
                  this.send(socket, {
                    type: 'status',
                    uri: state.uri,
                    status: state.status,
                    detail: state.detail ?? state.diagnostics[0]?.message,
                  });
                  this.notify();
                },
                patch: (patch) => {
                  if (socket.readyState !== WebSocket.OPEN) throw new Error('Editor disconnected');
                  this.send(socket, { type: 'document.applyPatch', ...patch });
                },
                recover: (r) => {
                  this.recovery.archive(r);
                },
                persist: (uri, l) => this.atomic(this.layoutPath(uri), l),
              },
              this.clock,
              layout,
            );
            this.sessions.set(msg.uri, session);
            return;
          }
          const session = this.sessions.get(msg.uri);
          if (!session || this.owners.get(msg.uri) !== socket)
            throw new Error('Document was not explicitly shared by this editor.');
          if (msg.type === 'document.change') {
            // Sync-origin claims are not trusted: only a matching one-use patchResult can acknowledge a patch.
            if (msg.origin === 'sync') throw new Error('Unsolicited sync-origin document change.');
            session.userText(msg.version, msg.text);
          } else if (msg.type === 'document.patchResult') {
            if (!session.patchResult(msg.patchId, msg.ok, msg.currentVersion, msg.text))
              throw new Error('Unknown or expired patch token.');
          } else if (msg.type === 'document.close') {
            session.close();
            this.sessions.delete(msg.uri);
            this.owners.delete(msg.uri);
            this.states.delete(msg.uri);
            this.notify();
          }
        } catch (error) {
          this.send(socket, { type: 'error', error: String(error) });
          if (!authenticated) socket.close(1008, 'Authentication failed');
        }
      });
      socket.on('close', () => {
        clearTimeout(timeout);
        if (this.editor === socket) {
          this.editor = undefined;
          this.editorRecovery = false;
        }
        for (const [uri, owner] of this.owners)
          if (owner === socket) {
            this.sessions.get(uri)?.disconnect();
            this.owners.delete(uri);
          }
      });
    });
  }
  private tokenEqual(token: string) {
    const a = Buffer.from(token),
      b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  private checkURI(uri: string) {
    const url = new URL(uri);
    if (url.protocol !== 'file:' || url.host)
      throw new Error('Only local file documents are supported.');
    const path = fileURLToPath(url);
    const rel = relative(this.workspace, path);
    if (
      !rel ||
      rel.startsWith('..') ||
      isAbsolute(rel) ||
      !['.v', '.sv', '.vhd', '.vhdl'].includes(extname(path).toLowerCase())
    )
      throw new Error('Share a .v, .sv, .vhd or .vhdl document inside the selected workspace.');
  }
  private layoutPath(uri: string) {
    return join(this.metadata, `layout-${hash(uri)}.json`);
  }
  private atomic(path: string, data: unknown) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new Error('Metadata symlinks are not allowed.');
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  }
  private send(socket: WebSocket, message: ServiceMessage) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
  private notify() {
    for (const f of this.listeners) f([...this.states.values()]);
  }
  subscribe(f: (states: State[]) => void) {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }
  openRecovery(id: string, preview: boolean, compare: boolean, expectedHash?: string) {
    if (!this.editor || this.editor.readyState !== WebSocket.OPEN)
      throw new Error('Connect VS Code to open a recovered copy. You can also copy the text here.');
    if (!this.editorRecovery)
      throw new Error(
        'Update the Mira companion extension to 0.6.0 or newer to open recovery. Copy text is still available.',
      );
    const saved = this.recovery.read(id);
    if (expectedHash !== undefined && recoveryFingerprint(saved) !== expectedHash)
      throw new Error('This snapshot changed after you previewed it. Refresh and select it again.');
    if (compare && this.owners.get(saved.uri) !== this.editor)
      throw new Error('Share the current source document before comparing it with recovery.');
    if (preview && saved.previewText === undefined)
      throw new Error('This snapshot has no graph preview.');
    const message: ServiceMessage = {
      type: 'recovery.open',
      uri: saved.uri,
      text: preview ? saved.previewText! : saved.text,
      compare,
      title: preview ? 'Recovered graph preview' : 'Recovered source buffer',
    };
    if (Buffer.byteLength(JSON.stringify(message)) > MAX_MESSAGE_BYTES)
      throw new Error('This recovery is too large for the editor link. Use Copy text instead.');
    this.send(this.editor, message);
  }
  graphEdit(uri: string, id: string, op: Operator) {
    const s = this.sessions.get(uri);
    if (!s) throw new Error('Document not shared.');
    s.graphEdit(id, op);
  }
  graphChange(uri: string, id: string, change: GraphChange) {
    const s = this.sessions.get(uri);
    if (!s) throw new Error('Document not shared.');
    s.graphChange(id, change);
  }
  importModule(uri: string, fromUri: string, name: string) {
    const from = this.sessions.get(fromUri),
      target = this.sessions.get(uri);
    if (!from || !target) throw new Error('Both documents must be explicitly shared.');
    return target.circuitAction({ kind: 'import', definitions: from.exportModules(name) });
  }
  selectModule(uri: string, name: string) {
    this.sessions.get(uri)!.selectModule(name);
  }
  copy(uri: string, ids: string[]) {
    return this.sessions.get(uri)!.copy(ids);
  }
  simulate(uri: string, inputs: Record<string, string>) {
    return this.sessions.get(uri)!.simulate(inputs);
  }
  circuitAction(uri: string, action: CircuitAction) {
    return this.sessions.get(uri)!.circuitAction(action);
  }
  constructionHistory(uri: string, direction: 'undo' | 'redo') {
    this.sessions.get(uri)!.constructionHistory(direction);
  }
  discardGraphChanges(uri: string) {
    this.sessions.get(uri)!.discardGraphChanges();
  }
  move(uri: string, id: string, x: number, y: number) {
    this.sessions.get(uri)?.move(id, x, y);
  }
  autoLayout(uri: string) {
    this.sessions.get(uri)?.autoLayout();
  }
  viewport(uri: string, v: Viewport) {
    this.sessions.get(uri)?.viewport(v);
  }
  async ready(writeDescriptor = true) {
    if (!this.server.address())
      await new Promise<void>((ok, fail) => {
        this.server.once('listening', ok);
        this.server.once('error', fail);
      });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Local service failed.');
    const config = {
      protocolVersion: 1,
      port: address.port,
      token: this.token,
      workspace: pathToFileURL(this.workspace).href,
    };
    if (writeDescriptor) {
      this.descriptor = join(this.metadata, 'connection.json');
      this.atomic(this.descriptor, config);
    }
    return config;
  }
  async close() {
    for (const s of this.sessions.values()) s.close();
    for (const socket of this.server.clients) socket.terminate();
    await new Promise<void>((ok) => this.server.close(() => ok()));
    if (this.descriptor && existsSync(this.descriptor)) {
      try {
        if (JSON.parse(readFileSync(this.descriptor, 'utf8')).token === this.token)
          unlinkSync(this.descriptor);
      } catch {}
    }
  }
}
