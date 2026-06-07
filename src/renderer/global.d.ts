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
      getSettings(): Promise<{ baseDir: string; thresholds: { freshDays: number; warnDays: number; neglectedDays: number }; language: string }>;
      setBaseDir(dir: string): Promise<void>;
      setThresholds(t: { freshDays: number; warnDays: number; neglectedDays: number }): Promise<void>;
      pickFolder(): Promise<string | null>;
      openFolder(path: string): Promise<void>;
      openEditor(path: string): Promise<void>;
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
