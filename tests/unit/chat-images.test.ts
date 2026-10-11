import { afterEach, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { ChatStore } from '../../src/main/chat/ChatStore';
import { ChatService } from '../../src/main/chat/ChatService';
import { ModelConfig } from '../../src/main/chat/ModelConfig';
import { prepareContext } from '../../src/main/chat/ContextBuilder';
import { summaryPrompt } from '../../src/main/chat/ConversationSummary';
import { longMemoryPrompt, sourceHash } from '../../src/main/chat/LongMemory';
import { estimateMessages } from '../../src/main/chat/ContextBudget';
import { type StoredImage } from '../../src/main/chat/MessageImages';
import { type Generate } from '../../src/main/chat/ModelClient';
import { loadPack } from '../../src/main/characters/PackLoader';
import { supportsImages } from '../../src/shared/imageInput';
import { chatSendInputSchema } from '../../src/shared/chatInput';
import { temporary, remove } from './fixtures';

const pack = loadPack(resolve('characters'), 'yoshino');
const roots: string[] = [], cleanup: (() => void)[] = [];
const codec = { encrypt: (s: string) => s, decrypt: (s: string) => s }; // Synthetic keys only.
function image(): StoredImage {
  const data = Buffer.from('fixture-pixels');
  return { id: randomUUID(), name: '测试图片.png', mime: 'image/png', width: 10, height: 10, byteLength: data.length, sha256: createHash('sha256').update(data).digest('hex'), data };
}
function setup(client: Generate = async () => '{"text":"看到了"}') {
  const dir = temporary(); roots.push(dir);
  const store = new ChatStore(dir), config = new ModelConfig(dir, codec);
  config.save({ baseUrl: 'http://localhost:8000/v1', model: 'fixture', imageInput: 'enabled', memoryEnabled: true, proactive: false, autoSummary: false, autoLongMemory: false });
  const service = new ChatService(store, config, () => ({ pack, epoch: 1 }), () => {}, () => {}, () => false, client);
  cleanup.push(() => service.dispose()); return { store, service, config, dir };
}
function target(service: ChatService) { const { characterId, epoch, sessionId, historyRevision } = service.state(); return { characterId, epoch, sessionId, historyRevision }; }
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); roots.splice(0).forEach(remove); });

it('accepts image-only input, rejects empty and duplicate IDs, auto-detects only known vision support', () => {
  const { service } = setup(), input = { ...target(service), text: '', imageIds: [randomUUID()] };
  expect(chatSendInputSchema.safeParse(input).success).toBe(true);
  expect(chatSendInputSchema.safeParse({ ...input, imageIds: [] }).success).toBe(false);
  expect(chatSendInputSchema.safeParse({ ...input, imageIds: [...input.imageIds, ...input.imageIds] }).success).toBe(false);
  expect(supportsImages({ provider: 'deepseek', model: 'deepseek-flash' })).toBe(true);
  expect(supportsImages({ provider: 'deepseek', model: 'deepseek-chat' })).toBe(false);
  expect(supportsImages({ provider: 'deepseek', model: 'deepseek-flash', imageInput: 'disabled' })).toBe(false);
});
it('persists BLOBs and attachment metadata without leaking pixels into chat state or raw-input export', () => {
  const { store, service, dir } = setup(), session = target(service).sessionId, photo = image();
  const id = store.append(session, 'user', '', false, 'complete', [photo]);
  expect(store.message(session, id).images?.[0]).toMatchObject({ id: photo.id, url: `pet-image://image/${photo.id}` });
  expect(store.sessionEntry(session).title).toContain('图片');
  expect(store.dataPage({ section: 'inputs', sessionId: session }).records[0]).toMatchObject({ id, text: '', images: [{ id: photo.id }] });
  expect(JSON.stringify(service.state())).not.toContain(photo.data.toString('base64'));
  const reopened = new ChatStore(dir); try { expect(reopened.message(session, id).images?.[0].sha256).toBe(photo.sha256); expect(reopened.image(photo.id)?.data).toEqual(photo.data); } finally { reopened.close(); }
});
it('rolls back message, independent user archive and all images on attachment insert failure', () => {
  const { store, service } = setup(), session = target(service).sessionId, photo = image();
  expect(() => store.append(session, 'user', '不会留下半条数据', false, 'complete', [photo, photo])).toThrow();
  expect(store.messages(session)).toEqual([]); expect(store.dataPage({ section: 'inputs' }).total).toBe(0); expect(store.image(photo.id)).toBeUndefined();
});
it('editing retains pixels under fresh IDs, regeneration keeps the original question and retract cascades attachments', async () => {
  const { store, service } = setup(), photo = image();
  service.send({ ...target(service), text: '', imageIds: [photo.id] }, [photo]); await new Promise(done => setTimeout(done, 10));
  const user = service.state().messages[0];
  service.edit({ ...target(service), messageId: user.id, text: '新的说明' }); await new Promise(done => setTimeout(done, 10));
  const edited = service.state().messages[0], newId = edited.images![0].id;
  expect(edited.text).toBe('新的说明'); expect(newId).not.toBe(photo.id); expect(store.image(photo.id)).toBeUndefined(); expect(store.image(newId)?.data).toEqual(photo.data);
  service.regenerate({ ...target(service), messageId: service.state().messages.at(-1)!.id }); await new Promise(done => setTimeout(done, 10));
  expect(service.state().messages[0].images![0].id).toBe(newId);
  service.retract({ ...target(service), messageId: edited.id }); expect(store.image(newId)).toBeUndefined(); expect(store.dataPage({ section: 'inputs' }).total).toBe(0);
});
it('only hydrates selected image blocks at the provider boundary and keeps exact raw caption', async () => {
  let captured: Parameters<Generate>[1] = [];
  const { store, service } = setup(async (_c, messages) => { captured = messages; return '{"text":"看到了"}'; }), photo = image(), caption = '  这是什么？\n';
  service.send({ ...target(service), text: caption, imageIds: [photo.id] }, [photo]); await new Promise(done => setTimeout(done, 10));
  expect(captured.at(-1)).toMatchObject({ role: 'user', content: caption, images: [{ url: `data:image/png;base64,${photo.data.toString('base64')}` }] });
  expect(store.dataPage({ section: 'inputs' }).records[0].text).toBe(caption);
});
it('rejects unsupported models before persisting input and does not silently send empty image requests', () => {
  const { service, config, store } = setup(), photo = image();
  const { hasKey: _hasKey, ...settings } = config.public(); config.save({ ...settings, imageInput: 'disabled' });
  expect(() => service.send({ ...target(service), text: '', imageIds: [photo.id] }, [photo])).toThrow('当前模型');
  expect(store.messages(target(service).sessionId)).toEqual([]);
  expect(() => service.send({ ...target(service), text: '描述图片', imageIds: [photo.id] })).toThrow('未准备完成');
});
it('selection budgets images separately from base64 tokenization, and text-only history explicitly marks unread images', () => {
  const { store, service } = setup(), photo = image(), session = target(service).sessionId;
  store.append(session, 'user', '旧图', false, 'complete', [photo]); store.append(session, 'assistant', '已看到旧图'); store.append(session, 'user', '本轮');
  const history = store.messages(session), text = prepareContext(pack, history, [], false, { imageInput: false });
  expect(text.messages.some(m => m.images?.length)).toBe(false); expect(text.messages.some(m => m.content.includes('当前模型未读取图片'))).toBe(true);
  const visual = prepareContext(pack, history, [], false, { imageInput: true });
  expect(visual.messages.find(m => m.content === '旧图')?.images).toHaveLength(1);
  expect(estimateMessages([{ role: 'user', content: '', images: [{ url: 'data:image/png;base64,' + 'x'.repeat(100000), byteLength: 10 }] }])).toBe(4107);
  const over = history.map(m => m.images ? { ...m, images: m.images.map(i => ({ ...i, byteLength: 17 * 1024 * 1024 })) } : m);
  expect(prepareContext(pack, over, [], false, { imageInput: true }).messages.some(m => m.images?.length)).toBe(false);
});
it('summary and long-memory prompts associate image blocks with source IDs; changing pixels changes source hashes', () => {
  const { store, service, dir } = setup(), photo = image(), session = target(service).sessionId;
  store.append(session, 'user', '图里是虚构角色', false, 'complete', [photo]); const history = store.messages(session);
  for (const prompt of [summaryPrompt(undefined, history), longMemoryPrompt(history)]) { expect(prompt.at(-1)?.images).toHaveLength(1); expect(prompt.at(-1)?.content).toContain(history[0].id); expect(prompt.at(-1)?.content).toContain(photo.id); }
  const hash = sourceHash(history), snapshot = store.sourceSnapshot(session, history[0].id);
  const db = new DatabaseSync(join(dir, 'chat.sqlite')); try { db.prepare('UPDATE message_images SET sha256=? WHERE id=?').run('changed', photo.id); } finally { db.close(); }
  expect(sourceHash(store.messages(session))).not.toBe(hash); expect(store.sourceSnapshot(session, history[0].id).sourceHash).not.toBe(snapshot.sourceHash);
});
