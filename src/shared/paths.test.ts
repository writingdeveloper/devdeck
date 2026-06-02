import { describe, it, expect } from 'vitest';
import { encodeProjectPath } from './paths';

describe('encodeProjectPath', () => {
  it('encodes a Windows path the way Claude names its session dir', () => {
    expect(encodeProjectPath('C:\\Users\\SIHYEONG\\Documents\\GitHub\\rockgaze'))
      .toBe('C--Users-SIHYEONG-Documents-GitHub-rockgaze');
  });

  it('encodes the base dir itself', () => {
    expect(encodeProjectPath('C:\\Users\\SIHYEONG\\Documents\\GitHub'))
      .toBe('C--Users-SIHYEONG-Documents-GitHub');
  });
});
