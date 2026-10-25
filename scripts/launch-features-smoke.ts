// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow } from 'electron';
import { WebSocket } from 'ws';
import type { SyncService } from '../packages/core/service.js';
export async function launchFeaturesSmoke(
  service: SyncService,
  win: BrowserWindow,
  root: string,
  ws: WebSocket,
  click: (s: string) => Promise<void>,
  fill: (s: string, v: string) => Promise<void>,
) {
  const until = async (f: () => Promise<boolean> | boolean) => {
    const start = Date.now();
    while (!(await f())) {
      assert(Date.now() - start < 22000, 'Launch feature UI timed out');
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const choose = async (selector: string, value: string) =>
    win.webContents.executeJavaScript(
      `(()=>{const s=document.querySelector(${JSON.stringify(selector)});s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  for (const spec of [
    { file: 'clocked-hierarchy.sv', module: 'pipeline', output: 'second', value: '0x50' },
    { file: 'clocked-counter.vhd', module: 'clocked_counter', output: 'q', value: '0x02' },
  ]) {
    const uri = pathToFileURL(join(service.workspace, 'feature-' + spec.file)).href;
    ws.send(
      JSON.stringify({
        type: 'document.open',
        uri,
        version: 1,
        text: readFileSync(join(root, 'fixtures', spec.file), 'utf8'),
      }),
    );
    await until(() => service.states.get(uri)?.status === 'Synced');
    service.selectModule(uri, spec.module);
    await choose('[aria-label="Shared module"]', uri);
    if (
      !(await win.webContents.executeJavaScript(
        `!!document.querySelector('[aria-label="Clocked simulation"]')`,
      ))
    )
      await click('Simulation');
    await until(() =>
      win.webContents.executeJavaScript(
        `!!document.querySelector('[aria-label="Simulation input reset"]')`,
      ),
    );
    const sample = async (label: string, count: number) => {
      await click(label);
      await until(() =>
        win.webContents.executeJavaScript(
          `document.querySelector('[aria-label="Clocked simulation"] [role="status"]')?.textContent.startsWith('${count} ')&&!document.body.innerText.includes('Evaluating…')`,
        ),
      );
    };
    await fill('[aria-label="Simulation input reset"]', '1');
    await sample('Sample inputs', 1);
    await fill('[aria-label="Simulation input reset"]', '0');
    await fill('[aria-label="Simulation input en"]', '1');
    if (spec.module === 'pipeline') await fill('[aria-label="Simulation input data"]', '4');
    await sample('Step clk', 2);
    await sample('Step clk', 3);
    const result = service.states
      .get(uri)!
      .graph!.nodes.find((n) => n.kind === 'output' && n.label === spec.output)!;
    await until(() =>
      win.webContents.executeJavaScript(
        `document.querySelector('[data-id="${result.id}"] .node-simulation')?.textContent===${JSON.stringify(spec.value)}`,
      ),
    );
    if (spec.module === 'clocked_counter') {
      await click('Add component');
      await until(() => win.webContents.executeJavaScript(`!!document.querySelector('#new-kind')`));
      await choose('#new-kind', 'register');
      await fill('#new-name', 'shadow_q');
      await fill('#new-width', '8');
      await choose('#register-clock', 'clk');
      await choose('#register-reset', 'reset');
      await choose('#new-source', 'q');
      await click('Create component');
      await until(
        () =>
          !!service.states
            .get(uri)
            ?.previewGraph?.nodes.some((n) => n.register && n.label === 'shadow_q'),
      );
      await click('Discard pending');
      await until(() => !service.states.get(uri)?.pendingSteps);
    }
  }
  writeFileSync(
    join(root, 'test-results', 'launch-features-smoke.json'),
    JSON.stringify(
      { passed: true, hierarchicalClockSteps: true, vhdlClockSteps: true, registerPalette: true },
      null,
      2,
    ),
  );
}

export async function launchFeaturesStandalone(
  service: SyncService,
  win: BrowserWindow,
  root: string,
) {
  const config = await service.ready(),
    ws = new WebSocket('ws://127.0.0.1:' + config.port);
  await new Promise<void>((ok, fail) => {
    ws.once('open', ok);
    ws.once('error', fail);
  });
  ws.send(JSON.stringify({ ...config, type: 'hello', editor: 'vscode' }));
  const click = async (label: string) => {
    const start = Date.now();
    while (
      !(await win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('button')).some(b=>b.textContent===${JSON.stringify(label)}&&!b.disabled)`,
      ))
    ) {
      if (Date.now() - start > 10000) throw new Error('Missing button ' + label);
      await new Promise((r) => setTimeout(r, 50));
    }
    await win.webContents.executeJavaScript(
      `(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)});const menu=b.closest('details');if(menu&&!menu.open)menu.querySelector('summary').click();b.click();})()`,
    );
  };
  const fill = async (selector: string, value: string) => {
    await win.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)}).select()`,
    );
    win.webContents.insertText(value);
    await new Promise((r) => setTimeout(r, 80));
  };
  try {
    await launchFeaturesSmoke(service, win, root, ws, click, fill);
  } finally {
    ws.close();
  }
}
