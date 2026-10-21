// src/main/sessionImages.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSessionImages, listSessionTurns, readEmbeddedImage, _clearSessionImageCache } from './sessionImages';
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

describe('image context', () => {
  const said = (text: string) => JSON.stringify({ type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  it('says what led to each image: the call\'s target, the page its browser was on, and the agent\'s last words', () => {
    const c = new SessionImageCollector();
    const lines = [
      said('Let me open the login page.\nThen check it.'),
      toolCall('n1', 'mcp__playwright__browser_navigate', { url: 'http://localhost:3000/login' }),
      said('Now the button state:'),
      toolCall('s1', 'mcp__playwright__browser_take_screenshot', { element: 'Submit button', ref: 'e12' }),
      toolResultWithImage('s1'),
      toolCall('w1', 'mcp__windows-mcp__Screenshot'),
      toolResultWithImage('w1'),
    ];
    const refs = lines.flatMap((l, i) => c.add(l, i * 1000));
    expect(refs.map((r) => [r.detail, r.page, r.said])).toEqual([
      ['Submit button', 'http://localhost:3000/login', 'Now the button state:'],
      // Another server's screenshot is not of that page.
      [null, null, 'Now the button state:'],
    ]);
  });

  it('gives a pasted image the words the person sent with it, without the placeholder', () => {
    const c = new SessionImageCollector();
    const line = JSON.stringify({ type: 'user', timestamp: TS, message: { role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
      { type: 'text', text: '[Image #1] 이 버튼 위치 이상해요' },
    ] } });
    expect(c.add(line, 0).map((r) => r.said)).toEqual(['이 버튼 위치 이상해요']);
  });

  it('never parses a huge call just for context, and still names its tool', () => {
    const c = new SessionImageCollector();
    c.add(toolCall('big', 'mcp__x__shot', { text: 'y'.repeat(200_000) }), 0);
    const [ref] = c.add(toolResultWithImage('big'), 1);
    expect([ref.tool, ref.detail]).toEqual(['mcp__x__shot', null]);
  });
});

describe('session turns', () => {
  const said = (text: string) => JSON.stringify({ type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'text', text }] } });

  it('keeps what the person typed, with its time and the reply that came back', () => {
    const c = new SessionImageCollector();
    const lines = [
      plain('fix the login page\nit fails on submit'),
      said('Looking at it.'),
      toolCall('s1', 'mcp__playwright__browser_take_screenshot'),
      toolResultWithImage('s1'),
      said('Fixed: the handler was not awaited.'),
      pasted(),
      plain('<command-name>/clear</command-name>'),
      JSON.stringify({ type: 'user', isMeta: true, timestamp: TS, message: { role: 'user', content: 'Caveat: hidden' } }),
      plain('[Request interrupted by user]'),
      JSON.stringify({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, timestamp: TS, message: { role: 'user', content: 'This session is being continued from a previous conversation' } }),
      plain('\n\n<pasted_content id="3a1d">\nRead CLAUDE.md first.\nThen continue.\n</pasted_content id="3a1d">\n'),
    ];
    lines.forEach((l, i) => c.add(l, i * 100));
    expect(c.turns).toEqual([
      { id: 't0', ts: Date.parse(TS), text: 'fix the login page', pasted: 0, reply: 'Fixed: the handler was not awaited.' },
      { id: 't500', ts: Date.parse(TS), text: 'look', pasted: 1, reply: null },
      { id: 't1000', ts: Date.parse(TS), text: 'Read CLAUDE.md first.', pasted: 0, reply: null },
    ]);
  });

  it('is listed from the same pass as the images', async () => {
    writeFileSync(file, [plain('first'), said('ok'), plain('second')].join('\n') + '\n');
    expect((await listSessionTurns(file)).map((t) => [t.text, t.reply])).toEqual([['first', 'ok'], ['second', null]]);
    appendFileSync(file, said('done') + '\n');
    expect((await listSessionTurns(file)).map((t) => t.reply)).toEqual(['ok', 'done']);
  });
});
