import { describe, it, expect } from 'vitest';
import {
  FrameKind, FRAME_HEADER_BYTES, LINK_PROTOCOL, MAX_FRAME_BYTES, PRE_AUTH_MAX_FRAME_BYTES,
  encodeJsonFrame, encodePtyFrame, decodePtyPayload, makeFrameDecoder, parseLinkMessage, protocolMatches,
} from './protocol';

const decodeJson = (payload: Buffer) => parseLinkMessage(payload);

describe('frame encoding', () => {
  it('round-trips a JSON message', () => {
    const frame = encodeJsonFrame({ t: 'hello', protocol: LINK_PROTOCOL, appVersion: '1.34.1', machineId: 'm1', machineName: 'desktop' });
    const [decoded] = makeFrameDecoder().push(frame);
    expect(decoded.kind).toBe(FrameKind.Json);
    expect(decodeJson(decoded.payload)).toEqual({ t: 'hello', protocol: LINK_PROTOCOL, appVersion: '1.34.1', machineId: 'm1', machineName: 'desktop' });
  });

  it('round-trips terminal bytes without touching them', () => {
    // ANSI escapes, CR, and a spinner glyph: the stream must arrive byte-identical or the screen is wrong.
    const raw = '[2K\r[38;5;208m✻[0m Thinking…\r\n';
    const [decoded] = makeFrameDecoder().push(encodePtyFrame('proj#7', raw));
    expect(decoded.kind).toBe(FrameKind.Pty);
    expect(decodePtyPayload(decoded.payload)).toEqual({ sessionId: 'proj#7', bytes: Buffer.from(raw, 'utf8') });
  });

  it('keeps multi-byte characters intact when they are handed over as bytes', () => {
    const bytes = Buffer.from('한글 출력 ✅', 'utf8');
    const [decoded] = makeFrameDecoder().push(encodePtyFrame('s', bytes));
    expect(decodePtyPayload(decoded.payload)!.bytes.equals(bytes)).toBe(true);
  });

  it('carries an empty chunk without confusing it for a malformed frame', () => {
    const [decoded] = makeFrameDecoder().push(encodePtyFrame('s', ''));
    expect(decodePtyPayload(decoded.payload)).toEqual({ sessionId: 's', bytes: Buffer.alloc(0) });
  });
});

describe('makeFrameDecoder', () => {
  it('reassembles a frame split across chunks — including a split header', () => {
    // TCP hands over a byte stream. A header straddling a chunk boundary is where framing bugs live.
    const frame = encodeJsonFrame({ t: 'detach', sessionId: 'abc' });
    const decoder = makeFrameDecoder();
    for (let i = 0; i < frame.length - 1; i++) {
      expect(decoder.push(frame.subarray(i, i + 1))).toEqual([]);
    }
    const done = decoder.push(frame.subarray(frame.length - 1));
    expect(done).toHaveLength(1);
    expect(decodeJson(done[0].payload)).toEqual({ t: 'detach', sessionId: 'abc' });
    expect(decoder.pending).toBe(0);
  });

  it('returns every frame when several arrive in one chunk', () => {
    const chunk = Buffer.concat([
      encodePtyFrame('a', 'one'),
      encodePtyFrame('b', 'two'),
      encodeJsonFrame({ t: 'evt', ch: 'cockpit:exit', payload: { id: 'a' } }),
    ]);
    const frames = makeFrameDecoder().push(chunk);
    expect(frames).toHaveLength(3);
    expect(decodePtyPayload(frames[0].payload)!.sessionId).toBe('a');
    expect(decodePtyPayload(frames[1].payload)!.bytes.toString()).toBe('two');
    expect(decodeJson(frames[2].payload)).toMatchObject({ t: 'evt', ch: 'cockpit:exit' });
  });

  it('holds a trailing partial frame and completes it on the next chunk', () => {
    const a = encodePtyFrame('a', 'hello');
    const b = encodePtyFrame('b', 'world');
    const decoder = makeFrameDecoder();
    const first = decoder.push(Buffer.concat([a, b.subarray(0, 3)]));
    expect(first).toHaveLength(1);
    expect(decoder.pending).toBe(3);
    const second = decoder.push(b.subarray(3));
    expect(decodePtyPayload(second[0].payload)!.bytes.toString()).toBe('world');
  });

  it('refuses an absurd declared length instead of allocating for it', () => {
    // The length is attacker-controlled. Trusting it is how a peer turns one packet into an OOM.
    const evil = Buffer.alloc(FRAME_HEADER_BYTES);
    evil.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    evil.writeUInt8(FrameKind.Json, 4);
    expect(() => makeFrameDecoder().push(evil)).toThrow(/refusing a frame/);
  });

  it('refuses a zero-length frame, which cannot even carry its kind', () => {
    const evil = Buffer.alloc(FRAME_HEADER_BYTES);
    evil.writeUInt32BE(0, 0);
    expect(() => makeFrameDecoder().push(evil)).toThrow(/refusing a frame/);
  });

  it('refuses an unknown frame kind rather than guessing how to read it', () => {
    const evil = Buffer.alloc(FRAME_HEADER_BYTES + 1);
    evil.writeUInt32BE(2, 0);
    evil.writeUInt8(99, 4);
    expect(() => makeFrameDecoder().push(evil)).toThrow(/unknown frame kind 99/);
  });
});

describe('parseLinkMessage', () => {
  it('answers null for malformed payloads instead of throwing', () => {
    // This text comes off the network. A parse failure is something to reply to, not to crash on.
    for (const bad of ['', 'not json', '[]', 'null', '"hello"', '{"no":"tag"}', '{"t":1}']) {
      expect(parseLinkMessage(Buffer.from(bad, 'utf8')), bad).toBeNull();
    }
  });

  it('accepts a well-formed message', () => {
    expect(parseLinkMessage(Buffer.from('{"t":"req","id":1,"method":"projects:list","args":[]}')))
      .toEqual({ t: 'req', id: 1, method: 'projects:list', args: [] });
  });
});

describe('decodePtyPayload', () => {
  it('answers null for a truncated payload rather than reading past the end', () => {
    expect(decodePtyPayload(Buffer.alloc(1))).toBeNull();
    const claimsLongId = Buffer.alloc(4);
    claimsLongId.writeUInt16BE(1000, 0);
    expect(decodePtyPayload(claimsLongId)).toBeNull();
  });
});

describe('protocolMatches', () => {
  it('accepts only its exact version — there is nothing to negotiate down to', () => {
    expect(protocolMatches(LINK_PROTOCOL)).toBe(true);
    expect(protocolMatches('devdeck-link/2')).toBe(false);
    expect(protocolMatches(undefined)).toBe(false);
  });
});

describe('makeFrameDecoder limits and large frames', () => {
  it('reassembles a large frame fed in small chunks, byte-identical', () => {
    // A scrollback replay is the largest real frame and arrives in socket-sized reads. Gluing every
    // read onto the buffer as it came copied the frame once per read — quadratic in its size.
    const body = Buffer.alloc(4 * 1024 * 1024);
    for (let i = 0; i < body.length; i++) body[i] = (i * 31) & 0xff;
    const frame = encodePtyFrame('big', body);
    const decoder = makeFrameDecoder();
    const out = [];
    const started = Date.now();
    for (let i = 0; i < frame.length; i += 16 * 1024) out.push(...decoder.push(frame.subarray(i, i + 16 * 1024)));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out).toHaveLength(1);
    expect(decodePtyPayload(out[0].payload)!.bytes.equals(body)).toBe(true);
    expect(decoder.pending).toBe(0);
  });

  it('keeps frames that share a chunk with the tail of a previous one intact', () => {
    const a = encodeJsonFrame({ t: 'detach', sessionId: 'a' });
    const b = encodeJsonFrame({ t: 'detach', sessionId: 'b' });
    const c = encodeJsonFrame({ t: 'detach', sessionId: 'c' });
    const all = Buffer.concat([a, b, c]);
    const decoder = makeFrameDecoder();
    const split = a.length + 2; // the second header straddles the boundary
    const frames = [...decoder.push(all.subarray(0, split)), ...decoder.push(all.subarray(split))];
    expect(frames.map((f) => (decodeJson(f.payload) as { sessionId: string }).sessionId)).toEqual(['a', 'b', 'c']);
  });

  it('refuses a frame over a lowered ceiling, and accepts it once the ceiling is raised', () => {
    // Before a peer is let in, nothing it may say is bigger than a hello.
    const frame = encodePtyFrame('s', Buffer.alloc(PRE_AUTH_MAX_FRAME_BYTES + 10));
    expect(() => makeFrameDecoder({ maxFrameBytes: PRE_AUTH_MAX_FRAME_BYTES }).push(frame)).toThrow(/refusing a frame/);
    const decoder = makeFrameDecoder({ maxFrameBytes: PRE_AUTH_MAX_FRAME_BYTES });
    decoder.maxFrameBytes = MAX_FRAME_BYTES;
    expect(decoder.push(frame)).toHaveLength(1);
  });

  it('never lets a ceiling be raised past the protocol maximum', () => {
    const decoder = makeFrameDecoder({ maxFrameBytes: MAX_FRAME_BYTES * 4 });
    expect(decoder.maxFrameBytes).toBe(MAX_FRAME_BYTES);
    decoder.maxFrameBytes = Number.NaN;
    expect(decoder.maxFrameBytes).toBe(MAX_FRAME_BYTES);
  });
});
