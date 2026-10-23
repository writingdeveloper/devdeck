import { describe, expect, it, vi } from 'vitest';
import { attachFiles, sendInPieces, type AttachTarget, type UploadApi } from './attachments';
import { MAX_SENT_FILE_BYTES, MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES } from '../shared/sentFiles';

const remote = (over: Partial<AttachTarget> = {}): AttachTarget => ({
  local: false,
  receiveImage: vi.fn().mockResolvedValue(null),
  receiveFile: vi.fn().mockResolvedValue('C:\\Temp\\devdeck-file-x-build.log'),
  pathForFile: () => '',
  ...over,
});

describe('attaching documents to a session on a PC older than uploads', () => {
  it('sends a document the host can take and types the path it landed at', async () => {
    const target = remote();
    const out = await attachFiles([new File(['step 1 ok\n'], 'build.log')], target);
    expect(out.paths).toEqual(['C:\\Temp\\devdeck-file-x-build.log']);
    expect(target.receiveFile).toHaveBeenCalledWith('build.log', btoa('step 1 ok\n'));
  });

  it('counts a host too old to receive documents apart from a failure', async () => {
    const out = await attachFiles([new File(['x'], 'a.log')], remote({ receiveFile: vi.fn().mockRejectedValue(new Error('no such method: cockpit:receiveFile')) }));
    expect([out.paths.length, out.hostTooOld, out.failed]).toEqual([0, 1, 0]);
  });

  it('skips what such a PC cannot take: other kinds, and documents past 5MB', async () => {
    const target = remote();
    const out = await attachFiles([new File(['MZ'], 'setup.exe'), new File([new Uint8Array(MAX_SENT_FILE_BYTES + 1)], 'huge.log')], target);
    expect(out.skippedNonImage).toBe(2);
    expect(target.receiveFile).not.toHaveBeenCalled();
  });

  it('falls back to the old way when the PC answers that it has no uploads', async () => {
    const target = remote({ upload: vi.fn().mockResolvedValue({ error: 'host-too-old' }) });
    const out = await attachFiles([new File(['ok\n'], 'build.log'), new File(['PK'], 'src.zip')], target);
    expect(out.paths).toEqual(['C:\\Temp\\devdeck-file-x-build.log']);
    expect(out.skippedNonImage).toBe(1);
  });
});

/** A host that keeps what it is sent, as the real one writes it to disk. */
function fakeHost() {
  const files = new Map<string, { name: string; size: number; data: number[] }>();
  const api: UploadApi = {
    uploadStart: vi.fn(async (name: string, size: number) => {
      if (size > MAX_UPLOAD_BYTES) return { error: 'too-large' as const };
      const id = 'u' + files.size; files.set(id, { name, size, data: [] }); return { id };
    }),
    uploadChunk: vi.fn(async (id: string, offset: number, b64: string) => {
      const f = files.get(id)!; if (offset !== f.data.length) return null;
      const bin = atob(b64); for (let i = 0; i < bin.length; i++) f.data.push(bin.charCodeAt(i)); return f.data.length;
    }),
    uploadFinish: vi.fn(async (id: string) => { const f = files.get(id)!; return f.data.length === f.size ? 'C:\\Temp\\devdeck-file-' + id + '-' + f.name : null; }),
    uploadAbort: vi.fn(async () => {}),
  };
  return { api, files };
}

describe('sending any file to a session on another PC', () => {
  it('sends a kind the old way refused, as it is, and types where it landed', async () => {
    const host = fakeHost();
    const target = remote({ upload: (file, onProgress) => sendInPieces(file, host.api, onProgress) });
    const out = await attachFiles([new File([new Uint8Array([0x4d, 0x5a, 0, 1])], 'tool.exe'), new File(['PK\x03\x04'], 'src.zip')], target);
    expect(out.paths).toEqual(['C:\\Temp\\devdeck-file-u0-tool.exe', 'C:\\Temp\\devdeck-file-u1-src.zip']);
    expect(host.files.get('u0')!.data).toEqual([0x4d, 0x5a, 0, 1]);
    expect(target.receiveFile).not.toHaveBeenCalled();
  });

  it('splits a large file into pieces in order and reports progress', async () => {
    const host = fakeHost();
    const size = UPLOAD_CHUNK_BYTES * 2 + 123;
    const bytes = new Uint8Array(size); for (let i = 0; i < size; i++) bytes[i] = i % 251;
    const seen: number[] = [];
    const r = await sendInPieces(new File([bytes], 'big.bin'), host.api, (n) => seen.push(n));
    expect(r).toEqual({ path: 'C:\\Temp\\devdeck-file-u0-big.bin' });
    expect(host.api.uploadChunk).toHaveBeenCalledTimes(3);
    expect(seen).toEqual([UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES * 2, size]);
    expect(host.files.get('u0')!.data.length).toBe(size);
    expect(host.files.get('u0')!.data[size - 1]).toBe((size - 1) % 251);
  });

  it('sends an empty file', async () => {
    const host = fakeHost();
    expect(await sendInPieces(new File([], 'empty.txt'), host.api)).toEqual({ path: 'C:\\Temp\\devdeck-file-u0-empty.txt' });
  });

  it('abandons the upload when a piece is refused, and says so', async () => {
    const host = fakeHost();
    host.api.uploadChunk = vi.fn().mockResolvedValue(null);
    expect(await sendInPieces(new File(['abc'], 'a.bin'), host.api)).toEqual({ error: 'failed' });
    expect(host.api.uploadAbort).toHaveBeenCalledWith('u0');
  });

  it('tells a PC without uploads, a full disk and a refused size apart', async () => {
    const api = (start: UploadApi['uploadStart']): UploadApi => ({ ...fakeHost().api, uploadStart: start });
    expect(await sendInPieces(new File(['x'], 'a'), api(vi.fn().mockRejectedValue(new Error('no such method: cockpit:uploadStart'))))).toEqual({ error: 'host-too-old' });
    expect(await sendInPieces(new File(['x'], 'a'), api(vi.fn().mockResolvedValue({ error: 'no-space' })))).toEqual({ error: 'no-space' });
    expect(await sendInPieces(new File(['x'], 'a'), api(vi.fn().mockResolvedValue({ error: 'too-large' })))).toEqual({ error: 'too-large' });
  });
});
