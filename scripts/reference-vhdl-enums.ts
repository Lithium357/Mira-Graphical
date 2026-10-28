// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { simulate, type SimulationState } from '../packages/verilog/simulation.js';
const dir = join('test-results', 'vhdl-enum-reference');
mkdirSync(dir, { recursive: true });
const source = readFileSync('fixtures/enum-fsm.vhd', 'utf8');
function generate() {
  let tb = `${source}\nlibrary ieee;use ieee.std_logic_1164.all;
entity tb is end;architecture sim of tb is
signal clk,reset,start,finish:std_logic:='0';signal busy,done:std_logic;
begin dut:entity work.enum_fsm port map(clk,reset,start,finish,busy,done);
process begin\n`;
  const expected: string[] = [];
  let state: SimulationState | undefined;
  const sample = (clk: string, reset: string, start: string, finish: string) => {
    tb += `clk<='${clk}';reset<='${reset}';start<='${start}';finish<='${finish}';wait for 1 ns;report "TRACE:" & std_logic'image(busy) & "|" & std_logic'image(done);\n`;
    const result = simulate(source, 'enum_fsm', { clk, reset, start, finish }, state);
    state = result.state;
    expected.push(`'${result.signals.busy.value}'|'${result.signals.done.value}'`);
  };
  sample('0', '0', '0', '0'); // Native enum initialization, before reset.
  sample('0', '1', '0', '0');
  sample('0', '0', '0', '0');
  let seed = 431;
  for (let i = 0; i < 256; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const start = String(seed & 1),
      finish = String((seed >>> 9) & 1),
      reset = i % 31 === 0 ? '1' : '0';
    sample('0', reset, start, finish);
    sample('1', reset, start, finish);
    sample('0', '0', start, finish);
  }
  tb += 'wait;end process;end architecture;\n';
  writeFileSync(join(dir, 'reference.vhd'), tb);
  writeFileSync(join(dir, 'expected.json'), JSON.stringify(expected));
}
function verify() {
  const expected: string[] = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
  const actual = readFileSync(join(dir, 'reference.log'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('TRACE:'))
    .map((l) => l.split('TRACE:')[1].trim());
  assert.deepEqual(actual, expected);
  const report = {
    passed: true,
    compiler: 'GHDL',
    vectors: expected.length,
    checks: expected.length * 2,
    nativeEnumInitialization: true,
  };
  writeFileSync(join(dir, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
if (process.argv.includes('--generate')) generate();
else if (process.argv.includes('--verify')) verify();
else {
  generate();
  const ghdl = process.env.MIRA_GHDL ?? 'ghdl',
    cwd = resolve(dir);
  execFileSync(ghdl, ['-a', '--std=08', 'reference.vhd'], {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
  });
  writeFileSync(
    join(dir, 'reference.log'),
    execFileSync(ghdl, ['-r', '--std=08', 'tb'], { cwd, windowsHide: true }),
  );
  verify();
}
