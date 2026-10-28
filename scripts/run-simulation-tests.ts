// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync, statSync } from 'node:fs';
import { parse } from '../packages/verilog/index.js';
import { runSimulationTest, validateSimulationTest } from '../packages/verilog/test-vectors.js';

try {
  const args = process.argv.slice(2);
  const sources = args.filter((a) => a.startsWith('--source=')).map((a) => a.slice(9));
  const tests = args.filter((a) => a.startsWith('--tests=')).map((a) => a.slice(8));
  if (
    !sources.length ||
    sources.length > 16 ||
    tests.length !== 1 ||
    args.length !== sources.length + 1
  )
    throw new Error(
      'Usage: pnpm test:simulation --source=top.sv [--source=child.sv] --tests=suite.json',
    );
  const read = (path: string, limit: number) => {
    if (statSync(path).size > limit) throw new Error(`Oversized file: ${path}`);
    return readFileSync(path, 'utf8');
  };
  const source = sources.map((s) => read(s, 4_000_000)).join('\n');
  const data: unknown = JSON.parse(read(tests[0], 2_000_000));
  const list = Array.isArray(data) ? data : [data];
  if (!list.length || list.length > 32) throw new Error('Choose 1–32 saved tests.');
  const results = list.map((t) => {
    const test = validateSimulationTest(t);
    return {
      name: test.name,
      module: test.module,
      ...runSimulationTest(parse(source, test.module), test),
    };
  });
  console.log(JSON.stringify(results, null, 2));
  if (results.some((r) => !r.passed)) process.exitCode = 1;
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
