// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../packages/verilog/index.js';
test('unsupported preprocessing and event controls provide actionable diagnostics with original offsets', () => {
  const prefix = '// Unicode 🙂\r\n';
  for (const directive of ['`default_nettype none', '`include "external.v"', '`define VALUE 3']) {
    assert.throws(
      () => parse(prefix + directive + '\nmodule x(); endmodule'),
      (e: any) => {
        assert.match(e.message, /Unsupported preprocessor directive/);
        assert.match(e.message, /self-contained/);
        assert.equal(e.start, prefix.length);
        return true;
      },
    );
  }
  assert.throws(
    () => parse('module clocked(input clk, output reg q); always @(posedge clk) q <= 1; endmodule'),
    /Unsupported event control/,
  );
  assert.doesNotThrow(() =>
    parse(
      '// `include "ignored.v" and @ are just comments\nmodule x(input a, output y); assign y = a; endmodule',
    ),
  );
});
