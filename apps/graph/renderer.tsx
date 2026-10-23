// SPDX-License-Identifier: GPL-3.0-only
import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useNodesState,
  type NodeProps,
  type Node as FlowNode,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './style.css';
import type { State } from '../../packages/core/index.js';
import type { Operator } from '../../packages/protocol/index.js';
type Command = { type: string; [key: string]: unknown };
declare global {
  interface Window {
    mira: {
      command(c: Command): Promise<any>;
      subscribe(f: (states: State[]) => void): () => void;
    };
  }
}
const names: Record<Operator, string> = {
  '+': 'ADD',
  '-': 'SUB',
  '*': 'MUL',
  '&': 'AND',
  '|': 'OR',
  '^': 'XOR',
};
type Data = { label: string; kind: string; width?: number; op?: Operator; [key: string]: unknown };
function CircuitNode({ data, selected }: NodeProps<FlowNode<Data>>) {
  return (
    <div className={`circuit-node ${data.kind} ${selected ? 'selected' : ''}`}>
      {data.kind !== 'input' && data.kind !== 'literal' && (
        <Handle
          type="target"
          position={Position.Left}
          id="left"
          style={{ top: ['op', 'mux'].includes(data.kind) ? '35%' : '50%' }}
        />
      )}
      {['op', 'mux'].includes(data.kind) && (
        <Handle type="target" position={Position.Left} id="right" style={{ top: '72%' }} />
      )}
      {data.kind === 'mux' && <Handle type="target" position={Position.Top} id="select" />}
      <div className="node-kind">
        {['op', 'literal', 'slice'].includes(data.kind)
          ? `${data.kind.toUpperCase()} · EDITABLE`
          : data.kind.toUpperCase()}
      </div>
      <div className="node-name">
        {data.kind === 'op' ? (
          <>
            <span className="op-symbol">{data.op}</span>
            {names[data.op!]}
          </>
        ) : (
          data.label
        )}
      </div>
      <div className="node-width">
        {data.width ?? '?'} bit{data.width === 1 ? '' : 's'}
        {data.kind === 'op' ? ' · RTL expression' : ''}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { circuit: CircuitNode };
function Diagram({ state, onError }: { state: State; onError: (s: string) => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode<Data>>([]);
  const [selected, setSelected] = useState<string>();
  const pending = state.pendingEdits ?? {};
  const [draft, setDraft] = useState('');
  const keyboardMove = useRef(false);
  const dragging = useRef(false);
  const latestPositions = useRef(new Map<string, { x: number; y: number }>());
  useEffect(() => {
    if (dragging.current) return;
    setNodes(
      (old) =>
        state.graph?.nodes.map((n) => ({
          id: n.id,
          type: 'circuit',
          position: state.layout.nodes[n.id] ?? { x: n.depth * 250, y: n.row * 120 },
          selected: old.find((o) => o.id === n.id)?.selected,
          data: { ...n, label: n.label },
        })) ?? [],
    );
  }, [state.graph, state.layout, state.status, setNodes]);
  const node = state.graph?.nodes.find((n) => n.id === selected);
  useEffect(() => {
    setDraft(node ? (pending[node.id]?.value ?? node.range ?? node.selector ?? node.label) : '');
  }, [selected, node?.label, node?.range, node?.selector, pending[selected ?? '']?.value]);
  const command = (c: Command) => window.mira.command(c).catch((e: Error) => onError(e.message));
  const change = async (op: Operator) => {
    try {
      await window.mira.command({ type: 'edit', uri: state.uri, id: selected, op });
    } catch (e) {
      onError(String(e));
    }
  };
  const displayNodes = useMemo(
    () =>
      nodes.map((n) => {
        const p = pending[n.id];
        if (!p) return n;
        return {
          ...n,
          data: {
            ...n.data,
            ...(p.kind === 'operator'
              ? { op: p.value as Operator }
              : p.kind === 'literal'
                ? { label: p.value }
                : p.kind === 'slice'
                  ? { label: n.data.label.split('[')[0] + p.value }
                  : {}),
          },
        };
      }),
    [nodes, pending],
  );
  return (
    <div className="workspace">
      <section
        className="canvas"
        aria-label="Circuit graph"
        onKeyDownCapture={(e) => {
          keyboardMove.current =
            ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) &&
            !!(e.target as HTMLElement).closest('.react-flow__node');
        }}
      >
        <div className="canvas-caption">
          <span className="live-dot" /> SOURCE LEVEL RTL{' '}
          <span className="caption-count">
            {state.graph?.nodes.length ?? 0} nodes · {state.graph?.edges.length ?? 0} connections
          </span>
        </div>
        <ReactFlow
          nodes={displayNodes}
          edges={state.graph?.edges ?? []}
          nodeTypes={nodeTypes}
          onNodesChange={(changes) => {
            for (const c of changes)
              if (c.type === 'position' && c.position) {
                latestPositions.current.set(c.id, c.position);
                if (c.dragging) dragging.current = true;
                if (keyboardMove.current)
                  void command({
                    type: 'move',
                    uri: state.uri,
                    id: c.id,
                    x: c.position.x,
                    y: c.position.y,
                  });
              }
            onNodesChange(changes);
            keyboardMove.current = false;
          }}
          onNodeClick={(_e, n) => setSelected(n.id)}
          onSelectionChange={useCallback(
            ({ nodes }: { nodes: FlowNode[] }) => setSelected(nodes[0]?.id),
            [],
          )}
          onPaneClick={() => setSelected(undefined)}
          onNodeDragStart={() => {
            dragging.current = true;
          }}
          onNodeDragStop={(_e, n) => {
            dragging.current = false;
            const p = latestPositions.current.get(n.id) ?? n.position;
            void command({ type: 'move', uri: state.uri, id: n.id, x: p.x, y: p.y });
          }}
          onMoveEnd={(_e, v) => {
            void command({ type: 'viewport', uri: state.uri, ...v });
          }}
          defaultViewport={state.layout.viewport}
          fitView={!state.layout.viewport}
          fitViewOptions={{ padding: 0.3 }}
          nodesConnectable={false}
          deleteKeyCode={null}
          minZoom={0.25}
          maxZoom={2}
          colorMode="dark"
          defaultEdgeOptions={{ type: 'smoothstep', style: { stroke: '#718aaa', strokeWidth: 2 } }}
        >
          <Background color="#26354c" gap={24} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => (n.data.kind === 'op' ? '#56debd' : '#667ba0')}
            maskColor="#0b1220bb"
          />
        </ReactFlow>
        {!state.graph && (
          <div className="empty">
            <div className="empty-symbol">⌘</div>
            <h2>Waiting for the first circuit</h2>
            <p>The module appears after 15 seconds of inactivity.</p>
          </div>
        )}
        <div className="canvas-legend">
          ○ Input &nbsp; ◇ Operation &nbsp; □ Output <span>Drag to arrange · Scroll to zoom</span>
        </div>
      </section>
      <aside className="inspector">
        <div className="eyebrow">COMPONENT INSPECTOR</div>
        {node ? (
          <>
            <h2>
              {node.kind === 'op'
                ? names[(pending[node.id]?.value as Operator) ?? node.op!]
                : node.label}
            </h2>
            <p className="muted">
              {node.kind === 'op'
                ? 'Editable RTL operation'
                : node.kind === 'mux'
                  ? 'MUX · select, true, false inputs'
                  : 'Source-defined ' + node.kind}
            </p>
            <dl>
              <dt>Width</dt>
              <dd>{node.width} bits</dd>
              <dt>Operands</dt>
              <dd>{node.operands?.join(', ') ?? '—'}</dd>
              <dt>Position</dt>
              <dd>
                {Math.round(state.layout.nodes[node.id]?.x ?? 0)},{' '}
                {Math.round(state.layout.nodes[node.id]?.y ?? 0)}
              </dd>
            </dl>
            {node.kind === 'op' && (
              <>
                <h3>Replace operation</h3>
                <div className="palette">
                  {(Object.keys(names) as Operator[]).map((op) => (
                    <button
                      key={op}
                      disabled={
                        state.status === 'Disconnected' ||
                        state.status === 'Applying' ||
                        state.status === 'Conflict'
                      }
                      className={(pending[node.id]?.value ?? node.op) === op ? 'active' : ''}
                      onClick={() => void change(op)}
                      aria-label={`Replace with ${names[op]}`}
                    >
                      <b>{op}</b>
                      <span>{names[op]}</span>
                    </button>
                  ))}
                </div>
                <p className="hint">
                  Updates the selected operator in VS Code after 15 quiet seconds. Comments and
                  formatting are preserved.
                </p>
              </>
            )}
            {(node.kind === 'literal' ||
              node.kind === 'slice' ||
              (node.kind === 'mux' && node.selector)) && (
              <form
                className="edit-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void command({
                    type: 'change',
                    uri: state.uri,
                    id: node.id,
                    kind: node.kind === 'mux' ? 'selector' : node.kind,
                    value: draft,
                  });
                }}
              >
                <label htmlFor="component-value">
                  {node.kind === 'literal'
                    ? 'Literal value'
                    : node.kind === 'slice'
                      ? 'Slice range'
                      : 'Mux selector'}
                </label>
                {node.kind === 'mux' ? (
                  <select
                    id="component-value"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                  >
                    {state.graph?.nodes
                      .filter((n) => ['input', 'wire', 'output'].includes(n.kind) && n.width === 1)
                      .map((n) => (
                        <option key={n.id} value={n.label}>
                          {n.label}
                        </option>
                      ))}
                  </select>
                ) : (
                  <input
                    id="component-value"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    maxLength={8192}
                    placeholder={node.kind === 'literal' ? "8'hFF" : '[7:0]'}
                  />
                )}
                <button disabled={['Disconnected', 'Applying', 'Conflict'].includes(state.status)}>
                  Queue change
                </button>
                <p className="hint">
                  Only this source token or range changes after 15 quiet seconds.
                </p>
              </form>
            )}
            {node.kind === 'mux' && !node.selector && (
              <p className="hint">
                This selector is an expression. Edit its supported operations in the graph, or
                change its structure in VS Code.
              </p>
            )}
          </>
        ) : (
          <>
            <h2>Explore the circuit</h2>
            <p className="muted">
              Select an operation to inspect its operands and change its function.
            </p>
            <div className="info-card">
              <span>01</span>
              <h3>Edit in either window</h3>
              <p>Text and operation changes sync after 15 seconds of inactivity.</p>
            </div>
            <div className="info-card">
              <span>02</span>
              <h3>Arrange your view</h3>
              <p>Drag nodes freely. Positions are saved independently of Verilog.</p>
            </div>
          </>
        )}
        <div className="inspector-bottom">
          LOCAL CONNECTION
          <br />
          <strong>127.0.0.1 · authenticated</strong>
          <p>Offline · No source uploads</p>
        </div>
      </aside>
    </div>
  );
}
function App() {
  const [states, setStates] = useState<State[]>([]);
  const [uri, setUri] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const known = useRef(new Set<string>());
  useEffect(() => {
    const added = states.filter((s) => !known.current.has(s.uri));
    known.current = new Set(states.map((s) => s.uri));
    if (added.length) setUri(added.at(-1)!.uri);
  }, [states]);
  useEffect(() => {
    const off = window.mira.subscribe(setStates);
    window.mira
      .command({ type: 'snapshot' })
      .then((s) => {
        setStates(s.states);
        setWorkspace(s.workspace);
      })
      .catch((e) => setError(String(e)));
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => {
      off();
      clearInterval(timer);
    };
  }, []);
  const state = states.find((s) => s.uri === uri) ?? states[0];
  const seconds = state?.deadline ? Math.max(0, Math.ceil((state.deadline - now) / 1000)) : 0;
  return (
    <main>
      <header>
        <div className="brand-icon">M</div>
        <div className="brand">
          Mira<span>GRAPHICAL</span>
        </div>
        <div className="header-divider" />
        <div className="project-name">
          {workspace.split(/[\\/]/).pop() ?? 'Local workspace'}
          <span>Verilog graph companion</span>
        </div>
        <div className="header-right">
          <span className="version">0.2 · COMBINATIONAL</span>
          <span
            className={`status ${(state?.status ?? 'Disconnected').replaceAll(' ', '-')}`}
            role="status"
          >
            ● {state?.status ?? 'Disconnected'}
            {seconds ? ` · ${seconds}s` : ''}
          </span>
        </div>
      </header>
      <nav>
        <span className="tab-icon">⌁</span>
        {states.length ? (
          <select
            aria-label="Shared module"
            value={state?.uri}
            onChange={(e) => setUri(e.target.value)}
          >
            {states.map((s) => (
              <option key={s.uri} value={s.uri}>
                {s.graph?.module ?? decodeURIComponent(s.uri.split('/').pop()!)} ·{' '}
                {decodeURIComponent(s.uri.split('/').pop()!)}
              </option>
            ))}
          </select>
        ) : (
          <span>No shared documents</span>
        )}
        <span className="nav-note">RTL STRUCTURE · VERILOG-2005 SUBSET</span>
      </nav>
      {error || state?.diagnostics.length || state?.detail ? (
        <div className="notice" role="alert">
          {error ||
            state?.diagnostics.map((d) => `${d.message} (UTF-16 offset ${d.start})`).join(' ') ||
            state?.detail}
          {error && (
            <button onClick={() => setError('')} aria-label="Dismiss notice">
              ×
            </button>
          )}
        </div>
      ) : null}
      {state ? (
        <Diagram key={state.uri} state={state} onError={setError} />
      ) : (
        <div className="welcome">
          <div className="eyebrow">YOUR RTL, CONNECTED</div>
          <h1>A circuit beside your code.</h1>
          <p>
            Open a Verilog file in VS Code, then run
            <br />
            <strong>RTL Graph: Open Current Module</strong>.
          </p>
          <div className="welcome-steps">
            <span>1 &nbsp; Start this app for your workspace</span>
            <span>2 &nbsp; Open the companion extension</span>
            <span>3 &nbsp; Share a module and wait 15 seconds</span>
          </div>
          <p className="hint">Workspace: {workspace}</p>
        </div>
      )}
      <footer>
        <span>◈ &nbsp; {state?.graph?.module ?? 'Mira Graphical'}</span>
        <span>
          {state
            ? 'Layout saved separately · Semantic updates after 15s'
            : 'Waiting for VS Code · Use Connect/Disconnect to reconnect'}
        </span>
        <span>GPLv3 · Local first</span>
      </footer>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
