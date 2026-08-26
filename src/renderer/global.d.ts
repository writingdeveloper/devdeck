import type { ProjectViewModel } from '../shared/types';

declare global {
  interface Window {
    devdeck: {
      listProjects(): Promise<ProjectViewModel[]>;
      projectMemory(path: string, fresh?: boolean): Promise<import('../shared/types').ProjectMemory>;
      setNote(path: string, note: string): Promise<void>;
      setTodos(path: string, todos: import('../shared/tasks').Todo[]): Promise<void>;
      setPinned(path: string, pinned: boolean): Promise<void>;
      setHidden(path: string, hidden: boolean): Promise<void>;
      open(items: import('../shared/types').ProjectOpenIntent[]): Promise<void>;
      onError(cb: (msg: string) => void): void;
      usageReport(sinceMs: number): Promise<import('../shared/types').UsageReport>;
      getLanguage(): Promise<string>;
      setLanguage(lang: string): Promise<void>;
      getAgent(): Promise<import('../shared/types').AgentId>;
      setAgent(id: string): Promise<void>;
      availableAgents(): Promise<import('../shared/types').AgentId[]>;
      getSettings(): Promise<{ baseDir: string; thresholds: { freshDays: number; warnDays: number; neglectedDays: number }; language: string; openAtLogin: boolean; platform: string; osRelease: string; ptyAvailable: boolean; viewMode: 'cards' | 'list'; trayAlert: 'off' | 'attention' | 'all'; contextWindow: number; shutdownIdleMinutes: number; cockpitSidebarCollapsed: boolean; sessionSummary: boolean; aiSessionSummary: boolean }>;
      link: {
        hostStatus(): Promise<import('../main/link/linkService').HostStatus>;
        setHostMode(on: boolean): Promise<import('../main/link/linkService').HostStatus>;
        setPort(port: number): Promise<import('../main/link/linkService').HostStatus>;
        createInvite(permissions?: import('../shared/link/permissions').LinkPermission[]): Promise<import('../main/link/linkService').HostStatus>;
        revokeInvite(): Promise<import('../main/link/linkService').HostStatus>;
        machines(): Promise<import('../main/link/linkService').MachineStatus[]>;
        addMachine(code: string): Promise<
          | { ok: true; machine: import('../main/link/linkService').MachineStatus }
          | { ok: false; problem: import('../main/link/inviteCode').InviteProblem | 'dial'; failure?: import('../main/link/clientLink').DialFailure }>;
        removeMachine(machineId: string): Promise<void>;
        setDevicePermissions(fingerprint: string, permissions: import('../shared/link/permissions').LinkPermission[]): Promise<void>;
        revokeDevice(fingerprint: string): Promise<void>;
        disconnectDevice(fingerprint: string): Promise<void>;
        clipboardInvite(): Promise<{ code: string; machineName: string } | null>;
        log(limit?: number): Promise<import('../main/link/hostServer').HostLogEntry[]>;
        clearLog(): Promise<void>;
        onChanged(cb: () => void): void;
        onSessions(cb: (p: { machineId: string; sessions: import('../main/ptyHost').PtySessionInfo[] }) => void): void;
      };
      openRemoteRepo(machineId: string, projectPath: string): Promise<void>;
      /** The same deck calls, aimed at a paired machine. Local work keeps using the top-level calls. */
      machine(machineId: string): {
        listProjects(): Promise<ProjectViewModel[]>;
        projectMemory(path: string, fresh?: boolean): Promise<import('../shared/types').ProjectMemory>;
        setNote(path: string, note: string): Promise<void>;
        setTodos(path: string, todos: import('../shared/tasks').Todo[]): Promise<void>;
        setPinned(path: string, pinned: boolean): Promise<void>;
        setHidden(path: string, hidden: boolean): Promise<void>;
        usageReport(sinceMs: number): Promise<import('../shared/types').UsageReport>;
        usageSnapshot(): Promise<unknown>;
        getSettings(): Promise<unknown>;
        getFolders(): Promise<import('../shared/types').Folder[]>;
        availableAgents(): Promise<import('../shared/types').AgentId[]>;
        appInfo(): Promise<{ version: string; electron: string; repoUrl: string; packaged: boolean; machineId: string; machineName: string }>;
        cockpit: {
          open(req: { projectPath: string; sessionId: string | null; cols: number; rows: number; mode: import('../shared/types').OpenMode; agentId: string }): Promise<{ id: string; agentId: import('../shared/types').AgentId; sessionId: string | null }>;
          sessionMeta(projectPath: string, sessionId: string, agentId?: string, wantAi?: boolean): Promise<unknown>;
          sessionIds(projectPath: string, agentId?: string): Promise<string[]>;
          sessionsExist(items: { projectPath: string; sessionId: string | null; agentId?: string }[]): Promise<boolean[]>;
          liveSessionId(projectPath: string, opts: unknown): Promise<string | null>;
          liveAgent(id: string): Promise<import('../shared/types').AgentId | null>;
          gitInfo(projectPath: string): Promise<{ branch: string | null; dirty: number } | null>;
          receiveImage(base64: string): Promise<string | null>;
          liveSessions(): Promise<import('../main/ptyHost').PtySessionInfo[]>;
          sessionBuffer(id: string): Promise<string>;
          sessionScreen(id: string): Promise<{ data: string; cols: number; rows: number }>;
        };
      };
      setTrayAlert(mode: 'off' | 'attention' | 'all'): Promise<void>;
      setContextWindow(w: number): Promise<void>;
      setTrayCounts(counts: { attention?: number; turn?: number; overdue?: number }): void;
      setTrayAlertImage(dataUrl: string): void;
      setBaseDir(dir: string): Promise<void>;
      getFolders(): Promise<import('../shared/types').Folder[]>;
      /** `kind` omitted ⇒ auto-detect (a `.git` in the folder makes it a single project). */
      addFolder(path: string, kind?: import('../shared/types').Folder['kind']): Promise<import('../shared/types').Folder[]>;
      removeFolder(path: string): Promise<import('../shared/types').Folder[]>;
      setThresholds(t: { freshDays: number; warnDays: number; neglectedDays: number }): Promise<void>;
      setOpenAtLogin(enabled: boolean): Promise<void>;
      pickFolder(): Promise<string | null>;
      openFolder(path: string): Promise<void>;
      openEditor(path: string): Promise<void>;
      openRepo(path: string): Promise<void>;
      createProject(parent: string, name: string): Promise<import('../main/createProject').CreateProjectResult>;
      setViewMode(mode: 'cards' | 'list'): Promise<void>;
      setCockpitSidebar(collapsed: boolean): Promise<void>;
      setSessionSummary(on: boolean): Promise<void>;
      setAiSessionSummary(on: boolean): Promise<void>;
      usageSnapshot(): Promise<import('../shared/usageWindows').UsageSnapshot | null>;
      refreshUsageProviders(opts?: { force?: boolean }): Promise<import('../shared/usageWindows').UsageSnapshot>;
      openUsageLogin(providerId: 'claude' | 'codex', cols: number, rows: number): Promise<{ id: string; providerId: 'claude' | 'codex' } | null>;
      onResume: (cb: () => void) => void;
      onUpdate(cb: (p: import('../shared/update').UpdatePayload) => void): void;
      downloadUpdate(): Promise<void>;
      installUpdate(): Promise<void>;
      setPendingAutoRestore(sessions: import('../shared/cockpitPersist').PersistedSession[]): Promise<void>;
      consumeAutoRestore(): Promise<import('../shared/cockpitPersist').PersistedSession[]>;
      getAppInfo(): Promise<{ version: string; electron: string; repoUrl: string; packaged: boolean; machineId: string; machineName: string }>;
      openExternal(url: string): Promise<void>;
      checkForUpdates(): Promise<void>;
      windowControls: {
        show(): Promise<void>;
        minimize(): Promise<void>;
        toggleMaximize(): Promise<void>;
        close(): Promise<void>;
        isMaximized(): Promise<boolean>;
        onMaximizeChange(cb: (maximized: boolean) => void): void;
      };
      logDiagnostic(message: string, level?: 'error' | 'warn' | 'info', source?: string): void;
      diagnosticsInfo(): Promise<{ path: string | null; bytes: number }>;
      diagnosticsTail(lines?: number): Promise<string>;
      revealDiagnostics(): Promise<boolean>;
      clipboard: {
        writeText(text: string): void;
        readText(): Promise<string>;
        readImage(): Promise<string | null>;
        readImageBytes(): Promise<{ tooLarge: boolean; bytes: string | null } | null>;
      };
      cockpit: {
        open(req: { projectPath: string; sessionId: string | null; cols: number; rows: number; mode: import('../shared/types').OpenMode; agentId: import('../shared/types').AgentId }): Promise<{ id: string; agentId: import('../shared/types').AgentId; sessionId: string | null }>;
        input(id: string, data: string): void;
        resize(id: string, cols: number, rows: number): void;
        close(id: string): void;
        onData(cb: (p: { id: string; chunk: string }) => void): void;
        onExit(cb: (p: { id: string; exitCode: number }) => void): void;
        onResized(cb: (p: { id: string; cols: number; rows: number }) => void): void;
        liveSessions(): Promise<import('../main/ptyHost').PtySessionInfo[]>;
        sessionBuffer(id: string): Promise<string>;
          sessionScreen(id: string): Promise<{ data: string; cols: number; rows: number }>;
        noteLabel(id: string, label: string | null): void;
        onSessions(cb: (p: import('../main/ptyHost').PtySessionInfo[]) => void): void;
        loadSessions(): Promise<import('../shared/cockpitPersist').PersistedSession[]>;
        saveSessions(list: import('../shared/cockpitPersist').PersistedSession[]): void;
        sessionMeta(projectPath: string, sessionId: string, agentId?: import('../shared/types').AgentId, wantAi?: boolean): Promise<{ model: string | null; activeMs: number; contextTokens: number; contextWindow: number; summary: string | null; summarySource: import('../shared/sessionSummary').SummarySource | null }>;
        sessionIds(projectPath: string, agentId?: import('../shared/types').AgentId): Promise<string[]>;
        /** Parallel array: does each saved entry's conversation still exist on disk? Unverifiable → true. */
        sessionsExist(items: { projectPath: string; sessionId: string | null; agentId?: string }[]): Promise<boolean[]>;
        liveSessionId(projectPath: string, opts: { currentId: string | null; claimedIds: string[]; openedAtMs: number; sinceMs: number; lastDataAtMs: number; agentId?: import('../shared/types').AgentId }): Promise<string | null>;
        liveAgent(id: string): Promise<import('../shared/types').AgentId | null>;
        gitInfo(projectPath: string): Promise<{ branch: string | null; dirty: number } | null>;
        openLink(url: string): Promise<void>;
        openFile(projectPath: string, filePath: string): Promise<string>;
      };
      shutdown: {
        arm(): Promise<import('../main/shutdownScheduler').ShutdownStatus>;
        disarm(): Promise<import('../main/shutdownScheduler').ShutdownStatus>;
        now(): Promise<import('../main/shutdownScheduler').ShutdownStatus>;
        cancel(): Promise<import('../main/shutdownScheduler').ShutdownStatus>;
        status(): Promise<import('../main/shutdownScheduler').ShutdownStatus>;
        history(): Promise<import('../shared/shutdownIdle').ShutdownRecord[]>;
        clearHistory(): Promise<boolean>;
        bootBanner(): Promise<{ record: import('../shared/shutdownIdle').ShutdownRecord; verdict: 'confirmed' | 'not-executed' } | null>;
        ackBanner(): Promise<boolean>;
        setIdleMinutes(m: number): Promise<void>;
        report(p: { working: number; sessions: { project: string; activity: string }[] }): void;
        onStatus(cb: (s: import('../main/shutdownScheduler').ShutdownStatus) => void): void;
      };
    };
  }
}
export {};
