import { describe, expect, it, vi } from 'vitest';
import { attachFiles, type AttachTarget } from './attachments';
import { MAX_SENT_FILE_BYTES } from '../shared/sentFiles';

const remote = (over: Partial<AttachTarget> = {}): AttachTarget => ({
  local: false,
  receiveImage: vi.fn().mockResolvedValue(null),
  receiveFile: vi.fn().mockResolvedValue('C:\\Temp\\devdeck-file-x-build.log'),
  pathForFile: () => '',
  ...over,
});

describe('attaching documents to a session on another PC', () => {
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

  it('never sends a kind that could run, or one over the limit', async () => {
    const target = remote();
    const out = await attachFiles([new File(['MZ'], 'setup.exe'), new File([new Uint8Array(MAX_SENT_FILE_BYTES + 1)], 'huge.log')], target);
    expect([out.skippedNonImage, out.tooLarge]).toEqual([1, 1]);
    expect(target.receiveFile).not.toHaveBeenCalled();
  });
});
