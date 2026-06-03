import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('devdeck', {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  setNote: (path: string, note: string) => ipcRenderer.invoke('project:setNote', path, note),
  setPinned: (path: string, pinned: boolean) => ipcRenderer.invoke('project:setPinned', path, pinned),
  setHidden: (path: string, hidden: boolean) => ipcRenderer.invoke('project:setHidden', path, hidden),
  open: (paths: string[]) => ipcRenderer.invoke('projects:open', paths),
  onError: (cb: (msg: string) => void) =>
    ipcRenderer.on('devdeck:error', (_e, msg: string) => cb(msg)),
});
