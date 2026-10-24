// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { SyncService } from '../packages/core/service.js';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const delay = () => new Promise((r) => setTimeout(r, 70));
export async function accessibilitySmoke(
  win: BrowserWindow,
  service: SyncService,
  uri: string,
  output: string,
) {
  const js = (code: string) => win.webContents.executeJavaScript(code);
  const key = async (keyCode: string) => {
    const nativeCode = keyCode === 'ArrowDown' ? 'Down' : keyCode;
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: nativeCode });
    if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: nativeCode });
    await delay();
  };
  const tabTo = async (expression: string) => {
    for (let n = 0; n < 150; n++) {
      if (await js(`(()=>{const el=document.activeElement;return ${expression}})()`)) return;
      await key('Tab');
    }
    assert.fail(
      `Keyboard could not reach ${expression}; focus: ${await js('document.activeElement?.outerHTML')}`,
    );
  };
  await tabTo(`el?.textContent==='Setup help'`);
  await key('Enter');
  assert(await js(`!!document.querySelector('.setup-dialog[open]')`));
  for (let i = 0; i < 8; i++) {
    await key('Tab');
    assert(
      await js(`!!document.activeElement?.closest('.setup-dialog')`),
      'Modal keeps keyboard focus inside',
    );
  }
  await key('Escape');
  assert.equal(await js('document.activeElement?.textContent'), 'Setup help');
  await tabTo(`el?.textContent==='Recovery'&&el.tagName==='BUTTON'`);
  await key('Enter');
  assert(await js(`!!document.querySelector('.recovery-dialog[open]')`));
  await tabTo(
    `el?.tagName==='BUTTON'&&el.hasAttribute('aria-pressed')&&!!el.closest('.recovery-list')`,
  );
  await key('Enter');
  for (
    let i = 0;
    i < 40 &&
    !(await js(`!!document.querySelector('[aria-label="Recovered source"]')?.textContent`));
    i++
  )
    await delay();
  assert(await js(`!!document.querySelector('[aria-label="Recovered source"]')?.textContent`));
  await key('Escape');
  assert.equal(await js('document.activeElement?.textContent'), 'Recovery');
  await tabTo(`el?.tagName==='SUMMARY'&&el.textContent==='View'`);
  await key('Enter');
  await tabTo(`el?.id==='component-navigator'`);
  const opIndex = await js(
    `Array.from(document.querySelector('#component-navigator').options).findIndex(o=>o.textContent.includes(' · op · '))`,
  );
  assert(opIndex > 0);
  await key('Home');
  for (let i = 0; i < opIndex; i++) await key('ArrowDown');
  await tabTo(`el?.textContent==='Inspect component'`);
  await key('Enter');
  for (
    let i = 0;
    i < 40 &&
    !(await js(`document.activeElement?.getAttribute('aria-label')==='Component inspector'`));
    i++
  )
    await delay();
  assert.equal(
    await js(`document.activeElement?.getAttribute('aria-label')`),
    'Component inspector',
  );
  await tabTo(`el?.id==='wire-source'`);
  await key('Home');
  await key('ArrowDown');
  await tabTo(`el?.textContent==='Connect right'`);
  await key('Enter');
  assert(service.states.get(uri)?.pendingSteps, 'Keyboard wiring creates a pending transaction');
  service.discardGraphChanges(uri);
  await key('Escape');
  assert.equal(await js(`document.activeElement?.hasAttribute('data-add-component')`), true);
  await key('Enter');
  assert.equal(await js('document.activeElement?.id'), 'palette-search');
  win.webContents.insertText('mux');
  await delay();
  await key('Tab');
  assert.equal(await js('document.activeElement?.textContent'), 'mux');
  await key('Enter');
  await key('Escape');
  await tabTo(`el?.textContent==='Simulation'&&el.tagName==='BUTTON'`);
  await key('Enter');
  assert(
    (await js(`document.activeElement?.getAttribute('aria-label')`))?.startsWith(
      'Simulation input',
    ),
  );
  await tabTo(`el?.textContent==='Sample inputs'`);
  await key('Enter');
  await delay();
  assert(await js(`!!document.querySelector('svg[aria-label="Waveforms, 1 samples"]')`));
  win.webContents.debugger.attach('1.3');
  let tree;
  try {
    await win.webContents.debugger.sendCommand('Accessibility.enable');
    tree = await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
  } finally {
    win.webContents.debugger.detach();
  }
  const accessible = tree.nodes
    .filter((n: any) => !n.ignored)
    .map((n: any) => ({ role: n.role?.value, name: n.name?.value }));
  assert(accessible.some((n: any) => n.role === 'region' && n.name === 'Combinational simulation'));
  assert(accessible.some((n: any) => n.name?.startsWith('Simulation input')));
  assert(accessible.some((n: any) => n.name === 'Waveforms, 1 samples'));
  await tabTo(`el?.getAttribute('aria-label')==='Close simulation'`);
  await key('Enter');
  assert.equal(await js(`document.activeElement?.textContent`), 'Simulation');
  writeFileSync(
    join(output, 'accessibility-smoke.json'),
    JSON.stringify(
      {
        keyboard: [
          'setup modal trapping and return',
          'recovery keyboard selection and return',
          'component navigation and inspector focus',
          'wiring transaction',
          'palette search and Escape',
          'simulation sample and return',
        ],
        accessible,
        humanScreenReaderAcceptance: 'Still requires a human screen-reader session',
      },
      null,
      2,
    ),
  );
}
export async function accessibilityFixtureSmoke(
  service: SyncService,
  win: BrowserWindow,
  root: string,
) {
  const config = await service.ready();
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}`);
  await once(ws, 'open');
  const uri = pathToFileURL(join(service.workspace, 'adder.v')).href;
  ws.send(JSON.stringify({ ...config, type: 'hello', editor: 'vscode' }));
  ws.send(
    JSON.stringify({
      type: 'document.open',
      uri,
      version: 1,
      text: readFileSync(join(root, 'fixtures/adder.v'), 'utf8'),
    }),
  );
  const started = Date.now();
  while (service.states.get(uri)?.status !== 'Synced') {
    assert(Date.now() - started < 20000);
    await delay();
  }
  await accessibilitySmoke(win, service, uri, join(root, 'test-results'));
  ws.close();
}
