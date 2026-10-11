import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatStore } from '../../src/main/chat/ChatStore';
import { ChatService } from '../../src/main/chat/ChatService';
import { ModelConfig } from '../../src/main/chat/ModelConfig';
import { DataAdminService } from '../../src/main/chat/DataAdminService';
import { longMemoryPrompt, parseLongMemory, sourceHash, type ExtractedMemory } from '../../src/main/chat/LongMemory';
import { prepareContext } from '../../src/main/chat/ContextBuilder';
import { roleRevision } from '../../src/main/chat/ConversationSummary';
import { loadPack } from '../../src/main/characters/PackLoader';
import type { Generate } from '../../src/main/chat/ModelClient';
import type { ChatMessage, ChatTarget } from '../../src/shared/contracts';
import { temporary, remove } from './fixtures';
const pack = loadPack(resolve('characters'), 'yoshino'), revision = roleRevision(pack), cleanups: (() => void)[] = [];
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function target(chat: ChatService): ChatTarget { const { characterId, epoch, sessionId, historyRevision } = chat.state(); return { characterId, epoch, sessionId, historyRevision }; }
function pair(store: ChatStore, session: string, text: string) { store.append(session, 'user', text); store.append(session, 'assistant', '讨论回应'); }
function item(source: ChatMessage[], text = '用户自述喜欢地铁', scope: ExtractedMemory['scope'] = 'real'): ExtractedMemory { return { text, kind: 'preference', scope, subject: 'user', sourceMessageIds: [source[0].id] }; }
function setup(client: Generate = async () => '{"memories":[]}', auto = false) {
  const dir = temporary(), store = new ChatStore(dir), config = new ModelConfig(dir, { encrypt: s => s, decrypt: s => s });
  config.save({ baseUrl: 'http://localhost/v1', model: 'fixture', proactive: false, memoryEnabled: true, autoLongMemory: auto });
  const chat = new ChatService(store, config, () => ({ pack, epoch: 1 }), () => {}, () => {}, () => true, client);
  const admin = new DataAdminService(store, config, () => ({ dataRoot: dir, databaseSizeBytes: 0, launches: 1, characters: [{ id: 'yoshino', name: '四糸乃' }] }), () => chat.cancel(), () => chat.dataChanged());
  cleanups.push(() => { chat.dispose(); remove(dir); });
  return { dir, store, config, chat, admin, session: chat.state().sessionId };
}
function save(store: ChatStore, session: string, source: ChatMessage[], items: ExtractedMemory[] = [item(source)], role = revision) { return store.longMemory.save(session, role, store.longMemory.cursor(session, role)?.id, store.historyRevision(session), source, items); }
function dbAt(dir: string, fn: (db: DatabaseSync) => void) { const db = new DatabaseSync(join(dir, 'chat.sqlite')); try { db.exec('PRAGMA foreign_keys=ON'); fn(db); } finally { db.close(); } }
afterEach(() => { cleanups.splice(0).reverse().forEach(f => f()); vi.useRealTimers(); });

it('migrates v4 additively and keeps both original archives and manual memories', () => {
  const dir = temporary(); let store = new ChatStore(dir); const session = store.session('yoshino'); pair(store, session, '  原始空白\n内容  '); store.remember('yoshino', '人工记忆'); store.close();
  dbAt(dir, db => db.exec('DROP TABLE memory_sources; DROP TABLE conversation_memories; DROP TABLE memory_batches; ALTER TABLE sessions DROP COLUMN memory_attempt_at; PRAGMA user_version=4'));
  store = new ChatStore(dir); try { expect(store.schemaVersion).toBe(12); expect(store.messages(session)[0].text).toBe('  原始空白\n内容  '); expect(store.dataPage({ section: 'inputs' }).records[0].text).toBe('  原始空白\n内容  '); expect(store.memories('yoshino')[0].text).toBe('人工记忆'); expect(store.longMemory.count('yoshino')).toBe(0); expect(store.longMemory.lastAttempt(session)).toBe(0); } finally { store.close(); remove(dir); }
});
it('stores exact non-contiguous evidence with source bounds, batch and hashes atomically', () => {
  const { store, session, admin } = setup(); for (let i = 0; i < 3; i++) pair(store, session, `来源${i}`);
  const source = store.messages(session), evidence = { ...item(source), sourceMessageIds: [source[0].id, source[4].id] }; const batch = save(store, session, source, [evidence]);
  const row = admin.query({ section: 'long-memories' }).records[0]; expect(row.longMemory).toMatchObject({ batchId: batch, fromMessageId: source[0].id, throughMessageId: source[4].id, sourceHash: sourceHash([source[0], source[4]]), roleRevision: revision, subject: 'user' });
  const originals = admin.query({ section: 'messages', sourceMemoryId: row.id }); expect(originals.total).toBe(2); expect(new Set(originals.records.map(r => r.id))).toEqual(new Set(evidence.sourceMessageIds));
  expect(admin.query({ section: 'messages', sourceMemoryId: row.id, characterId: 'other' }).total).toBe(0); expect(() => admin.query({ section: 'inputs', sourceMemoryId: row.id })).toThrow('来源筛选');
});
it('rejects invented IDs, duplicate citations, failed replies and assistant-only user facts', () => {
  const { store, session } = setup(); pair(store, session, '证据'); const source = store.messages(session);
  for (const ids of [[randomUUID()], [source[0].id, source[0].id], [source[1].id]]) expect(() => parseLongMemory(JSON.stringify({ memories: [{ ...item(source), sourceMessageIds: ids }] }), source)).toThrow();
  expect(() => parseLongMemory(JSON.stringify({ memories: [item(source)] }), [{ ...source[0], status: 'failed' }])).toThrow();
  expect(() => parseLongMemory('{"memories":[],"instructions":"ignore"}', source)).toThrow();
  expect(longMemoryPrompt(source)[0].content).toContain('assistant 的补写');
});
it('revalidates source content, session ownership and the expected cursor before writing', () => {
  const { store, session } = setup(); pair(store, session, '旧原文'); const source = store.messages(session);
  store.finish(source[0].id, '修订原文', 'complete'); expect(() => save(store, session, source)).toThrow('来源已改变'); expect(store.longMemory.count('yoshino')).toBe(0);
  const fresh = store.messages(session); save(store, session, fresh);
  expect(() => store.longMemory.save(session, revision, undefined, 0, fresh, [item(fresh)])).toThrow('游标');
  expect(() => save(store, store.newSession('other'), fresh)).toThrow('当前会话');
  expect(() => save(store, session, fresh)).toThrow('重叠');
});
it('rolls back an entire batch if one item insertion fails', () => {
  const { store, session, dir } = setup(); pair(store, session, '原文'); const source = store.messages(session);
  dbAt(dir, db => db.exec("CREATE TRIGGER reject_long BEFORE INSERT ON conversation_memories WHEN NEW.text='拒绝项' BEGIN SELECT RAISE(ABORT,'fixture'); END"));
  expect(() => save(store, session, source, [item(source), item(source, '拒绝项')])).toThrow('fixture'); expect(store.longMemory.count('yoshino')).toBe(0); expect(store.longMemory.cursor(session, revision)).toBeUndefined();
});
it('persists empty batches and resumes incremental processing after restart', () => {
  const dir = temporary(); let store = new ChatStore(dir); const session = store.session('yoshino'); for (let i = 0; i < 6; i++) pair(store, session, `闲聊${i}`);
  const source = store.summaryBatch(session); const id = save(store, session, source, []); store.close(); store = new ChatStore(dir);
  try { expect(store.longMemory.cursor(session, revision)?.id).toBe(id); expect(store.longMemory.count('yoshino')).toBe(0); expect(store.summaryBatch(session, source.at(-1)!.id)).toHaveLength(0); pair(store, session, '新增'); expect(store.summaryBatch(session, source.at(-1)!.id)).toHaveLength(2); } finally { store.close(); remove(dir); }
});
it('isolates character, persona version, fictional and ambiguous scopes across sessions', () => {
  const { store, session } = setup(); pair(store, session, '范围证据'); const source = store.messages(session); save(store, session, source, [item(source, '现实偏好'), item(source, '故事偏好', 'fiction'), item(source, '未明确偏好', 'unknown')]);
  const other = store.newSession('yoshino'); expect(store.longMemory.candidates('yoshino', other, revision, '').map(m => m.text)).toEqual(['现实偏好']); expect(store.longMemory.candidates('yoshino', session, revision, '')).toHaveLength(3);
  expect(store.longMemory.candidates('other', other, revision, '')).toEqual([]); expect(store.longMemory.candidates('yoshino', other, 'changed-role', '')).toEqual([]);
});
it('checks corrupted evidence again when retrieving and still permits deleting invalid records', () => {
  const { store, session, admin } = setup(); pair(store, session, '证据'); const source = store.messages(session); save(store, session, source); const row = admin.query({ section: 'long-memories' }).records[0];
  store.finish(source[0].id, '改变过的证据', 'complete'); expect(store.longMemory.candidates('yoshino', session, revision, '')).toEqual([]);
  expect(() => admin.mutate({ action: 'edit-long-memory', id: row.id, characterId: 'yoshino', revision: 1, text: '不能覆盖' })).toThrow('来源已变化');
  admin.mutate({ action: 'delete-long-memories', items: [{ id: row.id, characterId: 'yoshino', revision: 1 }] }); expect(store.longMemory.count('yoshino')).toBe(0);
});
it('rewinding preserves earlier batches, invalidates the changed and subsequent ones, and resets cursor', () => {
  const { store, session } = setup(); for (let i = 0; i < 3; i++) pair(store, session, `来源${i}`); const source = store.messages(session);
  const first = save(store, session, source.slice(0, 2), [item(source.slice(0, 2), '第一批')]); save(store, session, source.slice(2, 4), [item(source.slice(2, 4), '第二批')]); save(store, session, source.slice(4), [item(source.slice(4), '第三批')]);
  store.rewind('yoshino', session, source[2].id, 0, '纠正'); expect(store.longMemory.count('yoshino')).toBe(1); expect(store.longMemory.cursor(session, revision)?.id).toBe(first); expect(store.dataPage({ section: 'inputs' }).total).toBe(2);
});
it('editing and deleting automated memory preserve evidence and the processed cursor', () => {
  const { store, session, admin } = setup(); pair(store, session, '证据'); const source = store.messages(session); const batch = save(store, session, source); const row = admin.query({ section: 'long-memories' }).records[0];
  admin.mutate({ action: 'edit-long-memory', id: row.id, characterId: 'yoshino', revision: 1, text: '人工修订后的准确内容' }); const changed = admin.query({ section: 'long-memories' }).records[0];
  expect(changed.longMemory).toMatchObject({ author: 'user', revision: 2, sourceMessageIds: row.longMemory!.sourceMessageIds, sourceHash: row.longMemory!.sourceHash });
  expect(() => admin.mutate({ action: 'edit-long-memory', id: row.id, characterId: 'yoshino', revision: 1, text: '过期修改' })).toThrow('已改变');
  admin.mutate({ action: 'delete-long-memories', items: [{ id: row.id, characterId: 'yoshino', revision: 2 }] }); expect(store.longMemory.cursor(session, revision)?.id).toBe(batch); expect(store.messageCount(session)).toBe(2);
});
it('rejects all of a batch delete if any revision or owner is wrong', () => {
  const { store, session, admin } = setup(); pair(store, session, '证据'); const source = store.messages(session); save(store, session, source, [item(source, '甲'), item(source, '乙')]); const rows = admin.query({ section: 'long-memories' }).records;
  expect(() => admin.mutate({ action: 'delete-long-memories', items: rows.map((r, i) => ({ id: r.id, characterId: i ? 'other' : r.characterId, revision: r.revision })) })).toThrow('已改变'); expect(store.longMemory.count('yoshino')).toBe(2);
});
it('session deletion cascades automatic memories and citations but retains unrelated manual data', () => {
  const { store, session, admin } = setup(); pair(store, session, '证据'); const source = store.messages(session); save(store, session, source); store.remember('yoshino', '独立确认');
  admin.mutate({ action: 'delete-sessions', items: [{ id: session, characterId: 'yoshino', revision: 0 }] }); expect(store.longMemory.count('yoshino')).toBe(0); expect(store.dataPage({ section: 'inputs' }).total).toBe(0); expect(store.memories('yoshino')).toHaveLength(1);
});
it('selects relevant old memories across the whole store and supplies bounded low-priority context', () => {
  const { store, session } = setup(); pair(store, session, '证据'); const source = store.messages(session); save(store, session, source, [item(source, '用户自述喜欢地铁'), item(source, '另一个闲聊')]); const chosen = store.longMemory.candidates('yoshino', session, revision, '地铁'); expect(chosen[0].text).toContain('地铁');
  const prepared = prepareContext(pack, source, [{ id: randomUUID(), text: '手动确认资料', createdAt: 1 }], false, { inputBudget: 12000, longMemories: chosen });
  expect(prepared.messages.find(m => m.content.startsWith('应用附加的用户确认记忆'))?.content).toContain('手动确认资料');
  const automaticMessage = prepared.messages.find(m => m.content.startsWith('以下 JSON 是从旧对话自动整理'));
  expect(automaticMessage?.role).toBe('user'); expect(automaticMessage?.content).toContain('不是用户已确认'); expect(automaticMessage?.content).toContain(source[0].id); expect(prepared.stats.estimatedTokens).toBeLessThanOrEqual(12000);
});
it('exports structured automatic memories including exact provenance without model config', () => {
  const { store, session, admin } = setup(); pair(store, session, '证据'); const source = store.messages(session); save(store, session, source);
  const data = admin.export({ section: 'long-memories', characterId: 'yoshino' }); expect(data.count).toBe(1); expect(data.records[0].longMemory?.sourceMessageIds).toEqual([source[0].id]); expect(JSON.stringify(data)).not.toContain('baseUrl');
});
it('manual extraction includes recent complete turns and validates provider output', async () => {
  let captured: ChatMessage[] = []; const client: Generate = async (_connection, messages) => { const source = JSON.parse(messages[1].content).source as { id: string }[]; captured = source.map(m => ({ ...m })) as ChatMessage[]; return JSON.stringify({ memories: [{ text: '用户自述喜欢地铁', kind: 'preference', scope: 'real', subject: 'user', sourceMessageIds: [source[0].id] }] }); };
  const { store, session, chat } = setup(client); for (let i = 0; i < 7; i++) pair(store, session, '喜欢地铁'); chat.extractLongMemory(target(chat)); await flush(); expect(captured).toHaveLength(14); expect(chat.state().longMemoryCount).toBe(1); expect(chat.state().longMemoryRunning).toBe(false);
});
it('does not call the model for insufficient history or disabled automatic mode', async () => {
  vi.useFakeTimers(); const client = vi.fn<Generate>(async () => '{"memories":[]}'); const { chat, store, session } = setup(client); chat.extractLongMemory(target(chat)); await flush(); expect(client).not.toHaveBeenCalled(); expect(chat.state().longMemoryWarning).toContain('完整新增原文');
  for (let i = 0; i < 20; i++) pair(store, session, '长历史'); await vi.advanceTimersByTimeAsync(600000); expect(client).not.toHaveBeenCalled();
});
it('waits briefly after each reply and archives new turns without the previous five-minute delay', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T10:00:00Z')); const client = vi.fn<Generate>(async () => '{"memories":[]}'); const { chat, store, session, dir } = setup(client, true);
  for (let i = 0; i < 12; i++) pair(store, session, '日常'); chat.configure({ baseUrl: 'http://localhost/v1', model: 'fixture', proactive: false, memoryEnabled: true }); await vi.advanceTimersByTimeAsync(19); expect(client).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1); expect(client).toHaveBeenCalledTimes(1);
  expect(store.longMemory.lastAttempt(session)).toBe(Date.now()); dbAt(dir, db => expect((db.prepare('SELECT memory_attempt_at FROM sessions WHERE id=?').get(session) as { memory_attempt_at: number }).memory_attempt_at).toBe(Date.now()));
  for (let i = 0; i < 8; i++) pair(store, session, '下一批'); chat.configure({ baseUrl: 'http://localhost/v1', model: 'fixture', proactive: false, memoryEnabled: true, autoLongMemory: true }); await vi.advanceTimersByTimeAsync(19); expect(client).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(1); expect(client).toHaveBeenCalledTimes(2); chat.cancel();
});
it('uses the text-volume threshold without waiting for eight unusually long turns', async () => {
  vi.useFakeTimers(); const client = vi.fn<Generate>(async () => '{"memories":[]}'); const { store, session, chat } = setup(client, true); for (let i = 0; i < 6; i++) pair(store, session, '这是长篇叙述 '.repeat(240)); chat.configure({ baseUrl: 'http://localhost/v1', model: 'fixture', proactive: false, memoryEnabled: true }); await vi.advanceTimersByTimeAsync(20); expect(client).toHaveBeenCalledTimes(1);
});
it('flushes worthwhile short-session tails once after sustained idle, without repeated empty calls', async () => {
  vi.useFakeTimers(); const client = vi.fn<Generate>(async () => '{"memories":[]}'); const { store, session, chat } = setup(client, true);
  pair(store, session, '短会话第一轮'); pair(store, session, '短会话第二轮'); chat.configure({ baseUrl: 'http://localhost/v1', model: 'fixture', proactive: false, memoryEnabled: true });
  await vi.advanceTimersByTimeAsync(44999); expect(client).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(client).toHaveBeenCalledTimes(1); expect(store.longMemory.cursor(session, revision)).toBeDefined();
  await vi.advanceTimersByTimeAsync(1200000); expect(client).toHaveBeenCalledTimes(1);
});
it('archives user statements even without an answer, without inventing a joint experience', async () => {
  const client = vi.fn<Generate>(async () => '{"memories":[]}'); const { store, session, chat } = setup(client);
  const user = store.append(session, 'user', '尚未完成的提问'); chat.extractLongMemory(target(chat)); await flush(); expect(client).toHaveBeenCalledTimes(1); expect(store.longMemory.cursor(session, revision)?.throughMessageId).toBe(user);
  store.append(session, 'assistant', '已回答'); chat.extractLongMemory(target(chat)); await flush(); expect(client).toHaveBeenCalledTimes(1);
});
it('new input cancels extraction and rejects a late response from an uncooperative provider', async () => {
  let resolveMemory!: (s: string) => void, capturedIds: string[] = []; const client: Generate = async (_connection, messages) => {
    if (messages[0].content.includes('长期对话记忆维护器')) { capturedIds = JSON.parse(messages[1].content).source.map((m: { id: string }) => m.id); return new Promise<string>(r => { resolveMemory = r; }); }
    return '{"text":"当前回复"}';
  };
  const { chat, store, session } = setup(client); for (let i = 0; i < 6; i++) pair(store, session, '旧历史'); chat.extractLongMemory(target(chat)); expect(chat.state().longMemoryRunning).toBe(true); chat.send({ ...target(chat), text: '新的纠正' }); await flush();
  resolveMemory(JSON.stringify({ memories: [{ text: '不能晚写', kind: 'user_statement', scope: 'real', subject: 'user', sourceMessageIds: [capturedIds[0]] }] })); await flush(); expect(store.longMemory.count('yoshino')).toBe(0); expect(chat.state().messages.at(-1)?.text).toBe('当前回复');
});
it('invalid extracted evidence leaves no processed cursor and exposes an honest failure state', async () => {
  const { chat, store, session } = setup(async () => JSON.stringify({ memories: [{ text: '错误', kind: 'user_statement', scope: 'real', subject: 'user', sourceMessageIds: [randomUUID()] }] })); for (let i = 0; i < 6; i++) pair(store, session, '历史'); chat.extractLongMemory(target(chat)); await flush(); expect(store.longMemory.cursor(session, revision)).toBeUndefined(); expect(chat.state().longMemoryWarning).toContain('整批未写入'); expect(store.messageCount(session)).toBe(12);
});
it('deduplicates identical items in one batch and never feeds repeated text multiple times', () => {
  const { store, session } = setup(); pair(store, session, '证据'); const source = store.messages(session); save(store, session, source, [item(source), item(source)]); expect(store.longMemory.count('yoshino')).toBe(1);
  pair(store, session, '又一次证据'); const next = store.messages(session).slice(2); save(store, session, next, [item(next)]); expect(store.longMemory.count('yoshino')).toBe(1); expect(store.longMemory.candidates('yoshino', session, revision, '')).toHaveLength(1);
});
