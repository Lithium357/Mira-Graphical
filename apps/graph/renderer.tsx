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
import { PaneDivider } from './pane-divider.js';
import type { State } from '../../packages/core/index.js';
import { SimulationPanel } from './simulation-panel.js';
import type { Simulation } from '../../packages/verilog/simulation.js';
import type { ClipboardItem, InputPort } from '../../packages/protocol/index.js';
import { ConstructionForm, WiringInspector } from './construction-form.js';
import type { CircuitAction } from '../../packages/protocol/index.js';
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
function CircuitNode({ data }: NodeProps<FlowNode<Data>>) {
  return (
    <div
      className={`circuit-node ${data.kind} ${data.inspected ? 'selected' : ''}`}
      style={
        ['instance', 'concat'].includes(data.kind)
          ? {
              minHeight: Math.max(
                110,
                Math.max(
                  (data.inputPorts as unknown[] | undefined)?.length ?? 0,
                  (data.outputPorts as unknown[] | undefined)?.length ?? 0,
                ) *
                  26 +
                  50,
              ),
            }
          : undefined
      }
    >
      {!['input', 'literal', 'instance', 'concat'].includes(data.kind) && (
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
      {(data.inputPorts as { name: string; width: number }[] | undefined)?.map((p, i, ports) => (
        <Handle
          key={p.name}
          type="target"
          position={Position.Left}
          id={p.name}
          style={{ top: `${((i + 1) * 100) / (ports.length + 1)}%` }}
        />
      ))}
      {(data.outputPorts as { name: string }[] | undefined)?.map((p, i, ports) => (
        <Handle
          key={p.name}
          type="source"
          position={Position.Right}
          id={`out:${p.name}`}
          isConnectableStart={false}
          style={{ top: `${((i + 1) * 100) / (ports.length + 1)}%` }}
        />
      ))}
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
        {data.kind === 'instance' ? (
          `${(data.inputPorts as unknown[] | undefined)?.length ?? 0} inputs · ${(data.outputPorts as unknown[] | undefined)?.length ?? 0} outputs`
        ) : (
          <>
            {data.width ?? '?'} bit{data.width === 1 ? '' : 's'}
          </>
        )}
        {data.kind === 'op' ? ' · RTL expression' : ''}
      </div>
      {data.assignmentTarget ? (
        <div className="node-result">→ {String(data.assignmentTarget)}</div>
      ) : null}
      {data.kind !== 'instance' && (
        <Handle
          type="source"
          position={Position.Right}
          isConnectableStart={!!data.sourceNet && !!data.connectable}
        />
      )}
      {data.simulation ? (
        <div className="node-simulation" title={String(data.simulation)}>
          {String(data.simulation).slice(0, 26)}
        </div>
      ) : null}
      {data.warning ? <div className="undriven">⚠ {String(data.warning)}</div> : null}
      {data.undriven ? <div className="undriven">UNDRIVEN</div> : null}
    </div>
  );
}
const nodeTypes = { circuit: CircuitNode };
// React Flow queues fits in its store. Stable props must not overwrite a queued
// overview fit when a layout/status update renders the parent in the same frame.
const initialFit = { padding: 0.15, minZoom: 0.65, maxZoom: 1 };
const overviewFit = { padding: 0.15, minZoom: 0.25, maxZoom: 1 };
function Diagram({
  state,
  shared,
  onError,
}: {
  state: State;
  shared: State[];
  onError: (s: string) => void;
}) {
  const graph = state.previewGraph ?? state.graph;
  const flowInstance = useRef<(() => Promise<boolean>) | null>(null);
  const [adding, setAdding] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [clipboard, setClipboard] = useState<ClipboardItem[]>([]);
  const [importChoice, setImportChoice] = useState('');
  const [copyNote, setCopyNote] = useState('');
  const [wireLabels, setWireLabels] = useState(false);
  const [simulationOpen, setSimulationOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const inspector = useRef<HTMLElement>(null);
  const workspaceElement = useRef<HTMLDivElement>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [simulationMinimized, setSimulationMinimized] = useState(false);
  const readSize = (key: string, fallback: number) => {
    try {
      const n = Number(localStorage.getItem(key));
      return Number.isFinite(n) && n > 0 ? n : fallback;
    } catch {
      return fallback;
    }
  };
  const [inspectorWidth, setInspectorWidth] = useState(() => readSize('mira.inspectorWidth', 320));
  const [simulationHeight, setSimulationHeight] = useState(() =>
    readSize('mira.simulationHeight', 220),
  );
  const [space, setSpace] = useState({
    width: window.innerWidth,
    height: window.innerHeight - 150,
  });
  useEffect(() => {
    const element = workspaceElement.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setSpace({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const maxInspector = Math.max(260, Math.min(480, space.width * 0.42));
  const maxSimulation = Math.max(140, Math.floor((space.height - 52) * 0.45));
  const rightSize = Math.max(260, Math.min(maxInspector, inspectorWidth));
  const bottomSize = Math.max(140, Math.min(maxSimulation, simulationHeight));
  useEffect(() => {
    try {
      localStorage.setItem('mira.inspectorWidth', String(inspectorWidth));
      localStorage.setItem('mira.simulationHeight', String(simulationHeight));
    } catch {}
  }, [inspectorWidth, simulationHeight]);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode<Data>>([]);
  const [selected, setSelected] = useState<string>();
  useEffect(() => {
    inspector.current?.scrollTo(0, 0);
  }, [selected, adding]);
  useEffect(() => {
    setInspectorOpen(!!selected || adding);
  }, [selected, adding]);
  const pending = state.pendingEdits ?? {};
  const [draft, setDraft] = useState('');
  const keyboardMove = useRef(false);
  const dragging = useRef(false);
  const latestPositions = useRef(new Map<string, { x: number; y: number }>());
  useEffect(() => {
    if (dragging.current) return;
    setNodes(
      (old) =>
        graph?.nodes.map((n) => ({
          id: n.id,
          type: 'circuit',
          position: state.layout.nodes[n.id] ?? { x: n.depth * 250, y: n.row * 160 },
          selected: old.find((o) => o.id === n.id)?.selected,
          data: { ...n, label: n.label, connectable: state.canConstruct },
        })) ?? [],
    );
  }, [graph, state.layout, state.status, state.canConstruct, setNodes]);
  const node = graph?.nodes.find((n) => n.id === selected);
  useEffect(() => {
    setDraft(node ? (pending[node.id]?.value ?? node.range ?? node.selector ?? node.label) : '');
  }, [selected, node?.label, node?.range, node?.selector, pending[selected ?? '']?.value]);
  const command = (c: Command) => window.mira.command(c).catch((e: Error) => onError(e.message));
  const action = async (action: CircuitAction) => {
    const result = await command({ type: 'circuit', uri: state.uri, action });
    if (result?.createdModule) {
      setAdding(false);
      setCopyNote('Module queued. Choose it in the module picker after synchronization.');
    }
    if (result?.selectedId) {
      setSelected(result.selectedId);
      setAdding(false);
    }
  };
  const copy = async (duplicate = false) => {
    const items = await command({
      type: 'copy',
      uri: state.uri,
      ids:
        selected && !selection.includes(selected)
          ? [selected]
          : selection.length
            ? selection
            : selected
              ? [selected]
              : [],
    });
    if (items) {
      setClipboard(items);
      setCopyNote(`Copied ${items.length} items`);
      if (duplicate) await action({ kind: 'paste', items });
    }
  };
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
        if (!p)
          return {
            ...n,
            data: {
              ...n.data,
              inspected: selection.includes(selected ?? '')
                ? selection.includes(n.id)
                : n.id === selected,
              simulation: values[n.data.key as string],
              warning: graph?.issues
                ?.filter((i) => i.nodeKey === n.data.key)
                .map((i) => i.code)
                .join(', '),
            },
          };
        return {
          ...n,
          data: {
            ...n.data,
            inspected: selection.includes(selected ?? '')
              ? selection.includes(n.id)
              : n.id === selected,
            simulation: values[n.data.key as string],
            warning: graph?.issues
              ?.filter((i) => i.nodeKey === n.data.key)
              .map((i) => i.code)
              .join(', '),
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
    [nodes, pending, selected, selection, values, graph],
  );
  return (
    <div
      className="workspace"
      ref={workspaceElement}
      onPointerDownCapture={(e) => {
        for (const menu of e.currentTarget.querySelectorAll<HTMLDetailsElement>(
          '.toolbar-menu[open]',
        ))
          if (!menu.contains(e.target as Node)) menu.open = false;
      }}
    >
      <section
        className="canvas"
        aria-label="Circuit graph"
        onKeyDownCapture={(e) => {
          if (
            !(e.target as HTMLElement).closest('input,select,textarea,button') &&
            (e.ctrlKey || e.metaKey)
          ) {
            if (e.key.toLowerCase() === 'c') {
              e.preventDefault();
              void copy();
            }
            if (e.key.toLowerCase() === 'v' && clipboard.length) {
              e.preventDefault();
              void action({ kind: 'paste', items: clipboard });
            }
            if (e.key.toLowerCase() === 'd') {
              e.preventDefault();
              void copy(true);
            }
            if (e.key.toLowerCase() === 'k') {
              e.preventDefault();
              setAdding(true);
            }
          }
          keyboardMove.current =
            ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) &&
            !!(e.target as HTMLElement).closest('.react-flow__node');
        }}
      >
        <div className="construction-toolbar">
          <button
            disabled={!state.canConstruct}
            onClick={() => {
              setAdding(true);
              setSelected(undefined);
            }}
          >
            Add component
          </button>
          <details
            className="toolbar-menu"
            onKeyDown={(e) => {
              if (e.key === 'Escape') e.currentTarget.open = false;
            }}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('button')) e.currentTarget.open = false;
            }}
          >
            <summary>Edit</summary>
            <div className="menu-popover">
              <button
                disabled={!state.canConstruct || !state.undoCount}
                onClick={() => void command({ type: 'history', uri: state.uri, direction: 'undo' })}
              >
                Undo pending
              </button>
              <button
                disabled={!state.canConstruct || !state.redoCount}
                onClick={() => void command({ type: 'history', uri: state.uri, direction: 'redo' })}
              >
                Redo pending
              </button>
              <button
                disabled={!state.canConstruct || !state.pendingSteps}
                onClick={() =>
                  void command({ type: 'discard', uri: state.uri }).then(() =>
                    setCopyNote('Pending batch discarded.'),
                  )
                }
              >
                Discard pending
              </button>
              <button
                disabled={!state.canConstruct || (!selection.length && !selected)}
                onClick={() => void copy()}
              >
                Copy
              </button>
              <button
                disabled={!state.canConstruct || !clipboard.length}
                onClick={() => void action({ kind: 'paste', items: clipboard })}
              >
                Paste
              </button>
              <button
                disabled={!state.canConstruct || (!selection.length && !selected)}
                onClick={() => void copy(true)}
              >
                Duplicate
              </button>
            </div>
          </details>
          <button onClick={() => setSimulationOpen((open) => !open)} aria-pressed={simulationOpen}>
            Simulation
          </button>
          <details
            className="toolbar-menu"
            onKeyDown={(e) => {
              if (e.key === 'Escape') e.currentTarget.open = false;
            }}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('button')) e.currentTarget.open = false;
            }}
          >
            <summary>View</summary>
            <div className="menu-popover">
              <label>
                <input
                  type="checkbox"
                  checked={wireLabels}
                  onChange={(e) => setWireLabels(e.target.checked)}
                />{' '}
                Wire labels
              </label>
              <button onClick={() => void flowInstance.current?.()}>Readable zoom</button>
            </div>
          </details>
          <span className="toolbar-spacer" />
          {!!graph?.issues?.length && (
            <button className="warnings-toggle" onClick={() => setInspectorOpen(true)}>
              {graph.issues.length} warnings
            </button>
          )}
          <button onClick={() => setInspectorOpen((open) => !open)} aria-pressed={inspectorOpen}>
            Inspector
          </button>
        </div>
        <div className="flow-surface">
          {' '}
          <div className="canvas-caption">
            <span className="live-dot" /> SOURCE LEVEL RTL{' '}
            <span className="caption-count">
              {graph?.nodes.length ?? 0} nodes · {graph?.edges.length ?? 0} connections
            </span>
          </div>
          <ReactFlow
            selectionOnDrag
            panOnDrag={[1, 2]}
            multiSelectionKeyCode={['Meta', 'Control']}
            nodes={displayNodes}
            edges={(graph?.edges ?? []).map((e) => {
              const source = graph?.nodes.find((n) => n.id === e.source),
                port = source?.outputPorts?.find((p) => `out:${p.name}` === e.sourceHandle);
              return {
                ...e,
                label: wireLabels
                  ? `${port?.signal ?? source?.sourceNet ?? source?.label} · ${port?.width ?? source?.width ?? '?'}b`
                  : undefined,
                labelStyle: { fill: '#d8eee7', fontSize: 16 },
                labelBgStyle: { fill: '#0c1827' },
              };
            })}
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
            onNodeClick={(_e, n) => {
              setSelected(n.id);
              setAdding(false);
            }}
            onPaneClick={() => setSelected(undefined)}
            onSelectionChange={useCallback(({ nodes }: { nodes: FlowNode[] }) => {
              setSelected(nodes[0]?.id);
              setSelection(nodes.map((n) => n.id));
            }, [])}
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
            fitViewOptions={initialFit}
            onInit={(flow) => {
              flowInstance.current = async () => {
                const fitted = await flow.fitView({ padding: 0.15, minZoom: 0.75, maxZoom: 1 });
                const bounds = flow.getNodesBounds(flow.getNodes());
                const area = workspaceElement.current?.querySelector('.flow-surface');
                const viewport = flow.getViewport();
                if (area)
                  await flow.setViewport({
                    ...viewport,
                    x:
                      bounds.width * viewport.zoom > area.clientWidth - 48
                        ? 24 - bounds.x * viewport.zoom
                        : viewport.x,
                    y:
                      bounds.height * viewport.zoom > area.clientHeight - 80
                        ? 48 - bounds.y * viewport.zoom
                        : viewport.y,
                  });
                return fitted;
              };
              if (state.layout.viewport && state.layout.viewport.zoom < 0.65)
                requestAnimationFrame(
                  () => void flow.fitView({ padding: 0.15, minZoom: 0.65, maxZoom: 1 }),
                );
            }}
            nodesConnectable={!!state.canConstruct}
            isValidConnection={(c) =>
              !!graph?.nodes.find((n) => n.id === c.source)?.sourceNet &&
              c.source !== c.target &&
              (['left', 'right', 'select'].includes(c.targetHandle ?? '') ||
                /^(part:[0-9]+|port:[A-Za-z_][A-Za-z0-9_$]*)$/.test(c.targetHandle ?? ''))
            }
            onConnect={(c) =>
              void action({
                kind: 'connect',
                source: c.source,
                target: c.target,
                port: c.targetHandle as InputPort,
              })
            }
            deleteKeyCode={null}
            minZoom={0.25}
            maxZoom={2}
            colorMode="dark"
            defaultEdgeOptions={{
              type: 'smoothstep',
              style: { stroke: '#718aaa', strokeWidth: 2 },
            }}
          >
            <Background color="#26354c" gap={24} size={1} />
            <Controls showInteractive={false} fitViewOptions={overviewFit} />
            <MiniMap
              pannable
              zoomable
              nodeColor={(n) => (n.data.kind === 'op' ? '#56debd' : '#667ba0')}
              maskColor="#0b1220bb"
            />
          </ReactFlow>
          {!graph && (
            <div className="empty">
              <div className="empty-symbol">⌘</div>
              <h2>Waiting for the first circuit</h2>
              <p>The module appears after 15 seconds of inactivity.</p>
            </div>
          )}
          <div className="canvas-legend">
            Drag to arrange · Scroll to zoom · Shift-drag to select
          </div>
        </div>
        {simulationOpen && graph && (
          <div
            className={`simulation-dock ${simulationMinimized ? 'minimized' : ''}`}
            style={{ height: simulationMinimized ? 42 : bottomSize }}
          >
            {!simulationMinimized && (
              <PaneDivider
                axis="horizontal"
                label="Resize simulation"
                value={bottomSize}
                min={140}
                max={maxSimulation}
                onChange={setSimulationHeight}
              />
            )}
            <SimulationPanel
              minimized={simulationMinimized}
              onMinimize={() => setSimulationMinimized((value) => !value)}
              onClose={() => setSimulationOpen(false)}
              graph={graph}
              revision={`${state.version}:${state.pendingSteps}`}
              disabled={!state.canConstruct}
              run={(inputs) =>
                window.mira.command({
                  type: 'simulate',
                  uri: state.uri,
                  inputs,
                }) as Promise<Simulation>
              }
              onValues={setValues}
              onError={onError}
            />
          </div>
        )}
      </section>
      {inspectorOpen && (
        <>
          <PaneDivider
            axis="vertical"
            label="Resize inspector"
            value={rightSize}
            min={260}
            max={maxInspector}
            onChange={setInspectorWidth}
          />
          <aside
            className="inspector"
            ref={inspector}
            style={{ width: rightSize }}
            aria-label="Component inspector"
          >
            <div className="pane-heading">
              <strong>{adding ? 'Add component' : 'Inspector'}</strong>
              <button aria-label="Close inspector" onClick={() => setInspectorOpen(false)}>
                ×
              </button>
            </div>
            {node && (
              <div className="node-actions">
                <button disabled={!state.canConstruct} onClick={() => void copy()}>
                  Copy
                </button>
                <button disabled={!state.canConstruct} onClick={() => void copy(true)}>
                  Duplicate
                </button>
              </div>
            )}
            {!!graph?.issues?.length && (
              <details className="diagnostic-list">
                <summary>{graph.issues.length} circuit warnings</summary>
                {graph.issues.map((issue, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setSelected(graph.nodes.find((n) => n.key === issue.nodeKey)?.id);
                      setAdding(false);
                    }}
                  >
                    {issue.message}
                  </button>
                ))}
              </details>
            )}
            {adding && graph ? (
              <>
                <div className="edit-form import-form">
                  <label htmlFor="import-module">Import from another shared file</label>
                  <select
                    id="import-module"
                    value={importChoice}
                    onChange={(e) => setImportChoice(e.target.value)}
                  >
                    <option value="">Choose shared module</option>
                    {shared
                      .filter((s) => s.uri !== state.uri && s.canConstruct && !s.pendingSteps)
                      .flatMap(
                        (s) =>
                          s.graph?.library?.map((m) => (
                            <option key={s.uri + m.name} value={JSON.stringify([s.uri, m.name])}>
                              {m.name} · {decodeURIComponent(s.uri.split('/').pop()!)}
                            </option>
                          )) ?? [],
                      )}
                  </select>
                  <button
                    disabled={!state.canConstruct || !importChoice}
                    onClick={() => {
                      const [fromUri, name] = JSON.parse(importChoice);
                      void command({ type: 'importModule', uri: state.uri, fromUri, name }).then(
                        (result) => {
                          if (result) {
                            setAdding(false);
                            setCopyNote(
                              'Definitions imported as a local copy. Choose them after synchronization.',
                            );
                          }
                        },
                      );
                    }}
                  >
                    Import module
                  </button>
                </div>
                <ConstructionForm
                  graph={graph}
                  disabled={!state.canConstruct}
                  onCreate={(a) => void action(a)}
                />
              </>
            ) : node ? (
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
                {graph && (
                  <WiringInspector
                    key={node.id}
                    node={node}
                    graph={graph}
                    disabled={!state.canConstruct}
                    onAction={(a) => void action(a)}
                  />
                )}
                {node.childModule && (
                  <>
                    <p>Module: {node.childModule}</p>
                    <button
                      disabled={!state.canConstruct || !!state.pendingSteps}
                      onClick={() =>
                        void command({ type: 'module', uri: state.uri, name: node.childModule })
                      }
                    >
                      Open module
                    </button>
                    {node.outputPorts?.map((p) => (
                      <p className="hint" key={p.name}>
                        {p.name} → {p.signal} ({p.width} bits)
                      </p>
                    ))}
                  </>
                )}
                <dl>
                  <dt>Width</dt>
                  <dd>{node.width === undefined ? 'See named ports' : `${node.width} bits`}</dd>
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
                        {graph?.nodes
                          .filter(
                            (n) => ['input', 'wire', 'output'].includes(n.kind) && n.width === 1,
                          )
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
                    <button
                      disabled={['Disconnected', 'Applying', 'Conflict'].includes(state.status)}
                    >
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
                  Add components, connect named signals, or select an existing component to edit it.
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
        </>
      )}
      <div className="workspace-status" role="status">
        {copyNote}
      </div>
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
          <span className="version">0.4 · CIRCUIT WORKBENCH</span>
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
        {state?.graph?.library && (
          <select
            aria-label="Module definition"
            value={state.graph.module}
            disabled={!state.canConstruct || !!state.pendingSteps}
            onChange={(e) =>
              void window.mira
                .command({ type: 'module', uri: state.uri, name: e.target.value })
                .catch((e) => setError(String(e)))
            }
          >
            {state.graph.library.map((m) => (
              <option key={m.name}>{m.name}</option>
            ))}
          </select>
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
        <Diagram
          key={`${state.uri}:${state.graph?.module}`}
          state={state}
          shared={states}
          onError={setError}
        />
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
