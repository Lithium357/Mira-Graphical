// SPDX-License-Identifier: GPL-3.0-only
import type { Diagnostic } from '../verilog/index.js';
export function locateDiagnostic(source: string, d: Diagnostic): Diagnostic {
  const start = Math.max(0, Math.min(source.length, Number.isSafeInteger(d.start) ? d.start : 0));
  const before = source.slice(0, start),
    line = before.split(/\r\n|\n|\r/).length;
  const column = start - Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'));
  const plain = source.replace(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|--[^\r\n]*/g, (s) =>
    s.replace(/[^\r\n]/g, ' '),
  );
  let module: string | undefined;
  for (const m of plain.matchAll(
    /\bmodule\s+([A-Za-z_][\w$]*)|\barchitecture\s+\w+\s+of\s+(\w+)/gi,
  )) {
    if (m.index! > start) break;
    module = m[1] ?? m[2];
  }
  return {
    ...d,
    start,
    end: Math.max(start, Math.min(source.length, d.end ?? start)),
    line,
    column,
    module,
  };
}
