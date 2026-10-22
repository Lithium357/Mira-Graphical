// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { SyncService, loadLayout } from '../packages/core/service.js';
import type { Clock } from '../packages/core/index.js';
test('authenticated protocol: shared buffer → graph → patch ACK, scope and origin protection',async()=> {
  const root=mkdtempSync(join(tmpdir(),'mira-test-')); let now=0; let job: (()=>void)|undefined;
  const clock: Clock={now:()=>now,set:f=>{job=f;return 1;},clear:()=>{job=undefined;}};
  const service=new SyncService(root,clock); const config=await service.ready();
  const ws=new WebSocket(`ws://127.0.0.1:${config.port}`); const messages:any[]=[]; ws.on('message',b=>messages.push(JSON.parse(b.toString())));
  const wait=async(f:()=>boolean)=>{for(let i=0;i<100;i++){if(f())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Protocol event timed out');};
  const send=(m:unknown)=>ws.send(JSON.stringify(m));
  try {
    await new Promise(r=>ws.once('open',r)); send({type:'hello',...config,editor:'vscode'}); await wait(()=>messages.some(m=>m.type==='hello.ok'));
    const uri=pathToFileURL(join(root,'adder.v')).href; const text=readFileSync('fixtures/adder.v','utf8');
    send({type:'document.open',uri,version:1,text}); await wait(()=>service.sessions.has(uri)); assert(!service.states.get(uri)?.graph);
    now=15000; job!(); const graph=service.states.get(uri)!.graph!; const op=graph.nodes.find(n=>n.kind==='op')!;
    service.graphEdit(uri,op.id,'*'); now+=15000; job!(); await wait(()=>messages.some(m=>m.type==='document.applyPatch'));
    const patch=messages.find(m=>m.type==='document.applyPatch'); assert.equal(patch.edits.length,1); assert.equal(patch.edits[0].end-patch.edits[0].start,1);
    send({type:'document.patchResult',uri,patchId:patch.patchId,ok:true,currentVersion:2,text:text.replace('a + b','a * b')}); await wait(()=>service.states.get(uri)?.version===2); assert.equal(service.states.get(uri)?.status,'Synced');
    service.move(uri,op.id,315,172);const file=readdirSync(join(root,'.hdlgraph')).find(n=>n.startsWith('layout-'))!;const stored=loadLayout(join(root,'.hdlgraph',file))!;assert.equal(stored.nodes[op.id].x,315);assert.equal(stored.identities[op.key],op.id);
    send({type:'document.change',uri,version:3,text,origin:'sync'}); await wait(()=>messages.some(m=>m.error?.includes('Unsolicited'))); assert.equal(service.states.get(uri)?.version,2);
    send({type:'document.open',uri:pathToFileURL(join(root,'..','outside.v')).href,version:1,text}); await wait(()=>messages.some(m=>m.error?.includes('inside'))); assert.equal(service.sessions.size,1);
  } finally { ws.terminate(); await service.close(); rmSync(root,{recursive:true,force:true}); }
});
test('wrong authentication and malformed messages never open sessions',async()=> {
  const root=mkdtempSync(join(tmpdir(),'mira-auth-')); const s=new SyncService(root); const config=await s.ready(false);
  const ws=new WebSocket(`ws://127.0.0.1:${config.port}`);
  try { await new Promise(r=>ws.once('open',r)); const closed=new Promise(r=>ws.once('close',r)); ws.send(JSON.stringify({type:'hello',...config,token:'wrong',editor:'vscode'})); await closed; assert.equal(s.sessions.size,0); }
  finally { await s.close(); rmSync(root,{recursive:true,force:true}); }
});
