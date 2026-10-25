// SPDX-License-Identifier: GPL-3.0-only
import React, { useState, useEffect, useRef } from 'react';
import type { Circuit } from '../../packages/verilog/index.js';
import type { Simulation } from '../../packages/verilog/simulation.js';
export function SimulationPanel({
  graph,
  minimized,
  onMinimize,
  onClose,
  revision,
  disabled,
  run,
  onValues,
  onError,
}: {
  graph: Circuit;
  minimized: boolean;
  onMinimize: () => void;
  onClose: () => void;
  revision: string;
  disabled: boolean;
  run: (inputs: Record<string, string>, reset?: boolean) => Promise<Simulation>;
  onValues: (values: Record<string, string>) => void;
  onError: (message: string) => void;
}) {
  const ports = graph.nodes.filter((n) => n.kind === 'input');
  const signature = JSON.stringify([
    graph.module,
    graph.nodes.map((n) => [n.key, n.label, n.op, n.width, n.operands, n.range, n.selector]),
  ]);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [samples, setSamples] = useState<Simulation['signals'][]>([]);
  const [watch, setWatch] = useState<string[]>([]);
  const [latest, setLatest] = useState<Simulation>();
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const fresh = useRef(true);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, []);
  const callbacks = useRef({ onValues, onError });
  callbacks.current = { onValues, onError };
  useEffect(() => {
    generation.current++;
    fresh.current = true;
    setSamples([]);
    setLatest(undefined);
    setBusy(false);
    setInputs(Object.fromEntries(ports.map((p) => [p.label, '0'])));
    setWatch(
      graph.nodes
        .filter((n) => ['input', 'output'].includes(n.kind))
        .slice(0, 12)
        .map((n) => n.label),
    );
    callbacks.current.onValues({});
  }, [revision, signature]);
  useEffect(
    () => () => {
      generation.current++;
      callbacks.current.onValues({});
    },
    [],
  );
  const sample = async (clock?: { signal: string; edge: 'posedge' | 'negedge' }) => {
    const revision = generation.current;
    setBusy(true);
    try {
      let vector = inputs;
      if (clock) {
        const inactive = { ...inputs, [clock.signal]: clock.edge === 'posedge' ? '0' : '1' };
        await run(inactive, fresh.current);
        if (revision !== generation.current) return;
        fresh.current = false;
        vector = { ...inputs, [clock.signal]: clock.edge === 'posedge' ? '1' : '0' };
        setInputs(vector);
      }
      const result = await run(vector, fresh.current);
      fresh.current = false;
      if (revision !== generation.current) return;
      setLatest(result);
      setSamples((old) =>
        [...old, Object.fromEntries(watch.map((name) => [name, result.signals[name]]))].slice(-64),
      );
      callbacks.current.onValues(result.nodes);
    } catch (error) {
      callbacks.current.onError(String(error));
    } finally {
      if (revision === generation.current) setBusy(false);
    }
  };
  const csv = () => {
    const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
    return [
      'sample,' + watch.map(quote).join(','),
      ...samples.map(
        (s, i) => i + ',' + watch.map((name) => quote(s[name]?.value ?? '—')).join(','),
      ),
    ].join('\n');
  };
  return (
    <section
      ref={panel}
      className="simulation-panel"
      aria-label={graph.sequential ? 'Clocked simulation' : 'Combinational simulation'}
    >
      <div className="simulation-heading">
        <strong>Simulation</strong>
        <span role="status">
          {samples.length} {samples.length === 1 ? 'sample' : 'samples'} ·{' '}
          {graph.sequential ? 'clocked' : 'combinational'}
        </span>
        <details className="toolbar-menu simulation-tools">
          <summary>Trace</summary>
          <div className="menu-popover">
            {' '}
            <div className="simulation-actions">
              <button
                disabled={!samples.length}
                onClick={() => {
                  setSamples([]);
                  setLatest(undefined);
                  onValues({});
                }}
              >
                Clear trace
              </button>
              <button
                disabled={!samples.length}
                onClick={() =>
                  void window.mira
                    .command({ type: 'copyText', text: csv() })
                    .catch((e) => onError(String(e)))
                }
              >
                Copy CSV
              </button>
            </div>
          </div>
        </details>
        <span className="toolbar-spacer" />
        <button
          aria-label={minimized ? 'Expand simulation' : 'Minimize simulation'}
          onClick={onMinimize}
        >
          {minimized ? 'Expand' : 'Minimize'}
        </button>
        <button aria-label="Close simulation" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="simulation-content" hidden={minimized}>
        <div className="simulation-setup">
          <form
            className="simulation-inputs"
            onSubmit={(e) => {
              e.preventDefault();
              void sample();
            }}
          >
            {ports.map((port) => (
              <label key={port.id}>
                {port.label} ({port.width}b)
                <input
                  aria-label={`Simulation input ${port.label}`}
                  value={inputs[port.label] ?? '0'}
                  onChange={(e) => setInputs({ ...inputs, [port.label]: e.target.value })}
                  maxLength={8192}
                />
              </label>
            ))}
            <button disabled={disabled || busy}>{busy ? 'Evaluating…' : 'Sample inputs'}</button>
            {graph.clocks?.map((clock) => (
              <button
                type="button"
                key={clock.signal}
                disabled={disabled || busy}
                onClick={() => void sample(clock)}
              >
                Step {clock.signal}
              </button>
            ))}
            {graph.sequential && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  generation.current++;
                  fresh.current = true;
                  setLatest(undefined);
                  setSamples([]);
                  onValues({});
                }}
              >
                Restart simulation
              </button>
            )}
            <span>Decimal, 0x hex, 0b binary, or x</span>
            {graph.sequential && (
              <span>
                Registers start unknown. Assert the circuit’s reset input and sample before
                stepping. Each step pulses one clock; other inputs stay fixed.
              </span>
            )}
          </form>
          <details className="trace-options">
            <summary>Signals ({watch.length})</summary>
            <div className="trace-controls">
              <label>
                Add trace{' '}
                <select
                  aria-label="Add waveform signal"
                  value=""
                  onChange={(e) => {
                    const name = e.target.value;
                    setWatch((old) => [...old, name]);
                  }}
                  disabled={watch.length >= 16}
                >
                  <option value="">Choose signal</option>
                  {Object.keys(
                    latest?.signals ??
                      Object.fromEntries(
                        graph.nodes
                          .filter((n) => ['input', 'wire', 'output'].includes(n.kind))
                          .map((n) => [n.label, {}]),
                      ),
                  )
                    .filter((name) => !watch.includes(name))
                    .map((name) => (
                      <option key={name}>{name}</option>
                    ))}
                </select>
              </label>
              {watch.map((name) => (
                <button
                  key={name}
                  aria-label={`Remove trace ${name}`}
                  onClick={() => setWatch((old) => old.filter((n) => n !== name))}
                >
                  {name} ×
                </button>
              ))}
            </div>
          </details>
        </div>
        {!samples.length ? (
          <p className="hint">
            Set inputs and sample to see values on the circuit. Each sample adds a waveform column.
            Undriven signals remain unknown.
          </p>
        ) : (
          <div className="waveform-scroll">
            <svg
              role="img"
              aria-label={`Waveforms, ${samples.length} samples`}
              width={160 + samples.length * 80}
              height={34 + watch.length * 34}
            >
              {samples.map((_, i) => (
                <text key={i} x={168 + i * 80} y={16} fill="#8ca5c2" fontSize="13">
                  {i}
                </text>
              ))}
              {watch.map((name, row) => {
                const y = 34 + row * 34,
                  width = latest?.signals[name]?.width;
                return (
                  <g key={name}>
                    <text x={6} y={y + 16} fill="#dce8f7" fontSize="13">
                      {name.slice(0, 18)}
                    </text>
                    {samples.map((sample, i) => {
                      const value = sample[name]?.value ?? '—',
                        x = 160 + i * 80,
                        unknown = value.includes('x') && !value.startsWith('0x');
                      return (
                        <g key={i}>
                          <title>{`${name}, sample ${i}: ${value}`}</title>
                          <rect
                            x={x}
                            y={y}
                            width={80}
                            height={26}
                            fill={unknown ? '#432d21' : '#132f32'}
                            stroke="#3b5b68"
                          />
                          {width === 1 && !unknown ? (
                            <path
                              d={`M${x},${y + (value === '1' ? 5 : 21)} H${x + 80}`}
                              stroke={unknown ? '#ffc777' : '#66e2c4'}
                              strokeWidth={2}
                            />
                          ) : null}
                          <text
                            x={x + 4}
                            y={y + 16}
                            fill={unknown ? '#ffc777' : '#80ead1'}
                            fontSize="13"
                          >
                            {value.length > 9 ? value.slice(0, 8) + '…' : value}
                          </text>
                        </g>
                      );
                    })}
                  </g>
                );
              })}
            </svg>
            <details>
              <summary>Sample values</summary>
              <table>
                <caption>Sampled signal values</caption>
                <thead>
                  <tr>
                    <th scope="col">Signal</th>
                    {samples.map((_, i) => (
                      <th scope="col" key={i}>
                        Sample {i}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {watch.map((name) => (
                    <tr key={name}>
                      <th scope="row">{name}</th>
                      {samples.map((s, i) => (
                        <td key={i}>{s[name]?.value ?? '—'}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </div>
        )}
      </div>
    </section>
  );
}
