import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('devdeck', {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  projectMemory: (path: string, fresh?: boolean) => ipcRenderer.invoke('project:memory', path, fresh === true),
  setNote: (path: string, note: string) => ipcRenderer.invoke('project:setNote', path, note),
  setTodos: (path: string, todos: unknown) => ipcRenderer.invoke('project:setTodos', path, todos),
  setPinned: (path: string, pinned: boolean) => ipcRenderer.invoke('project:setPinned', path, pinned),
  setHidden: (path: string, hidden: boolean) => ipcRenderer.invoke('project:setHidden', path, hidden),
  open: (items: import('../shared/types').ProjectOpenIntent[]) => ipcRenderer.invoke('projects:open', items),
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
  addFolder: (path: string, kind?: 'root' | 'repo') => ipcRenderer.invoke('settings:addFolder', path, kind),
  removeFolder: (path: string) => ipcRenderer.invoke('settings:removeFolder', path),
  setThresholds: (t: { freshDays: number; warnDays: number; neglectedDays: number }) => ipcRenderer.invoke('settings:setThresholds', t),
  setOpenAtLogin: (enabled: boolean) => ipcRenderer.invoke('settings:setOpenAtLogin', enabled),
  pickFolder: () => ipcRenderer.invoke('settings:pickFolder'),
  openFolder: (path: string) => ipcRenderer.invoke('project:openFolder', path),
  openEditor: (path: string) => ipcRenderer.invoke('project:openEditor', path),
  openRepo: (path: string) => ipcRenderer.invoke('project:openRepo', path),
  createProject: (parent: string, name: string) => ipcRenderer.invoke('project:create', parent, name),
  setViewMode: (mode: 'cards' | 'list') => ipcRenderer.invoke('settings:setViewMode', mode),
  setCockpitSidebar: (collapsed: boolean) => ipcRenderer.invoke('settings:setCockpitSidebar', collapsed),
  setSessionSummary: (on: boolean) => ipcRenderer.invoke('settings:setSessionSummary', on),
  setAiSessionSummary: (on: boolean) => ipcRenderer.invoke('settings:setAiSessionSummary', on),
  usageSnapshot: () => ipcRenderer.invoke('usage:snapshot'),
  refreshUsageProviders: (opts?: { force?: boolean }) => ipcRenderer.invoke('usage:refresh', { force: opts?.force === true }),
  openUsageLogin: (providerId: 'claude' | 'codex', cols: number, rows: number) => ipcRenderer.invoke('usage:login', providerId, cols, rows),
  /** The machine woke from sleep: every clock-based reading over there was taken before a jump. */
  onResume: (cb: () => void) => ipcRenderer.on('devdeck:resume', () => cb()),
  onUpdate: (cb: (p: import('../shared/update').UpdatePayload) => void) =>
    ipcRenderer.on('devdeck:update', (_e, p) => cb(p as import('../shared/update').UpdatePayload)),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  setPendingAutoRestore: (sessions: unknown) => ipcRenderer.invoke('update:setPendingAutoRestore', sessions),
  consumeAutoRestore: () => ipcRenderer.invoke('update:consumeAutoRestore'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  windowControls: {
    show: () => ipcRenderer.invoke('win:show'),
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggleMaximize'),
    close: () => ipcRenderer.invoke('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
    onMaximizeChange: (cb: (maximized: boolean) => void) =>
      ipcRenderer.on('win:maximize-changed', (_e, m: boolean) => cb(m)),
  },
  clipboard: {
    writeText: (text: string) => ipcRenderer.send('clipboard:writeText', text),
    readText: (): Promise<string> => ipcRenderer.invoke('clipboard:readText'),
    readImage: (): Promise<string | null> => ipcRenderer.invoke('clipboard:readImage'),
    readImageBytes: (): Promise<{ tooLarge: boolean; bytes: string | null } | null> => ipcRenderer.invoke('clipboard:readImageBytes'),
  },
  // Diagnostics: one file per machine, readable by a person or an agent sitting at it.
  logDiagnostic: (message: string, level = 'error', source = 'renderer') =>
    ipcRenderer.send('diag:log', level, source, message),
  diagnosticsInfo: () => ipcRenderer.invoke('diag:info'),
  diagnosticsTail: (lines?: number) => ipcRenderer.invoke('diag:tail', lines ?? 400),
  revealDiagnostics: () => ipcRenderer.invoke('diag:reveal'),
  cockpit: {
    open: (req: { projectPath: string; sessionId: string | null; cols: number; rows: number; mode: import('../shared/types').OpenMode; agentId: string }) =>
      ipcRenderer.invoke('cockpit:open', req),
    input: (id: string, data: string) => ipcRenderer.send('cockpit:input', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.send('cockpit:resize', id, cols, rows),
    close: (id: string) => ipcRenderer.send('cockpit:close', id),
    onData: (cb: (p: { id: string; chunk: string }) => void) =>
      ipcRenderer.on('cockpit:data', (_e, p) => cb(p)),
    onExit: (cb: (p: { id: string; exitCode: number }) => void) =>
      ipcRenderer.on('cockpit:exit', (_e, p) => cb(p)),
    onResized: (cb: (p: { id: string; cols: number; rows: number }) => void) =>
      ipcRenderer.on('cockpit:resized', (_e, p) => cb(p)),
    liveSessions: () => ipcRenderer.invoke('cockpit:liveSessions'),
    sessionBuffer: (id: string) => ipcRenderer.invoke('cockpit:sessionBuffer', id),
    sessionScreen: (id: string) => ipcRenderer.invoke('cockpit:sessionScreen', id),
    /** Tell the machine running a session what the user named it — routed by tile id like input(). */
    noteLabel: (id: string, label: string | null) => ipcRenderer.send('cockpit:noteLabel', id, label),
    /** What is running on a machine, announced whenever it changes rather than polled. */
    onSessions: (cb: (p: { id: string; projectPath: string; sessionId: string | null; agentId: string; startedAtMs: number; label: string | null }[]) => void) =>
      ipcRenderer.on('cockpit:sessions', (_e, p) => cb(p)),
    loadSessions: () => ipcRenderer.invoke('cockpit:loadSessions'),
    saveSessions: (list: unknown) => ipcRenderer.send('cockpit:saveSessions', list),
    sessionMeta: (projectPath: string, sessionId: string, agentId?: string, wantAi?: boolean) => ipcRenderer.invoke('cockpit:sessionMeta', projectPath, sessionId, agentId, wantAi),
    sessionIds: (projectPath: string, agentId?: string) => ipcRenderer.invoke('cockpit:sessionIds', projectPath, agentId),
    sessionsExist: (items: { projectPath: string; sessionId: string | null; agentId?: string }[]) => ipcRenderer.invoke('cockpit:sessionsExist', items),
    liveSessionId: (projectPath: string, opts: { currentId: string | null; claimedIds: string[]; openedAtMs: number; sinceMs: number; lastDataAtMs: number; agentId?: string }) =>
      ipcRenderer.invoke('cockpit:liveSessionId', projectPath, opts),
    liveAgent: (id: string) => ipcRenderer.invoke('cockpit:liveAgent', id),
    gitInfo: (projectPath: string) => ipcRenderer.invoke('cockpit:gitInfo', projectPath),
    openLink: (url: string) => ipcRenderer.invoke('cockpit:openLink', url),
    openFile: (projectPath: string, filePath: string) => ipcRenderer.invoke('cockpit:openFile', projectPath, filePath),
  },
  shutdown: {
    arm: () => ipcRenderer.invoke('shutdown:arm'),
    disarm: () => ipcRenderer.invoke('shutdown:disarm'),
    now: () => ipcRenderer.invoke('shutdown:now'),
    cancel: () => ipcRenderer.invoke('shutdown:cancel'),
    status: () => ipcRenderer.invoke('shutdown:status'),
    history: () => ipcRenderer.invoke('shutdown:history'),
    clearHistory: () => ipcRenderer.invoke('shutdown:clearHistory'),
    bootBanner: () => ipcRenderer.invoke('shutdown:bootBanner'),
    ackBanner: () => ipcRenderer.invoke('shutdown:ackBanner'),
    setIdleMinutes: (m: number) => ipcRenderer.invoke('shutdown:setIdleMinutes', m),
    report: (p: { working: number; sessions: { project: string; activity: string }[] }) => ipcRenderer.send('shutdown:report', p),
    onStatus: (cb: (s: unknown) => void) => ipcRenderer.on('shutdown:status', (_e, s) => cb(s)),
  },
  /**
   * DevDeck Link.
   *
   * `machine(id)` returns the SAME deck calls, aimed at another machine. Local work keeps calling
   * `window.devdeck.*` exactly as before — the local path is untouched, so nothing about a
   * single-machine install changes — while a remote view routes the same method names over one
   * channel. Adding a deck method therefore does not mean adding an IPC channel to reach it remotely.
   */
  link: {
    hostStatus: () => ipcRenderer.invoke('link:hostStatus'),
    setHostMode: (on: boolean) => ipcRenderer.invoke('link:setHostMode', on),
    setPort: (port: number) => ipcRenderer.invoke('link:setPort', port),
    createInvite: (permissions?: string[]) => ipcRenderer.invoke('link:createInvite', permissions),
    revokeInvite: () => ipcRenderer.invoke('link:revokeInvite'),
    machines: () => ipcRenderer.invoke('link:machines'),
    addMachine: (code: string) => ipcRenderer.invoke('link:addMachine', code),
    removeMachine: (machineId: string) => ipcRenderer.invoke('link:removeMachine', machineId),
    setDevicePermissions: (fingerprint: string, permissions: string[]) => ipcRenderer.invoke('link:setDevicePermissions', fingerprint, permissions),
    revokeDevice: (fingerprint: string) => ipcRenderer.invoke('link:revokeDevice', fingerprint),
    disconnectDevice: (fingerprint: string) => ipcRenderer.invoke('link:disconnectDevice', fingerprint),
    clipboardInvite: () => ipcRenderer.invoke('link:clipboardInvite'),
    log: (limit?: number) => ipcRenderer.invoke('link:log', limit),
    clearLog: () => ipcRenderer.invoke('link:clearLog'),
    onChanged: (cb: () => void) => ipcRenderer.on('link:changed', () => cb()),
    /** What a paired machine is running, announced when it changes. Carries the machine explicitly:
     *  an empty list has no ids to read it from, and that is exactly the case that matters. */
    onSessions: (cb: (p: { machineId: string; sessions: unknown[] }) => void) =>
      ipcRenderer.on('link:sessions', (_e, p) => cb(p)),
  },
  /** Read the repository URL on the machine that holds it, open it in the browser here. */
  openRemoteRepo: (machineId: string, projectPath: string) => ipcRenderer.invoke('link:openRepo', machineId, projectPath),
  machine: (machineId: string) => ({
    listProjects: () => ipcRenderer.invoke('link:call', machineId, 'projects:list', []),
    projectMemory: (path: string, fresh?: boolean) => ipcRenderer.invoke('link:call', machineId, 'project:memory', [path, fresh === true]),
    setNote: (path: string, note: string) => ipcRenderer.invoke('link:call', machineId, 'project:setNote', [path, note]),
    setTodos: (path: string, todos: unknown) => ipcRenderer.invoke('link:call', machineId, 'project:setTodos', [path, todos]),
    setPinned: (path: string, pinned: boolean) => ipcRenderer.invoke('link:call', machineId, 'project:setPinned', [path, pinned]),
    setHidden: (path: string, hidden: boolean) => ipcRenderer.invoke('link:call', machineId, 'project:setHidden', [path, hidden]),
    usageReport: (sinceMs: number) => ipcRenderer.invoke('link:call', machineId, 'usage:report', [sinceMs]),
    usageSnapshot: () => ipcRenderer.invoke('link:call', machineId, 'usage:snapshot', []),
    getSettings: () => ipcRenderer.invoke('link:call', machineId, 'settings:get', []),
    getFolders: () => ipcRenderer.invoke('link:call', machineId, 'settings:getFolders', []),
    availableAgents: () => ipcRenderer.invoke('link:call', machineId, 'settings:availableAgents', []),
    appInfo: () => ipcRenderer.invoke('link:call', machineId, 'app:info', []),
    cockpit: {
      // Answers with an id already qualified by this machine, so every id-taking call below — and the
      // input/resize/close path in the deck API — routes itself without further bookkeeping.
      open: (req: unknown) => ipcRenderer.invoke('link:call', machineId, 'cockpit:open', [req]),
      sessionMeta: (projectPath: string, sessionId: string, agentId?: string, wantAi?: boolean) =>
        ipcRenderer.invoke('link:call', machineId, 'cockpit:sessionMeta', [projectPath, sessionId, agentId, wantAi]),
      sessionIds: (projectPath: string, agentId?: string) => ipcRenderer.invoke('link:call', machineId, 'cockpit:sessionIds', [projectPath, agentId]),
      sessionsExist: (items: unknown) => ipcRenderer.invoke('link:call', machineId, 'cockpit:sessionsExist', [items]),
      liveSessionId: (projectPath: string, opts: unknown) => ipcRenderer.invoke('link:call', machineId, 'cockpit:liveSessionId', [projectPath, opts]),
      liveAgent: (id: string) => ipcRenderer.invoke('link:call', machineId, 'cockpit:liveAgent', [id]),
      gitInfo: (projectPath: string) => ipcRenderer.invoke('link:call', machineId, 'cockpit:gitInfo', [projectPath]),
      receiveImage: (base64: string) => ipcRenderer.invoke('link:call', machineId, 'cockpit:receiveImage', [base64]),
      liveSessions: () => ipcRenderer.invoke('link:call', machineId, 'cockpit:liveSessions', []),
      sessionBuffer: (id: string) => ipcRenderer.invoke('link:call', machineId, 'cockpit:sessionBuffer', [id]),
      sessionScreen: (id: string) => ipcRenderer.invoke('link:call', machineId, 'cockpit:sessionScreen', [id]),
    },
  }),
  setTrayAlert: (mode: string) => ipcRenderer.invoke('settings:setTrayAlert', mode),
  setContextWindow: (w: number) => ipcRenderer.invoke('settings:setContextWindow', w),
  setTrayCounts: (counts: { attention?: number; turn?: number; overdue?: number }) => ipcRenderer.send('tray:counts', counts),
  setTrayAlertImage: (dataUrl: string) => ipcRenderer.send('tray:alertImage', dataUrl),
});
