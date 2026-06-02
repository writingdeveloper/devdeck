import type { ProjectViewModel } from '../shared/types';

declare global {
  interface Window {
    devdeck: {
      listProjects(): Promise<ProjectViewModel[]>;
      setNote(path: string, note: string): Promise<void>;
      setPinned(path: string, pinned: boolean): Promise<void>;
      setHidden(path: string, hidden: boolean): Promise<void>;
      open(paths: string[]): Promise<void>;
    };
  }
}
export {};
