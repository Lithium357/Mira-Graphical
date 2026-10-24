// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { simulate } from '../packages/verilog/simulation.js';
import { parse, project } from '../packages/verilog/index.js';
import { copyComponents, planTransaction } from '../packages/verilog/construction.js';
const folder = join('test-results', 'alu-reference');
const proceduralSource = `module procedural_copy(input logic [3:0] a,input logic [7:0] b,input logic s,output logic [15:0] y);
 always_comb begin if(s) y=$signed(a)>>>b;else y=$unsigned($signed(a)>>>b);end
endmodule`;
const proceduralGraph = project(parse(proceduralSource));
const procedural = planTransaction(proceduralSource, [
  {
    kind: 'paste',
    items: copyComponents(proceduralSource, proceduralGraph, [
      proceduralGraph.nodes.find((n) => n.kind === 'output' && n.label === 'y')!.id,
    ]),
  },
]).text;
mkdirSync(folder, { recursive: true });
const alu = readFileSync('fixtures/alu-int16.v', 'utf8');
const signedAlu = readFileSync('fixtures/alu-int16-signed.v', 'utf8')
  .replaceAll('ALU_INT16', 'ALU_INT16_SIGNED')
  .replaceAll('ALU_FP16', 'ALU_FP16_SIGNED');
const isolatedAlu = signedAlu
  .replaceAll('ALU_INT16_SIGNED', 'ALU_INT16_ISOLATED')
  .replaceAll('ALU_FP16_SIGNED', 'ALU_FP16_ISOLATED')
  .replace('($signed(OPc) >>> OPd)', '$unsigned($signed(OPc) >>> OPd)');
const probes = `module probes(input [3:0] a,input [7:0] b,input [15:0] amount,
 output [15:0] inv,shl,shr,eq,ne,lt,le,gt,ge,mixed,nested,eqcontext,notcmp,precedence,
 signedge,signedlt,signedwide,unsignedwide,ashr,unshr,muxcoerce,isolated,signadd,signsumcast,signnot,signbits,nestedtypes,signamount,mixedcompare,selfcompare,caseeq,casene);
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
 assign signedge=$signed(a)>=$signed(b);
 assign signedlt=$signed(a)<$signed(b);
 assign signedwide=$signed(a);
 assign unsignedwide=$unsigned($signed(a));
 assign ashr=$signed(a)>>>amount;
 assign unshr=a>>>amount;
 assign muxcoerce=1'b0 ? 16'b0 : ($signed(a)>>>amount);
 assign isolated=1'b0 ? 16'b0 : $unsigned($signed(a)>>>amount);
 assign signadd=$signed(a)+$signed(b);
 assign signsumcast=$signed(a+b);
 assign signnot=~$signed(a);
 assign signbits=$signed({a,b})>>>amount;
 assign nestedtypes=($signed(a)<$signed(b)) ? ($signed(a)>>>amount) : $unsigned(b);
 assign signamount=$signed(a)>>>$signed(b);
 assign mixedcompare=$signed(a)<b;
 assign selfcompare=$signed(a+b)<$signed(b);
 assign caseeq=$signed(a) === $signed(b);
 assign casene=a !== b;
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
  'signedge',
  'signedlt',
  'signedwide',
  'unsignedwide',
  'ashr',
  'unshr',
  'muxcoerce',
  'isolated',
  'signadd',
  'signsumcast',
  'signnot',
  'signbits',
  'nestedtypes',
  'signamount',
  'mixedcompare',
  'selfcompare',
  'caseeq',
  'casene',
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
    signedAlu +
    '\n' +
    isolatedAlu +
    '\n' +
    procedural +
    '\n' +
    probes +
    `\nmodule tb;
 reg [15:0] OPc,OPd,amount;reg [3:0] opcode,a;reg [7:0] b;wire [15:0] result,signedresult,isolatedresult,proc_result,proc_copy,${probeOutputs.join(',')};
 ALU_INT16 dut(.OPc(OPc),.OPd(OPd),.opcode(opcode),.result(result));
 ALU_INT16_SIGNED signed_dut(.OPc(OPc),.OPd(OPd),.opcode(opcode),.result(signedresult));
 ALU_INT16_ISOLATED isolated_dut(.OPc(OPc),.OPd(OPd),.opcode(opcode),.result(isolatedresult));
 procedural_copy procedure_dut(.a(a),.b(b),.s(a[0]),.y(proc_result),.y_copy1(proc_copy));
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
      tb += `OPc=16'b${binary(OPc, 16)};OPd=16'b${binary(OPd, 16)};opcode=4'd${opcode};#1;$display("TRACE:%b|%b|%b",result,signedresult,isolatedresult);\n`;
      expected.push(
        [
          [alu, 'ALU_INT16'],
          [signedAlu, 'ALU_INT16_SIGNED'],
          [isolatedAlu, 'ALU_INT16_ISOLATED'],
        ]
          .map(([source, module]) => {
            const value = simulate(source, module, { OPc, OPd, opcode: String(opcode) }).signals
              .result;
            return bits(value.value, value.width);
          })
          .join('|'),
      );
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
    tb += `a=4'b${binary(a, 4)};b=8'b${binary(b, 8)};amount=16'b${binary(amount, 16)};#1;$display("TRACE:${[...probeOutputs, 'proc_result', 'proc_copy'].map(() => '%b').join('|')}",${[...probeOutputs, 'proc_result', 'proc_copy'].join(',')});\n`;
    const signals = simulate(probes, 'probes', { a, b, amount }).signals;
    const procedure = simulate(procedural, 'procedural_copy', {
      a,
      b,
      s: binary(a, 4).at(-1)!,
    }).signals;
    expected.push(
      [
        ...probeOutputs.map((n) => bits(signals[n].value, signals[n].width)),
        bits(procedure.y.value, 16),
        bits(procedure.y_copy1.value, 16),
      ].join('|'),
    );
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
  assert.equal(actual.length, expected.length, 'Icarus must produce every reference vector');
  for (const [i, line] of expected.entries())
    assert.equal(actual[i], line, `ALU/width/unknown-bit reference vector ${i}`);
  const aluVectors = expected.filter((line) => line.split('|').length === 3).length;
  const probeVectors = expected.length - aluVectors;
  const result = {
    passed: true,
    aluVectors,
    aluVariants: 3,
    probeVectors,
    probeOutputs: probeOutputs.length + 2,
    checks: aluVectors * 3 + probeVectors * (probeOutputs.length + 2),
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
