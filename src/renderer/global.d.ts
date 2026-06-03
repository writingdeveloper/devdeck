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
    };
  }
}
export {};
