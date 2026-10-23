// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, project } from '../packages/verilog/index.js';
import { sourceActionEdits, copyComponents } from '../packages/verilog/construction.js';
import { PatchDraft } from '../packages/verilog/patches.js';
import { simulate } from '../packages/verilog/simulation.js';
import type { SourceAction } from '../packages/protocol/index.js';
const output = join(process.cwd(), 'test-results/hdl-reference');
mkdirSync(output, { recursive: true });
const signals = [
  'result',
  'joined',
  'product',
  'probe_result',
  'constant_result',
  'concat_result',
  'low_result',
  'duplicate_result',
  'selected_result',
];
function generate() {
  const expected: Record<string, string[][]> = {};
  for (const language of ['sv', 'vhd']) {
    let source = readFileSync(`fixtures/hierarchy.${language}`, 'utf8');
    const action = (value: SourceAction) => {
      const draft = new PatchDraft(source);
      draft.apply(sourceActionEdits(source, { scope: 'workbench', ...value }));
      source = draft.text;
    };
    action({
      kind: 'change',
      scope: 'arithmetic',
      target: 'arithmetic/assign/result/expr',
      change: { kind: 'operator', value: '-' },
    });
    action({ kind: 'create', component: 'operation', name: 'probe', width: 8, operator: '*' });
    for (const [name, port] of [
      ['a', 'left'],
      ['b', 'right'],
    ] as const) {
      const op = project(parse(source, 'workbench')).nodes.find(
        (n) => n.kind === 'op' && n.key.startsWith('workbench/assign/probe/'),
      )!;
      action({ kind: 'connect', source: `workbench/net/${name}`, target: op.key, port });
    }
    action({
      kind: 'create',
      component: 'constant',
      name: 'constant_value',
      width: 8,
      value: "8'hA5",
    });
    action({
      kind: 'create',
      component: 'concat',
      name: 'concat_value',
      width: 16,
      parts: ['a', 'b'],
    });
    action({
      kind: 'create',
      component: 'slice',
      name: 'low_value',
      width: 4,
      source: 'a',
      range: '[3:0]',
    });
    action({ kind: 'create', component: 'mux', name: 'selected_value', width: 8 });
    for (const [name, port] of [
      ['select_b', 'select'],
      ['a', 'left'],
      ['b', 'right'],
    ] as const)
      action({
        kind: 'connect',
        source: `workbench/net/${name}`,
        target: project(parse(source, 'workbench')).nodes.find(
          (n) => n.kind === 'mux' && n.assignmentTarget === 'selected_value',
        )!.key,
        port,
      });
    const graph = project(parse(source, 'workbench')),
      probe = graph.nodes.find((n) => n.assignmentTarget === 'probe')!;
    action({ kind: 'paste', items: copyComponents(source, graph, [probe.id]) });
    for (const [name, driver, width] of [
      ['probe_result', 'probe', 8],
      ['constant_result', 'constant_value', 8],
      ['concat_result', 'concat_value', 16],
      ['low_result', 'low_value', 4],
      ['duplicate_result', 'probe_copy1', 8],
      ['selected_result', 'selected_value', 8],
    ] as const) {
      action({ kind: 'create', component: 'output', name, width });
      action({
        kind: 'connect',
        source: `workbench/net/${driver}`,
        target: `workbench/net/${name}`,
        port: 'left',
      });
    }
    writeFileSync(join(output, `generated.${language}`), source);
    const rows: string[][] = [],
      vhdlLines: string[] = [],
      svLines: string[] = [];
    for (let i = 0; i < 256; i++) {
      const a = i < 4 ? [0, 255, 128, 16][i] : (i * 73) & 255,
        b = i < 4 ? [0, 255, 2, 17][i] : (i * 151 + 7) & 255,
        select = i & 1;
      const result = simulate(source, 'workbench', {
        a: String(a),
        b: String(b),
        select_b: String(select),
      });
      const row = signals.map((name) => String(BigInt(result.signals[name].value)));
      rows.push(row);
      const independently = [
        select ? (a - b + 256) & 255 : a,
        (a << 8) | b,
        a * b,
        (a * b) & 255,
        165,
        (a << 8) | b,
        a & 15,
        (a * b) & 255,
        select ? a : b,
      ];
      assert.deepEqual(
        row,
        independently.map(String),
        `Independent arithmetic vector ${language} ${i}`,
      );
      vhdlLines.push(
        `a <= to_unsigned(${a},8); b <= to_unsigned(${b},8); select_b <= '${select}'; wait for 1 ns; report "MIRA ${i}"${signals.map((n) => ` & " " & integer'image(to_integer(${n}))`).join('')};`,
      );
      svLines.push(
        `a=8'd${a}; b=8'd${b}; select_b=1'b${select}; #1; $display("MIRA ${i}${signals.map(() => ' %0d').join('')}", ${signals.join(',')});`,
      );
    }
    expected[language] = rows;
    if (language === 'vhd') {
      writeFileSync(
        join(output, 'bench.vhd'),
        `library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
entity bench is end; architecture test of bench is
signal a,b:unsigned(7 downto 0); signal select_b:std_logic;
${signals.map((n) => `signal ${n}:unsigned(${['joined', 'product', 'concat_result'].includes(n) ? 15 : n === 'low_result' ? 3 : 7} downto 0);`).join('\n')}
begin dut:entity work.workbench port map(a=>a,b=>b,select_b=>select_b,${signals.map((n) => `${n}=>${n}`).join(',')});
process begin ${vhdlLines.join('\n')} wait; end process; end;`,
      );
    } else
      writeFileSync(
        join(output, 'bench.sv'),
        `module bench; reg[7:0] a,b; reg select_b;
${signals.map((n) => `wire [${['joined', 'product', 'concat_result'].includes(n) ? 15 : n === 'low_result' ? 3 : 7}:0] ${n};`).join('\n')}
workbench dut(.a(a),.b(b),.select_b(select_b),${signals.map((n) => `.${n}(${n})`).join(',')}); initial begin ${svLines.join('\n')} $finish; end endmodule`,
      );
  }
  writeFileSync(join(output, 'expected.json'), JSON.stringify({ signals, expected }, null, 2));
  console.log(
    `Generated native construction/clipboard fixtures and ${256 * signals.length * 2} reference comparisons.`,
  );
}
function verify() {
  const data = JSON.parse(readFileSync(join(output, 'expected.json'), 'utf8'));
  let comparisons = 0;
  for (const language of ['sv', 'vhd']) {
    const log = readFileSync(join(output, `${language}.log`), 'utf8');
    const rows = [...log.matchAll(/MIRA\s+([0-9]+)((?:\s+[0-9]+){9})/g)];
    assert.equal(rows.length, 256, `${language}: expected every vector exactly once`);
    rows.forEach((m, i) => {
      assert.equal(Number(m[1]), i);
      const actual = m[2].trim().split(/\s+/);
      assert.deepEqual(actual, data.expected[language][i], `${language} vector ${i}`);
      comparisons += actual.length;
    });
  }
  writeFileSync(
    join(output, 'result.json'),
    JSON.stringify({ passed: true, vectorsPerLanguage: 256, signals, comparisons }, null, 2),
  );
  console.log(
    `PASS: ${comparisons} native GHDL/Icarus comparisons, including constructed and duplicated circuits.`,
  );
}
const args = process.argv.slice(2);
if (args.includes('--verify')) verify();
else {
  generate();
  if (!args.includes('--generate')) {
    const run = (exe: string, args: string[], log?: string) => {
      const r = spawnSync(exe, args, { encoding: 'utf8', cwd: output });
      if (r.error) throw r.error;
      assert.equal(r.status, 0, r.stdout + r.stderr);
      if (log) writeFileSync(join(output, log), r.stdout + r.stderr);
    };
    const ghdl = process.env.MIRA_GHDL ?? 'ghdl';
    run(ghdl, ['-a', '--std=08', 'generated.vhd', 'bench.vhd']);
    run(ghdl, ['--elab-run', '--std=08', 'bench', '--assert-level=error'], 'vhd.log');
    run(process.env.MIRA_IVERILOG ?? 'iverilog', [
      '-g2012',
      '-s',
      'bench',
      '-o',
      'bench.vvp',
      'generated.sv',
      'bench.sv',
    ]);
    run(process.env.MIRA_VVP ?? 'vvp', ['bench.vvp'], 'sv.log');
    verify();
  }
}
