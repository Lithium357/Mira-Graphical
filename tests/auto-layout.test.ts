// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoLayout, nodeHeight } from '../packages/core/auto-layout.js';
import { parse, project, type Circuit } from '../packages/verilog/index.js';

function check(graph: Circuit) {
  const before = JSON.stringify(graph);
  const positions = autoLayout(graph);
  assert.equal(JSON.stringify(graph), before, 'layout must not modify the circuit');
  assert.equal(Object.keys(positions).length, graph.nodes.length);
  for (const [i, a] of graph.nodes.entries()) {
    const p = positions[a.id];
    assert(Number.isFinite(p.x) && Number.isFinite(p.y));
    for (const b of graph.nodes.slice(i + 1)) {
      const q = positions[b.id];
      assert(
        p.x + 200 <= q.x ||
          q.x + 200 <= p.x ||
          p.y + nodeHeight(a) <= q.y ||
          q.y + nodeHeight(b) <= p.y,
        `overlap: ${a.key}, ${b.key}`,
      );
    }
  }
  return positions;
}

test('57-node ALU folds mux stages into a compact rectangle without overlap', () => {
  const graph = project(parse(readFileSync('fixtures/alu-int16.v', 'utf8'), 'ALU_INT16'));
  const p = check(graph);
  assert.equal(graph.nodes.length, 57);
  const width = Math.max(...graph.nodes.map((n) => p[n.id].x + 200));
  const height = Math.max(...graph.nodes.map((n) => p[n.id].y + nodeHeight(n)));
  assert(width < 3000 && height < 3000, `${width} x ${height}`);
  assert(width / height > 0.65 && width / height < 1.8);
  const muxes = graph.nodes.filter((n) => n.kind === 'mux');
  assert(new Set(muxes.map((n) => p[n.id].y)).size >= 3);
  assert(new Set(muxes.map((n) => p[n.id].x)).size <= 4);
  // UUID allocation and input array ordering must not change the arrangement.
  const reordered = structuredClone(graph);
  reordered.nodes.reverse();
  reordered.edges.reverse();
  assert.deepEqual(autoLayout(reordered), p);
});

test('small circuits, hierarchy, and empty modules keep finite separated positions', () => {
  for (const fixture of [
    'adder.v',
    'combinational.v',
    'hierarchy.v',
    'hierarchy.sv',
    'hierarchy.vhd',
    'alu-int16.v',
  ]) {
    const ast = parse(readFileSync(`fixtures/${fixture}`, 'utf8'));
    for (const module of Object.values(ast.library)) check(project(module));
  }
});

test('a shared expression leaving and re-entering a mux chain remains layable', () => {
  const source = `module t(input wire a,b,c,d,s, output wire y,z);
    wire w;
    assign w = s ? a : b;
    assign z = w & c;
    assign y = s ? z : s ? c : s ? d : s ? a : w;
    endmodule`;
  check(project(parse(source)));
});
