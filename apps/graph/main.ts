// SPDX-License-Identifier: GPL-3.0-only
import { app, BrowserWindow, ipcMain, dialog, screen, clipboard } from 'electron';
import { readFileSync, writeFileSync, renameSync, existsSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { SyncService } from '../../packages/core/service.js';
import {
  operators,
  type Operator,
  type GraphChange,
  type CircuitAction,
} from '../../packages/protocol/index.js';
import { restoreBounds } from './window-state.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
let service: SyncService | undefined;
let window: BrowserWindow | undefined;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      const workspace = resolve(
        process.argv.find((a) => a.startsWith('--workspace='))?.slice(12) ?? process.cwd(),
      );
      service = new SyncService(workspace);
      await service.ready();
      const windowFile = join(service.metadata, 'window.json');
      let saved: unknown;
      try {
        if (!lstatSync(windowFile).isSymbolicLink())
          saved = JSON.parse(readFileSync(windowFile, 'utf8'));
      } catch {}
      const restored = restoreBounds(
        saved,
        screen.getAllDisplays().map((d) => d.workArea),
      );
      const available = screen.getPrimaryDisplay().workArea;
      window = new BrowserWindow({
        width: Math.min(1320, available.width),
        height: Math.min(860, available.height),
        ...restored,
        minWidth: Math.min(900, available.width),
        minHeight: Math.min(600, available.height),
        show: !process.argv.includes('--smoke'),
        backgroundColor: '#0b1220',
        title: 'Mira Graphical',
        webPreferences: {
          // Smoke runs keep pane preferences and browser storage out of the user's session.
          partition: process.argv.includes('--smoke') ? 'mira-smoke' : undefined,
          preload: join(root, 'dist/apps/graph/preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      const win = window;
      if (restored.maximized) win.maximize();
      const saveWindow = () => {
        try {
          if (existsSync(windowFile) && lstatSync(windowFile).isSymbolicLink()) return;
          const temp = windowFile + '.tmp';
          if (existsSync(temp) && lstatSync(temp).isSymbolicLink()) return;
          writeFileSync(
            temp,
            JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }),
            { mode: 0o600 },
          );
          renameSync(temp, windowFile);
        } catch (error) {
          console.warn('Window position could not be saved:', String(error));
        }
      };
      win.on('close', saveWindow);
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event) => event.preventDefault());
      ipcMain.handle('mira:command', (event, command: unknown) => {
        if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
          throw new Error('Unauthorized renderer.');
        if (!command || typeof command !== 'object') throw new Error('Invalid command.');
        const c = command as Record<string, unknown>;
        if (c.type === 'copyText' && typeof c.text === 'string' && c.text.length <= 1_000_000) {
          clipboard.writeText(c.text);
          return;
        }
        if (c.type === 'snapshot') return { workspace, states: [...service!.states.values()] };
        if (typeof c.uri !== 'string' || !service!.sessions.has(c.uri))
          throw new Error('Document not shared.');
        if (c.type === 'edit' && typeof c.id === 'string' && operators.includes(c.op as Operator))
          service!.graphEdit(c.uri, c.id, c.op as Operator);
        else if (
          c.type === 'change' &&
          typeof c.id === 'string' &&
          ['literal', 'slice', 'selector'].includes(String(c.kind)) &&
          typeof c.value === 'string' &&
          c.value.length <= 8192
        )
          service!.graphChange(c.uri, c.id, {
            kind: c.kind as GraphChange['kind'],
            value: c.value,
          });
        else if (
          c.type === 'move' &&
          typeof c.id === 'string' &&
          typeof c.x === 'number' &&
          typeof c.y === 'number'
        )
          service!.move(c.uri, c.id, c.x, c.y);
        else if (
          c.type === 'viewport' &&
          typeof c.x === 'number' &&
          typeof c.y === 'number' &&
          typeof c.zoom === 'number'
        )
          service!.viewport(c.uri, { x: c.x, y: c.y, zoom: c.zoom });
        else if (c.type === 'circuit' && c.action && typeof c.action === 'object')
          return service!.circuitAction(c.uri, c.action as CircuitAction);
        else if (c.type === 'history' && (c.direction === 'undo' || c.direction === 'redo'))
          service!.constructionHistory(c.uri, c.direction);
        else if (
          c.type === 'importModule' &&
          typeof c.fromUri === 'string' &&
          typeof c.name === 'string'
        )
          return service!.importModule(c.uri, c.fromUri, c.name);
        else if (c.type === 'module' && typeof c.name === 'string')
          service!.selectModule(c.uri, c.name);
        else if (
          c.type === 'copy' &&
          Array.isArray(c.ids) &&
          c.ids.every((id) => typeof id === 'string')
        )
          return service!.copy(c.uri, c.ids);
        else if (c.type === 'simulate' && c.inputs && typeof c.inputs === 'object')
          return service!.simulate(c.uri, c.inputs as Record<string, string>);
        else if (c.type === 'discard') service!.discardGraphChanges(c.uri);
        else throw new Error('Unsupported graph command.');
      });
      service.subscribe((states) => {
        if (!win.isDestroyed()) win.webContents.send('mira:states', states);
      });
      await win.loadFile(join(root, 'apps/graph/dist/index.html'));
      if (!process.argv.includes('--smoke')) win.show();
      if (process.argv.includes('--smoke')) {
        const { desktopSmoke } = await import('../../scripts/desktop-smoke.js');
        try {
          await desktopSmoke(service, win, root);
          console.log('DESKTOP SMOKE PASSED');
          app.quit();
        } catch (error) {
          console.error(error);
          try {
            writeFileSync(
              join(root, 'test-results/smoke-failure.png'),
              (await win.webContents.capturePage()).toPNG(),
            );
            console.error(
              'SMOKE UI',
              await win.webContents.executeJavaScript(
                `({text:document.body.innerText,viewport:document.querySelector('.react-flow__viewport')?.style.transform,handles:Array.from(document.querySelectorAll('.react-flow__handle')).map(h=>{const r=h.getBoundingClientRect();return {node:h.closest('[data-id]')?.getAttribute('data-id'),class:h.className,rect:r.toJSON(),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,350)};})})`,
              ),
            );
          } catch {}
          process.exitCode = 1;
          app.exit(1);
        }
      }
    })
    .catch((error) => {
      dialog.showErrorBox('Mira Graphical could not start', String(error));
      app.quit();
    });
  let stopping = false;
  app.on('before-quit', (event) => {
    if (service && !stopping) {
      event.preventDefault();
      stopping = true;
      void service.close().finally(() => app.quit());
    }
  });
  app.on('window-all-closed', () => app.quit());
}
