// SPDX-License-Identifier: GPL-3.0-only
import React, { useState, useEffect, useRef } from 'react';
import type { Circuit } from '../../packages/verilog/index.js';
import type { Simulation } from '../../packages/verilog/simulation.js';
export function SimulationPanel({
  graph,
  revision,
  disabled,
  run,
  onValues,
  onError,
}: {
  graph: Circuit;
  revision: string;
  disabled: boolean;
  run: (inputs: Record<string, string>) => Promise<Simulation>;
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
  const callbacks = useRef({ onValues, onError });
  callbacks.current = { onValues, onError };
  useEffect(() => {
    generation.current++;
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
  const sample = async () => {
    const revision = generation.current;
    setBusy(true);
    try {
      const result = await run(inputs);
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
    <section className="simulation-panel" aria-label="Combinational simulation">
      <div className="simulation-heading">
        <strong>Simulation</strong>
        <span>Unsigned · zero delay · samples, not clock cycles</span>
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
        <span>Decimal, 0x hex, 0b binary, or x</span>
      </form>
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
            width={130 + samples.length * 64}
            height={30 + watch.length * 32}
          >
            {samples.map((_, i) => (
              <text key={i} x={138 + i * 64} y={16} fill="#8ca5c2" fontSize="10">
                {i}
              </text>
            ))}
            {watch.map((name, row) => {
              const y = 30 + row * 32,
                width = latest?.signals[name]?.width;
              return (
                <g key={name}>
                  <text x={6} y={y + 16} fill="#dce8f7" fontSize="11">
                    {name.slice(0, 18)}
                  </text>
                  {samples.map((sample, i) => {
                    const value = sample[name]?.value ?? '—',
                      x = 130 + i * 64,
                      unknown = value.includes('x') && !value.startsWith('0x');
                    return (
                      <g key={i}>
                        <title>{`${name}, sample ${i}: ${value}`}</title>
                        <rect
                          x={x}
                          y={y}
                          width={64}
                          height={26}
                          fill={unknown ? '#432d21' : '#132f32'}
                          stroke="#3b5b68"
                        />
                        {width === 1 && !unknown ? (
                          <path
                            d={`M${x},${y + (value === '1' ? 5 : 21)} H${x + 64}`}
                            stroke={unknown ? '#ffc777' : '#66e2c4'}
                            strokeWidth={2}
                          />
                        ) : null}
                        <text
                          x={x + 4}
                          y={y + 16}
                          fill={unknown ? '#ffc777' : '#80ead1'}
                          fontSize="10"
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
              <thead>
                <tr>
                  <th>Signal</th>
                  {samples.map((_, i) => (
                    <th key={i}>{i}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {watch.map((name) => (
                  <tr key={name}>
                    <th>{name}</th>
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
    </section>
  );
}
