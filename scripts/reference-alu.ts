// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { simulate } from '../packages/verilog/simulation.js';
const folder = join('test-results', 'alu-reference');
mkdirSync(folder, { recursive: true });
const alu = readFileSync('fixtures/alu-int16.v', 'utf8');
const probes = `module probes(input [3:0] a,input [7:0] b,input [15:0] amount,
 output [15:0] inv,shl,shr,eq,ne,lt,le,gt,ge,mixed,nested,eqcontext,notcmp,precedence);
 assign inv=~a;
 assign shl=a<<amount;
 assign shr=a>>amount;
 assign eq=(a+b)==b;
 assign ne=a!=b;
 assign lt=a<b;
 assign le=a<=b;
 assign gt=a>b;
 assign ge=a>=b;
 assign mixed=a & b == 8'd1;
 assign nested=a << (b+8'd1);
 assign eqcontext=((a+b)==b)+16'd1;
 assign notcmp=~(a==b);
 assign precedence=a<<1+1;
endmodule`;
const probeOutputs = [
  'inv',
  'shl',
  'shr',
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'mixed',
  'nested',
  'eqcontext',
  'notcmp',
  'precedence',
];
const binary = (value: string, width: number) =>
  value === 'x'
    ? 'x'.repeat(width)
    : value.startsWith('0b')
      ? value.slice(2)
      : BigInt(value).toString(2).padStart(width, '0');
const bits = (value: string, width: number) =>
  value.startsWith('0x') ? BigInt(value).toString(2).padStart(width, '0') : binary(value, width);
function generate() {
  let tb =
    alu +
    '\n' +
    probes +
    `\nmodule tb;
 reg [15:0] OPc,OPd,amount;reg [3:0] opcode,a;reg [7:0] b;wire [15:0] result,${probeOutputs.join(',')};
 ALU_INT16 dut(.OPc(OPc),.OPd(OPd),.opcode(opcode),.result(result));
 probes widths(${['a', 'b', 'amount', ...probeOutputs].map((n) => '.' + n + '(' + n + ')').join(',')});
 initial begin\n`;
  const expected: string[] = [];
  let seed = 357;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed >>> 16;
  };
  const pairs: [string, string][] = [
    ['0', '0'],
    ['1', '1'],
    ['65535', '1'],
    ['32768', '15'],
    ['65535', '16'],
    ['65535', '65535'],
    ['x', '0'],
    ['0', 'x'],
    ['0b1x01', '1'],
  ];
  for (let i = 0; i < 128; i++) pairs.push([String(random()), String(random())]);
  for (const [OPc, OPd] of pairs)
    for (let opcode = 0; opcode < 16; opcode++) {
      tb += `OPc=16'b${binary(OPc, 16)};OPd=16'b${binary(OPd, 16)};opcode=4'd${opcode};#1;$display("TRACE:%b",result);\n`;
      const value = simulate(alu, 'ALU_INT16', { OPc, OPd, opcode: String(opcode) }).signals.result;
      expected.push(bits(value.value, value.width));
    }
  const inputs: [string, string, string][] = [
    ['15', '1', '0'],
    ['15', '255', '1'],
    ['0', '255', '15'],
    ['15', '16', '16'],
    ['x', '0', '16'],
    ['0b1x00', '1', '1'],
    ['0b0x00', '0', '1'],
    ['15', 'x', 'x'],
    ['15', '0', '65535'],
  ];
  for (let i = 0; i < 128; i++)
    inputs.push([String(random() % 16), String(random() % 256), String(random() % 32)]);
  for (const [a, b, amount] of inputs) {
    tb += `a=4'b${binary(a, 4)};b=8'b${binary(b, 8)};amount=16'b${binary(amount, 16)};#1;$display("TRACE:${probeOutputs.map(() => '%b').join('|')}",${probeOutputs.join(',')});\n`;
    const signals = simulate(probes, 'probes', { a, b, amount }).signals;
    expected.push(probeOutputs.map((n) => bits(signals[n].value, signals[n].width)).join('|'));
  }
  tb += '$finish;end\nendmodule\n';
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
  assert.deepEqual(actual, expected, 'ALU and width/unknown-bit probes must match Icarus Verilog');
  const aluVectors = expected.filter((line) => !line.includes('|')).length;
  const probeVectors = expected.length - aluVectors;
  const result = {
    passed: true,
    aluVectors,
    probeVectors,
    probeOutputs: probeOutputs.length,
    checks: aluVectors + probeVectors * probeOutputs.length,
    compiler: 'Icarus Verilog',
  };
  writeFileSync(join(folder, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
if (process.argv.includes('--generate')) console.log(`Generated ${generate()} reference vectors.`);
else if (process.argv.includes('--verify')) verify();
else {
  generate();
  execFileSync(
    process.env.MIRA_IVERILOG ?? 'iverilog',
    ['-g2005', '-s', 'tb', '-o', join(folder, 'reference.vvp'), join(folder, 'reference.v')],
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
