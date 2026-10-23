// SPDX-License-Identifier: GPL-3.0-only
import { createHash, randomUUID } from 'node:crypto';
import { DEBOUNCE_MS, type Edit, type Operator, type GraphChange } from '../protocol/index.js';
import {
  parse,
  project,
  graphPatch,
  validateEditableEdits,
  type Circuit,
  type Diagnostic,
} from '../verilog/index.js';
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export type Position = { x: number; y: number; manuallyPlaced: boolean };
export type Viewport = { x: number; y: number; zoom: number };
export type Layout = {
  schemaVersion: 1;
  nodes: Record<string, Position>;
  identities: Record<string, string>;
  viewport?: Viewport;
};
export type Recovery = {
  at: string;
  reason: string;
  uri: string;
  version: number;
  text: string;
  graphEdits: [string, GraphChange][];
};
export type State = {
  uri: string;
  version: number;
  status: string;
  detail?: string;
  graph?: Circuit;
  layout: Layout;
  deadline?: number;
  diagnostics: Diagnostic[];
  pendingEdits?: Record<string, GraphChange>;
};
export interface Clock {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}
const clock: Clock = {
  now: Date.now,
  set: (f, ms) => setTimeout(f, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};
export interface Hooks {
  publish(state: State): void;
  patch(p: {
    uri: string;
    baseVersion: number;
    baseHash: string;
    patchId: string;
    edits: Edit[];
  }): void;
  recover(snapshot: Recovery): void;
  persist(uri: string, layout: Layout): void;
}
export class Session {
  state: State;
  text: string;
  private authority?: 'text' | 'graph';
  private pendingText = false;
  private edits = new Map<string, GraphChange>();
  private timer?: unknown;
  private patchTimer?: unknown;
  private conflicted = false;
  private inFlight?: { id: string; expected: string; version: number };
  private connected = true;
  constructor(
    uri: string,
    version: number,
    text: string,
    private hooks: Hooks,
    private time: Clock = clock,
    layout?: Layout,
  ) {
    this.text = text;
    this.state = {
      uri,
      version,
      status: 'Pending',
      diagnostics: [],
      layout: layout ?? { schemaVersion: 1, nodes: {}, identities: {} },
    };
    this.pendingText = true;
    this.authority = 'text';
    this.activity();
  }
  private emit() {
    this.state.pendingEdits = Object.fromEntries(this.edits);
    this.hooks.publish(structuredClone(this.state));
  }
  private snapshot(reason: string) {
    this.hooks.recover({
      at: new Date(this.time.now()).toISOString(),
      reason,
      uri: this.state.uri,
      version: this.state.version,
      text: this.text,
      graphEdits: [...this.edits],
    });
  }
  private activity() {
    if (this.timer !== undefined) this.time.clear(this.timer);
    this.state.deadline = this.time.now() + DEBOUNCE_MS;
    this.state.status = !this.connected
      ? 'Disconnected'
      : this.conflicted
        ? 'Conflict'
        : this.inFlight
          ? 'Applying'
          : 'Pending';
    if (this.connected && !this.conflicted)
      this.timer = this.time.set(() => {
        this.timer = undefined;
        this.flush();
      }, DEBOUNCE_MS);
    this.emit();
  }
  userText(version: number, text: string) {
    if (version <= this.state.version) return;
    if (this.edits.size) {
      this.snapshot('Text superseded pending graph edits');
      this.state.detail = 'Pending graph edits saved to recovery.';
      this.edits.clear();
    }
    this.state.version = version;
    this.text = text;
    this.pendingText = true;
    this.authority = 'text';
    this.activity();
  }
  graphEdit(id: string, op: Operator) {
    this.graphChange(id, { kind: 'operator', value: op });
  }
  graphChange(id: string, change: GraphChange) {
    if (!this.connected || this.inFlight || this.conflicted)
      throw new Error(
        'Reconnect / reopen the module after a conflict, or wait for the patch acknowledgment.',
      );
    const patch = graphPatch(this.text, this.state.graph, id, change);
    if (this.text.slice(patch.start, patch.end) === patch.text) {
      const removed = this.edits.delete(id);
      if (!removed && !this.pendingText) return;
      if (!this.edits.size) this.authority = this.pendingText ? 'text' : undefined;
      this.activity();
      return;
    }
    if (this.pendingText) {
      this.snapshot('Graph superseded pending source changes');
      this.state.detail =
        'Source checkpoint saved to recovery; only selected source spans will change.';
    }
    this.edits.set(id, change);
    this.authority = 'graph';
    this.activity();
  }
  move(id: string, x: number, y: number) {
    if (
      !this.state.graph?.nodes.some((n) => n.id === id) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    )
      return;
    this.state.layout.nodes[id] = { x, y, manuallyPlaced: true };
    this.hooks.persist(this.state.uri, this.state.layout);
    this.activity();
  }
  viewport(viewport: Viewport) {
    if (
      ![viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) ||
      viewport.zoom < 0.25 ||
      viewport.zoom > 2
    )
      return;
    this.state.layout.viewport = viewport;
    this.hooks.persist(this.state.uri, this.state.layout);
  }
  private commit() {
    const ast = parse(this.text);
    const graph = project(ast, this.state.graph, this.state.layout.identities);
    const ids = new Set(graph.nodes.map((n) => n.id));
    this.state.layout.nodes = Object.fromEntries(
      Object.entries(this.state.layout.nodes).filter(([id]) => ids.has(id)),
    );
    this.state.layout.identities = Object.fromEntries(graph.nodes.map((n) => [n.key, n.id]));
    for (const node of graph.nodes)
      this.state.layout.nodes[node.id] ??= {
        x: node.depth * 250,
        y: node.row * 120,
        manuallyPlaced: false,
      };
    this.state.graph = graph;
    this.state.status = 'Synced';
    this.state.diagnostics = [];
    this.pendingText = false;
    this.authority = undefined;
    this.hooks.persist(this.state.uri, this.state.layout);
  }
  private flush() {
    this.state.deadline = undefined;
    if (!this.connected || this.inFlight || this.conflicted) return;
    try {
      if (this.authority === 'graph' && this.edits.size) {
        // Reparse the live buffer and match structural keys. Never use stale offsets.
        const edits = [...this.edits]
          .map(([id, change]) => graphPatch(this.text, this.state.graph, id, change))
          .sort((a, b) => b.start - a.start);
        validateEditableEdits(this.text, edits);
        let expected = this.text;
        for (const e of edits)
          expected = expected.slice(0, e.start) + e.text + expected.slice(e.end);
        parse(expected);
        const id = randomUUID();
        this.inFlight = { id, expected, version: this.state.version };
        this.state.status = 'Applying';
        this.emit();
        this.hooks.patch({
          uri: this.state.uri,
          baseVersion: this.state.version,
          baseHash: hash(this.text),
          patchId: id,
          edits,
        });
        this.patchTimer = this.time.set(() => {
          if (this.inFlight?.id === id) {
            this.snapshot('Patch acknowledgment timed out');
            this.inFlight = undefined;
            this.conflicted = true;
            this.state.status = 'Conflict';
            this.state.detail =
              'Patch acknowledgment timed out. Reopen the document to negotiate its current buffer.';
            this.state.deadline = undefined;
            this.emit();
          }
        }, 10_000);
        return;
      }
      if (this.authority === 'text') {
        this.state.status = 'Parsing';
        this.emit();
        this.commit();
      } else this.state.status = 'Synced';
    } catch (error) {
      const d = error as Diagnostic;
      this.state.status = /unsupported/i.test(d.message)
        ? 'Unsupported construct'
        : 'Invalid source';
      this.state.diagnostics = [{ message: d.message, start: d.start ?? 0, end: d.end ?? 0 }];
    }
    this.emit();
  }
  patchResult(id: string, ok: boolean, version: number, text: string) {
    const pending = this.inFlight;
    if (!pending || pending.id !== id) return false;
    if (this.timer !== undefined) this.time.clear(this.timer);
    if (this.patchTimer !== undefined) this.time.clear(this.patchTimer);
    this.patchTimer = undefined;
    this.timer = undefined;
    this.inFlight = undefined;
    if (
      !ok ||
      pending.expected !== text ||
      version <= pending.version ||
      this.state.version !== pending.version
    ) {
      this.snapshot('Patch refused or concurrent buffer change');
      this.conflicted = true;
      this.state.deadline = undefined;
      this.state.status = 'Conflict';
      this.state.detail =
        'Live revision changed. Reopen the document; recovery contains pending edits.';
      this.emit();
      return true;
    }
    this.text = text;
    this.state.version = version;
    this.edits.clear();
    this.commit();
    this.emit();
    return true;
  }
  disconnect() {
    this.connected = false;
    if (this.timer !== undefined) this.time.clear(this.timer);
    if (this.patchTimer !== undefined) this.time.clear(this.patchTimer);
    if (this.pendingText || this.edits.size || this.inFlight) this.snapshot('Editor disconnected');
    this.inFlight = undefined;
    this.state.deadline = undefined;
    this.state.status = 'Disconnected';
    this.emit();
  }
  close() {
    this.disconnect();
  }
}
