// SPDX-License-Identifier: GPL-3.0-only
import type { Module } from './index.js';
import { simulateModule, type Simulation, type SimulationState } from './simulation.js';

export type TestVector = { inputs: Record<string, string>; expect: Record<string, string> };
export type SimulationTest = {
  schemaVersion: 1;
  name: string;
  module: string;
  vectors: TestVector[];
};
export type TestResult = {
  passed: boolean;
  samples: number;
  assertions: number;
  failures: { sample: number; signal: string; expected: string; actual: string }[];
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export function validateSimulationTest(value: unknown): SimulationTest {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 64 ||
    typeof value.module !== 'string' ||
    !value.module ||
    value.module.length > 128 ||
    !Array.isArray(value.vectors) ||
    !value.vectors.length ||
    value.vectors.length > 128
  )
    throw new Error('Tests need a name, module and 1–128 samples (schemaVersion 1).');
  const vector = (v: unknown): Record<string, string> => {
    if (
      !record(v) ||
      Object.keys(v).length > 256 ||
      Object.entries(v).some(
        ([k, t]) =>
          !k ||
          k.length > 256 ||
          typeof t !== 'string' ||
          t.length > 8192 ||
          !/^(?:[0-9]+|0x[0-9a-f]+|0b[01x]+|x)$/i.test(t),
      )
    )
      throw new Error(
        'Test vectors need bounded signal names and decimal, hex, binary or x values.',
      );
    return Object.assign(Object.create(null), v);
  };
  const vectors = value.vectors.map((v: unknown) => {
    if (!record(v)) throw new Error('Invalid test sample.');
    return { inputs: vector(v.inputs), expect: vector(v.expect) };
  });
  if (!vectors.some((v) => Object.keys(v.expect).length))
    throw new Error('A test needs at least one expected value.');
  const result: SimulationTest = {
    schemaVersion: 1,
    name: value.name.trim(),
    module: value.module,
    vectors,
  };
  if (JSON.stringify(result).length > 1_000_000)
    throw new Error('Test exceeds 1 million characters.');
  return result;
}
// Known values compare numerically. Unknown bits compare exactly; x is never a wildcard.
function normalized(value: string, width: number): string {
  if (/^x$/i.test(value)) return 'x'.repeat(width);
  if (/^0b[01x]+$/i.test(value)) {
    const bits = value.slice(2).toLowerCase();
    if (bits.length > width) throw new Error('Expected value exceeds signal width.');
    return bits.padStart(width, '0');
  }
  const bits = BigInt(value).toString(2);
  if (bits.length > width) throw new Error('Expected value exceeds signal width.');
  return bits.padStart(width, '0');
}
export function runSimulationTest(ast: Module, input: unknown): TestResult {
  const test = validateSimulationTest(input);
  if (test.module !== ast.name) throw new Error('Select the test’s module before running it.');
  const ports = ast.nets.filter((n) => n.direction === 'input').map((n) => n.name);
  const failures: TestResult['failures'] = [];
  let state: SimulationState | undefined,
    assertions = 0;
  for (const [sample, vector] of test.vectors.entries()) {
    if (
      ports.length !== Object.keys(vector.inputs).length ||
      ports.some((p) => !Object.hasOwn(vector.inputs, p))
    )
      throw new Error(`Sample ${sample + 1} must specify every input port exactly once.`);
    const result: Simulation = simulateModule(ast, vector.inputs, state);
    state = result.state;
    for (const [signal, expected] of Object.entries(vector.expect)) {
      const actual = result.signals[signal];
      if (!actual) throw new Error(`Sample ${sample + 1}: unknown expected signal ${signal}.`);
      assertions++;
      if (normalized(expected, actual.width) !== normalized(actual.value, actual.width))
        failures.push({ sample: sample + 1, signal, expected, actual: actual.value });
    }
  }
  return { passed: failures.length === 0, samples: test.vectors.length, assertions, failures };
}
