import { describe, it, expect } from 'vitest';
import { encodeProjectPath } from './paths';

describe('encodeProjectPath', () => {
  it('encodes a Windows path the way Claude names its session dir', () => {
    expect(encodeProjectPath('C:\\Users\\dev\\Documents\\GitHub\\repo-one'))
      .toBe('C--Users-dev-Documents-GitHub-repo-one');
  });

  it('encodes the base dir itself', () => {
    expect(encodeProjectPath('C:\\Users\\dev\\Documents\\GitHub'))
      .toBe('C--Users-dev-Documents-GitHub');
  });
});
