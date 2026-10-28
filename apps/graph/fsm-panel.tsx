// SPDX-License-Identifier: GPL-3.0-only
import React, { useEffect, useRef, useState } from 'react';
import type { StateMachine } from '../../packages/verilog/fsm.js';

function encoding(value: string): bigint | undefined {
  try {
    const m = /^\d+'([bodh])([0-9a-f]+)$/i.exec(value);
    return m
      ? BigInt(({ b: '0b', o: '0o', d: '', h: '0x' }[m[1].toLowerCase()] ?? '') + m[2])
      : BigInt(value);
  } catch {
    return;
  }
}
export function FsmPanel({
  machines,
  values,
  module,
  onClose,
  stale,
}: {
  machines: StateMachine[];
  values: Record<string, string>;
  module: string;
  onClose: () => void;
  stale: boolean;
}) {
  const [selected, setSelected] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const machine = machines.find((m) => m.register === selected) ?? machines[0];
  const routes = new Map<string, { from: string; to: string; indices: number[] }>();
  machine?.transitions.forEach((t, i) => {
    const key = JSON.stringify([t.from, t.to]);
    const route = routes.get(key) ?? { from: t.from, to: t.to, indices: [] };
    route.indices.push(i + 1);
    routes.set(key, route);
  });
  const value = machine ? values[`${module}/net/${machine.register}`] : undefined;
  const active =
    value === undefined || stale
      ? undefined
      : machine?.states.find(
          (s) => encoding(s.value) !== undefined && encoding(s.value) === encoding(value),
        )?.name;
  const position = (name: string) => {
    const i = machine!.states.findIndex((s) => s.name === name);
    return { x: 140 + (i % 3) * 310, y: 85 + Math.floor(i / 3) * 180 };
  };
  return (
    <section
      className="workspace-overlay"
      aria-label="State machines"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="simulation-heading">
        <h2 ref={heading} tabIndex={-1}>
          State machines
        </h2>
        <span className="toolbar-spacer" />
        <button onClick={onClose}>Close state view</button>
      </div>
      <p>
        Derived from enum register drivers. Conditions describe reset and sampled clock transitions;
        the diagram does not edit HDL. Use Simulation to highlight the active state.
      </p>
      {stale && (
        <p role="status">
          Source changes are pending. This diagram shows the last synchronized design.
        </p>
      )}
      {!machine ? (
        <p>
          No supported enum state register in this module. Select a module containing a clocked enum
          variable.
        </p>
      ) : (
        <>
          <label>
            State register{' '}
            <select value={machine.register} onChange={(e) => setSelected(e.target.value)}>
              {machines.map((m) => (
                <option key={m.register}>{m.register}</option>
              ))}
            </select>
          </label>
          <p role="status">
            {machine.edge} {machine.clock} · Active state: {active ?? 'unknown / not sampled'}
          </p>
          {machine.detail ? (
            <p>{machine.detail}</p>
          ) : (
            <div className="fsm-diagram">
              <svg
                role="img"
                aria-label={`States and numbered transitions for ${machine.register}; conditions in the table below`}
                viewBox={`0 0 940 ${Math.max(180, Math.ceil(machine.states.length / 3) * 180)}`}
              >
                <defs>
                  <marker
                    id="fsm-arrow"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M0 0 L10 5 L0 10 z" fill="#91abc8" />
                  </marker>
                </defs>
                {[...routes.values()].map((t, i) => {
                  const a = position(t.from),
                    b = position(t.to),
                    same = t.from === t.to,
                    direction = a.x <= b.x ? 1 : -1;
                  const d = same
                    ? `M${a.x - 24},${a.y - 32} C${a.x - 100},${a.y - 100} ${a.x + 100},${a.y - 100} ${a.x + 24},${a.y - 32}`
                    : `M${a.x},${a.y + 40 * direction} Q${(a.x + b.x) / 2 + 35},${(a.y + b.y) / 2 + 65 * direction} ${b.x},${b.y - 42 * direction}`;
                  return (
                    <g key={i}>
                      <title>{`${t.indices.join(', ')}: ${t.from} → ${t.to}; conditions in the table below`}</title>
                      <path
                        d={d}
                        fill="none"
                        stroke="#91abc8"
                        strokeWidth="1.5"
                        markerEnd="url(#fsm-arrow)"
                      />
                      <text
                        x={same ? a.x : (a.x + b.x) / 2 + 18}
                        y={same ? a.y - 65 : (a.y + b.y) / 2 + 40 * direction}
                        fill="#bed2ec"
                        fontSize="14"
                      >
                        {t.indices.slice(0, 3).join(', ')}
                        {t.indices.length > 3 ? '…' : ''}
                      </text>
                    </g>
                  );
                })}
                {machine.states.map((s) => {
                  const p = position(s.name);
                  return (
                    <g key={s.name}>
                      <title>{`${s.name}, encoding ${s.value}${s.name === active ? ', active' : ''}`}</title>
                      <ellipse
                        cx={p.x}
                        cy={p.y}
                        rx="100"
                        ry="40"
                        fill={s.name === active ? '#185b4d' : '#17283c'}
                        stroke={s.name === active ? '#63efce' : '#91abc8'}
                        strokeWidth={s.name === active ? 4 : 2}
                      />
                      <text x={p.x} y={p.y + 5} textAnchor="middle" fill="#eef5ff" fontSize="17">
                        {s.name.length > 18 ? s.name.slice(0, 17) + '…' : s.name}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          )}
          <table>
            <caption>State encodings</caption>
            <thead>
              <tr>
                <th>State</th>
                <th>Encoding</th>
                <th>Active</th>
              </tr>
            </thead>
            <tbody>
              {machine.states.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td>{s.value}</td>
                  <td>{s.name === active ? 'Yes' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!machine.detail && (
            <table>
              <caption>Transition conditions (including holds and reset)</caption>
              <thead>
                <tr>
                  <th>#</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Condition</th>
                </tr>
              </thead>
              <tbody>
                {machine.transitions.map((t, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>{t.from}</td>
                    <td>{t.to}</td>
                    <td>{t.condition}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
