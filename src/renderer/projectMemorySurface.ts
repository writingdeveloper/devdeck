export type MemorySurfaceMode = 'drawer' | 'sheet';

export function memorySurfaceMode(width: number): MemorySurfaceMode {
  return width >= 720 ? 'drawer' : 'sheet';
}
