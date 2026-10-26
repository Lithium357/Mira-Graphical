// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import type { BrowserWindow } from 'electron';
import type { SyncService } from '../../packages/core/service.js';
import { APP_VERSION } from '../../packages/protocol/version.js';
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
    {
      ext: 'clocked.v',
      text: "module counter(input clk,reset,output reg [7:0] y);always @(posedge clk or posedge reset) if(reset) y<=8'd0;else y<=y+8'd1;endmodule",
    },
    {
      ext: 'native-clocked.vhd',
      text: "library ieee;use ieee.std_logic_1164.all;use ieee.numeric_std.all;entity counter is port(clk,reset:in std_logic;y:out unsigned(7 downto 0));end entity;architecture rtl of counter is begin process(clk,reset) begin if reset='1' then y<=to_unsigned(0,8);elsif rising_edge(clk) then y<=y+to_unsigned(1,8);end if;end process;end architecture;",
    },
    {
      ext: 'hierarchy.sv',
      text: "module parent(input clk,reset,output [7:0] y);leaf c(.clk(clk),.reset(reset),.y(y));endmodule module leaf(input clk,reset,output reg [7:0] y);always @(posedge clk or posedge reset) if(reset)y<=8'd0;else case(y[1:0]) 2'd0:y<=8'd1;default:y<=y+8'd1;endcase endmodule",
    },
    {
      ext: 'enum.sv',
      text: 'module counter(input clk,reset,output wire [7:0] y);typedef enum logic[7:0]{IDLE,RUN} state_t;state_t state;always_ff @(posedge clk or posedge reset)if(reset)state<=IDLE;else case(state)IDLE:state<=RUN;default:state<=RUN;endcase assign y=state;endmodule',
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
  for (const uri of [...service.states.keys()].filter(
    (uri) => !service.states.get(uri)?.graph?.sequential,
  ))
    assert.equal(
      service.simulate(uri, { a: '2', b: '3' }).signals.y.value,
      uri.endsWith('alu.v') ? '0xef' : uri.endsWith('signed.v') ? '0x01' : '0x05',
    );
  const signedURI = pathToFileURL(join(workspace, 'check.signed.v')).href;
  assert.equal(service.simulate(signedURI, { a: '128', b: '1' }).signals.y.value, '0xc0');
  for (const uri of [...service.states.keys()].filter(
    (uri) => service.states.get(uri)?.graph?.sequential,
  )) {
    assert.equal(service.simulate(uri, { clk: '0', reset: '1' }).signals.y.value, '0x00');
    service.simulate(uri, { clk: '0', reset: '0' });
    assert.equal(service.simulate(uri, { clk: '1', reset: '0' }).signals.y.value, '0x01');
    assert.equal(service.simulate(uri, { clk: '1', reset: '0' }).signals.y.value, '0x01');
  }
  const snapshot = await win.webContents.executeJavaScript(
    `window.mira.command({type:'snapshot'})`,
  );
  assert.equal(snapshot.workspace, workspace);
  assert.equal(snapshot.version, APP_VERSION);
  assert(
    await win.webContents.executeJavaScript(
      `typeof process==='undefined' && typeof require==='undefined'`,
    ),
    'Packaged renderer must not expose Node globals',
  );
  assert(!process.argv.includes('--no-sandbox'));
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
        clockedSimulation: true,
        clockedHierarchy: true,
        clockedVhdl: true,
        enumFSM: true,
        platform: process.platform,
        version: APP_VERSION,
        nodeIsolation: true,
      },
      null,
      2,
    ),
  );
  ws.close();
}
