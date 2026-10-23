// SPDX-License-Identifier: GPL-3.0-only
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { simulate } from '../packages/verilog/simulation.js';
const folder = join('test-results', 'reference');
mkdirSync(folder, { recursive: true });
const source = `module reference_circuit(input [7:0] a,b,input [0:7] ascending,input [3:0] n,input select,
 output [15:0] sum,product,nested,muxed,joined,output [7:0] child_result,bit_and,bit_or,bit_xor,output [3:0] cut,high);
 assign sum=a+b;
 assign product=a*b;
 assign nested=(a+b)*(a-b);
 assign muxed=select?(a+b):(a*b);
 assign joined={a[7:4],b[3:0],n,ascending[0:3]};
 assign bit_and=a&b;
 assign bit_or=a|b;
 assign bit_xor=a^b;
 assign cut=a+b;
 assign high=ascending[0:3];
 reference_child stage(.a(a),.b(b),.y(child_result));
endmodule
module reference_child(input [7:0] a,b,output [7:0] y);assign y=a+b;endmodule
`;
const outputs = [
  'sum',
  'product',
  'nested',
  'muxed',
  'joined',
  'child_result',
  'bit_and',
  'bit_or',
  'bit_xor',
  'cut',
  'high',
];
function generate() {
  let seed = 357;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed >>> 24;
  };
  const vectors: Record<string, string>[] = Array.from({ length: 256 }, () => ({
    a: String(random()),
    b: String(random()),
    ascending: String(random()),
    n: String(random() % 16),
    select: String(random() % 2),
  }));
  for (const [a, b, select] of [
    ['x', '0', 'x'],
    ['0', 'x', 'x'],
    ['x', '255', '1'],
    ['0b10x101x0', '0b010x1001', 'x'],
    ['255', '1', '1'],
    ['255', '255', '0'],
    ['0', '0', 'x'],
    ['1', '1', 'x'],
  ])
    vectors.push({ a, b, select, ascending: '171', n: '5' });
  const expected = vectors.map((inputs) => {
    const result = simulate(source, 'reference_circuit', inputs);
    return outputs
      .map((name) => {
        const { width, value } = result.signals[name];
        return value.startsWith('0x')
          ? BigInt(value).toString(2).padStart(width, '0')
          : value.startsWith('0b')
            ? value.slice(2)
            : value === 'x'
              ? 'x'.repeat(width)
              : value;
      })
      .join('|');
  });
  const literal = (value: string, width: number) =>
    `${width}'b${value === 'x' ? 'x'.repeat(width) : value.startsWith('0b') ? value.slice(2) : Number(value).toString(2)}`;
  let tb =
    source +
    '\nmodule tb;reg [7:0] a,b;reg [0:7] ascending;reg [3:0] n;reg select;wire [15:0] sum,product,nested,muxed,joined;wire [7:0] child_result,bit_and,bit_or,bit_xor;wire [3:0] cut,high;\nreference_circuit dut(' +
    ['a', 'b', 'ascending', 'n', 'select', ...outputs].map((n) => `.${n}(${n})`).join(',') +
    ');\ninitial begin\n';
  vectors.forEach((inputs, index) => {
    for (const name of ['a', 'b', 'ascending', 'n', 'select'])
      tb += `${name}=${literal(inputs[name], name === 'select' ? 1 : name === 'n' ? 4 : 8)};`;
    tb += `#1;$display("TRACE${index}:${outputs.map(() => '%b').join('|')}",${outputs.join(',')});\n`;
  });
  tb += '$finish;end\nendmodule\n';
  writeFileSync(join(folder, 'reference.v'), tb);
  writeFileSync(join(folder, 'expected.json'), JSON.stringify(expected));
  return expected.length;
}
function verify() {
  const expected = JSON.parse(readFileSync(join(folder, 'expected.json'), 'utf8')) as string[],
    log = readFileSync(join(folder, 'reference.log'), 'utf8');
  const actual = log
    .split(/\r?\n/)
    .filter((line) => line.startsWith('TRACE'))
    .map((line) => line.slice(line.indexOf(':') + 1));
  assert.deepEqual(actual, expected, 'Simulator results must match Icarus Verilog bit for bit');
  const result = {
    passed: true,
    vectors: expected.length,
    outputsPerVector: outputs.length,
    checks: expected.length * outputs.length,
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
