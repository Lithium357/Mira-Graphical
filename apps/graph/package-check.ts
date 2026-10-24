// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import type { BrowserWindow } from 'electron';
import type { SyncService } from '../../packages/core/service.js';
export async function checkPackagedApp(
  service: SyncService,
  win: BrowserWindow,
  workspace: string,
) {
  const config = await service.ready();
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}`);
  await new Promise<void>((ok, fail) => {
    ws.once('open', ok);
    ws.once('error', fail);
  });
  const documents = [
    {
      ext: 'v',
      text: 'module adder(input [7:0] a, b, output [7:0] y); assign y = a + b; endmodule',
    },
    {
      ext: 'sv',
      text: 'module adder(input logic [7:0] a, b, output logic [7:0] y); always_comb y = a + b; endmodule',
    },
    {
      ext: 'vhd',
      text: 'library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all; entity adder is port(a,b: in unsigned(7 downto 0); y: out unsigned(7 downto 0)); end entity; architecture rtl of adder is begin y <= a + b; end architecture;',
    },
    {
      ext: 'alu.v',
      text: "module adder(input [7:0] a,b,output [7:0] y);assign y=(a==8'd2)?~(a<<b):(a>>b);endmodule",
    },
    {
      ext: 'signed.v',
      text: "module adder(input [7:0] a,b,output [7:0] y);assign y=(a==8'd2)?($signed(a)<$signed(b)):$unsigned($signed(a)>>>b);endmodule",
    },
  ];
  ws.send(JSON.stringify({ ...config, type: 'hello', editor: 'vscode' }));
  for (const document of documents)
    ws.send(
      JSON.stringify({
        type: 'document.open',
        uri: pathToFileURL(join(workspace, `check.${document.ext}`)).href,
        version: 1,
        text: document.text,
      }),
    );
  const start = Date.now();
  while (
    [...service.states.values()].filter((s) => s.status === 'Synced').length !== documents.length
  ) {
    assert(
      Date.now() - start < 25000,
      JSON.stringify(
        [...service.states.values()].map((s) => ({ status: s.status, diagnostics: s.diagnostics })),
      ),
    );
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const uri of service.states.keys())
    assert.equal(
      service.simulate(uri, { a: '2', b: '3' }).signals.y.value,
      uri.endsWith('alu.v') ? '0xef' : uri.endsWith('signed.v') ? '0x01' : '0x05',
    );
  const signedURI = pathToFileURL(join(workspace, 'check.signed.v')).href;
  assert.equal(service.simulate(signedURI, { a: '128', b: '1' }).signals.y.value, '0xc0');
  const snapshot = await win.webContents.executeJavaScript(
    `window.mira.command({type:'snapshot'})`,
  );
  assert.equal(snapshot.workspace, workspace);
  assert.equal(snapshot.states.length, documents.length);
  const firstURI = pathToFileURL(join(workspace, 'check.v')).href;
  await win.webContents.executeJavaScript(
    `(()=>{const s=document.querySelector('[aria-label="Shared module"]');s.value=${JSON.stringify(firstURI)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  const deadline = Date.now() + 5000;
  while (
    !(await win.webContents.executeJavaScript(
      `document.querySelectorAll('.circuit-node').length===4`,
    ))
  ) {
    assert(Date.now() < deadline, 'Packaged renderer did not render the circuit');
    await new Promise((r) => setTimeout(r, 100));
  }
  writeFileSync(
    join(workspace, 'package-check.json'),
    JSON.stringify(
      {
        passed: true,
        packaged: true,
        languages: documents.map((d) => d.ext),
        renderer: true,
        preloadIPC: true,
        simulation: true,
      },
      null,
      2,
    ),
  );
  ws.close();
}
