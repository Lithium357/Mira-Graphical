// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { simulate, type SimulationState } from '../packages/verilog/simulation.js';
import { parse, project } from '../packages/verilog/index.js';
import { planTransaction, copyComponents } from '../packages/verilog/construction.js';
const dir = join('test-results', 'projects-reference');
mkdirSync(dir, { recursive: true });
const hierarchy = readFileSync('fixtures/clocked-hierarchy.sv', 'utf8');
const ordered = `module ordered(input [7:0] a,b,input [1:0] op,output reg [7:0] y);reg signed [3:0] temp;
always @* begin temp=a+b;y=8'd0;case(op+2'd1) 2'd0: y=temp+8'd1;1,2:y=a^b;default:y=b;endcase end endmodule`;
const graph = project(parse(ordered));
const copied = planTransaction(ordered, [
  {
    kind: 'paste',
    items: copyComponents(ordered, graph, [
      graph.nodes.find((n) => n.label === 'y' && n.kind === 'output')!.id,
    ]),
  },
]).text;
const signedCase = `module signedcase(input [3:0] s,output reg [7:0] y);always_comb case(s) -1:y=8'd1;default:y=8'd0;endcase endmodule`;
// Negative labels are not yet in the bounded literal grammar; mix signed
// decimal and unsigned sized labels to test whole-case coercion instead.
const caseProbe = signedCase.replace("-1:y=8'd1;", "31:y=8'd1;8'd255:y=8'd2;15:y=8'd3;");
const bits = (v: string, w: number) =>
  v === 'x'
    ? 'x'.repeat(w)
    : v.startsWith('0b')
      ? v.slice(2).padStart(w, '0')
      : BigInt(v).toString(2).padStart(w, '0');
function generate() {
  let tb =
    hierarchy +
    '\n' +
    copied +
    '\n' +
    caseProbe +
    `\nmodule tb;reg clk,reset,en;reg[7:0] data,b;reg[1:0] op;wire[7:0] first,second,y,y_copy1,cy;
 pipeline p(clk,reset,en,data,first,second);ordered o(data,b,op,y,y_copy1);signedcase c(data[3:0],cy);
 initial begin\n`;
  const expected: string[] = [];
  let state: SimulationState | undefined;
  const sample = (clk: string, reset: string, en: string, data: string, b: string, op: string) => {
    tb += `clk=1'b${clk};reset=1'b${reset};en=1'b${en};data=8'b${bits(data, 8)};b=8'b${bits(b, 8)};op=2'b${bits(op, 2)};#1;$display("TRACE:%b|%b|%b|%b|%b|%b|%b",first,second,p.a.q,p.b.q,y,y_copy1,cy);\n`;
    const h = simulate(hierarchy, 'pipeline', { clk, reset, en, data }, state);
    state = h.state;
    const o = simulate(copied, 'ordered', { a: data, b, op });
    const c = simulate(caseProbe, 'signedcase', {
      s: data === 'x' ? 'x' : String(Number(data) & 15),
    });
    expected.push(
      [
        h.signals.first,
        h.signals.second,
        h.signals['a.q'],
        h.signals['b.q'],
        o.signals.y,
        o.signals.y_copy1,
        c.signals.y,
      ]
        .map((s) => bits(s.value, s.width))
        .join('|'),
    );
  };
  sample('0', '1', '0', '0', '0', '0');
  sample('0', '0', '1', '0', '1', '0');
  let seed = 123456;
  for (let i = 0; i < 128; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const a = String(seed & 255),
      b = String((seed >>> 8) & 255),
      op = i % 9 === 0 ? 'x' : String(i % 4),
      en = i % 13 === 0 ? 'x' : i % 7 === 0 ? '0' : '1',
      reset = i % 29 === 0 ? '1' : '0';
    sample('0', reset, en, a, b, op);
    sample('1', reset, en, a, b, op);
    sample('1', reset, en, a, b, op);
  }
  tb += '$finish;end endmodule\n';
  writeFileSync(join(dir, 'reference.sv'), tb);
  writeFileSync(join(dir, 'expected.json'), JSON.stringify(expected));
  const native = readFileSync('fixtures/clocked-counter.vhd', 'utf8');
  const falling = native
    .replaceAll('clocked_counter', 'falling_counter')
    .replaceAll('rising_edge', 'falling_edge')
    .replace(
      'q <= q + to_unsigned(1,8);',
      'case q(1 downto 0) is when "00" => q <= q + to_unsigned(1,8); when others => q <= q + to_unsigned(2,8); end case;',
    );
  const low = native
    .replaceAll('clocked_counter', 'low_counter')
    .replace("reset = '1'", "reset = '0'");
  const sources = [native, falling, low];
  let vhdl =
    sources.join('\n') +
    `\nlibrary ieee;use ieee.std_logic_1164.all;use ieee.numeric_std.all;
 entity tb is end entity;architecture test of tb is signal clk,reset,en:std_logic;signal q,f,l:unsigned(7 downto 0);
 function bits(v:unsigned) return string is variable s:string(1 to v'length);begin for i in v'range loop case v(i) is when '0'=>s(v'left-i+1):='0';when '1'=>s(v'left-i+1):='1';when others=>s(v'left-i+1):='x';end case;end loop;return s;end;
 begin a:entity work.clocked_counter port map(clk,reset,en,q);b:entity work.falling_counter port map(clk,reset,en,f);c:entity work.low_counter port map(clk,reset,en,l);
 process begin\n`;
  const states: (SimulationState | undefined)[] = [],
    vExpected: string[] = [];
  const nativeSample = (clk: string, reset: string, en: string) => {
    vhdl += `clk<='${clk.toUpperCase()}';reset<='${reset}';en<='${en.toUpperCase()}';wait for 1 ns;report "TRACE:" & bits(q)&"|"&bits(f)&"|"&bits(l);\n`;
    vExpected.push(
      sources
        .map((source, i) => {
          const r = simulate(
            source,
            ['clocked_counter', 'falling_counter', 'low_counter'][i],
            { clk, reset, en },
            states[i],
          );
          states[i] = r.state;
          return bits(r.signals.q.value, 8);
        })
        .join('|'),
    );
  };
  nativeSample('0', '1', '1');
  nativeSample('0', '0', '1');
  for (let i = 0; i < 128; i++) {
    nativeSample(i % 31 === 0 ? 'x' : '0', i % 19 === 0 ? '1' : '0', i % 9 === 0 ? 'x' : '1');
    nativeSample('1', i % 19 === 0 ? '1' : '0', i % 9 === 0 ? 'x' : '1');
  }
  vhdl += 'wait;end process;end architecture;\n';
  writeFileSync(join(dir, 'reference.vhd'), vhdl);
  writeFileSync(join(dir, 'native-expected.json'), JSON.stringify(vExpected));
}
function verify() {
  let checks = 0;
  for (const [expectedName, logName, width] of [
    ['expected.json', 'reference.log', 7],
    ['native-expected.json', 'native.log', 3],
  ] as const) {
    const expected = JSON.parse(readFileSync(join(dir, expectedName), 'utf8')) as string[];
    const actual = readFileSync(join(dir, logName), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.includes('TRACE:'))
      .map((l) => l.slice(l.indexOf('TRACE:') + 6));
    assert.equal(actual.length, expected.length, logName);
    expected.forEach((line, i) => assert.equal(actual[i], line, `${logName} vector ${i}`));
    checks += expected.length * width;
  }
  const report = {
    passed: true,
    checks,
    compilers: ['Icarus Verilog', 'GHDL'],
    hierarchy: true,
    cases: true,
    blockingWidths: true,
    copiedProcedures: true,
    nativeEdges: true,
  };
  writeFileSync(join(dir, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
if (process.argv.includes('--generate')) generate();
else if (process.argv.includes('--verify')) verify();
else {
  generate();
  execFileSync(
    'iverilog',
    ['-g2012', '-s', 'tb', '-o', join(dir, 'reference.vvp'), join(dir, 'reference.sv')],
    { stdio: 'inherit' },
  );
  writeFileSync(join(dir, 'reference.log'), execFileSync('vvp', [join(dir, 'reference.vvp')]));
  execFileSync('ghdl', ['-a', '--std=08', 'reference.vhd'], { cwd: dir, stdio: 'inherit' });
  execFileSync('ghdl', ['-e', '--std=08', 'tb'], { cwd: dir, stdio: 'inherit' });
  writeFileSync(
    join(dir, 'native.log'),
    execFileSync('ghdl', ['-r', '--std=08', 'tb'], { cwd: dir }),
  );
  verify();
}
