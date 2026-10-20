// src/main/sessionImages.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSessionImages, readEmbeddedImage, _clearSessionImageCache } from './sessionImages';
import { mergeImageRefs, SessionImageCollector } from '../shared/sessionImages';

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
const TS = '2026-10-16T18:02:06.182Z';

const toolCall = (id: string, name: string, input: Record<string, unknown> = {}) => JSON.stringify({
  type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResultWithImage = (id: string, data = PNG_B64) => JSON.stringify({
  type: 'user', timestamp: TS, message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: [
    { type: 'text', text: 'Screenshot' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
  ] }] },
});
const pasted = () => JSON.stringify({
  type: 'user', timestamp: TS, message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PNG_B64 } }, { type: 'text', text: 'look' }] },
});
const plain = (text: string) => JSON.stringify({ type: 'user', timestamp: TS, message: { role: 'user', content: text } });

let dir: string; let file: string;
beforeEach(() => { _clearSessionImageCache(); dir = mkdtempSync(join(tmpdir(), 'devdeck-img-')); file = join(dir, 's.jsonl'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('listSessionImages', () => {
  it('finds tool screenshots (named by their call), pasted images and image files a tool touched', async () => {
    writeFileSync(file, [
      plain('hi'),
      toolCall('t1', 'mcp__playwright__browser_take_screenshot'),
      toolResultWithImage('t1'),
      pasted(),
      toolCall('t2', 'Write', { file_path: 'out/render.png', content: 'x' }),
      toolCall('t3', 'Read', { file_path: 'src/a.ts' }),
    ].join('\n') + '\n');
    const refs = await listSessionImages(file);
    expect(refs.map((r) => [r.kind, r.tool, r.path])).toEqual([
      ['screenshot', 'mcp__playwright__browser_take_screenshot', null],
      ['pasted', null, null],
      ['file', 'Write', 'out/render.png'],
    ]);
    expect(refs[0].ts).toBe(Date.parse(TS));
  });

  it('reads only what was appended, and never a half-written last line', async () => {
    writeFileSync(file, toolCall('t1', 'shot') + '\n' + toolResultWithImage('t1') + '\n');
    expect(await listSessionImages(file)).toHaveLength(1);
    const half = pasted();
    appendFileSync(file, half.slice(0, 40));
    expect(await listSessionImages(file)).toHaveLength(1);
    appendFileSync(file, half.slice(40) + '\n');
    const refs = await listSessionImages(file);
    expect(refs.map((r) => r.kind)).toEqual(['screenshot', 'pasted']);
  });

  it('starts over when the file was replaced', async () => {
    writeFileSync(file, pasted() + '\n' + pasted() + '\n');
    expect(await listSessionImages(file)).toHaveLength(2);
    writeFileSync(file, plain('new conversation') + '\n');
    expect(await listSessionImages(file)).toEqual([]);
  });

  it('a missing transcript is an empty list, not an error', async () => {
    expect(await listSessionImages(join(dir, 'nope.jsonl'))).toEqual([]);
  });
});

describe('readEmbeddedImage', () => {
  it('returns the bytes behind an id, and null for an id that points at nothing', async () => {
    writeFileSync(file, plain('a') + '\n' + toolCall('t1', 'shot') + '\n' + toolResultWithImage('t1') + '\n' + pasted() + '\n');
    const refs = await listSessionImages(file);
    const shot = await readEmbeddedImage(file, refs[0].id);
    expect(shot?.mediaType).toBe('image/png');
    expect(shot?.data.equals(Buffer.from(PNG_B64, 'base64'))).toBe(true);
    expect((await readEmbeddedImage(file, refs[1].id))?.mediaType).toBe('image/jpeg');
    expect(await readEmbeddedImage(file, '0.0')).toBeNull(); // first line holds no image
    expect(await readEmbeddedImage(file, '999999.0')).toBeNull();
    expect(await readEmbeddedImage(file, '../etc')).toBeNull();
  });
});

describe('mergeImageRefs', () => {
  it('keeps one entry per file at its latest touch, and only the newest `limit`', () => {
    const c = new SessionImageCollector();
    const a = c.add(toolCall('1', 'Write', { file_path: 'a.png' }), 0);
    const b = c.add(pasted(), 10);
    const a2 = c.add(toolCall('2', 'Edit', { file_path: 'a.png' }), 20);
    const merged = mergeImageRefs(mergeImageRefs([], [...a, ...b], 10), a2, 10);
    expect(merged.map((r) => [r.kind, r.tool])).toEqual([['pasted', null], ['file', 'Edit']]);
    expect(mergeImageRefs([], [...b, ...c.add(pasted(), 30)], 1).map((r) => r.id)).toEqual(['30.0']);
  });
});
