import { describe, expect, it } from 'vitest';
import { memorySurfaceMode } from './projectMemorySurface';

describe('memorySurfaceMode', () => {
  it('uses an overlay drawer on wide layouts and a sheet on narrow layouts', () => {
    expect(memorySurfaceMode(1000)).toBe('drawer');
    expect(memorySurfaceMode(720)).toBe('drawer');
    expect(memorySurfaceMode(719)).toBe('sheet');
  });
});
