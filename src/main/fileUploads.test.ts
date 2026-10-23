import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createUploads } from './fileUploads';
import { MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES } from '../shared/sentFiles';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'devdeck-uploads-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64');
const make = (free = 100 * 1024 ** 3) => createUploads({ dir, prefix: 'devdeck-file-', freeBytes: async () => free });
const idOf = (r: Awaited<ReturnType<ReturnType<typeof make>['start']>>) => { if (!('id' in r)) throw new Error(r.error); return r.id; };

describe('receiving a file of any kind in pieces', () => {
  it('writes the pieces in order and lands the file under its own name in the given folder', async () => {
    const up = make();
    const id = idOf(await up.start('..\\..\\Windows\\tool.exe', 6));
    expect(await up.chunk(id, 0, b64(Buffer.from([0x4d, 0x5a, 0])))).toBe(3);
    expect(await up.chunk(id, 3, b64(Buffer.from([1, 2, 3])))).toBe(6);
    const path = await up.finish(id);
    expect(dirname(path!)).toBe(dir);
    expect(basename(path!)).toMatch(/^devdeck-file-[0-9a-f-]{36}-tool\.exe$/);
    expect([...readFileSync(path!)]).toEqual([0x4d, 0x5a, 0, 1, 2, 3]);
    if (process.platform === 'win32') expect(readFileSync(path! + ':Zone.Identifier', 'utf8')).toContain('ZoneId=3');
  });

  it('takes an empty file', async () => {
    const up = make();
    const path = await up.finish(idOf(await up.start('empty.txt', 0)));
    expect(readFileSync(path!).length).toBe(0);
  });

  it('refuses a piece out of order, too large, or past the announced size, and drops the upload for the last two', async () => {
    const up = make();
    const id = idOf(await up.start('a.bin', 4));
    expect(await up.chunk(id, 2, b64('ab'))).toBeNull(); // not where the last one ended
    expect(await up.chunk(id, 0, b64('abcdef'))).toBeNull(); // more than announced
    expect(await up.chunk(id, 0, b64('ab'))).toBeNull(); // the upload is gone
    expect(readdirSync(dir)).toEqual([]);
    const id2 = idOf(await up.start('b.bin', MAX_UPLOAD_BYTES));
    expect(await up.chunk(id2, 0, 'A'.repeat(Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4 + 4))).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('lands nothing when bytes are missing, and abort removes the part file', async () => {
    const up = make();
    const id = idOf(await up.start('a.bin', 10));
    await up.chunk(id, 0, b64('abc'));
    expect(await up.finish(id)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
    const id2 = idOf(await up.start('b.bin', 10));
    expect(readdirSync(dir)).toHaveLength(1);
    await up.abort(id2);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a name with nothing left, a size over 4GB, and a file that would leave under 2GB free', async () => {
    expect(await make().start('...', 1)).toEqual({ error: 'bad-name' });
    expect(await make().start(42, 1)).toEqual({ error: 'bad-name' });
    expect(await make().start('a.bin', MAX_UPLOAD_BYTES + 1)).toEqual({ error: 'too-large' });
    expect(await make().start('a.bin', -1)).toEqual({ error: 'too-large' });
    expect(await make(3 * 1024 ** 3).start('a.bin', 1.5 * 1024 ** 3)).toEqual({ error: 'no-space' });
    // What open uploads still have to write counts too.
    const up = make(5 * 1024 ** 3);
    idOf(await up.start('a.bin', 2 * 1024 ** 3));
    expect(await up.start('b.bin', 2 * 1024 ** 3)).toEqual({ error: 'no-space' });
    await up.dispose();
  });

  it('holds at most four uploads open at once', async () => {
    const up = make();
    for (let i = 0; i < 4; i++) idOf(await up.start(`f${i}.bin`, 1));
    expect(await up.start('f4.bin', 1)).toEqual({ error: 'busy' });
    await up.dispose();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('answers nothing for an id it never gave', async () => {
    const up = make();
    expect(await up.chunk('nope', 0, b64('a'))).toBeNull();
    expect(await up.finish('nope')).toBeNull();
    expect(existsSync(dir)).toBe(true);
  });
});
