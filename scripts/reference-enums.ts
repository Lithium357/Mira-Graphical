// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { simulate, type SimulationState } from '../packages/verilog/simulation.js';
const dir = join('test-results', 'enum-reference');
mkdirSync(dir, { recursive: true });
const fsm = readFileSync('fixtures/enum-fsm.sv', 'utf8');
const encodings = `module enum_encodings(input sel,output [63:0] wide,output [2:0] code,output negative);
typedef enum {NEG=-1,ZERO,POS} signed_t;
enum logic signed[1:0]{MIN=2'b10,NEXT,LAST=2'b01} state;
typedef enum logic[2:0]{LOW,HIGH=3'd4,TOP} code_t;
assign wide=sel?NEG:POS;assign code=sel?TOP:HIGH;assign negative=MIN<LAST;
endmodule`;
const bits = (value: string, width: number) =>
  value === 'x'
    ? 'x'.repeat(width)
    : value.startsWith('0b')
      ? value.slice(2).padStart(width, '0')
      : BigInt(value).toString(2).padStart(width, '0');
function generate() {
  let tb = `${fsm}\n${encodings}\nmodule tb;reg clk,reset,start,finish;wire busy,done,negative;wire[1:0] state_code;wire[63:0] wide;wire[2:0] code;
enum_fsm f(clk,reset,start,finish,busy,done,state_code);enum_encodings e(start,wide,code,negative);
initial begin\n`;
  const expected: string[] = [];
  let state: SimulationState | undefined;
  const sample = (clk: string, reset: string, start: string, finish: string) => {
    tb += `clk=1'b${clk};reset=1'b${reset};start=1'b${start};finish=1'b${finish};#1;$display("TRACE:%b|%b|%b|%b|%b|%b",state_code,busy,done,wide,code,negative);\n`;
    const a = simulate(fsm, 'enum_fsm', { clk, reset, start, finish }, state);
    state = a.state;
    const b = simulate(encodings, 'enum_encodings', { sel: start });
    expected.push(
      [
        a.signals.state_code,
        a.signals.busy,
        a.signals.done,
        b.signals.wide,
        b.signals.code,
        b.signals.negative,
      ]
        .map((s) => bits(s.value, s.width))
        .join('|'),
    );
  };
  sample('0', '0', '0', '0');
  sample('0', '1', '0', '0');
  sample('0', '0', '0', '0');
  let seed = 123;
  for (let i = 0; i < 256; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const start = i % 17 === 0 ? 'x' : String(seed & 1),
      finish = i % 19 === 0 ? 'x' : String((seed >>> 1) & 1),
      reset = i % 31 === 0 ? '1' : '0';
    sample('0', reset, start, finish);
    sample('1', reset, start, finish);
    sample('1', reset, start, finish);
  }
  tb += '$finish;end endmodule\n';
  writeFileSync(join(dir, 'reference.sv'), tb);
  writeFileSync(join(dir, 'expected.json'), JSON.stringify(expected));
}
function verify() {
  const expected: string[] = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
  const actual = readFileSync(join(dir, 'reference.log'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('TRACE:'))
    .map((l) => l.slice(6));
  assert.equal(actual.length, expected.length);
  expected.forEach((line, i) => assert.equal(actual[i], line, `Enum reference sample ${i}`));
  const report = {
    passed: true,
    compiler: 'Icarus Verilog',
    vectors: expected.length,
    checks: expected.length * 6,
    enumFSM: true,
    signedEncodings: true,
    unknownSelectors: true,
  };
  writeFileSync(join(dir, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
if (process.argv.includes('--generate')) generate();
else if (process.argv.includes('--verify')) verify();
else {
  generate();
  execFileSync(
    process.env.MIRA_IVERILOG ?? 'iverilog',
    ['-g2012', '-s', 'tb', '-o', join(dir, 'reference.vvp'), join(dir, 'reference.sv')],
    { stdio: 'inherit', windowsHide: true },
  );
  writeFileSync(
    join(dir, 'reference.log'),
    execFileSync(process.env.MIRA_VVP ?? 'vvp', [join(dir, 'reference.vvp')], {
      windowsHide: true,
    }),
  );
  verify();
}
