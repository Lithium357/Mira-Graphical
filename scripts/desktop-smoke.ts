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
  // Exercise construction/selection in a laptop-sized viewport on every host.
  win.setSize(1000, 680);
  await until(() =>
    win.webContents.executeJavaScript(
      `document.body.innerText.includes('Workspace:')&&document.body.innerText.includes('Install from VSIX')`,
    ),
  );
  assert.equal(service.editorConnected, false, 'Fresh workspace starts disconnected');
  const click = async (label: string) => {
    await until(() =>
      win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('button')).some(b=>b.textContent===${JSON.stringify(label)}&&!b.disabled)`,
      ),
    );
    await win.webContents.executeJavaScript(
      `(()=>{const button=Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)});const menu=button.closest('details');if(menu&&!menu.open)menu.querySelector('summary').click();button.click();})()`,
    );
  };
  const config = await service.ready();
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}`);
  let patches = 0;
  const recoveryRequests: { text: string; compare: boolean }[] = [];
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
    if (m.type === 'recovery.open') {
      recoveryRequests.push(m);
      return;
    }
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
  ws.send(
    JSON.stringify({
      type: 'hello',
      ...config,
      editor: 'vscode',
      capabilities: ['recovery-review'],
    }),
  );
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
  await click('Add component');
  await until(() => win.webContents.executeJavaScript(`!!document.querySelector('#new-name')`));
  await win.webContents.executeJavaScript(`document.querySelector('#new-name').select()`);
  win.webContents.insertText('product');
  await sleep(100);
  await click('Create component');
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
  await until(() =>
    win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.react-flow__node')).every(n=>getComputedStyle(n).visibility==='visible'&&n.getBoundingClientRect().width>0)`,
    ),
  );
  await until(() =>
    win.webContents.executeJavaScript(
      `!!document.querySelector('[data-id="${product.id}"] .react-flow__handle.target.connectable')`,
    ),
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('.react-flow__controls-fitview').click()`,
  );
  await sleep(600);
  let points: { x: number; y: number }[] = [];
  await until(async () => {
    points = await win.webContents.executeJavaScript(
      `(()=>{const point=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}};return [point('[data-id="${a.id}"] .react-flow__handle.source'),point('[data-id="${product.id}"] .react-flow__handle[data-handleid="left"]')];})()`,
    );
    return win.webContents.executeJavaScript(
      `${JSON.stringify(points)}.every((p,i)=>document.elementFromPoint(p.x,p.y)?.matches(i===0?'.react-flow__handle.source.connectablestart':'.react-flow__handle.target.connectable'))`,
    );
  });
  win.focus();
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'mouseMove', ...points[0] });
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    ...points[0],
    button: 'left',
    clickCount: 1,
  });
  await sleep(100);
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
  await click('Undo pending');
  await until(() => service.states.get(comboURI)?.pendingSteps === 1);
  await until(() =>
    win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Redo pending'&&!b.disabled)`,
    ),
  );
  await click('Redo pending');
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
  await until(() => win.webContents.executeJavaScript(`!document.querySelector('.inspector')`));
  // Explicitly reopen it to verify overview fitting in the narrower canvas as well.
  await click('Inspector');
  await until(() => win.webContents.executeJavaScript(`!!document.querySelector('.inspector')`));
  await win.webContents.executeJavaScript(
    `document.querySelector('.react-flow__controls-fitview').click()`,
  );
  await sleep(600);
  await until(() =>
    win.webContents.executeJavaScript(
      `(()=>{const area=document.querySelector('.flow-surface').getBoundingClientRect();return Array.from(document.querySelectorAll('.react-flow__node')).every(n=>{const r=n.getBoundingClientRect();return r.left>=area.left+8&&r.right<=area.right-8&&r.top>=area.top+8&&r.bottom<=area.bottom-8;});})()`,
    ),
  );
  const inputs = parent.nodes.filter((n) => ['a', 'b'].includes(n.label));
  const box = await win.webContents.executeJavaScript(
    `(()=>{const rects=${JSON.stringify(inputs.map((n) => n.id))}.map(id=>document.querySelector('[data-id="'+id+'"]').getBoundingClientRect());return {x:Math.round(Math.min(...rects.map(r=>r.x))-8),y:Math.round(Math.min(...rects.map(r=>r.y))-8),right:Math.round(Math.max(...rects.map(r=>r.right))+8),bottom:Math.round(Math.max(...rects.map(r=>r.bottom))+8)}})()`,
  );
  win.focus();
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' });
  await sleep(100);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: box.x, y: box.y, modifiers: ['shift'] });
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    x: box.x,
    y: box.y,
    modifiers: ['shift'],
    button: 'left',
    clickCount: 1,
  });
  for (let i = 1; i <= 10; i++) {
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(box.x + ((box.right - box.x) * i) / 10),
      y: Math.round(box.y + ((box.bottom - box.y) * i) / 10),
      modifiers: ['shift', 'leftbuttondown'],
    });
    await sleep(35);
  }
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: box.right,
    y: box.bottom,
    modifiers: ['shift'],
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
    `(()=>{const input=document.querySelector('.construction-toolbar input[type="checkbox"]');const menu=input.closest('details');if(!menu.open)menu.querySelector('summary').click();input.click();})()`,
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
  // Workspace regressions: no outer/nested scrolling, readable zoom, and usable docks.
  await click('Readable zoom');
  await sleep(300);
  if (!(await win.webContents.executeJavaScript(`!!document.querySelector('.inspector')`)))
    await click('Inspector');
  await until(() =>
    win.webContents.executeJavaScript(
      `!!document.querySelector('[aria-label="Resize inspector"]')`,
    ),
  );
  const resizePane = async (label: string, dx: number, dy: number) => {
    const point = await win.webContents.executeJavaScript(
      `(()=>{const r=document.querySelector('[aria-label="${label}"]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
    );
    win.focus();
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    await sleep(100);
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: point.x + dx,
      y: point.y + dy,
      modifiers: ['leftbuttondown'],
    });
    await sleep(100);
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      x: point.x + dx,
      y: point.y + dy,
      button: 'left',
      clickCount: 1,
    });
    await sleep(150);
  };
  const setPaneEdge = async (label: string, key: string) => {
    win.focus();
    win.webContents.focus();
    await win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="${label}"]').focus()`,
    );
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
    await sleep(150);
  };
  await setPaneEdge('Resize inspector', 'Home');
  const inspectorBefore = await win.webContents.executeJavaScript(
    `document.querySelector('.inspector').getBoundingClientRect().width`,
  );
  await resizePane('Resize inspector', -40, 0);
  await until(() =>
    win.webContents.executeJavaScript(
      `document.querySelector('.inspector').getBoundingClientRect().width>${inspectorBefore}+10`,
    ),
  );
  await setPaneEdge('Resize simulation', 'End');
  const simulationBefore = await win.webContents.executeJavaScript(
    `document.querySelector('.simulation-dock').getBoundingClientRect().height`,
  );
  await resizePane('Resize simulation', 0, 40);
  await until(() =>
    win.webContents.executeJavaScript(
      `document.querySelector('.simulation-dock').getBoundingClientRect().height<${simulationBefore}-10`,
    ),
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Resize simulation"]').focus()`,
  );
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Up' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Up' });
  await until(() =>
    win.webContents.executeJavaScript(
      `Number(document.querySelector('[aria-label="Resize simulation"]').getAttribute('aria-valuenow'))>${simulationBefore}-40+5`,
    ),
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Close inspector"]').click()`,
  );
  await until(() => win.webContents.executeJavaScript(`!document.querySelector('.inspector')`));
  await click('Minimize');
  await until(() =>
    win.webContents.executeJavaScript(
      `document.querySelector('.simulation-dock').getBoundingClientRect().height<=43 && !!document.querySelector('svg[aria-label="Waveforms, 1 samples"]')`,
    ),
  );
  await click('Expand');
  await until(() =>
    win.webContents.executeJavaScript(`!document.querySelector('.simulation-content').hidden`),
  );
  const responsiveLayouts = [];
  for (const [width, height] of [
    [1280, 800],
    [1000, 680],
    [900, 600],
  ]) {
    win.setSize(width!, height!);
    await sleep(350);
    await click('Readable zoom');
    await sleep(250);
    const metrics = await win.webContents.executeJavaScript(
      `(()=>{const graph=document.querySelector('.flow-surface').getBoundingClientRect();const dock=document.querySelector('.simulation-dock').getBoundingClientRect();const waveform=document.querySelector('.waveform-scroll');return {width:innerWidth,height:innerHeight,graphWidth:graph.width,graphHeight:graph.height,graphTop:graph.top,firstNodeTop:Math.min(...Array.from(document.querySelectorAll('.react-flow__node')).map(n=>n.getBoundingClientRect().top)),dockHeight:dock.height,zoom:Number(document.querySelector('.react-flow__viewport').style.transform.match(/scale\\(([^)]+)\\)/)[1]),outerOverflow:document.documentElement.scrollHeight>innerHeight||document.documentElement.scrollWidth>innerWidth,nestedWaveformScroll:['auto','scroll'].includes(getComputedStyle(waveform).overflowY)}})()`,
    );
    assert(!metrics.outerOverflow, JSON.stringify(metrics));
    assert(!metrics.nestedWaveformScroll, JSON.stringify(metrics));
    assert(metrics.graphWidth >= metrics.width * 0.95, JSON.stringify(metrics));
    assert(metrics.graphHeight > metrics.dockHeight, JSON.stringify(metrics));
    assert(metrics.zoom >= 0.7, JSON.stringify(metrics));
    assert(metrics.firstNodeTop >= metrics.graphTop + 8, JSON.stringify(metrics));
    responsiveLayouts.push(metrics);
    writeFileSync(
      join(output, `workspace-${width}x${height}.png`),
      (await win.webContents.capturePage()).toPNG(),
    );
  }
  win.setSize(
    Math.min(1320, screen.getPrimaryDisplay().workArea.width),
    Math.min(860, screen.getPrimaryDisplay().workArea.height),
  );
  await sleep(350);
  await click('Readable zoom');
  await sleep(250);
  writeFileSync(join(output, 'desktop-smoke.png'), (await win.webContents.capturePage()).toPNG());
  writeFileSync(
    join(output, 'desktop-smoke.json'),
    JSON.stringify(
      {
        passed: true,
        patches,
        adderNodes: 4,
        combinationalNodes: 11,
        resizableWorkspace: true,
        responsiveLayouts,
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
  // Render both native languages and exercise their real inspector patch path.
  const languageDocuments = ['sv', 'vhd'].map((ext) => ({
    ext,
    uri: pathToFileURL(join(service.workspace, `hierarchy.${ext}`)).href,
    text: readFileSync(join(root, `fixtures/hierarchy.${ext}`), 'utf8'),
  }));
  for (const doc of languageDocuments)
    ws.send(JSON.stringify({ type: 'document.open', uri: doc.uri, version: 1, text: doc.text }));
  await until(() => languageDocuments.every((d) => !!service.states.get(d.uri)?.graph));
  for (const doc of languageDocuments) {
    await win.webContents.executeJavaScript(
      `(()=>{const s=document.querySelector('[aria-label="Shared module"]');s.value=${JSON.stringify(doc.uri)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    service.selectModule(doc.uri, 'arithmetic');
    const operation = service.states.get(doc.uri)!.graph!.nodes.find((n) => n.kind === 'op')!;
    await until(() =>
      win.webContents.executeJavaScript(`!!document.querySelector('[data-id="${operation.id}"]')`),
    );
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-id="${operation.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`,
    );
    await until(() =>
      win.webContents.executeJavaScript(
        `!!document.querySelector('[aria-label="Replace with ${doc.ext === 'sv' ? 'SHL' : 'SUB'}"]')`,
      ),
    );
    await win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="Replace with ${doc.ext === 'sv' ? 'SHL' : 'SUB'}"]').click()`,
    );
    await until(
      () =>
        service.states
          .get(doc.uri)
          ?.previewGraph?.nodes.some((n) => n.op === (doc.ext === 'sv' ? '<<' : '-')) === true ||
        service.states.get(doc.uri)?.pendingEdits?.[operation.id]?.value ===
          (doc.ext === 'sv' ? '<<' : '-'),
    );
    assert.equal(
      service.simulate(doc.uri, { a: '9', b: '3' }).signals.result.value,
      doc.ext === 'sv' ? '0x48' : '0x06',
    );
    await click('Readable zoom');
    await sleep(250);
    const text = await win.webContents.executeJavaScript('document.body.innerText');
    assert(text.includes(doc.ext === 'vhd' ? 'VHDL' : 'SYSTEMVERILOG'));
    writeFileSync(
      join(output, `language-${doc.ext}.png`),
      (await win.webContents.capturePage()).toPNG(),
    );
    service.discardGraphChanges(doc.uri);
  }
  const recoveryId = service.recovery.archive({
    at: new Date().toISOString(),
    reason: 'Desktop recovery smoke',
    uri: hierarchyURI,
    version: hierarchyVersion,
    text: hierarchy,
    previewText: '// recovered smoke preview\n' + hierarchy,
    graphEdits: [],
  });
  await click('Recovery');
  await until(() =>
    win.webContents.executeJavaScript(`!!document.querySelector('.recovery-dialog[open]')`),
  );
  await until(() =>
    win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.recovery-list button')).some(b=>b.innerText.includes('Desktop recovery smoke'))`,
    ),
  );
  await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('.recovery-list button')).find(b=>b.innerText.includes('Desktop recovery smoke')).click()`,
  );
  await until(() =>
    win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="Recovered source"]')?.textContent.startsWith('// recovered smoke preview')`,
    ),
  );
  await click('Copy text');
  await until(() =>
    win.webContents.executeJavaScript(
      `document.querySelector('.recovery-dialog [role="status"]')?.textContent==='Recovery text copied.'`,
    ),
  );
  const { clipboard } = await import('electron');
  assert.equal(await clipboard.readText(), service.recovery.read(recoveryId).previewText);
  await win.webContents.executeJavaScript(
    `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`,
  );
  writeFileSync(join(output, 'recovery-smoke.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(
    `document.querySelector('.recovery-preview input').click()`,
  );
  await until(() =>
    win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="Recovered source"]')?.textContent===${JSON.stringify(hierarchy)}`,
    ),
  );
  const recoveryMetrics = await win.webContents.executeJavaScript(
    `(()=>{const d=document.querySelector('.recovery-dialog').getBoundingClientRect();return {width:d.width,height:d.height,x:d.x,y:d.y,innerWidth,innerHeight}})()`,
  );
  assert(
    recoveryMetrics.x >= 0 &&
      recoveryMetrics.y >= 0 &&
      recoveryMetrics.x + recoveryMetrics.width <= recoveryMetrics.innerWidth + 1 &&
      recoveryMetrics.y + recoveryMetrics.height <= recoveryMetrics.innerHeight + 1,
    JSON.stringify(recoveryMetrics),
  );
  await click('Compare in VS Code');
  await until(() => recoveryRequests.length === 1);
  assert.deepEqual(
    recoveryRequests.map((r) => ({ text: r.text, compare: r.compare })),
    [{ text: hierarchy, compare: true }],
  );
  await click('Open recovered copy');
  await until(() => recoveryRequests.length === 2);
  assert.equal(recoveryRequests[1].compare, false);
  assert.equal(recoveryRequests[1].text, hierarchy);
  assert.equal(service.sessions.get(hierarchyURI)!.text, hierarchy);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await until(() =>
    win.webContents.executeJavaScript(`!document.querySelector('.recovery-dialog')`),
  );
  const { accessibilitySmoke } = await import('./accessibility-smoke.js');
  const selectedURI = await win.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Shared module"]').value`,
  );
  assert(service.sessions.has(selectedURI));
  await accessibilitySmoke(win, service, selectedURI, output);
  const aluURI = pathToFileURL(join(service.workspace, 'alu-int16.v')).href;
  ws.send(
    JSON.stringify({
      type: 'document.open',
      uri: aluURI,
      version: 1,
      text: readFileSync(join(root, 'fixtures/alu-int16.v'), 'utf8'),
    }),
  );
  await until(() => !!service.states.get(aluURI)?.graph);
  service.selectModule(aluURI, 'ALU_INT16');
  await win.webContents.executeJavaScript(
    `(()=>{const s=document.querySelector('[aria-label="Shared module"]');s.value=${JSON.stringify(aluURI)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  const aluGraph = service.states.get(aluURI)!.graph!;
  const not = aluGraph.nodes.find((n) => n.op === '~')!;
  await until(() =>
    win.webContents.executeJavaScript(
      `!!document.querySelector('[data-id="${not.id}"] [data-handleid="left"]')`,
    ),
  );
  assert.equal(
    await win.webContents.executeJavaScript(
      `!!document.querySelector('[data-id="${not.id}"] [data-handleid="right"]')`,
    ),
    false,
  );
  // Exercise the public command after a manual move, then inspect actual DOM
  // geometry (including measured card height), rather than just layout data.
  service.move(aluURI, not.id, 9000, 9000);
  // Suspend frames without hiding Chromium itself: executeJavaScript can pause
  // indefinitely in a hidden native window, which would stall the test driver.
  await win.webContents.executeJavaScript(
    `window.__savedLayoutRAF=window.requestAnimationFrame;void(window.requestAnimationFrame=()=>0);`,
  );
  await click('Auto layout');
  await until(() => !service.states.get(aluURI)!.layout.nodes[not.id].manuallyPlaced);
  await sleep(500);
  const geometry = await win.webContents.executeJavaScript(`(()=>{
    const viewport=document.querySelector('.react-flow__viewport');
    const zoom=new DOMMatrix(getComputedStyle(viewport).transform).a;
    return Array.from(document.querySelectorAll('.react-flow__node')).map(n=>{
      const r=n.getBoundingClientRect();
      return {id:n.dataset.id,x:r.x/zoom,y:r.y/zoom,width:r.width/zoom,height:r.height/zoom};
    });
  })()`);
  assert.equal(geometry.length, 57);
  for (const [i, a] of geometry.entries())
    for (const b of geometry.slice(i + 1))
      assert(
        a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y,
        `ALU cards overlap: ${a.id}, ${b.id}`,
      );
  const layoutWidth =
    Math.max(...geometry.map((n: any) => n.x + n.width)) -
    Math.min(...geometry.map((n: any) => n.x));
  const layoutHeight =
    Math.max(...geometry.map((n: any) => n.y + n.height)) -
    Math.min(...geometry.map((n: any) => n.y));
  assert(layoutWidth < 3000 && layoutHeight < 3000, `ALU layout ${layoutWidth} x ${layoutHeight}`);
  await win.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Fit entire circuit"]').click()`,
  );
  await until(() =>
    win.webContents.executeJavaScript(`(()=>{
    const area=document.querySelector('.flow-surface').getBoundingClientRect();
    return Array.from(document.querySelectorAll('.react-flow__node')).every(n=>{
      const r=n.getBoundingClientRect();return r.left>=area.left+8&&r.right<=area.right-8&&r.top>=area.top+8&&r.bottom<=area.bottom-8;
    });
  })()`),
  );
  writeFileSync(join(output, 'alu-layout.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(
    `window.requestAnimationFrame=window.__savedLayoutRAF;delete window.__savedLayoutRAF;`,
  );
  await click('Readable zoom');
  await sleep(500);
  writeFileSync(
    join(output, 'alu-layout-readable.png'),
    (await win.webContents.capturePage()).toPNG(),
  );
  assert.equal(
    service.simulate(aluURI, { OPc: '15', OPd: '1', opcode: '8' }).signals.result.value,
    '0x001e',
  );
  assert.equal(
    service.simulate(aluURI, { OPc: '15', OPd: '1', opcode: '12' }).signals.result.value,
    '0xfff0',
  );
  const signedSource = readFileSync(join(root, 'fixtures/alu-int16-signed.v'), 'utf8');
  ws.send(
    JSON.stringify({
      type: 'document.change',
      uri: aluURI,
      version: 2,
      origin: 'user',
      text: signedSource,
    }),
  );
  await until(
    () =>
      service.states.get(aluURI)?.status === 'Synced' &&
      service.states.get(aluURI)?.graph?.nodes.some((n) => n.op === '>>>') === true,
  );
  const signedGraph = service.states.get(aluURI)!.graph!;
  const cast = signedGraph.nodes.find((n) => n.kind === 'convert')!;
  const arithmeticShift = signedGraph.nodes.find((n) => n.op === '>>>')!;
  await until(() =>
    win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-id="${cast.id}"] .react-flow__handle.target').length===1 && document.querySelector('[data-id="${arithmeticShift.id}"] .node-width')?.textContent.includes('zero fill')`,
    ),
  );
  assert.equal(
    service.simulate(aluURI, { OPc: '32768', OPd: '1', opcode: '5' }).signals.result.value,
    '0x0000',
  );
  assert.equal(
    service.simulate(aluURI, { OPc: '32768', OPd: '1', opcode: '6' }).signals.result.value,
    '0x0001',
  );
  assert.equal(
    service.simulate(aluURI, { OPc: '32768', OPd: '1', opcode: '7' }).signals.result.value,
    '0x4000',
  );
  ws.send(
    JSON.stringify({
      type: 'document.change',
      uri: aluURI,
      version: 3,
      origin: 'user',
      text: signedSource.replace('($signed(OPc) >>> OPd)', '$unsigned($signed(OPc) >>> OPd)'),
    }),
  );
  await until(
    () =>
      service.states.get(aluURI)?.status === 'Synced' && service.states.get(aluURI)?.version === 3,
  );
  assert.equal(
    service.simulate(aluURI, { OPc: '32768', OPd: '1', opcode: '7' }).signals.result.value,
    '0xc000',
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Fit entire circuit"]').click()`,
  );
  await sleep(500);
  writeFileSync(join(output, 'signed-alu.png'), (await win.webContents.capturePage()).toPNG());
  const clockedURI = pathToFileURL(join(service.workspace, 'clocked.v')).href;
  ws.send(
    JSON.stringify({
      type: 'document.open',
      uri: clockedURI,
      version: 1,
      text: readFileSync(join(root, 'fixtures/alu-int16-clocked.v'), 'utf8'),
    }),
  );
  await until(() => !!service.states.get(clockedURI)?.graph);
  service.selectModule(clockedURI, 'INT16_MUL');
  await win.webContents.executeJavaScript(
    `(()=>{const s=document.querySelector('[aria-label="Shared module"]');s.value=${JSON.stringify(clockedURI)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await until(() =>
    win.webContents.executeJavaScript(`document.body.innerText.includes('INT16_MUL')`),
  );
  if (
    !(await win.webContents.executeJavaScript(
      `!!document.querySelector('[aria-label="Clocked simulation"]')`,
    ))
  )
    await click('Simulation');
  const sampled = async (count: number) =>
    until(() =>
      win.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Clocked simulation"] [role="status"]')?.textContent.includes('${count} ${count === 1 ? 'sample' : 'samples'}') && !Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Evaluating…')`,
      ),
    );
  await fill('[aria-label="Simulation input reset"]', '1');
  await click('Sample inputs');
  await sampled(1);
  await fill('[aria-label="Simulation input reset"]', '0');
  await fill('[aria-label="Simulation input OPm"]', '65535');
  await fill('[aria-label="Simulation input OPn"]', '2');
  await fill('[aria-label="Simulation input signed_mode"]', '1');
  await fill('[aria-label="Simulation input start"]', '1');
  await click('Step clk');
  await sampled(2);
  await fill('[aria-label="Simulation input start"]', '0');
  for (let i = 0; i < 16; i++) {
    await click('Step clk');
    await sampled(i + 3);
  }
  const clockedGraph = service.states.get(clockedURI)!.graph!;
  const clockedProduct = clockedGraph.nodes.find(
    (n) => n.kind === 'output' && n.label === 'result',
  )!;
  await until(() =>
    win.webContents.executeJavaScript(
      `document.querySelector('[data-id="${clockedProduct.id}"] .node-simulation')?.textContent==='0xfffffffe'`,
    ),
  );
  assert.equal(clockedGraph.nodes.filter((n) => n.register).length, 7);
  assert.equal(service.states.get(clockedURI)!.canConstruct, true);
  await fill('[aria-label="Simulation input reset"]', '1');
  await click('Sample inputs');
  await sampled(19);
  await until(() =>
    win.webContents.executeJavaScript(
      `document.querySelector('[data-id="${clockedProduct.id}"] .node-simulation')?.textContent==='0x00000000'`,
    ),
  );
  await click('Restart simulation');
  await fill('[aria-label="Simulation input reset"]', '0');
  await fill('[aria-label="Simulation input clk"]', '0');
  await click('Sample inputs');
  await sampled(1);
  await until(() =>
    win.webContents.executeJavaScript(
      `document.querySelector('[data-id="${clockedProduct.id}"] .node-simulation')?.textContent.startsWith('0bxxxxxxxx')`,
    ),
  );
  writeFileSync(
    join(output, 'clocked-multiplier.png'),
    (await win.webContents.capturePage()).toPNG(),
  );
  writeFileSync(
    join(output, 'clocked-smoke.json'),
    JSON.stringify(
      {
        passed: true,
        registers: 7,
        clockSteps: 17,
        signedProduct: true,
        asynchronousReset: true,
        restartUnknown: true,
        sourceUntouched: true,
      },
      null,
      2,
    ),
  );
  await win.webContents.executeJavaScript(
    `(()=>{const s=document.querySelector('[aria-label="Module definition"]');if(s.disabled)throw new Error('Clocked module navigation disabled');s.value='ALU_INT16';s.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await until(() => service.states.get(clockedURI)?.graph?.module === 'ALU_INT16');
  assert.equal(service.states.get(clockedURI)!.canConstruct, true);
  writeFileSync(
    join(output, 'alu-smoke.json'),
    JSON.stringify(
      {
        passed: true,
        projection: true,
        unarySocket: true,
        shiftSimulation: true,
        notSimulation: true,
        signedCasts: true,
        signedComparisons: true,
        arithmeticShift: true,
        unsignedMuxCoercion: true,
        autoLayout: {
          width: layoutWidth,
          height: layoutHeight,
          noOverlap: true,
          resetManualPosition: true,
        },
      },
      null,
      2,
    ),
  );
  const { launchFeaturesSmoke } = await import('./launch-features-smoke.js');
  await launchFeaturesSmoke(service, win, root, ws, click, fill);
  ws.close();
}
