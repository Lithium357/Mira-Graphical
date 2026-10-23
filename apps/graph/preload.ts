// SPDX-License-Identifier: GPL-3.0-only
import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('mira', {
  command: (command: unknown) => ipcRenderer.invoke('mira:command', command),
  subscribe: (callback: (states: unknown) => void) => {
    const listener = (_event: unknown, states: unknown) => callback(states);
    ipcRenderer.on('mira:states', listener);
    return () => ipcRenderer.removeListener('mira:states', listener);
  },
});
