import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('devdeck', {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  setNote: (path: string, note: string) => ipcRenderer.invoke('project:setNote', path, note),
  setPinned: (path: string, pinned: boolean) => ipcRenderer.invoke('project:setPinned', path, pinned),
  setHidden: (path: string, hidden: boolean) => ipcRenderer.invoke('project:setHidden', path, hidden),
  open: (items: { path: string; sessionId: string | null }[]) => ipcRenderer.invoke('projects:open', items),
  onError: (cb: (msg: string) => void) =>
    ipcRenderer.on('devdeck:error', (_e, msg: string) => cb(msg)),
  usageReport: (sinceMs: number) => ipcRenderer.invoke('usage:report', sinceMs),
  getLanguage: () => ipcRenderer.invoke('settings:getLanguage'),
  setLanguage: (lang: string) => ipcRenderer.invoke('settings:setLanguage', lang),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setBaseDir: (dir: string) => ipcRenderer.invoke('settings:setBaseDir', dir),
  setThresholds: (t: { freshDays: number; warnDays: number; neglectedDays: number }) => ipcRenderer.invoke('settings:setThresholds', t),
  pickFolder: () => ipcRenderer.invoke('settings:pickFolder'),
});
