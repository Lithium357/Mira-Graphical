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
  const hierarchyURI = pathToFileURL(join(service.workspace, 'hierarchy.v')).href;
  const hierarchyOriginal = readFileSync(join(root, 'fixtures/hierarchy.v'), 'utf8');
  let hierarchy = hierarchyOriginal,
    hierarchyVersion = 1;
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
      } else if (m.uri === hierarchyURI) {
        assert.equal(m.baseVersion, hierarchyVersion);
        for (const e of m.edits)
          hierarchy = hierarchy.slice(0, e.start) + e.text + hierarchy.slice(e.end);
        hierarchyVersion++;
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
          currentVersion:
            m.uri === uri ? version : m.uri === hierarchyURI ? hierarchyVersion : comboVersion,
          text: m.uri === uri ? live : m.uri === hierarchyURI ? hierarchy : combo,
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
  await until(() => service.states.get(comboURI)?.status === 'Synced');
  await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Add component').click()`,
  );
  await until(() => win.webContents.executeJavaScript(`!!document.querySelector('#new-name')`));
  await win.webContents.executeJavaScript(`document.querySelector('#new-name').select()`);
  win.webContents.insertText('product');
  await sleep(100);
  await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Create component').click()`,
  );
  await until(
    () =>
      !!service.states
        .get(comboURI)
        ?.previewGraph?.nodes.find((n) => n.assignmentTarget === 'product'),
  );
  const product = service.states
    .get(comboURI)!
    .previewGraph!.nodes.find((n) => n.assignmentTarget === 'product')!;
  const a = graph.nodes.find((n) => n.label === 'a')!;
  await win.webContents.executeJavaScript(
    `document.querySelector('.react-flow__controls-fitview').click()`,
  );
  await sleep(600);
  const points = await win.webContents.executeJavaScript(
    `(()=>{const point=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}};return [point('[data-id="${a.id}"] .react-flow__handle.source'),point('[data-id="${product.id}"] .react-flow__handle[data-handleid="left"]')];})()`,
  );
  win.webContents.sendInputEvent({ type: 'mouseMove', ...points[0] });
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    ...points[0],
    button: 'left',
    clickCount: 1,
  });
  for (let i = 1; i <= 10; i++) {
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(points[0].x + ((points[1].x - points[0].x) * i) / 10),
      y: Math.round(points[0].y + ((points[1].y - points[0].y) * i) / 10),
      modifiers: ['leftbuttondown'],
    });
    await sleep(40);
  }
  win.webContents.sendInputEvent({ type: 'mouseUp', ...points[1], button: 'left', clickCount: 1 });
  try {
    await until(() => service.states.get(comboURI)?.pendingSteps === 2, 3000);
  } catch (error) {
    console.log(
      'WIRING DEBUG',
      points,
      service.states.get(comboURI)?.pendingSteps,
      await win.webContents.executeJavaScript(
        `({notice:document.querySelector('[role="alert"]')?.textContent,points:${JSON.stringify(points)}.map(p=>document.elementFromPoint(p.x,p.y)?.outerHTML)})`,
      ),
    );
    mkdirSync(join(root, 'test-results'), { recursive: true });
    writeFileSync(
      join(root, 'test-results/wiring-failure.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    throw error;
  }
  await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Undo pending').click()`,
  );
  await until(() => service.states.get(comboURI)?.pendingSteps === 1);
  await until(() =>
    win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Redo pending'&&!b.disabled)`,
    ),
  );
  await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Redo pending').click()`,
  );
  await until(() => service.states.get(comboURI)?.pendingSteps === 2);
  assert.equal(patches, 2, 'Construction must wait for inactivity');
  await until(() => patches === 3);
  assert(combo.includes("assign product = a + 8'd0;"));
  await until(() => service.states.get(comboURI)?.status === 'Synced');
  ws.send(
    JSON.stringify({
      type: 'document.open',
      uri: hierarchyURI,
      version: hierarchyVersion,
      text: hierarchy,
    }),
  );
  await until(() => service.states.get(hierarchyURI)?.status === 'Synced');
  await until(() =>
    win.webContents.executeJavaScript(`!!document.querySelector('.circuit-node.instance')`),
  );
  const click = async (label: string) => {
    await until(() =>
      win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('button')).some(b=>b.textContent===${JSON.stringify(label)}&&!b.disabled)`,
      ),
    );
    await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)}).click()`,
    );
  };
  const fill = async (selector: string, value: string) => {
    await win.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)}).select()`,
    );
    win.webContents.insertText(value);
    await sleep(60);
  };
  await click('Simulation');
  await until(() =>
    win.webContents.executeJavaScript(`!!document.querySelector('.simulation-inputs')`),
  );
  await fill('[aria-label="Simulation input a"]', '2');
  await fill('[aria-label="Simulation input b"]', '3');
  await fill('[aria-label="Simulation input select"]', '1');
  await click('Sample inputs');
  await until(() =>
    win.webContents.executeJavaScript(
      `!!document.querySelector('svg[aria-label="Waveforms, 1 samples"]')`,
    ),
  );
  const resultNode = service.states
    .get(hierarchyURI)!
    .graph!.nodes.find((n) => n.label === 'result')!;
  assert(
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-id="${resultNode.id}"] .node-simulation')?.title==='0x05'`,
    ),
  );
  await fill('[aria-label="Simulation input a"]', '4');
  await fill('[aria-label="Simulation input select"]', '0');
  await click('Sample inputs');
  await until(() =>
    win.webContents.executeJavaScript(
      `!!document.querySelector('svg[aria-label="Waveforms, 2 samples"]')`,
    ),
  );
  assert(
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-id="${resultNode.id}"] .node-simulation')?.title==='0x04'`,
    ),
  );
  await click('Simulation');
  const instance = service.states
    .get(hierarchyURI)!
    .graph!.nodes.find((n) => n.kind === 'instance')!;
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-id="${instance.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`,
  );
  await until(() =>
    win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Open module')`,
    ),
  );
  await click('Open module');
  await until(() => service.states.get(hierarchyURI)?.graph?.module === 'arithmetic');
  const child = service.states.get(hierarchyURI)!.graph!.nodes.find((n) => n.kind === 'op')!;
  await until(() =>
    win.webContents.executeJavaScript(`!!document.querySelector('[data-id="${child.id}"]')`),
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-id="${child.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`,
  );
  await until(() =>
    win.webContents.executeJavaScript(
      `!!document.querySelector('[aria-label="Replace with MUL"]')`,
    ),
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Replace with MUL"]').click()`,
  );
  await until(() => patches === 4);
  assert.equal(hierarchy, hierarchyOriginal.replace('a + b', 'a * b'));
  await until(() => service.states.get(hierarchyURI)?.status === 'Synced');
  await win.webContents.executeJavaScript(
    `(()=>{const select=document.querySelector('[aria-label="Module definition"]');select.value='workbench';select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await until(() => service.states.get(hierarchyURI)?.graph?.module === 'workbench');
  const parent = service.states.get(hierarchyURI)!.graph!;
  const instanceAfter = parent.nodes.find((n) => n.kind === 'instance')!;
  await until(() =>
    win.webContents.executeJavaScript(
      `!!document.querySelector('[data-id="${instanceAfter.id}"]')`,
    ),
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-id="${instanceAfter.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`,
  );
  await until(() =>
    win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Duplicate'&&!b.disabled)`,
    ),
  );
  await click('Duplicate');
  await until(
    () =>
      !!service.states
        .get(hierarchyURI)
        ?.previewGraph?.nodes.find((n) => n.label === 'add_stage_copy1'),
  );
  await click('Undo pending');
  await until(
    () =>
      !service.states
        .get(hierarchyURI)
        ?.previewGraph?.nodes.some((n) => n.label === 'add_stage_copy1'),
  );
  await until(() =>
    win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Redo pending'&&!b.disabled)`,
    ),
  );
  await click('Redo pending');
  await until(
    () =>
      !!service.states
        .get(hierarchyURI)
        ?.previewGraph?.nodes.find((n) => n.label === 'add_stage_copy1'),
  );
  await click('Discard pending');
  await until(() => !service.states.get(hierarchyURI)?.previewGraph);
  await click('Add component');
  await until(() =>
    win.webContents.executeJavaScript(`!!document.querySelector('#palette-search')`),
  );
  await fill('#palette-search', 'concat');
  await until(() =>
    win.webContents.executeJavaScript(`!!document.querySelector('.palette-results button')`),
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('.palette-results button').click()`,
  );
  await fill('#new-name', 'joined_again');
  await fill('#new-width', '16');
  await click('Create component');
  await until(
    () =>
      !!service.states
        .get(hierarchyURI)
        ?.previewGraph?.nodes.find((n) => n.assignmentTarget === 'joined_again'),
  );
  const joined = service.states
    .get(hierarchyURI)!
    .previewGraph!.nodes.find((n) => n.assignmentTarget === 'joined_again')!;
  await until(() =>
    win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-id="${joined.id}"] .react-flow__handle.target').length===2`,
    ),
  );
  await win.webContents.executeJavaScript(
    `window.mira.command({type:'circuit',uri:${JSON.stringify(hierarchyURI)},action:{kind:'create',component:'split',name:'pieces',width:4,source:'a'}})`,
  );
  assert(
    service.states
      .get(hierarchyURI)
      ?.previewGraph?.nodes.some((n) => n.assignmentTarget === 'pieces_1'),
  );
  await click('Discard pending');
  await until(() => !service.states.get(hierarchyURI)?.previewGraph);
  // Real box selection, copy and paste of two input ports.
  await win.webContents.executeJavaScript(
    `document.querySelector('.react-flow__controls-fitview').click()`,
  );
  await sleep(600);
  const inputs = parent.nodes.filter((n) => ['a', 'b'].includes(n.label));
  const box = await win.webContents.executeJavaScript(
    `(()=>{const rects=${JSON.stringify(inputs.map((n) => n.id))}.map(id=>document.querySelector('[data-id="'+id+'"]').getBoundingClientRect());return {x:Math.round(Math.min(...rects.map(r=>r.x))-8),y:Math.round(Math.min(...rects.map(r=>r.y))-8),right:Math.round(Math.max(...rects.map(r=>r.right))+8),bottom:Math.round(Math.max(...rects.map(r=>r.bottom))+8)}})()`,
  );
  win.focus();
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' });
  await sleep(100);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: box.x, y: box.y });
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
  });
  for (let i = 1; i <= 10; i++) {
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(box.x + ((box.right - box.x) * i) / 10),
      y: Math.round(box.y + ((box.bottom - box.y) * i) / 10),
      modifiers: ['leftbuttondown'],
    });
    await sleep(35);
  }
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: box.right,
    y: box.bottom,
    button: 'left',
    clickCount: 1,
  });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' });
  try {
    await until(() =>
      win.webContents.executeJavaScript(
        `document.querySelectorAll('.react-flow__node.selected').length===2 && document.querySelectorAll('.circuit-node.selected').length===2`,
      ),
    );
  } catch (error) {
    console.log(
      'BOX DEBUG',
      box,
      await win.webContents.executeJavaScript(
        `({start:document.elementFromPoint(${box.x},${box.y})?.outerHTML,nodes:Array.from(document.querySelectorAll('.react-flow__node')).map(n=>({id:n.dataset.id,class:n.className,rect:n.getBoundingClientRect().toJSON()}))})`,
      ),
    );
    writeFileSync(
      join(root, 'test-results/selection-failure.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    throw error;
  }
  await click('Copy');
  await until(() =>
    win.webContents.executeJavaScript(
      `document.body.textContent.includes('Copied 2 items') && Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Paste'&&!b.disabled)`,
    ),
  );
  await click('Paste');
  await until(
    () =>
      !!service.states.get(hierarchyURI)?.previewGraph?.nodes.find((n) => n.label === 'b_copy1'),
  );
  await click('Discard pending');
  await until(() => !service.states.get(hierarchyURI)?.previewGraph);
  // Explicit cross-file import is a copied definition, and remains a pending, discardable action.
  await click('Add component');
  await until(() =>
    win.webContents.executeJavaScript(`!!document.querySelector('#import-module')`),
  );
  await win.webContents.executeJavaScript(
    `(()=>{const select=document.querySelector('#import-module');select.value=${JSON.stringify(JSON.stringify([uri, 'adder']))};select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await click('Import module');
  await until(
    () =>
      !!service.states.get(hierarchyURI)?.previewGraph?.library?.find((m) => m.name === 'adder'),
  );
  await click('Discard pending');
  await until(() => !service.states.get(hierarchyURI)?.previewGraph);
  assert.equal(patches, 4);
  assert.equal(hierarchy, hierarchyOriginal.replace('a + b', 'a * b'));
  await win.webContents.executeJavaScript(
    `document.querySelector('.construction-toolbar input[type="checkbox"]').click()`,
  );
  await until(() =>
    win.webContents.executeJavaScript(
      `document.querySelectorAll('.react-flow__edge-text').length>0`,
    ),
  );
  await click('Simulation');
  await until(() =>
    win.webContents.executeJavaScript(`!!document.querySelector('.simulation-inputs')`),
  );
  await fill('[aria-label="Simulation input a"]', '2');
  await fill('[aria-label="Simulation input b"]', '3');
  await fill('[aria-label="Simulation input select"]', '1');
  await click('Sample inputs');
  await until(() =>
    win.webContents.executeJavaScript(
      `!!document.querySelector('svg[aria-label="Waveforms, 1 samples"]')`,
    ),
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('.react-flow__controls-fitview').click()`,
  );
  await sleep(500);
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
        constructionWiring: true,
        pendingUndoRedo: true,
        hierarchy: true,
        busConstruction: true,
        boxSelection: true,
        copyPasteDuplicate: true,
        simulationWaveforms: true,
        moduleImport: true,
        wireLabels: true,
        dragged,
        secondMonitorTested,
        windowBounds: win.getNormalBounds(),
        realDebounceMs: 15000,
        screenshot: 'desktop-smoke.png',
        manualRemaining: [],
      },
      null,
      2,
    ),
  );
  ws.close();
}
