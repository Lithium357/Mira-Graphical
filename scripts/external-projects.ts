// SPDX-License-Identifier: GPL-3.0-only
// Source is read as data only. Download pinned references separately; never execute upstream scripts.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse, project } from '../packages/verilog/index.js';
const directory = 'test-results/external-projects';
mkdirSync(directory, { recursive: true });
export const references = [
  ...[
    'ALU',
    'Add16',
    'And',
    'And16',
    'FullAdder',
    'HalfAdder',
    'Mux',
    'Mux16',
    'Nand',
    'Not',
    'Not16',
    'Or',
    'Or8Way',
    'Xor',
  ].map((name) => ({
    repository: 'wuhanstudio/nand2tetris-iverilog',
    revision: '06a924223f4fb37194ddb0c644432fc6ca16ea72',
    path: `1-ALU/${name}.v`,
    file: `hack-${name}.v`,
  })),
  {
    repository: 'YosysHQ/yosys',
    revision: '5053d0e266d9e5f895211e39e6ee3a94cbba408a',
    path: 'docs/source/code_examples/intro/counter.v',
    file: 'yosys-counter.v',
  },
];
const results = [];
for (const reference of references) {
  if (process.argv.includes('--download')) {
    const response = await fetch(
      `https://raw.githubusercontent.com/${reference.repository}/${reference.revision}/${reference.path}`,
      { signal: AbortSignal.timeout(15000) },
    );
    assert(response.ok, `Download failed: ${reference.path}`);
    const text = await response.text();
    assert(text.length <= 1_000_000, 'Reference source exceeds limit');
    writeFileSync(join(directory, reference.file), text);
  }
  const source = readFileSync(join(directory, reference.file), 'utf8');
  const sha256 = createHash('sha256').update(source).digest('hex');
  const url = `https://github.com/${reference.repository}/blob/${reference.revision}/${reference.path}`;
  try {
    const graph = project(parse(source));
    assert(graph.nodes.length > 0);
    results.push({ ...reference, sha256, url, outcome: 'projected', nodes: graph.nodes.length });
  } catch (error) {
    results.push({
      ...reference,
      sha256,
      url,
      outcome: 'refused',
      diagnostic: (error as Error).message,
    });
  }
}
writeFileSync(
  join(directory, 'report.json'),
  JSON.stringify(
    {
      scope:
        'Unmodified individual source files, no upstream scripts or synthesized netlists; refusal is not compatibility',
      results,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(results, null, 2));
