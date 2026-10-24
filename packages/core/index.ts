// SPDX-License-Identifier: GPL-3.0-only
import { createHash, randomUUID } from 'node:crypto';
import {
  DEBOUNCE_MS,
  type Edit,
  type Operator,
  type GraphChange,
  type CircuitAction,
  type SourceAction,
  type ClipboardItem,
} from '../protocol/index.js';
import { exportVhdlModule } from '../vhdl/index.js';
import { simulate } from '../verilog/simulation.js';
import { PatchDraft } from '../verilog/patches.js';
import { autoLayout } from './auto-layout.js';
import {
  sourceActionEdits,
  validateConstructionProof,
  copyComponents,
} from '../verilog/construction.js';
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
  viewports?: Record<string, Viewport>;
};
export type Recovery = {
  at: string;
  reason: string;
  uri: string;
  version: number;
  text: string;
  graphEdits: [string, GraphChange][];
  previewText?: string;
  graphActions?: SourceAction[];
};
export type State = {
  uri: string;
  version: number;
  activeModule?: string;
  status: string;
  detail?: string;
  graph?: Circuit;
  layout: Layout;
  deadline?: number;
  diagnostics: Diagnostic[];
  pendingEdits?: Record<string, GraphChange>;
  previewGraph?: Circuit;
  pendingSteps?: number;
  undoCount?: number;
  redoCount?: number;
  canConstruct?: boolean;
  recoveryWarning?: string;
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
  checkpoint?(snapshot: Recovery): void;
  publish(state: State): void;
  patch(p: {
    uri: string;
    baseVersion: number;
    baseHash: string;
    patchId: string;
    edits: Edit[];
    transaction?: SourceAction[];
  }): void;
  recover(snapshot: Recovery): void;
  persist(uri: string, layout: Layout): void;
}
type DraftFrame = {
  table: PatchDraft;
  graph: Circuit;
  steps: SourceAction[];
  edits: [string, GraphChange][];
};
type ConstructionDraft = DraftFrame & { undo: DraftFrame[]; redo: DraftFrame[] };
export class Session {
  private lastCheckpoint?: { text: string; version: number; table?: PatchDraft; edits: string };
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
  private draft?: ConstructionDraft;
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
    if (this.hooks.checkpoint) {
      const current = {
        text: this.text,
        version: this.state.version,
        table: this.draft?.table,
        edits: JSON.stringify([...this.edits]),
      };
      if (
        !this.lastCheckpoint ||
        Object.entries(current).some(
          ([key, value]) => this.lastCheckpoint![key as keyof typeof current] !== value,
        )
      ) {
        try {
          this.hooks.checkpoint(this.recoveryData('Live buffer checkpoint'));
          this.lastCheckpoint = current;
          this.state.recoveryWarning = undefined;
        } catch (error) {
          this.state.recoveryWarning = `Recovery checkpoint could not be saved: ${String(error)}`;
        }
      }
    }
    this.state.pendingEdits = Object.fromEntries(this.edits);
    this.state.previewGraph = this.draft?.graph;
    this.state.pendingSteps = this.draft?.steps.length ?? 0;
    this.state.undoCount = this.draft?.undo.length ?? 0;
    this.state.redoCount = this.draft?.redo.length ?? 0;
    this.state.canConstruct =
      !!this.state.graph &&
      this.connected &&
      !this.pendingText &&
      !this.inFlight &&
      !this.conflicted;
    this.hooks.publish(structuredClone(this.state));
  }
  private snapshot(reason: string) {
    this.hooks.recover(this.recoveryData(reason));
  }
  private recoveryData(reason: string): Recovery {
    let previewText = this.draft?.table.text;
    if (previewText === undefined && this.edits.size) {
      try {
        const edits = [...this.edits]
          .map(([id, change]) => graphPatch(this.text, this.state.graph, id, change))
          .sort((a, b) => b.start - a.start);
        validateEditableEdits(this.text, edits);
        previewText = edits.reduce(
          (text, e) => text.slice(0, e.start) + e.text + text.slice(e.end),
          this.text,
        );
      } catch {
        /* A concurrent source change may make the saved intent unsafe to render. */
      }
    }
    return {
      at: new Date(this.time.now()).toISOString(),
      reason,
      uri: this.state.uri,
      version: this.state.version,
      text: this.text,
      graphEdits: [...this.edits],
      previewText,
      graphActions: this.draft?.steps,
    };
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
    if (this.edits.size || this.draft) {
      this.snapshot('Text superseded pending graph edits');
      this.state.detail = 'Pending graph edits saved to recovery.';
      this.edits.clear();
      this.clearDraft();
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
    if (!this.pendingText) {
      const node = (this.draft?.graph ?? this.state.graph)?.nodes.find((n) => n.id === id);
      if (!node) throw new Error('Component no longer exists.');
      this.draftStep({ kind: 'change', target: node.key, change }, [id, change]);
      return;
    }
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
  private editableConstruction() {
    if (
      !this.connected ||
      this.inFlight ||
      this.conflicted ||
      this.pendingText ||
      !this.state.graph
    )
      throw new Error(
        'Wait for valid source to synchronize before changing circuit structure. Reopen after a conflict.',
      );
  }
  private frame(draft: ConstructionDraft): DraftFrame {
    return {
      table: draft.table.clone(),
      graph: structuredClone(draft.graph),
      steps: structuredClone(draft.steps),
      edits: structuredClone([...this.edits]),
    };
  }
  private place(graph: Circuit) {
    const positions = autoLayout(graph);
    for (const n of graph.nodes) {
      if (!this.state.layout.nodes[n.id]?.manuallyPlaced)
        this.state.layout.nodes[n.id] = { ...positions[n.id], manuallyPlaced: false };
    }
  }
  autoLayout() {
    const graph = this.draft?.graph ?? this.state.graph;
    if (!graph) return;
    for (const n of graph.nodes) delete this.state.layout.nodes[n.id];
    this.place(graph);
    delete this.state.layout.viewport;
    if (this.state.layout.viewports) delete this.state.layout.viewports[graph.module];
    this.hooks.persist(this.state.uri, this.state.layout);
    this.emit();
  }
  private clearDraft() {
    this.draft = undefined;
    this.state.previewGraph = undefined;
    if (this.state.graph) {
      const ids = new Set([
        ...this.state.graph.nodes.map((n) => n.id),
        ...Object.entries(this.state.layout.identities)
          .filter(([key]) => !key.startsWith(`${this.state.graph!.module}/`))
          .map(([, id]) => id),
      ]);
      this.state.layout.nodes = Object.fromEntries(
        Object.entries(this.state.layout.nodes).filter(([id]) => ids.has(id)),
      );
      this.place(this.state.graph);
    }
  }
  private draftStep(action: SourceAction, change?: [string, GraphChange]) {
    this.editableConstruction();
    const current = this.draft ?? {
      table: new PatchDraft(this.text),
      graph: this.state.graph!,
      steps: [],
      edits: [],
      undo: [],
      redo: [],
    };
    if (current.steps.length >= 100)
      throw new Error('Synchronize or discard this batch before adding more than 100 actions.');
    const table = current.table.clone();
    action = { ...action, scope: this.state.graph!.module };
    table.apply(sourceActionEdits(table.text, action));
    const graph = project(parse(table.text, this.state.graph!.module), current.graph);
    const before = this.frame(current);
    this.draft = {
      table,
      graph,
      steps: [...current.steps, action],
      edits: [],
      undo: [...current.undo, before].slice(-50),
      redo: [],
    };
    if (change) this.edits.set(change[0], change[1]);
    this.place(graph);
    this.authority = 'graph';
    this.activity();
  }
  circuitAction(action: CircuitAction) {
    this.editableConstruction();
    const graph = this.draft?.graph ?? this.state.graph!;
    if (graph.language === 'vhdl' && 'name' in action)
      action = { ...action, name: action.name.toLowerCase() };
    const key = (id: string) => {
      const n = graph.nodes.find((n) => n.id === id);
      if (!n) throw new Error('Component no longer exists.');
      return n.key;
    };
    let normalized: SourceAction = action;
    if (action.kind === 'connect')
      normalized = { ...action, source: key(action.source), target: key(action.target) };
    else if ('target' in action) normalized = { ...action, target: key(action.target) };
    const previousIds = new Set(graph.nodes.map((n) => n.id));
    this.draftStep(normalized);
    return {
      createdModule: action.kind === 'module' ? action.name : undefined,
      selectedIds: this.draft!.graph.nodes.filter((n) => !previousIds.has(n.id)).map((n) => n.id),
      selectedId:
        action.kind === 'create'
          ? ((this.draft!.graph.language === 'vhdl' && action.component === 'operation'
              ? this.draft!.graph.nodes.find(
                  (n) =>
                    n.kind === 'op' &&
                    n.key.startsWith(`${this.state.graph!.module}/assign/${action.name}/expr`),
                )?.id
              : undefined) ??
            this.draft!.graph.nodes.find((n) => n.assignmentTarget === action.name)?.id ??
            this.draft!.graph.nodes.find((n) => n.label === action.name)?.id)
          : this.draft!.graph.nodes.find((n) => !previousIds.has(n.id))?.id,
    };
  }
  exportModules(name: string): string[] {
    this.editableConstruction();
    if (this.draft?.table.edits().length)
      throw new Error('Synchronize the source module before importing it.');
    const ast = parse(this.text, name),
      needed = new Set<string>();
    const visit = (name: string) => {
      if (needed.has(name)) return;
      needed.add(name);
      for (const inst of ast.library[name].instances) visit(inst.module);
    };
    visit(name);
    return [...needed].map((name) =>
      ast.language === 'vhdl'
        ? exportVhdlModule(this.text, ast.library[name])
        : this.text.slice(ast.library[name].start, ast.library[name].end),
    );
  }
  simulate(inputs: Record<string, string>) {
    this.editableConstruction();
    return simulate(this.draft?.table.text ?? this.text, this.state.graph!.module, inputs);
  }
  copy(ids: string[]): ClipboardItem[] {
    this.editableConstruction();
    return copyComponents(
      this.draft?.table.text ?? this.text,
      this.draft?.graph ?? this.state.graph!,
      ids,
    );
  }
  selectModule(name: string) {
    this.editableConstruction();
    if (this.draft?.table.edits().length || this.edits.size)
      throw new Error('Synchronize or discard pending edits before navigating modules.');
    parse(this.text, name);
    this.clearDraft();
    if (this.timer !== undefined) this.time.clear(this.timer);
    this.timer = undefined;
    this.state.deadline = undefined;
    const views = (this.state.layout.viewports ??= Object.create(null));
    if (this.state.graph && this.state.layout.viewport)
      views[this.state.graph.module] = this.state.layout.viewport;
    this.state.layout.viewport = Object.hasOwn(views, name) ? views[name] : undefined;
    this.state.activeModule = name;
    this.commit();
    this.emit();
  }
  constructionHistory(direction: 'undo' | 'redo') {
    this.editableConstruction();
    const d = this.draft;
    if (!d || !d[direction].length) throw new Error(`No pending construction to ${direction}.`);
    const frame = this.frame(d),
      stack = [...d[direction]],
      restore = stack.pop()!;
    this.draft = {
      ...restore,
      table: restore.table.clone(),
      undo: direction === 'undo' ? stack : [...d.undo, frame],
      redo: direction === 'redo' ? stack : [...d.redo, frame],
    };
    this.edits = new Map(restore.edits);
    this.place(this.draft.graph);
    this.authority = 'graph';
    this.activity();
  }
  discardGraphChanges() {
    if (this.inFlight) throw new Error('Wait for the editor acknowledgment before discarding.');
    if (this.draft || this.edits.size) this.snapshot('Pending graph changes discarded by user');
    this.edits.clear();
    this.clearDraft();
    this.authority = this.pendingText ? 'text' : undefined;
    if (this.timer !== undefined) this.time.clear(this.timer);
    this.timer = undefined;
    this.state.deadline = undefined;
    if (this.pendingText) this.activity();
    else {
      this.state.status = !this.connected
        ? 'Disconnected'
        : this.conflicted
          ? 'Conflict'
          : 'Synced';
      this.emit();
    }
  }
  move(id: string, x: number, y: number) {
    if (
      !(this.draft?.graph ?? this.state.graph)?.nodes.some((n) => n.id === id) ||
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
      viewport.zoom < 0.1 ||
      viewport.zoom > 2
    )
      return;
    this.state.layout.viewport = viewport;
    this.hooks.persist(this.state.uri, this.state.layout);
  }
  private commit() {
    const first = parse(this.text);
    const ast = first.library[this.state.activeModule ?? ''] ?? first;
    this.state.activeModule = ast.name;
    const graph = project(ast, this.draft?.graph ?? this.state.graph, this.state.layout.identities);
    const ids = new Set([
      ...graph.nodes.map((n) => n.id),
      ...Object.entries(this.state.layout.identities)
        .filter(([key]) => !key.startsWith(`${ast.name}/`))
        .map(([, id]) => id),
    ]);
    this.state.layout.nodes = Object.fromEntries(
      Object.entries(this.state.layout.nodes).filter(([id]) => ids.has(id)),
    );
    this.state.layout.identities = Object.fromEntries([
      ...Object.entries(this.state.layout.identities).filter(
        ([key]) => !key.startsWith(`${ast.name}/`) && Object.hasOwn(ast.library, key.split('/')[0]),
      ),
      ...graph.nodes.map((n) => [n.key, n.id]),
    ]);
    this.place(graph);
    this.state.graph = graph;
    this.draft = undefined;
    this.state.previewGraph = undefined;
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
      if (this.authority === 'graph' && (this.edits.size || this.draft)) {
        // Reparse the live buffer and match structural keys. Never use stale offsets.
        const transaction = this.draft?.steps;
        const edits = this.draft
          ? this.draft.table.edits()
          : [...this.edits]
              .map(([id, change]) => graphPatch(this.text, this.state.graph, id, change))
              .sort((a, b) => b.start - a.start);
        if (!edits.length) {
          this.edits.clear();
          this.clearDraft();
          this.authority = undefined;
          this.state.status = 'Synced';
          this.emit();
          return;
        }
        if (transaction) validateConstructionProof(this.text, edits, transaction);
        else validateEditableEdits(this.text, edits);
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
          transaction,
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
    if (this.pendingText || this.edits.size || this.draft || this.inFlight)
      this.snapshot('Editor disconnected');
    this.inFlight = undefined;
    this.state.deadline = undefined;
    this.state.status = 'Disconnected';
    this.emit();
  }
  close() {
    this.disconnect();
  }
}
