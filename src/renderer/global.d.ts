import type { ProjectViewModel } from '../shared/types';

declare global {
  interface Window {
    devdeck: {
      listProjects(): Promise<ProjectViewModel[]>;
      setNote(path: string, note: string): Promise<void>;
      setTodos(path: string, todos: import('../shared/tasks').Todo[]): Promise<void>;
      setPinned(path: string, pinned: boolean): Promise<void>;
      setHidden(path: string, hidden: boolean): Promise<void>;
      open(items: { path: string; sessionId: string | null }[]): Promise<void>;
      onError(cb: (msg: string) => void): void;
      usageReport(sinceMs: number): Promise<import('../shared/types').UsageReport>;
      getLanguage(): Promise<string>;
      setLanguage(lang: string): Promise<void>;
      getAgent(): Promise<import('../shared/types').AgentId>;
      setAgent(id: string): Promise<void>;
      availableAgents(): Promise<import('../shared/types').AgentId[]>;
      getSettings(): Promise<{ baseDir: string; thresholds: { freshDays: number; warnDays: number; neglectedDays: number }; language: string; openAtLogin: boolean; platform: string; ptyAvailable: boolean; viewMode: 'cards' | 'list'; trayAlert: 'off' | 'attention' | 'all'; contextWindow: number; shutdownIdleMinutes: number; cockpitSidebarCollapsed: boolean }>;
      setTrayAlert(mode: 'off' | 'attention' | 'all'): Promise<void>;
      setContextWindow(w: number): Promise<void>;
      setTrayCounts(counts: { attention?: number; turn?: number; overdue?: number }): void;
      setTrayAlertImage(dataUrl: string): void;
      setBaseDir(dir: string): Promise<void>;
      getFolders(): Promise<import('../shared/types').Folder[]>;
      addFolder(path: string): Promise<import('../shared/types').Folder[]>;
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
      usageWindows(): Promise<import('../shared/usageWindows').UsageResult>;
      onUpdate(cb: (p: import('../shared/update').UpdatePayload) => void): void;
      downloadUpdate(): Promise<void>;
      installUpdate(): Promise<void>;
      setPendingAutoRestore(sessions: import('../shared/cockpitPersist').PersistedSession[]): Promise<void>;
      consumeAutoRestore(): Promise<import('../shared/cockpitPersist').PersistedSession[]>;
      getAppInfo(): Promise<{ version: string; electron: string; repoUrl: string; packaged: boolean }>;
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
      clipboard: {
        writeText(text: string): void;
        readText(): Promise<string>;
        readImage(): Promise<string | null>;
      };
      cockpit: {
        open(req: { projectPath: string; sessionId: string | null; cols: number; rows: number; fresh?: boolean }): Promise<{ id: string; agentId: import('../shared/types').AgentId; sessionId: string | null }>;
        input(id: string, data: string): void;
        resize(id: string, cols: number, rows: number): void;
        close(id: string): void;
        onData(cb: (p: { id: string; chunk: string }) => void): void;
        onExit(cb: (p: { id: string; exitCode: number }) => void): void;
        loadSessions(): Promise<import('../shared/cockpitPersist').PersistedSession[]>;
        saveSessions(list: import('../shared/cockpitPersist').PersistedSession[]): void;
        sessionMeta(projectPath: string, sessionId: string): Promise<{ model: string | null; activeMs: number; contextTokens: number }>;
        sessionIds(projectPath: string): Promise<string[]>;
        liveSessionId(projectPath: string, opts: { currentId: string | null; claimedIds: string[]; openedAtMs: number; sinceMs: number; lastDataAtMs: number }): Promise<string | null>;
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
