// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import type { BrowserWindow } from 'electron';
import type { SyncService } from '../packages/core/service.js';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(f:()=>boolean|Promise<boolean>,timeout=20_000){const start=Date.now();while(Date.now()-start<timeout){if(await f())return;await sleep(100);}throw new Error('Desktop smoke timed out');}
export async function desktopSmoke(service:SyncService,win:BrowserWindow,root:string){
  const config=await service.ready();const ws=new WebSocket(`ws://127.0.0.1:${config.port}`);let patches=0;
  const original=readFileSync(join(root,'fixtures/adder.v'),'utf8');let live=original;let version=1;
  const uri=pathToFileURL(join(service.workspace,'adder.v')).href;
  ws.on('message',b=>{const m=JSON.parse(b.toString());if(m.type==='document.applyPatch'){assert.equal(m.baseVersion,version);for(const e of m.edits){assert.equal(e.end-e.start,1);live=live.slice(0,e.start)+e.text+live.slice(e.end);}patches++;version++;ws.send(JSON.stringify({type:'document.patchResult',uri,patchId:m.patchId,ok:true,currentVersion:version,text:live}));}});
  await new Promise(r=>ws.once('open',r));ws.send(JSON.stringify({type:'hello',...config,editor:'vscode'}));await sleep(100);
  ws.send(JSON.stringify({type:'document.open',uri,version,text:live}));
  await sleep(1000);assert.equal(service.states.get(uri)?.graph,undefined,'No early projection');
  await until(()=>!!service.states.get(uri)?.graph);
  await until(()=>win.webContents.executeJavaScript(`document.querySelectorAll('.circuit-node').length===4`));
  const op=service.states.get(uri)!.graph!.nodes.find(n=>n.kind==='op')!;
  await win.webContents.executeJavaScript(`document.querySelector('[data-id="${op.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  await until(()=>win.webContents.executeJavaScript(`!!document.querySelector('[aria-label="Replace with MUL"]')`));
  await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Replace with MUL"]').click()`);
  await sleep(1000);assert.equal(patches,0,'No early graph patch');await until(()=>patches===1);
  assert.equal(live,original.replace('a + b','a * b'));await until(()=>service.states.get(uri)?.status==='Synced');
  // Exercise the same narrow IPC command emitted at drag end, then reload the renderer.
  await win.webContents.executeJavaScript(`window.mira.command({type:'move',uri:${JSON.stringify(uri)},id:${JSON.stringify(op.id)},x:380,y:170})`);
  assert.equal(service.states.get(uri)!.layout.nodes[op.id].x,380);
  win.reload();await sleep(1000);await until(()=>win.webContents.executeJavaScript(`document.querySelectorAll('.circuit-node').length===4`));
  assert.equal(service.states.get(uri)!.layout.nodes[op.id].y,170);
  const output=join(root,'test-results');mkdirSync(output,{recursive:true});
  writeFileSync(join(output,'desktop-smoke.png'),(await win.webContents.capturePage()).toPNG());
  writeFileSync(join(output,'desktop-smoke.json'),JSON.stringify({passed:true,patches,nodes:4,realDebounceMs:15000,screenshot:'desktop-smoke.png',manualRemaining:['Physical pointer drag','Second monitor positioning']},null,2));
  ws.close();
}
