// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { simulate, type SimulationState } from '../packages/verilog/simulation.js';
const folder = join('test-results', 'clocked-reference');
const design = readFileSync('fixtures/alu-int16-clocked.v', 'utf8');
const probe = `module edge_probe(input clk,reset,en,input [3:0] a,b,
 output reg [3:0] q,old,output [7:0] repeated,extended,output both,either,inverted);
 wire signed [3:0] s;assign s=a;
 assign repeated={4{a[1:0]}};assign extended=s;
 assign both=a&&b;assign either=a||b;assign inverted=!a;
 always_ff @(negedge clk or negedge reset) begin
 if(!reset) begin q<=4'd0;old<=4'd0;end
 else begin q<=4'd1;if(en) begin q<=q+4'd1;old<=q;end end
 end endmodule`;
const binary = (value: string, width: number): string =>
  value === 'x'
    ? 'x'.repeat(width)
    : value.startsWith('0b')
      ? value.slice(2).padStart(width, '0')
      : BigInt(value).toString(2).padStart(width, '0');
const outputs = [
  'product',
  'busy',
  'done',
  'overflow',
  'alu_result',
  'carry',
  'alu_overflow',
  'q',
  'old',
  'repeated',
  'extended',
  'both',
  'either',
  'inverted',
];
function generate() {
  mkdirSync(folder, { recursive: true });
  let tb = `${design}\n${probe}\nmodule tb;
 reg clk,reset,start,signed_mode,en;reg [15:0] a,b;reg [3:0] opcode,pa,pb;
 wire [31:0] product;wire busy,done,overflow,carry,alu_overflow;wire [15:0] alu_result;
 wire [3:0] q,old;wire [7:0] repeated,extended;wire both,either,inverted;
 INT16_MUL m(clk,reset,start,signed_mode,a,b,product,busy,done,overflow);
 ALU_INT16 alu(a,b,opcode,alu_result,carry,alu_overflow);
 edge_probe probe(clk,~reset,en,pa,pb,q,old,repeated,extended,both,either,inverted);
 initial begin\n`;
  const expected: string[] = [];
  let mulState: SimulationState | undefined, probeState: SimulationState | undefined;
  const vector = { clk: '0', reset: '0', start: '0', signed_mode: '0', OPm: '0', OPn: '0' };
  let en = '1',
    pa = '0',
    pb = '0',
    opcode = '0';
  const sample = () => {
    tb += `clk=1'b${vector.clk};reset=1'b${vector.reset};start=1'b${vector.start};signed_mode=1'b${vector.signed_mode};a=16'd${vector.OPm};b=16'd${vector.OPn};opcode=4'd${opcode};en=1'b${en};pa=4'b${binary(pa, 4)};pb=4'b${binary(pb, 4)};#1;$display("TRACE:${outputs.map(() => '%b').join('|')}",${outputs.join(',')});\n`;
    const mul = simulate(design, 'INT16_MUL', vector, mulState);
    mulState = mul.state;
    const alu = simulate(design, 'ALU_INT16', { OPc: vector.OPm, OPd: vector.OPn, opcode });
    const p = simulate(
      probe,
      'edge_probe',
      { clk: vector.clk, reset: vector.reset === '0' ? '1' : '0', en, a: pa, b: pb },
      probeState,
    );
    probeState = p.state;
    const signals = [
      mul.signals.result,
      mul.signals.busy,
      mul.signals.done,
      mul.signals.overflow,
      alu.signals.result,
      alu.signals.carry,
      alu.signals.overflow,
      ...['q', 'old', 'repeated', 'extended', 'both', 'either', 'inverted'].map(
        (n) => p.signals[n],
      ),
    ];
    expected.push(signals.map((s) => binary(s.value, s.width)).join('|'));
  };
  sample();
  vector.reset = '1';
  sample();
  vector.reset = '0';
  sample();
  const pairs = [
    [0, 0],
    [1, 65535],
    [32768, 65535],
    [65535, 65535],
    [32767, 32767],
    [32768, 32768],
    [123, 456],
    [65535, 2],
  ];
  let seed = 0x1258;
  for (let i = 0; i < 8; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const a = seed & 65535;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pairs.push([a, seed & 65535]);
  }
  for (const signed of ['0', '1'])
    for (const [index, [a, b]] of pairs.entries()) {
      Object.assign(vector, {
        clk: '0',
        reset: '0',
        start: '1',
        signed_mode: signed,
        OPm: String(a),
        OPn: String(b),
      });
      opcode = String(index);
      pa = index % 3 === 0 ? '0b1x01' : String(index);
      pb = index % 2 ? '0' : 'x';
      en = index % 4 === 0 ? 'x' : '1';
      sample();
      vector.clk = '1';
      sample();
      vector.start = '0';
      sample();
      for (let cycle = 0; cycle < 18; cycle++) {
        vector.clk = '0';
        sample();
        vector.clk = '1';
        sample();
      }
    }
  // Reset while clock is held high and a transaction is in flight.
  vector.start = '1';
  vector.clk = '0';
  sample();
  vector.clk = '1';
  sample();
  vector.start = '0';
  vector.reset = '1';
  sample();
  vector.reset = '0';
  sample();
  tb += '$finish;end endmodule\n';
  writeFileSync(join(folder, 'reference.v'), tb);
  writeFileSync(join(folder, 'expected.json'), JSON.stringify(expected));
  return expected.length;
}
function verify() {
  const expected = JSON.parse(readFileSync(join(folder, 'expected.json'), 'utf8')) as string[];
  const actual = readFileSync(join(folder, 'reference.log'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('TRACE:'))
    .map((l) => l.slice(6));
  assert.equal(actual.length, expected.length);
  expected.forEach((line, i) =>
    assert.equal(actual[i], line, `Clock/reset/NBA/signed/logic reference vector ${i}`),
  );
  const report = {
    passed: true,
    vectors: expected.length,
    checks: expected.length * outputs.length,
    compiler: 'Icarus Verilog',
  };
  writeFileSync(join(folder, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
if (process.argv.includes('--generate')) console.log(`Generated ${generate()} clocked vectors.`);
else if (process.argv.includes('--verify')) verify();
else {
  generate();
  execFileSync(
    process.env.MIRA_IVERILOG ?? 'iverilog',
    ['-g2012', '-s', 'tb', '-o', join(folder, 'reference.vvp'), join(folder, 'reference.v')],
    { stdio: 'inherit', windowsHide: true },
  );
  writeFileSync(
    join(folder, 'reference.log'),
    execFileSync(process.env.MIRA_VVP ?? 'vvp', [join(folder, 'reference.vvp')], {
      windowsHide: true,
    }),
  );
  verify();
}
