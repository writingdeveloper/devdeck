import { describe, it, expect } from 'vitest';
import { extractCwdFromDbBuffer, firstUserMessageFromTranscript, lastUserMessageFromTranscript } from './antigravityParse';

// Antigravity's conversation .db stores the workspace path as a protobuf string field:
// one length byte (the path's byte length) immediately followed by `file:///c:/...`.
function dbWith(path: string): Buffer {
  const uri = Buffer.from(path, 'utf8');
  return Buffer.concat([Buffer.from([0x00, 0xAA]), Buffer.from([uri.length]), uri, Buffer.from([0x12, 0x00])]);
}

describe('extractCwdFromDbBuffer', () => {
  it('decodes a file:/// URI to a Windows path using the protobuf length prefix', () => {
    const buf = dbWith('file:///c:/Users/SIHYEONG/Documents/ComfyUI');
    expect(extractCwdFromDbBuffer(buf)).toBe('C:\\Users\\SIHYEONG\\Documents\\ComfyUI');
  });
  it('stops exactly at the length prefix (no trailing over-capture)', () => {
    // a stray path-like byte follows the field; length prefix must cut it off
    const buf = Buffer.concat([dbWith('file:///c:/proj'), Buffer.from('ztrailing', 'utf8')]);
    expect(extractCwdFromDbBuffer(buf)).toBe('C:\\proj');
  });
  it('returns null when there is no file:/// marker', () => {
    expect(extractCwdFromDbBuffer(Buffer.from('no marker here'))).toBeNull();
  });
});

describe('transcript parsing', () => {
  const t = [
    JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\nfirst ask\n</USER_REQUEST>\n<META>x</META>' }),
    JSON.stringify({ type: 'AGENT', content: 'working...' }),
    JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>last ask</USER_REQUEST>' }),
  ].join('\n');
  it('firstUserMessageFromTranscript returns the first USER_REQUEST body', () => {
    expect(firstUserMessageFromTranscript(t)).toBe('first ask');
  });
  it('lastUserMessageFromTranscript returns the last USER_REQUEST body', () => {
    expect(lastUserMessageFromTranscript(t)).toBe('last ask');
  });
  it('returns null on empty/garbage', () => {
    expect(lastUserMessageFromTranscript('')).toBeNull();
    expect(firstUserMessageFromTranscript('not json\n{')).toBeNull();
  });
});
