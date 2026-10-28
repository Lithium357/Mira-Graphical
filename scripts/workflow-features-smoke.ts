// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow } from 'electron';
import { WebSocket } from 'ws';
import type { SyncService } from '../packages/core/service.js';

export async function workflowFeaturesSmoke(
  service: SyncService,
  win: BrowserWindow,
  root: string,
) {
  win.webContents.setBackgroundThrottling(false);
  win.show();
  win.focus();
  const execute = (s: string) => win.webContents.executeJavaScript(s);
  const wait = async (fn: () => Promise<unknown> | unknown) => {
    const start = Date.now();
    while (!(await fn())) {
      assert(Date.now() - start < 22000, 'Workflow desktop UI timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const click = async (text: string) => {
    await wait(() =>
      execute(
        `Array.from(document.querySelectorAll('button')).some(b=>b.textContent===${JSON.stringify(text)}&&!b.disabled)`,
      ),
    );
    await execute(
      `(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)});const d=b.closest('details');if(d)d.open=true;b.click();})()`,
    );
  };
  const fill = async (selector: string, value: string) => {
    await execute(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await new Promise((r) => setTimeout(r, 50));
  };
  const choose = async (selector: string, value: string) =>
    execute(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  const config = await service.ready(false),
    ws = new WebSocket(`ws://127.0.0.1:${config.port}`);
  const open = async (name: string, text: string) => {
    const uri = pathToFileURL(join(service.workspace, name)).href;
    ws.send(JSON.stringify({ type: 'document.open', uri, version: 1, text }));
    await wait(() => service.sessions.has(uri));
    return uri;
  };
  try {
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'hello', ...config, editor: 'vscode' }));
    await wait(() => service.editorConnected);
    const uri = await open('fsm.sv', readFileSync(join(root, 'fixtures/enum-fsm.sv'), 'utf8'));
    await wait(() => service.states.get(uri)?.status === 'Synced');
    await choose('[aria-label="Shared module"]', uri);
    await click('Simulation');
    await wait(() => execute(`!!document.querySelector('[aria-label="Simulation input reset"]')`));
    await fill('[aria-label="Simulation input reset"]', '1');
    await click('Sample inputs');
    await wait(() =>
      execute(
        `document.querySelector('.simulation-heading [role="status"]')?.textContent.startsWith('1 ')`,
      ),
    );
    await fill('[aria-label="Simulation input reset"]', '0');
    await fill('[aria-label="Simulation input start"]', '1');
    await click('Step clk');
    await wait(() =>
      execute(
        `document.querySelector('.simulation-heading [role="status"]')?.textContent.startsWith('2 ')`,
      ),
    );
    await execute(`document.querySelector('.saved-tests').open=true`);
    await fill('.saved-tests input', 'Start and hold');
    await click('Save recorded test');
    await wait(() => service.listTests(uri).length === 1);
    await click('Run test');
    await wait(() =>
      execute(
        `document.querySelector('.saved-tests [role="status"]')?.textContent.includes('PASS')`,
      ),
    );
    assert.equal(
      service.listTests(uri)[0].vectors.length,
      3,
      'Record the inactive clock sample too',
    );
    await click('State machines');
    await wait(() =>
      execute(
        `document.querySelector('[aria-label="State machines"]')?.textContent.includes('Active state: RUN')`,
      ),
    );
    await wait(() => execute(`!!document.querySelector('.fsm-diagram svg')`));
    await new Promise((resolve) => setTimeout(resolve, 300));
    writeFileSync(
      join(root, 'test-results/workflow-fsm.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    await click('Close state view');
    const test = service.listTests(uri)[0];
    test.name = 'Deliberate failure';
    test.vectors[2].expect.busy = '0';
    service.saveTest(uri, test);
    const failed = await execute(
      `window.mira.command({type:'testRun',uri:${JSON.stringify(uri)},test:${JSON.stringify(test)}})`,
    );
    assert.equal(failed.passed, false);
    assert(failed.failures.some((f: any) => f.signal === 'busy'));
    const parent = await open(
      'parent.v',
      'module parent(input a,b,output y);child u(.a(a),.b(b),.y(y));endmodule',
    );
    const child = await open('child.v', 'module child(input a,b,output y);assign y=a&b;endmodule');
    await wait(() => service.states.get(parent)?.status === 'Invalid source');
    await choose('[aria-label="Shared module"]', parent);
    await click('Project sources');
    await execute(
      `(()=>{const label=Array.from(document.querySelectorAll('.project-source')).find(e=>e.textContent.includes('child.v'));label.querySelector('input').click();})()`,
    );
    await click('Apply project sources');
    await wait(() => service.states.get(parent)?.status === 'Synced');
    assert.deepEqual(service.states.get(parent)?.projectSources, [child]);
    assert.equal(service.simulate(parent, { a: '1', b: '0' }).signals.y.value, '0');
    await wait(() => execute(`document.body.innerText.includes('Linked project')`));
    assert(await execute(`document.querySelector('[data-add-component]').disabled`));
    ws.send(
      JSON.stringify({
        type: 'document.change',
        uri: child,
        version: 2,
        text: 'module child(input a,b,output y);assign y=a|b;endmodule',
        origin: 'user',
      }),
    );
    await wait(() => service.sessions.get(child)?.state.version === 2);
    await wait(() => service.states.get(parent)?.status === 'Synced');
    assert.equal(service.simulate(parent, { a: '1', b: '0' }).signals.y.value, '1');
    writeFileSync(
      join(root, 'test-results/workflow-linked.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    const native = await open('fsm.vhd', readFileSync(join(root, 'fixtures/enum-fsm.vhd'), 'utf8'));
    await wait(() => service.states.get(native)?.status === 'Synced');
    await choose('[aria-label="Shared module"]', native);
    await click('State machines');
    await wait(() =>
      execute(
        `document.querySelector('[aria-label="State machines"]')?.textContent.includes('finished')`,
      ),
    );
    assert(service.states.get(native)?.machines?.[0].transitions.length);
    writeFileSync(
      join(root, 'test-results/workflow-features-smoke.json'),
      JSON.stringify(
        {
          passed: true,
          savedTestRecording: true,
          clockPulsesRecorded: true,
          isolatedReplay: true,
          deliberateFailure: true,
          activeStateDiagram: true,
          vhdlEnumDiagram: true,
          multiFileLiveBuffers: true,
          linkedConstructionDisabled: true,
        },
        null,
        2,
      ),
    );
  } finally {
    ws.close();
  }
}
