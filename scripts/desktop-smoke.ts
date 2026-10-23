// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { screen, type BrowserWindow } from 'electron';
import type { SyncService } from '../packages/core/service.js';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean | Promise<boolean>, timeout = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await f()) return;
    await sleep(100);
  }
  throw new Error('Desktop smoke timed out');
}
export async function desktopSmoke(service: SyncService, win: BrowserWindow, root: string) {
  const config = await service.ready();
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}`);
  let patches = 0;
  const original = readFileSync(join(root, 'fixtures/adder.v'), 'utf8');
  let live = original;
  let version = 1;
  const uri = pathToFileURL(join(service.workspace, 'adder.v')).href;
  const comboURI = pathToFileURL(join(service.workspace, 'combinational.v')).href;
  const comboOriginal = readFileSync(join(root, 'fixtures/combinational.v'), 'utf8');
  let combo = comboOriginal;
  let comboVersion = 1;
  ws.on('message', (b) => {
    const m = JSON.parse(b.toString());
    if (m.type === 'document.applyPatch') {
      if (m.uri === uri) {
        assert.equal(m.baseVersion, version);
        for (const e of m.edits) {
          assert.equal(e.end - e.start, 1);
          live = live.slice(0, e.start) + e.text + live.slice(e.end);
        }
        version++;
      } else {
        assert.equal(m.uri, comboURI);
        assert.equal(m.baseVersion, comboVersion);
        for (const e of m.edits) combo = combo.slice(0, e.start) + e.text + combo.slice(e.end);
        comboVersion++;
      }
      patches++;
      ws.send(
        JSON.stringify({
          type: 'document.patchResult',
          uri: m.uri,
          patchId: m.patchId,
          ok: true,
          currentVersion: m.uri === uri ? version : comboVersion,
          text: m.uri === uri ? live : combo,
        }),
      );
    }
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello', ...config, editor: 'vscode' }));
  await sleep(100);
  ws.send(JSON.stringify({ type: 'document.open', uri, version, text: live }));
  await sleep(1000);
  assert.equal(service.states.get(uri)?.graph, undefined, 'No early projection');
  await until(() => !!service.states.get(uri)?.graph);
  await until(() =>
    win.webContents.executeJavaScript(`document.querySelectorAll('.circuit-node').length===4`),
  );
  const op = service.states.get(uri)!.graph!.nodes.find((n) => n.kind === 'op')!;
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-id="${op.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`,
  );
  await until(() =>
    win.webContents.executeJavaScript(
      `!!document.querySelector('[aria-label="Replace with MUL"]')`,
    ),
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Replace with MUL"]').click()`,
  );
  await sleep(1000);
  assert.equal(patches, 0, 'No early graph patch');
  await until(() => patches === 1);
  assert.equal(live, original.replace('a + b', 'a * b'));
  await until(() => service.states.get(uri)?.status === 'Synced');
  // Exercise Chromium's real pointer event path, not just the drag-end IPC.
  const before = { ...service.states.get(uri)!.layout.nodes[op.id] };
  win.show();
  win.focus();
  win.webContents.focus();
  await sleep(200);
  const center = await win.webContents.executeJavaScript(
    `(()=>{const r=document.querySelector('[data-id="${op.id}"]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
  );
  win.webContents.sendInputEvent({ type: 'mouseMove', ...center });
  win.webContents.sendInputEvent({ type: 'mouseDown', ...center, button: 'left', clickCount: 1 });
  await sleep(100);
  for (let step = 1; step <= 10; step++) {
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: center.x + step * 8,
      y: center.y + step * 6,
      modifiers: ['leftbuttondown'],
    });
    await sleep(40);
  }
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: center.x + 80,
    y: center.y + 60,
    button: 'left',
    clickCount: 1,
  });
  await until(() => Math.abs(service.states.get(uri)!.layout.nodes[op.id].x - before.x) > 20);
  const dragged = { ...service.states.get(uri)!.layout.nodes[op.id] };
  assert.equal(patches, 1, 'Dragging must not patch source');
  win.reload();
  await sleep(1000);
  await until(() =>
    win.webContents.executeJavaScript(`document.querySelectorAll('.circuit-node').length===4`),
  );
  assert.equal(service.states.get(uri)!.layout.nodes[op.id].y, dragged.y);
  ws.send(
    JSON.stringify({ type: 'document.open', uri: comboURI, version: comboVersion, text: combo }),
  );
  await until(() => service.states.get(comboURI)?.status === 'Synced');
  await until(() =>
    win.webContents.executeJavaScript(`document.querySelectorAll('.circuit-node').length===11`),
  );
  const graph = service.states.get(comboURI)!.graph!;
  for (const [kind, value] of [
    ['literal', "8'h2A"],
    ['slice', '[3:0]'],
    ['mux', 'select_b'],
  ] as const) {
    const n = graph.nodes.find((n) => n.kind === kind)!;
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-id="${n.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`,
    );
    await until(() => win.webContents.executeJavaScript(`!!document.querySelector('.edit-form')`));
    if (kind === 'mux')
      await win.webContents.executeJavaScript(
        `(()=>{const input=document.querySelector('.edit-form select');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
    else {
      await win.webContents.executeJavaScript(
        `document.querySelector('.edit-form input').select()`,
      );
      win.webContents.insertText(value);
    }
    await sleep(100);
    await win.webContents.executeJavaScript(`document.querySelector('.edit-form button').click()`);
    await until(() => service.states.get(comboURI)?.pendingEdits?.[n.id]?.value === value, 3000);
  }
  await until(() => patches === 2);
  assert.equal(
    combo,
    comboOriginal
      .replace("8'h0F", "8'h2A")
      .replace('a[7:0]', 'a[3:0]')
      .replace('= select_a ?', '= select_b ?'),
  );
  assert.equal(live, original.replace('a + b', 'a * b'), 'Other shared document remains unchanged');
  const displays = screen.getAllDisplays();
  let secondMonitorTested = false;
  if (displays.length > 1) {
    const area = displays[1].workArea;
    win.setBounds({
      x: area.x + 20,
      y: area.y + 20,
      width: Math.min(1000, area.width),
      height: Math.min(700, area.height),
    });
    await sleep(200);
    const bounds = win.getBounds();
    assert(bounds.x >= area.x && bounds.x < area.x + area.width);
    secondMonitorTested = true;
  }
  const output = join(root, 'test-results');
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'desktop-smoke.png'), (await win.webContents.capturePage()).toPNG());
  writeFileSync(
    join(output, 'desktop-smoke.json'),
    JSON.stringify(
      {
        passed: true,
        patches,
        adderNodes: 4,
        combinationalNodes: 11,
        pointerDrag: true,
        multiDocument: true,
        literalSliceSelector: true,
        dragged,
        secondMonitorTested,
        windowBounds: win.getNormalBounds(),
        realDebounceMs: 15000,
        screenshot: 'desktop-smoke.png',
        manualRemaining: ['Second monitor physical placement'],
      },
      null,
      2,
    ),
  );
  ws.close();
}
