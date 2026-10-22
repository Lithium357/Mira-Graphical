// SPDX-License-Identifier: GPL-3.0-only
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { SyncService } from '../../packages/core/service.js';
import { operators, type Operator } from '../../packages/protocol/index.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
let service: SyncService | undefined;
let window: BrowserWindow | undefined;
if(!app.requestSingleInstanceLock())app.quit();
else {
  app.on('second-instance',()=>{window?.show();window?.focus();});
  app.whenReady().then(async()=>{
    const workspace=resolve(process.argv.find(a=>a.startsWith('--workspace='))?.slice(12) ?? process.cwd());
    service=new SyncService(workspace);await service.ready();
    window=new BrowserWindow({width:1320,height:860,minWidth:900,minHeight:600,show:!process.argv.includes('--smoke'),backgroundColor:'#0b1220',title:'Mira Graphical',webPreferences:{preload:join(root,'dist/apps/graph/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    const win=window;
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',event=>event.preventDefault());
    ipcMain.handle('mira:command',(event,command:unknown)=>{
      if(event.sender!==win.webContents || event.senderFrame!==win.webContents.mainFrame)throw new Error('Unauthorized renderer.');
      if(!command || typeof command!=='object')throw new Error('Invalid command.');
      const c=command as Record<string,unknown>;
      if(c.type==='snapshot')return {workspace,states:[...service!.states.values()]};
      if(typeof c.uri!=='string' || !service!.sessions.has(c.uri))throw new Error('Document not shared.');
      if(c.type==='edit' && typeof c.id==='string' && operators.includes(c.op as Operator))service!.graphEdit(c.uri,c.id,c.op as Operator);
      else if(c.type==='move' && typeof c.id==='string' && typeof c.x==='number' && typeof c.y==='number')service!.move(c.uri,c.id,c.x,c.y);
      else if(c.type==='viewport' && typeof c.x==='number' && typeof c.y==='number' && typeof c.zoom==='number')service!.viewport(c.uri,{x:c.x,y:c.y,zoom:c.zoom});
      else throw new Error('Unsupported graph command.');
    });
    service.subscribe(states=>{if(!win.isDestroyed())win.webContents.send('mira:states',states);});
    await win.loadFile(join(root,'apps/graph/dist/index.html'));
    if(process.argv.includes('--smoke')) {
      const {desktopSmoke}=await import('../../scripts/desktop-smoke.js');
      try { await desktopSmoke(service,win,root); console.log('DESKTOP SMOKE PASSED'); app.quit(); }
      catch(error) { console.error(error); process.exitCode=1; app.exit(1); }
    }
  }).catch(error=>{dialog.showErrorBox('Mira Graphical could not start',String(error));app.quit();});
  let stopping=false;
  app.on('before-quit',event=>{if(service && !stopping){event.preventDefault();stopping=true;void service.close().finally(()=>app.quit());}});
  app.on('window-all-closed',()=>app.quit());
}
