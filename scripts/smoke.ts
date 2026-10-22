// SPDX-License-Identifier: GPL-3.0-only
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, createWriteStream } from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runTests } from '@vscode/test-electron';
import { createRequire } from 'node:module';
import { SyncService } from '../packages/core/service.js';
const root=process.cwd();const output=join(root,'test-results');mkdirSync(output,{recursive:true});
const stamp=Date.now();const workspace=join(output,`smoke-workspace-${stamp}`);mkdirSync(workspace);writeFileSync(join(workspace,'adder.v'),readFileSync('fixtures/adder.v'));
const electron=createRequire(import.meta.url)('electron') as string;
async function launch(exe:string,args:string[],env=process.env){
  return await new Promise<void>((ok,fail)=>{const child=spawn(exe,args,{cwd:root,env,stdio:'inherit',windowsHide:true});const timer=setTimeout(()=>{child.kill();fail(new Error('Smoke process exceeded 120 seconds'));},120000);child.on('error',e=>{clearTimeout(timer);fail(e);});child.on('exit',code=>{clearTimeout(timer);code===0?ok():fail(new Error(`Smoke process exited ${code}`));});});
}
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
await launch(electron,['.','--smoke',`--workspace=${workspace}`],env);
const service=new SyncService(workspace);await service.ready();let edited=false;
service.subscribe(states=>{const s=states[0];if(!s)return;writeFileSync(join(workspace,'.hdlgraph','smoke-state.json'),JSON.stringify({version:s.version,status:s.status,op:s.graph?.nodes.find(n=>n.kind==='op')?.op}));if(!edited && s.status==='Synced' && s.graph){edited=true;const op=s.graph.nodes.find(n=>n.kind==='op')!;assert.equal(op.op,'-','Graph must reflect the unsaved operator');assert(service.sessions.get(s.uri)!.text.includes('unsaved smoke checkpoint'));service.graphEdit(s.uri,op.id,'*');}});
try{
  const userData=join(output,`vscode-user-${stamp}`);mkdirSync(join(userData,'User'),{recursive:true});writeFileSync(join(userData,'User/settings.json'),JSON.stringify({'telemetry.telemetryLevel':'off','update.mode':'none','extensions.autoUpdate':false,'workbench.startupEditor':'none'}));
  const log=createWriteStream(join(output,'vscode-smoke.log'));
  try {await runTests({vscodeExecutablePath:process.env.MIRA_CODE_EXE,extensionDevelopmentPath:join(root,'extensions/vscode'),extensionTestsPath:join(root,'extensions/vscode/dist/smoke.cjs'),extensionTestsEnv:env,stdout:log,stderr:log,launchArgs:[workspace,`--user-data-dir=${userData}`,`--extensions-dir=${join(output,'vscode-extensions')}`,'--disable-extensions','--disable-workspace-trust','--skip-welcome','--skip-release-notes','--disable-updates']});}finally{log.end();}
  const result=JSON.parse(readFileSync(join(workspace,'.hdlgraph/vscode-smoke-result.json'),'utf8'));if(!result.passed)throw new Error('VS Code smoke did not pass');
  writeFileSync(join(output,'vscode-smoke.json'),JSON.stringify(result,null,2));console.log('VS CODE SMOKE PASSED: unsaved buffer, minimal patch, native undo, disk unchanged.');
}finally{await service.close();}
