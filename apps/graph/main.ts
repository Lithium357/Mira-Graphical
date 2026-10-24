// SPDX-License-Identifier: GPL-3.0-only
import { app, BrowserWindow, ipcMain, dialog, screen, clipboard } from 'electron';
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  lstatSync,
  mkdirSync,
  statSync,
} from 'node:fs';
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
const packageCheck = app.isPackaged && process.argv.includes('--package-check');
const workspaceArgument = process.argv.find((a) => a.startsWith('--workspace='))?.slice(12);
if (packageCheck && workspaceArgument) {
  const profile = join(resolve(workspaceArgument), '.mira-test-profile');
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
}
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
      if (process.platform === 'win32') app.setAppUserModelId('com.lithium357.miragraphical');
      const preferences = join(app.getPath('userData'), 'workspace.json');
      let remembered: string | undefined;
      try {
        const saved = JSON.parse(readFileSync(preferences, 'utf8'));
        if (typeof saved.workspace === 'string' && statSync(saved.workspace).isDirectory())
          remembered = saved.workspace;
      } catch {}
      let folder = workspaceArgument ?? (app.isPackaged ? remembered : process.cwd());
      if (!folder) {
        const selection = await dialog.showOpenDialog({
          title: 'Choose your HDL project folder',
          properties: ['openDirectory'],
        });
        folder = selection.filePaths[0];
        if (!folder) {
          app.quit();
          return;
        }
      }
      const workspace = resolve(folder);
      if (!statSync(workspace).isDirectory()) throw new Error('Choose an existing project folder.');
      if (app.isPackaged && !packageCheck) {
        mkdirSync(dirname(preferences), { recursive: true });
        writeFileSync(preferences, JSON.stringify({ workspace }));
      }
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
        show: !packageCheck && !process.argv.includes('--smoke'),
        backgroundColor: '#0b1220',
        title: 'Mira Graphical',
        icon: app.isPackaged ? join(root, 'icon.ico') : undefined,
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
      ipcMain.handle('mira:command', async (event, command: unknown) => {
        if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
          throw new Error('Unauthorized renderer.');
        if (!command || typeof command !== 'object') throw new Error('Invalid command.');
        const c = command as Record<string, unknown>;
        if (c.type === 'chooseWorkspace') {
          const selection = await dialog.showOpenDialog(win, {
            title: 'Choose your HDL project folder',
            defaultPath: workspace,
            properties: ['openDirectory'],
          });
          if (selection.canceled || !selection.filePaths[0]) return;
          app.relaunch({
            args: [
              ...process.argv.slice(1).filter((a) => !a.startsWith('--workspace=')),
              `--workspace=${selection.filePaths[0]}`,
            ],
          });
          app.quit();
          return;
        }
        if (c.type === 'installCompanion') {
          const source = join(process.resourcesPath, 'companion', 'mira-graphical.vsix');
          if (!app.isPackaged || !existsSync(source))
            throw new Error('Build the companion with pnpm package:extension.');
          const { shell } = await import('electron');
          shell.showItemInFolder(source);
          return;
        }
        if (c.type === 'copyText' && typeof c.text === 'string' && c.text.length <= 1_000_000) {
          return clipboard.writeText(c.text);
        }
        if (c.type === 'snapshot')
          return {
            workspace,
            states: [...service!.states.values()],
            editorConnected: service!.editorConnected,
            packaged: app.isPackaged,
          };
        if (c.type === 'recoveryList') return service!.recovery.list();
        if (c.type === 'recoveryRead' && typeof c.id === 'string')
          return service!.recovery.inspect(c.id);
        if (
          c.type === 'recoveryOpen' &&
          typeof c.id === 'string' &&
          typeof c.preview === 'boolean' &&
          typeof c.compare === 'boolean' &&
          typeof c.expectedHash === 'string' &&
          /^[a-f0-9]{64}$/.test(c.expectedHash)
        )
          return service!.openRecovery(c.id, c.preview, c.compare, c.expectedHash);
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
        else if (c.type === 'autoLayout') service!.autoLayout(c.uri);
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
          return service!.simulate(c.uri, c.inputs as Record<string, string>, c.reset === true);
        else if (c.type === 'discard') service!.discardGraphChanges(c.uri);
        else throw new Error('Unsupported graph command.');
      });
      service.subscribe((states) => {
        if (!win.isDestroyed()) win.webContents.send('mira:states', states);
      });
      await win.loadFile(join(root, 'apps/graph/dist/index.html'));
      if (packageCheck) {
        const { checkPackagedApp } = await import('./package-check.js');
        await checkPackagedApp(service, win, workspace);
        app.quit();
      } else if (!process.argv.includes('--smoke')) win.show();
      if (process.env.MIRA_SMOKE_BUILD !== 'false' && process.argv.includes('--smoke')) {
        const { desktopSmoke } = await import('../../scripts/desktop-smoke.js');
        try {
          if (process.argv.includes('--accessibility-only')) {
            const { accessibilityFixtureSmoke } =
              await import('../../scripts/accessibility-smoke.js');
            await accessibilityFixtureSmoke(service, win, root);
          } else await desktopSmoke(service, win, root);
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
      if (packageCheck && workspaceArgument) {
        writeFileSync(
          join(resolve(workspaceArgument), 'package-check.json'),
          JSON.stringify({ passed: false, error: String(error) }),
        );
        app.exit(1);
        return;
      }
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
