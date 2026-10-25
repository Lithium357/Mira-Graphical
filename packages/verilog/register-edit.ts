// SPDX-License-Identifier: GPL-3.0-only
import type { Module } from './index.js';
import type { Edit } from '../protocol/index.js';
import type { InputPort } from '../protocol/index.js';
export function registerEdits(
  ast: Module,
  target: string,
  port: InputPort,
  replacement: string,
): Edit[] {
  const driver = ast.assigns.find((a) => a.target === target),
    info = driver?.registerInputs;
  if (!driver?.events || !info)
    throw new Error(
      'This register shares procedural control; edit its block in the HDL editor. Newly created individual registers can be wired here.',
    );
  if (port === 'port:D' || port === 'left') return [{ ...info.data, text: replacement }];
  if (!ast.nets.some((n) => n.name === replacement && n.width === 1 && n.direction === 'input'))
    throw new Error('Register clock/reset connections require scalar input ports.');
  if (port === 'port:clock')
    return [
      { ...info.clock, text: replacement },
      ...(info.clockSensitivity ? [{ ...info.clockSensitivity, text: replacement }] : []),
    ];
  if (port === 'port:reset' && info.reset) {
    const edits: Edit[] = [{ ...info.reset, text: replacement }];
    const reset = driver.events[1];
    if (reset?.start !== undefined && reset.end !== undefined)
      edits.push({ start: reset.start, end: reset.end, text: replacement });
    return edits;
  }
  throw new Error('Choose register D, clock, or reset.');
}
export function requireIndependentDriver(ast: Module, driver: Module['assigns'][number]) {
  if (driver.structured || ast.assigns.some((a) => a !== driver && a.start === driver.start))
    throw new Error('This result shares a procedural block; edit that block in the HDL editor.');
}
