// SPDX-License-Identifier: GPL-3.0-only
import React, { useState } from 'react';
import type { Circuit, Node } from '../../packages/verilog/index.js';
import type {
  CircuitAction,
  CreateComponent,
  InputPort,
  Operator,
} from '../../packages/protocol/index.js';
export function ConstructionForm({
  graph,
  disabled,
  onCreate,
}: {
  graph: Circuit;
  disabled: boolean;
  onCreate: (a: CircuitAction) => void;
}) {
  const [component, setComponent] = useState<CreateComponent['component'] | 'module'>('operation');
  const [name, setName] = useState(() => {
    let index = 1;
    while (graph.nodes.some((n) => n.label === `component_${index}`)) index++;
    return `component_${index}`;
  });
  const [width, setWidth] = useState(8);
  const [operator, setOperator] = useState<Operator>('+');
  const [value, setValue] = useState("8'h00");
  const nets = graph.nodes.filter((n) => ['input', 'output', 'wire'].includes(n.kind));
  const [source, setSource] = useState(nets[0]?.label ?? '');
  const [range, setRange] = useState('[0]');
  const [parts, setParts] = useState(
    nets
      .slice(0, 2)
      .map((n) => n.label)
      .join(', '),
  );
  const [moduleName, setModuleName] = useState(
    graph.library?.find((m) => m.name !== graph.module)?.name ?? '',
  );
  const [search, setSearch] = useState('');
  const types = [
    'operation',
    'mux',
    'constant',
    'slice',
    'split',
    'concat',
    'wire',
    'input',
    'output',
    'instance',
    'module',
  ] as const;
  return (
    <form
      className="edit-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (component === 'module') onCreate({ kind: 'module', name });
        else
          onCreate({
            kind: 'create',
            component,
            name,
            width,
            operator,
            value,
            source,
            range,
            parts: parts.split(',').map((p) => p.trim()),
            moduleName,
          });
      }}
    >
      <h2>Add component</h2>
      <label htmlFor="palette-search">Search palette</label>
      <input
        id="palette-search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="mux, bus, port, module…"
      />
      {search && (
        <div className="palette-results">
          {types
            .filter((k) =>
              (
                k +
                ' ' +
                (
                  {
                    concat: 'bus join',
                    split: 'bus bits',
                    input: 'port',
                    output: 'port',
                    instance: 'module',
                  } as Record<string, string>
                )[k]
              ).includes(search.toLowerCase()),
            )
            .map((k) => (
              <button
                type="button"
                key={k}
                onClick={() => {
                  setComponent(k);
                  setSearch('');
                  requestAnimationFrame(() => document.getElementById('new-kind')?.focus());
                }}
              >
                {k}
              </button>
            ))}
        </div>
      )}
      <label htmlFor="new-kind">Component type</label>
      <select
        id="new-kind"
        value={component}
        onChange={(e) => setComponent(e.target.value as CreateComponent['component'] | 'module')}
      >
        {types.map((k) => (
          <option key={k}>{k}</option>
        ))}
      </select>
      <label htmlFor="new-name">Signal / instance / module name</label>
      <input
        id="new-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        pattern="[a-zA-Z_][a-zA-Z_0-9$]*"
        maxLength={128}
        required
      />
      <label htmlFor="new-width">Bit width</label>
      <input
        id="new-width"
        type="number"
        min={1}
        max={4096}
        value={width}
        onChange={(e) => setWidth(Number(e.target.value))}
        required
      />
      {component === 'operation' && (
        <>
          <label htmlFor="new-op">Operation</label>
          <select
            id="new-op"
            value={operator}
            onChange={(e) => setOperator(e.target.value as Operator)}
          >
            {['+', '-', '*', '&', '|', '^'].map((op) => (
              <option key={op}>{op}</option>
            ))}
          </select>
        </>
      )}
      {component === 'constant' && (
        <>
          <label htmlFor="new-value">Constant value</label>
          <input id="new-value" value={value} onChange={(e) => setValue(e.target.value)} required />
        </>
      )}
      {(component === 'slice' || component === 'split') && (
        <>
          <label htmlFor="new-source">Source signal</label>
          <select id="new-source" value={source} onChange={(e) => setSource(e.target.value)}>
            {nets.map((n) => (
              <option key={n.id}>{n.label}</option>
            ))}
          </select>
          {component === 'slice' && (
            <>
              <label htmlFor="new-range">Slice range</label>
              <input
                id="new-range"
                value={range}
                onChange={(e) => setRange(e.target.value)}
                required
              />
            </>
          )}
        </>
      )}
      {component === 'concat' && (
        <>
          <label htmlFor="join-parts">Signals to join (MSB first)</label>
          <input
            id="join-parts"
            value={parts}
            onChange={(e) => setParts(e.target.value)}
            placeholder="high, low"
            required
          />
        </>
      )}
      {component === 'split' && (
        <p className="hint">
          Bit width is the chunk size. Results are named _0, _1… from least to most significant.
        </p>
      )}
      {component === 'instance' && (
        <>
          <label htmlFor="instance-module">Module definition</label>
          <select
            id="instance-module"
            value={moduleName}
            onChange={(e) => setModuleName(e.target.value)}
          >
            {graph.library
              ?.filter((m) => m.name !== graph.module)
              .map((m) => (
                <option key={m.name}>{m.name}</option>
              ))}
          </select>
        </>
      )}
      <button disabled={disabled}>Create component</button>
      <p className="hint">
        Operation and mux inputs start tied to zero. Wire them before the 15-second sync deadline,
        or continue after syncing.
      </p>
    </form>
  );
}
export function WiringInspector({
  node,
  graph,
  disabled,
  onAction,
}: {
  node: Node;
  graph: Circuit;
  disabled: boolean;
  onAction: (a: CircuitAction) => void;
}) {
  const sources = graph.nodes.filter(
    (n) => ['input', 'wire', 'output'].includes(n.kind) && n.id !== node.id,
  );
  const [source, setSource] = useState('');
  const ports: InputPort[] =
    node.kind === 'op'
      ? ['left', 'right']
      : node.kind === 'mux'
        ? ['select', 'left', 'right']
        : node.kind === 'instance' || node.kind === 'concat'
          ? (node.inputPorts?.map((p) => p.name as InputPort) ?? [])
          : ['wire', 'output', 'slice', 'convert'].includes(node.kind)
            ? ['left']
            : [];
  return (
    <div className="wiring-form">
      <h3>Wiring</h3>
      <p className="hint">
        Drag a named result handle to an input socket, or connect below. A new connection replaces
        the existing input.
      </p>
      {ports.length > 0 && (
        <>
          <label htmlFor="wire-source">Source signal</label>
          <select id="wire-source" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">Choose a signal</option>
            {sources.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label} · {n.width} bits
              </option>
            ))}
          </select>
          {ports.map((port) => (
            <button
              key={port}
              disabled={disabled || !source}
              onClick={() => onAction({ kind: 'connect', source, target: node.id, port })}
            >
              Connect{' '}
              {port === 'left' && ['wire', 'output', 'slice', 'convert'].includes(node.kind)
                ? 'driver'
                : port}
            </button>
          ))}
          {['op', 'mux', 'instance', 'concat', 'convert'].includes(node.kind) &&
            ports.map((port) => (
              <button
                key={`zero-${port}`}
                disabled={disabled}
                onClick={() => onAction({ kind: 'zero', target: node.id, port })}
              >
                Tie {port} to zero
              </button>
            ))}
        </>
      )}
      {node.undriven && <p className="undriven">Undriven signal: connect a source.</p>}
      {['wire', 'output'].includes(node.kind) && !node.undriven && (
        <button
          disabled={disabled}
          onClick={() => onAction({ kind: 'disconnect', target: node.id })}
        >
          Disconnect driver
        </button>
      )}
      {(node.kind === 'wire' || node.kind === 'instance' || node.assignmentTarget) && (
        <button disabled={disabled} onClick={() => onAction({ kind: 'remove', target: node.id })}>
          Remove component
        </button>
      )}
      {!['input', 'wire', 'output', 'instance'].includes(node.kind) && (
        <button disabled={disabled} onClick={() => onAction({ kind: 'zero', target: node.id })}>
          Replace component with zero
        </button>
      )}
    </div>
  );
}
