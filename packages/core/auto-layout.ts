// SPDX-License-Identifier: GPL-3.0-only
import type { Circuit } from '../verilog/index.js';

type Point = { x: number; y: number };
type Box = { id: string; width: number; height: number };
type Link = { source: string; target: string };
const GAP = 64;
const WIDTH = 200;
export const nodeHeight = (n: Circuit['nodes'][number]) =>
  Math.max(160, Math.max(n.inputPorts?.length ?? 0, n.outputPorts?.length ?? 0) * 26 + 110);

// Place leaves as late as their consumers allow. This keeps constants beside the
// operation that uses them instead of collecting them in a distant input column.
function layers(boxes: Box[], links: Link[]): Map<string, Point> {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const incoming = new Map(boxes.map((b) => [b.id, [] as string[]]));
  const outgoing = new Map(boxes.map((b) => [b.id, [] as string[]]));
  for (const e of links) {
    if (!byId.has(e.source) || !byId.has(e.target) || e.source === e.target) continue;
    incoming.get(e.target)!.push(e.source);
    outgoing.get(e.source)!.push(e.target);
  }
  const pending = new Map(boxes.map((b) => [b.id, incoming.get(b.id)!.length]));
  const queue = boxes.filter((b) => !pending.get(b.id)).map((b) => b.id);
  const rank = new Map(boxes.map((b) => [b.id, 0]));
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const target of outgoing.get(id)!) {
      rank.set(target, Math.max(rank.get(target)!, rank.get(id)! + 1));
      pending.set(target, pending.get(target)! - 1);
      if (!pending.get(target)) queue.push(target);
    }
  }
  // Graph projection rejects cycles; guard malformed layout-only input as well.
  if (queue.length !== boxes.length) throw new Error('Cannot lay out a cyclic circuit.');
  for (const id of [...queue].reverse()) {
    const next = outgoing.get(id)!;
    if (next.length) rank.set(id, Math.min(...next.map((n) => rank.get(n)!)) - 1);
  }
  const columns = new Map<number, Box[]>();
  for (const b of boxes) {
    const r = rank.get(b.id)!;
    if (!columns.has(r)) columns.set(r, []);
    columns.get(r)!.push(b);
  }
  const ordered = [...columns].sort(([a], [b]) => a - b);
  const result = new Map<string, Point>();
  const heights = ordered.map(([, col]) => col.reduce((s, b) => s + b.height + GAP, -GAP));
  const height = Math.max(0, ...heights);
  let x = 0;
  for (const [i, [, col]] of ordered.entries()) {
    let y = (height - heights[i]) / 2;
    for (const b of col) {
      result.set(b.id, { x, y });
      y += b.height + GAP;
    }
    x += Math.max(...col.map((b) => b.width)) + GAP;
  }
  // Alternating barycentre sweeps reduce crossings without relying on random IDs.
  for (let sweep = 0; sweep < 4; sweep++) {
    for (const [i, [, col]] of sweep % 2
      ? [...ordered.entries()].reverse()
      : [...ordered.entries()]) {
      const neighbours = sweep % 2 ? outgoing : incoming;
      const centre = (b: Box) => {
        const ns = neighbours.get(b.id)!;
        return ns.length
          ? ns.reduce((s, id) => s + result.get(id)!.y + byId.get(id)!.height / 2, 0) / ns.length
          : result.get(b.id)!.y + b.height / 2;
      };
      col.sort((a, b) => centre(a) - centre(b));
      let y = (height - heights[i]) / 2;
      for (const b of col) {
        result.get(b.id)!.y = y;
        y += b.height + GAP;
      }
    }
  }
  return result;
}

export function autoLayout(graph: Circuit): Record<string, Point> {
  // Q is a dependency boundary. Keep feedback wires visible, but do not use
  // register D/clock inputs as same-cycle layout dependencies.
  const registers = new Set(graph.nodes.filter((n) => n.register).map((n) => n.id));
  graph = { ...graph, edges: graph.edges.filter((e) => !registers.has(e.target)) };
  const nodes = [...graph.nodes].sort((a, b) => a.key.localeCompare(b.key));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map(nodes.map((n) => [n.id, [] as Circuit['edges']]));
  const outgoing = new Map(nodes.map((n) => [n.id, [] as Circuit['edges']]));
  for (const e of graph.edges) {
    incoming.get(e.target)?.push(e);
    outgoing.get(e.source)?.push(e);
  }
  const nextMux = (id: string) => {
    const e = incoming.get(id)!.find((e) => e.targetHandle === 'right');
    return e && byId.get(e.source)?.kind === 'mux' && outgoing.get(e.source)!.length === 1
      ? e.source
      : undefined;
  };
  const owned = new Map<string, string>();
  const blocks: Box[] = [];
  const local = new Map<string, Point>();
  for (const root of nodes.filter((n) => n.kind === 'mux')) {
    if (owned.has(root.id)) continue;
    const consumer = outgoing.get(root.id)!;
    if (
      consumer.length === 1 &&
      consumer[0].targetHandle === 'right' &&
      byId.get(consumer[0].target)?.kind === 'mux'
    )
      continue;
    const chain: string[] = [];
    let current: string | undefined = root.id;
    while (current && !chain.includes(current)) {
      chain.push(current);
      current = nextMux(current);
    }
    if (chain.length < 4) continue;
    const stages = chain.map((id) => {
      const members = new Set([id]);
      const collect = (target: string) => {
        for (const e of incoming.get(target)!) {
          const n = byId.get(e.source)!;
          // Shared nets stay outside the block; each private expression travels
          // with its consumer. Never duplicate nodes or change circuit edges.
          if (
            chain.includes(n.id) ||
            owned.has(n.id) ||
            n.kind === 'mux' ||
            n.sourceNet ||
            n.kind === 'input' ||
            outgoing.get(n.id)!.length !== 1 ||
            members.has(n.id)
          )
            continue;
          members.add(n.id);
          collect(n.id);
        }
      };
      collect(id);
      const boxes = nodes
        .filter((n) => members.has(n.id))
        .map((n) => ({ id: n.id, width: WIDTH, height: nodeHeight(n) }));
      const positions = layers(boxes, graph.edges);
      return {
        boxes,
        positions,
        width: Math.max(...boxes.map((b) => positions.get(b.id)!.x + b.width)),
        height: Math.max(...boxes.map((b) => positions.get(b.id)!.y + b.height)),
      };
    });
    const cellWidth = Math.max(...stages.map((s) => s.width)) + 96;
    const averageHeight = stages.reduce((sum, s) => sum + s.height + 96, 0) / stages.length;
    const cols = Math.max(1, Math.round(Math.sqrt((stages.length * averageHeight) / cellWidth)));
    const rows = Math.ceil(stages.length / cols);
    const rowOffsets = [0];
    for (let row = 0; row < rows; row++)
      rowOffsets.push(
        rowOffsets[row] +
          Math.max(...stages.slice(row * cols, (row + 1) * cols).map((s) => s.height)) +
          96,
      );
    stages.forEach((stage, i) => {
      const row = Math.floor(i / cols);
      const col = row % 2 ? i % cols : cols - 1 - (i % cols);
      for (const b of stage.boxes) {
        owned.set(b.id, root.id);
        const p = stage.positions.get(b.id)!;
        local.set(b.id, { x: col * cellWidth + p.x, y: rowOffsets[row] + p.y });
      }
    });
    blocks.push({ id: root.id, width: cols * cellWidth - 96, height: rowOffsets[rows] - 96 });
  }
  for (const n of nodes) {
    if (owned.has(n.id)) continue;
    owned.set(n.id, n.id);
    local.set(n.id, { x: 0, y: 0 });
    blocks.push({ id: n.id, width: WIDTH, height: nodeHeight(n) });
  }
  const links = graph.edges.map((e) => ({
    source: owned.get(e.source)!,
    target: owned.get(e.target)!,
  }));
  let positions: Map<string, Point>;
  try {
    positions = layers(blocks, links);
  } catch {
    // A path leaving and re-entering a folded chain cannot be contracted into
    // one DAG block. Keep that circuit in the ordinary layered representation.
    return Object.fromEntries(
      layers(
        nodes.map((n) => ({ id: n.id, width: WIDTH, height: nodeHeight(n) })),
        graph.edges,
      ),
    );
  }
  const result: Record<string, Point> = Object.fromEntries(
    nodes.map((n) => {
      const origin = positions.get(owned.get(n.id)!)!;
      const p = local.get(n.id)!;
      return [n.id, { x: origin.x + p.x, y: origin.y + p.y }];
    }),
  );
  // A folded block's centre is not a connection point. Keep interface-only
  // columns near their actual first consumer/driver instead of half a canvas
  // away, and pack the rail to preserve separation between interface cards.
  if (blocks.some((b) => b.width > WIDTH)) {
    const columns = new Map<number, typeof nodes>();
    for (const n of nodes) {
      const x = result[n.id].x;
      if (!columns.has(x)) columns.set(x, []);
      columns.get(x)!.push(n);
    }
    for (const col of columns.values()) {
      if (!col.every((n) => n.kind === 'input' || n.kind === 'output')) continue;
      const anchor = (n: (typeof nodes)[number]) => {
        const edges = n.kind === 'input' ? outgoing.get(n.id)! : incoming.get(n.id)!;
        return edges.length
          ? Math.min(...edges.map((e) => result[n.kind === 'input' ? e.target : e.source].y))
          : 0;
      };
      col.sort((a, b) => anchor(a) - anchor(b));
      let bottom = 0;
      for (const n of col) {
        result[n.id].y = Math.max(bottom, anchor(n));
        bottom = result[n.id].y + nodeHeight(n) + GAP;
      }
    }
  }
  return result;
}
