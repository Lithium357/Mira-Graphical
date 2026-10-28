// SPDX-License-Identifier: GPL-3.0-only
import React, { useEffect, useRef, useState } from 'react';
import type {
  SimulationTest,
  TestVector,
  TestResult,
} from '../../packages/verilog/test-vectors.js';

export function TestPanel({
  uri,
  module,
  revision,
  vectors,
  disabled,
  onError,
}: {
  uri: string;
  module: string;
  revision: string;
  vectors: TestVector[];
  disabled: boolean;
  onError: (message: string) => void;
}) {
  const [tests, setTests] = useState<SimulationTest[]>([]),
    [name, setName] = useState(''),
    [selected, setSelected] = useState('');
  const [json, setJson] = useState(''),
    [result, setResult] = useState<TestResult>(),
    [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const revision = ++generation.current;
    setResult(undefined);
    setBusy(false);
    window.mira
      .command({ type: 'testList', uri })
      .then((t) => {
        if (revision === generation.current) setTests(t);
      })
      .catch((e) => onError(String(e)));
    return () => {
      generation.current++;
    };
  }, [uri, module, revision]);
  const current = tests.find((t) => t.name === selected && t.module === module);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    const revision = generation.current;
    try {
      await fn();
    } catch (e) {
      onError(String(e));
    } finally {
      if (revision === generation.current) setBusy(false);
    }
  };
  return (
    <details className="saved-tests">
      <summary>Saved tests ({tests.filter((t) => t.module === module).length})</summary>
      <p>
        Record samples using the controls above, including reset and clock steps. Saving captures
        current output and watched signal values as expectations. Each run restarts registers
        (unknown for Verilog, leftmost member for VHDL enums); x compares exactly.
      </p>
      <div className="test-actions">
        <label>
          Test name <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
        </label>
        <button
          disabled={disabled || busy || !vectors.length || !name.trim()}
          onClick={() =>
            void action(async () => {
              const test: SimulationTest = { schemaVersion: 1, name: name.trim(), module, vectors };
              const next = await window.mira.command({ type: 'testSave', uri, test });
              setTests(next);
              setSelected(test.name);
              setResult(undefined);
            })
          }
        >
          Save recorded test
        </button>
        <span>
          {vectors.length}/128 recorded samples
          {vectors.length === 128 ? ' (recording full; restart simulation for a new sequence)' : ''}
          . Saving replaces a test with the same name and module.
        </span>
        <label>
          Saved test{' '}
          <select
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setResult(undefined);
            }}
          >
            <option value="">Choose test</option>
            {tests
              .filter((t) => t.module === module)
              .map((t) => (
                <option key={t.name}>{t.name}</option>
              ))}
          </select>
        </label>
        <button
          disabled={disabled || busy || !current}
          onClick={() =>
            void action(async () => {
              const revision = generation.current;
              const report = await window.mira.command({ type: 'testRun', uri, test: current });
              if (revision === generation.current) setResult(report);
            })
          }
        >
          {busy ? 'Working…' : 'Run test'}
        </button>
        <button
          disabled={busy || !current}
          onClick={() =>
            void action(async () => {
              await window.mira.command({
                type: 'copyText',
                text: JSON.stringify(current, null, 2),
              });
            })
          }
        >
          Copy test JSON
        </button>
        <button
          disabled={busy || !current}
          onClick={() =>
            void action(async () => {
              setTests(
                await window.mira.command({ type: 'testDelete', uri, name: current!.name, module }),
              );
              setSelected('');
              setResult(undefined);
            })
          }
        >
          Delete test
        </button>
      </div>
      {result && (
        <div role="status">
          <strong>{result.passed ? 'PASS' : 'FAIL'}</strong> · {result.samples} samples ·{' '}
          {result.assertions} assertions
          {!!result.failures.length && (
            <table>
              <caption>Failed expectations</caption>
              <thead>
                <tr>
                  <th>Sample</th>
                  <th>Signal</th>
                  <th>Expected</th>
                  <th>Actual</th>
                </tr>
              </thead>
              <tbody>
                {result.failures.slice(0, 128).map((f, i) => (
                  <tr key={i}>
                    <td>{f.sample}</td>
                    <td>{f.signal}</td>
                    <td>{f.expected}</td>
                    <td>{f.actual}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <details>
        <summary>Import test JSON</summary>
        <label>
          Test JSON
          <textarea value={json} maxLength={1_000_000} onChange={(e) => setJson(e.target.value)} />
        </label>
        <button
          disabled={busy || !json.trim()}
          onClick={() =>
            void action(async () => {
              const test = JSON.parse(json);
              if (test.module !== module)
                throw new Error('Select the imported test’s module first.');
              setTests(await window.mira.command({ type: 'testSave', uri, test }));
              setSelected(test.name);
              setJson('');
              setResult(undefined);
            })
          }
        >
          Import and save test
        </button>
      </details>
    </details>
  );
}
