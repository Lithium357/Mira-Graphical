// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { app, type BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function windowActivationSmoke(win: BrowserWindow, root: string) {
  win.show();
  win.minimize();
  for (let i = 0; i < 30 && !win.isMinimized(); i++) await sleep(50);
  assert(win.isMinimized(), 'Test window enters minimized state');
  app.emit('second-instance', {}, [], process.cwd());
  for (let i = 0; i < 30 && win.isMinimized(); i++) await sleep(50);
  const report = { visible: win.isVisible(), minimized: win.isMinimized() };
  writeFileSync(
    join(root, 'test-results/window-activation-smoke.json'),
    JSON.stringify(report, null, 2),
  );
  assert(!report.minimized && report.visible, 'Opening Mira again restores its minimized window');
}
