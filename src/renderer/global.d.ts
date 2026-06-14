import type { ProjectViewModel } from '../shared/types';

declare global {
  interface Window {
    devdeck: {
      listProjects(): Promise<ProjectViewModel[]>;
      setNote(path: string, note: string): Promise<void>;
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
      getSettings(): Promise<{ baseDir: string; thresholds: { freshDays: number; warnDays: number; neglectedDays: number }; language: string; openAtLogin: boolean; platform: string; viewMode: 'cards' | 'list' }>;
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
      onUpdate(cb: (p: import('../shared/update').UpdatePayload) => void): void;
      downloadUpdate(): Promise<void>;
      installUpdate(): Promise<void>;
      getAppInfo(): Promise<{ version: string; electron: string; repoUrl: string; packaged: boolean }>;
      openExternal(url: string): Promise<void>;
      checkForUpdates(): Promise<void>;
      windowControls: {
        minimize(): Promise<void>;
        toggleMaximize(): Promise<void>;
        close(): Promise<void>;
        isMaximized(): Promise<boolean>;
        onMaximizeChange(cb: (maximized: boolean) => void): void;
      };
    };
  }
}
export {};
