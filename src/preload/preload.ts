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
  getAgent: () => ipcRenderer.invoke('settings:getAgent'),
  setAgent: (id: string) => ipcRenderer.invoke('settings:setAgent', id),
  availableAgents: () => ipcRenderer.invoke('settings:availableAgents'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setBaseDir: (dir: string) => ipcRenderer.invoke('settings:setBaseDir', dir),
  getFolders: () => ipcRenderer.invoke('settings:getFolders'),
  addFolder: (path: string) => ipcRenderer.invoke('settings:addFolder', path),
  removeFolder: (path: string) => ipcRenderer.invoke('settings:removeFolder', path),
  setThresholds: (t: { freshDays: number; warnDays: number; neglectedDays: number }) => ipcRenderer.invoke('settings:setThresholds', t),
  pickFolder: () => ipcRenderer.invoke('settings:pickFolder'),
  openFolder: (path: string) => ipcRenderer.invoke('project:openFolder', path),
  openEditor: (path: string) => ipcRenderer.invoke('project:openEditor', path),
  onUpdate: (cb: (p: import('../shared/update').UpdatePayload) => void) =>
    ipcRenderer.on('devdeck:update', (_e, p) => cb(p as import('../shared/update').UpdatePayload)),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  windowControls: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggleMaximize'),
    close: () => ipcRenderer.invoke('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
    onMaximizeChange: (cb: (maximized: boolean) => void) =>
      ipcRenderer.on('win:maximize-changed', (_e, m: boolean) => cb(m)),
  },
});
