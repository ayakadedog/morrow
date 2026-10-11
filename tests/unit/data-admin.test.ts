import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatStore } from '../../src/main/chat/ChatStore';
import { ChatService } from '../../src/main/chat/ChatService';
import { DataAdminService } from '../../src/main/chat/DataAdminService';
import { ModelConfig } from '../../src/main/chat/ModelConfig';
import { loadPack } from '../../src/main/characters/PackLoader';
import { roleRevision } from '../../src/main/chat/ConversationSummary';
import type { Generate } from '../../src/main/chat/ModelClient';
import { temporary, remove } from './fixtures';
const pack = loadPack(resolve('characters'), 'yoshino'), cleanups: (() => void)[] = [];
const summaryData = { events: ['旧城市经历'], userStatements: ['我喜欢地铁'], fictionalState: [], uncertainties: ['可能搬家'], commitments: [], openQuestions: [], keyQuotes: [] };
function setup(client: Generate = async () => '{"text":"回答"}') {
  const dir = temporary(), store = new ChatStore(dir), config = new ModelConfig(dir, { encrypt: s => s, decrypt: s => s });
  config.save({ baseUrl: 'http://localhost/v1', model: 'fixture', apiKey: 'fixture-hidden', proactive: false, memoryEnabled: true });
  const delivered: string[] = []; let before = 0;
  const chat = new ChatService(store, config, () => ({ pack, epoch: 1 }), () => {}, reply => delivered.push(reply.text), () => true, client);
  const admin = new DataAdminService(store, config, () => ({ dataRoot: dir, databaseSizeBytes: 10, launches: 3, characters: [{ id: 'yoshino', name: '四糸乃' }] }), () => { before++; chat.cancel(); }, () => chat.dataChanged());
  cleanups.push(() => { chat.dispose(); remove(dir); });
  const session = chat.state().sessionId;
  return { dir, store, config, chat, admin, session, delivered, before: () => before };
}
function pair(store: ChatStore, session: string, text: string) { const user = store.append(session, 'user', text), assistant = store.append(session, 'assistant', '回答'); return { user, assistant }; }
function saveSummary(store: ChatStore, session: string, through: string) { store.saveSummary(session, roleRevision(pack), through, summaryData, 0, store.sourceSnapshot(session, through)); }
function sql(dir: string, run: (db: DatabaseSync) => void) { const db = new DatabaseSync(join(dir, 'chat.sqlite')); try { db.exec('PRAGMA foreign_keys=ON'); run(db); } finally { db.close(); } }
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()));
it('overview aggregates installed and orphan roles without exposing model credentials', () => {
  const { admin, store, session } = setup(); pair(store, session, '现实原文'); pair(store, store.newSession('orphan'), '另一个角色'); store.remember('yoshino', '偏好');
  const info = admin.overview(); expect(info.schemaVersion).toBe(12); expect(info.counts).toEqual({ 'long-memories': 0, memories: 1, messages: 4, inputs: 2, summaries: 0, sessions: 2 }); expect(info.roles.find(r => r.id === 'orphan')?.installed).toBe(false); expect(JSON.stringify(info)).not.toContain('fixture-hidden');
});
it('session cards expose only their own title, timestamps and record counts', () => {
  const { store, session, admin } = setup(); const first = pair(store, session, '会话甲 %_\n第一条输入'); pair(store, session, '甲后续');
  const other = store.newSession('yoshino'); pair(store, other, '会话乙的独立内容');
  store.longMemory.save(session, roleRevision(pack), undefined, 0, store.messages(session), [{ text: '用户甲的资料', kind: 'user_statement', scope: 'real', subject: 'user', sourceMessageIds: [first.user] }]); saveSummary(store, session, first.assistant);
  const cards = admin.query({ section: 'sessions', characterId: 'yoshino' }).records;
  expect(cards.find(r => r.id === session)).toMatchObject({ sessionTitle: '会话甲 %_ 第一条输入', messageCount: 4, inputCount: 2, longMemoryCount: 1, hasSummary: true });
  expect(cards.find(r => r.id === other)).toMatchObject({ sessionTitle: '会话乙的独立内容', messageCount: 2, inputCount: 1, longMemoryCount: 0, hasSummary: false });
  expect(cards.find(r => r.id === session)?.lastMessageAt).toBe(store.messages(session).at(-1)?.createdAt);
  expect(admin.query({ section: 'sessions', query: '%_' }).records.map(r => r.id)).toEqual([session]);
  expect(admin.query({ section: 'sessions', characterId: 'other', sessionId: session }).total).toBe(0);
});
it('single-session queries, searches and exports never merge another session', () => {
  const { store, session, admin } = setup(); for (let i = 0; i < 52; i++) pair(store, session, `共同关键词甲${i}`); const other = store.newSession('yoshino'); pair(store, other, '共同关键词乙');
  const page = admin.query({ section: 'inputs', characterId: 'yoshino', sessionId: session, query: '共同关键词' }), older = admin.query({ section: 'inputs', sessionId: session, before: page.nextBefore });
  expect(page.total).toBe(52); expect(page.records).toHaveLength(50); expect(older.records).toHaveLength(2); expect([...page.records, ...older.records].every(r => r.sessionId === session)).toBe(true);
  const exported = admin.export({ section: 'messages', characterId: 'yoshino', sessionId: other }); expect(exported.count).toBe(2); expect(exported.records.every(r => r.sessionId === other)).toBe(true);
});
it('derived session titles update after first-input revision without renaming or moving records', () => {
  const { store, session, admin } = setup(); const first = pair(store, session, '修改前标题'); const other = store.newSession('yoshino'); pair(store, other, '另一会话');
  admin.mutate({ action: 'edit-input', characterId: 'yoshino', sessionId: session, id: first.user, revision: 0, text: '修改后的标题' });
  expect(admin.query({ section: 'sessions', sessionId: session }).records[0]).toMatchObject({ sessionTitle: '修改后的标题', revision: 1, messageCount: 1, inputCount: 1 });
  expect(admin.query({ section: 'sessions', sessionId: other }).records[0].sessionTitle).toBe('另一会话');
  const empty = store.newSession('yoshino'); expect(admin.query({ section: 'sessions', sessionId: empty }).records[0]).toMatchObject({ sessionTitle: expect.stringContaining('新对话'), messageCount: 0, inputCount: 0, lastMessageAt: undefined });
});
it('manual names survive new messages, source revision and restart without changing history or memories', () => {
  const { admin, store, dir, session } = setup(), first = pair(store, session, '自动主题'); store.remember('yoshino', '用户偏好'); saveSummary(store, session, first.assistant);
  const row = admin.query({ section: 'sessions', sessionId: session }).records[0];
  admin.mutate({ action: 'rename-session', characterId: 'yoshino', id: session, titleRevision: row.titleRevision!, title: '  上海搬家与通勤  ' });
  expect(store.historyRevision(session)).toBe(0); expect(store.summary(session, roleRevision(pack))).toBeDefined(); expect(store.memories('yoshino')).toHaveLength(1);
  pair(store, session, '后续对话'); admin.mutate({ action: 'edit-input', characterId: 'yoshino', sessionId: session, id: first.user, revision: 0, text: '改了第一条内容' });
  expect(store.sessionEntry(session).title).toBe('上海搬家与通勤');
  const reopened = new ChatStore(dir); try { expect(reopened.sessionEntry(session)).toMatchObject({ title: '上海搬家与通勤', titleRevision: row.titleRevision! + 1 }); expect(reopened.dataPage({ section: 'sessions', query: '搬家' }).records[0].titleSource).toBe('manual'); } finally { reopened.close(); }
});
it('admin numbered pagination can jump directly, filters total correctly and exports every page', () => {
  const { admin, store, session } = setup(); for (let i = 0; i < 123; i++) pair(store, session, `分页甲 ${i}`); const other = store.newSession('other'); pair(store, other, '分页乙');
  const scope = { section: 'inputs' as const, characterId: 'yoshino', sessionId: session, query: '分页甲' };
  const first = admin.query(scope), last = admin.query({ ...scope, offset: 100 }); expect(first.total).toBe(123); expect(last.records).toHaveLength(23); expect(last.hasMore).toBe(false); expect(first.records.map(r => r.id).some(id => last.records.some(r => r.id === id))).toBe(false);
  expect(admin.query({ ...scope, offset: 500 }).records).toEqual([]); expect(admin.export(scope).count).toBe(123);
  expect(() => admin.query({ ...scope, offset: -1 })).toThrow(); expect(() => admin.query({ ...scope, offset: 20, before: 40 })).toThrow(); expect(() => admin.export({ ...scope, offset: 50 } as never)).toThrow();
});
it('rename validates ownership, an independent name version and empty or unsafe names', () => {
  const { admin, store, session, before } = setup(); pair(store, session, '自动标题'); const row = admin.query({ section: 'sessions', sessionId: session }).records[0];
  const input = { action: 'rename-session' as const, characterId: 'yoshino', id: session, titleRevision: row.titleRevision!, title: '自定义名称' };
  expect(() => admin.mutate({ ...input, characterId: 'other' })).toThrow('已改变'); expect(() => admin.mutate({ ...input, title: ' ' })).toThrow(); expect(() => admin.mutate({ ...input, title: '包含\n换行' })).toThrow();
  admin.mutate(input); expect(before()).toBe(0); expect(() => admin.mutate({ ...input, title: '迟到名称' })).toThrow('已改变'); expect(store.sessionEntry(session).title).toBe('自定义名称');
});
it('name fragments, literal wildcards, role, date and empty-session filters combine over all pages and exports', () => {
  const { admin, store, dir, session } = setup(); pair(store, session, '上海路线 %_');
  const second = store.newSession('yoshino'); pair(store, second, '北京路线'); const empty = store.newSession('yoshino'), other = store.newSession('other'); pair(store, other, '上海路线');
  sql(dir, db => { db.prepare('UPDATE sessions SET created_at=? WHERE id IN (?,?)').run(1000, session, empty); db.prepare('UPDATE sessions SET created_at=? WHERE id=?').run(2000, second); });
  const scope = { section: 'sessions' as const, characterId: 'yoshino', query: '路线', createdFrom: 1000, createdBefore: 2000, sessionContent: 'with-messages' as const };
  expect(admin.query(scope).records.map(row => row.id)).toEqual([session]); expect(admin.export(scope).records.map(row => row.id)).toEqual([session]);
  expect(admin.query({ section: 'sessions', query: '%_' }).records.map(row => row.id)).toEqual([session]); expect(admin.query({ section: 'sessions', query: '上海' }).total).toBe(2);
  expect(admin.query({ section: 'sessions', sessionContent: 'empty' }).records.map(row => row.id)).toEqual([empty]);
  expect(() => admin.query({ section: 'sessions', createdFrom: 2000, createdBefore: 1000 })).toThrow(); expect(() => admin.query({ section: 'inputs', sessionContent: 'empty' })).toThrow();
});
it('v5 names migrate from first input once, preserve all original fields and retain manual names after restart', () => {
  const dir = temporary(); let store = new ChatStore(dir); const session = store.newSession('yoshino'); pair(store, session, '  旧会话\n上海搬家  '); store.close();
  sql(dir, db => db.exec('ALTER TABLE sessions DROP COLUMN title; ALTER TABLE sessions DROP COLUMN title_source; ALTER TABLE sessions DROP COLUMN title_revision; PRAGMA user_version=5'));
  let oldRows: unknown; sql(dir, db => { oldRows = db.prepare('SELECT id,character_id,created_at,history_revision,memory_attempt_at FROM sessions').all(); });
  store = new ChatStore(dir); try { expect(store.schemaVersion).toBe(12); expect(store.sessionEntry(session).title).toBe('旧会话 上海搬家'); expect(store.messages(session)[0].text).toBe('  旧会话\n上海搬家  '); sql(dir, db => expect(db.prepare('SELECT id,character_id,created_at,history_revision,memory_attempt_at FROM sessions').all()).toEqual(oldRows)); } finally { store.close(); remove(dir); }
});
it('renaming during generation leaves the answer running and changes neither the source history nor pending reply', async () => {
  let complete!: (s: string) => void; const { admin, chat, store, delivered } = setup(() => new Promise(resolve => complete = resolve));
  const { characterId, epoch, sessionId, historyRevision } = chat.state(); chat.send({ characterId, epoch, sessionId, historyRevision, text: '等待回复' });
  const row = admin.query({ section: 'sessions', sessionId }).records[0]; admin.mutate({ action: 'rename-session', characterId, id: sessionId, titleRevision: row.titleRevision!, title: '新名称' });
  expect(chat.state().busy).toBe(true); complete('{"text":"正常完成的回答"}'); for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(delivered).toEqual(['正常完成的回答']); expect(store.historyRevision(sessionId)).toBe(0); expect(store.sessionEntry(sessionId).title).toBe('新名称');
});
it('stable pages retain every same-time message, literal searches and source ownership', () => {
  const { admin, store, session } = setup(); for (let i = 0; i < 56; i++) pair(store, session, `同日 ${i}`);
  const a = admin.query({ section: 'inputs', characterId: 'yoshino' }), b = admin.query({ section: 'inputs', characterId: 'yoshino', before: a.nextBefore });
  expect(a.records).toHaveLength(50); expect(b.records).toHaveLength(6); expect(new Set([...a.records, ...b.records].map(r => r.id)).size).toBe(56);
  pair(store, session, '字面%_引号\''); expect(admin.query({ section: 'messages', query: '%_' }).records).toHaveLength(1); expect(admin.query({ section: 'messages', query: "' OR 1=1 --" }).records).toHaveLength(0);
  expect(admin.query({ section: 'inputs', characterId: 'other' }).total).toBe(0); expect(admin.query({ section: 'inputs', sessionId: randomUUID() }).total).toBe(0);
});
it('memory correction retains identity/source and increments revision, invalidates dependent summaries and rejects stale or cross-role forms', () => {
  const { admin, store, session } = setup(), first = pair(store, session, '住上海'); store.remember('yoshino', '住上海', first.user); saveSummary(store, session, first.assistant);
  const memory = admin.query({ section: 'memories' }).records[0]; admin.mutate({ action: 'edit-memory', characterId: 'yoshino', id: memory.id, revision: memory.revision, text: '  常住北京  ' });
  const after = admin.query({ section: 'memories' }).records[0]; expect(after).toMatchObject({ id: memory.id, createdAt: memory.createdAt, sourceMessageId: first.user, text: '常住北京', revision: 2 }); expect(after.updatedAt).toBeGreaterThanOrEqual(memory.createdAt); expect(store.summary(session, roleRevision(pack))).toBeUndefined(); expect(store.message(session, first.user).text).toBe('住上海');
  expect(() => admin.mutate({ action: 'edit-memory', characterId: 'yoshino', id: memory.id, revision: 1, text: '迟到' })).toThrow('已改变'); expect(() => admin.mutate({ action: 'edit-memory', characterId: 'other', id: memory.id, revision: 2, text: '串角色' })).toThrow('已改变');
});
it('batch validation prevents partial deletion and detects duplicate targets', () => {
  const { admin, store } = setup(); store.remember('yoshino', '一'); store.remember('yoshino', '二'); const rows = admin.query({ section: 'memories' }).records;
  const items = rows.map(r => ({ id: r.id, characterId: r.characterId, revision: r.revision })); expect(() => admin.mutate({ action: 'delete-memories', items: [items[0], { ...items[1], revision: 20 }] })).toThrow('已改变'); expect(store.memories('yoshino')).toHaveLength(2);
  expect(() => admin.mutate({ action: 'delete-memories', items: [items[0], items[0]] })).toThrow();
});
it('a mid-transaction deletion fault rolls back earlier deletions', () => {
  const { admin, store, dir } = setup(); store.remember('yoshino', '保留一'); store.remember('yoshino', '保留二'); const rows = admin.query({ section: 'memories' }).records;
  sql(dir, db => db.exec(`CREATE TRIGGER fail_second BEFORE DELETE ON memories WHEN OLD.id='${rows[1].id}' BEGIN SELECT RAISE(ABORT,'fixture deletion failure'); END`));
  expect(() => admin.mutate({ action: 'delete-memories', items: rows.map(r => ({ id: r.id, characterId: r.characterId, revision: r.revision })) })).toThrow('fixture deletion failure'); expect(store.memories('yoshino')).toHaveLength(2);
});
it('input revision updates both archives without calling the model, removes dependent tail/source memories and rejects stale history', () => {
  let calls = 0; const { admin, store, session, chat } = setup(async () => { calls++; return '{"text":"never"}'; }); const first = pair(store, session, '旧用户输入'); pair(store, session, '后文'); store.remember('yoshino', '旧用户输入', first.user); store.remember('yoshino', '独立偏好');
  const row = admin.query({ section: 'inputs', query: first.user }).records[0], raw = '  新的输入\n保持空白。  ';
  admin.mutate({ action: 'edit-input', characterId: row.characterId, sessionId: session, id: row.id, revision: row.revision, text: raw });
  expect(calls).toBe(0); expect(chat.state().messages.map(m => m.text)).toEqual([raw]); const archive = admin.query({ section: 'inputs', sessionId: session }).records; expect(archive.map(r => r.text)).toEqual([raw]); expect(archive[0].id).not.toBe(first.user); expect(store.memories('yoshino').map(m => m.text)).toEqual(['独立偏好']);
  expect(() => admin.mutate({ action: 'retract-message', characterId: row.characterId, sessionId: session, id: archive[0].id, revision: 0 })).toThrow('已改变');
});
it('deleting the current session cascades sources and recovers a valid active conversation without touching another role', () => {
  const { admin, store, session, chat } = setup(), first = pair(store, session, '来源'), other = store.newSession('other'); pair(store, other, '角色独立'); store.remember('yoshino', '来源', first.user); store.remember('yoshino', '独立手写'); saveSummary(store, session, first.assistant);
  admin.mutate({ action: 'delete-sessions', items: [{ characterId: 'yoshino', id: session, revision: 0 }] }); const current = chat.state(); expect(current.sessionId).not.toBe(session); expect(current.messages).toEqual([]); expect(store.ownsSession('yoshino', current.sessionId)).toBe(true); expect(store.messages(other)).toHaveLength(2); expect(admin.query({ section: 'inputs', sessionId: session }).total).toBe(0); expect(store.memories('yoshino').map(m => m.text)).toEqual(['独立手写']);
});
it('manual summaries persist their author and version, preserve coverage, reject stale edits and a discarded/recreated same revision', () => {
  const { admin, store, session } = setup(), first = pair(store, session, '用户消息'); saveSummary(store, session, first.assistant);
  const old = admin.query({ section: 'summaries' }).records[0]; admin.mutate({ action: 'edit-summary', characterId: 'yoshino', sessionId: session, revision: old.revision, stamp: old.stamp!, data: { ...summaryData, userStatements: ['用户人工纠正'] } });
  const saved = store.summary(session, roleRevision(pack))!; expect(saved.author).toBe('user'); expect(saved.revision).toBe(2); expect(saved.sourceHash).toBe(old.summary!.sourceHash); expect(saved.throughMessageId).toBe(first.assistant);
  expect(() => admin.mutate({ action: 'discard-summary', characterId: 'yoshino', sessionId: session, revision: old.revision, stamp: old.stamp! })).toThrow('已改变');
  store.discardSummary(session); store.saveSummary(session, roleRevision(pack), first.assistant, { ...summaryData, events: ['重新整理'] }, 0, store.sourceSnapshot(session, first.assistant));
  expect(() => admin.mutate({ action: 'edit-summary', characterId: 'yoshino', sessionId: session, revision: 1, stamp: old.stamp!, data: summaryData })).toThrow('已改变');
});
it('filtered exports include all pages and no model configuration or credentials', () => {
  const { admin, store, session } = setup(); for (let i = 0; i < 55; i++) pair(store, session, `可导出 ${i}`); pair(store, store.newSession('other'), '不可串入');
  const exported = admin.export({ section: 'inputs', characterId: 'yoshino', query: '可导出' }); expect(exported.count).toBe(55); expect(exported.schemaVersion).toBe(1); expect(exported.records.every(row => row.characterId === 'yoshino')).toBe(true); expect(JSON.stringify(exported)).not.toContain('fixture-hidden');
  expect(() => admin.export({ section: 'inputs', before: 20 } as never)).toThrow();
});
it('v3 migration only adds revision/author fields and preserves existing rows', () => {
  const dir = temporary(); let store = new ChatStore(dir); const session = store.newSession('yoshino'), first = pair(store, session, '迁移原文'); store.remember('yoshino', '迁移原文', first.user); saveSummary(store, session, first.assistant); store.close();
  sql(dir, db => db.exec('ALTER TABLE memories DROP COLUMN revision; ALTER TABLE memories DROP COLUMN updated_at; ALTER TABLE session_summaries DROP COLUMN author; PRAGMA user_version=3'));
  store = new ChatStore(dir); try { expect(store.schemaVersion).toBe(12); expect(store.messages(session)[0].text).toBe('迁移原文'); expect(store.memories('yoshino')[0]).toMatchObject({ revision: 1, sourceMessageId: first.user, text: '迁移原文' }); expect(store.summary(session, roleRevision(pack))?.author).toBe('model'); } finally { store.close(); remove(dir); }
});
it('memory capacity and deduplication remain enforced in the admin API', () => {
  const { admin } = setup(); for (let i = 0; i < 100; i++) admin.mutate({ action: 'add-memory', characterId: 'yoshino', text: `资料${i}` }); admin.mutate({ action: 'add-memory', characterId: 'yoshino', text: '资料0' }); expect(admin.overview().counts.memories).toBe(100); admin.mutate({ action: 'add-memory', characterId: 'yoshino', text: '额外资料' }); expect(admin.overview().counts.memories).toBe(101); const row = admin.query({ section: 'memories' }).records[0]; expect(() => admin.mutate({ action: 'edit-memory', characterId: row.characterId, id: row.id, revision: row.revision, text: '资料0' })).toThrow('相同');
});
it('an admin correction cancels active generation and rejects late answer/reasoning', async () => {
  let complete!: (s: string) => void, reasoning!: (s: string) => void;
  const { admin, chat, delivered } = setup((_c, _m, _signal, _delta, think) => new Promise(resolve => { complete = resolve; reasoning = think!; }));
  const { characterId, epoch, sessionId, historyRevision } = chat.state(); chat.send({ characterId, epoch, sessionId, historyRevision, text: '先回答' }); admin.mutate({ action: 'add-memory', characterId, text: '当前偏好' }); reasoning('迟到推理'); complete('{"text":"迟到回答"}'); for (let i = 0; i < 5; i++) await Promise.resolve(); expect(delivered).toEqual([]); expect(JSON.stringify(chat.state())).not.toContain('迟到'); expect(chat.state().busy).toBe(false);
});
it('invalid inputs and nonexistent records are rejected before cancelling a live task', () => {
  const { admin, before } = setup(); expect(() => admin.mutate({ action: 'add-memory', characterId: 'missing', text: '禁止' })).toThrow('不存在'); expect(() => admin.mutate({ action: 'edit-memory', characterId: 'yoshino', id: randomUUID(), revision: 1, text: '不存在' })).toThrow('已改变'); expect(() => admin.query({ section: 'inputs', sql: 'DROP TABLE messages' } as never)).toThrow(); expect(before()).toBe(0);
});

it('uses a corrected confirmed memory on the next actual client call while retaining the old source as history', async () => {
  const requests: {role:string;content:string}[][] = [];
  const {chat,store,admin,session,config} = setup(async (_c, messages) => { requests.push(messages); return '{"text":"完成"}'; });
  const old = pair(store,session,'我住上海'); store.remember('yoshino','我住上海',old.user);
  const memory = store.memories('yoshino')[0];
  admin.mutate({action:'edit-memory',characterId:'yoshino',id:memory.id,revision:1,text:'当前常住北京，新住址未知'});
  let state=chat.state(); chat.send({...state,text:'我现在住哪里？'}); for(let i=0;i<8;i++) await Promise.resolve();
  const snapshot=requests[0].find(m=>m.content.startsWith('应用附加的用户确认记忆'))!;
  expect(snapshot.content).toContain('当前常住北京'); expect(snapshot.content).toContain('"revision":2'); expect(requests[0].indexOf(snapshot)).toBe(requests[0].length-2); expect(requests[0].at(-1)?.content).toBe('我现在住哪里？');
  expect(store.message(session,old.user).text).toBe('我住上海'); expect(chat.state().contextStats?.memoryTrace?.confirmed[0]).toMatchObject({id:memory.id,revision:2,text:'当前常住北京，新住址未知'});
  const {hasKey:_hasKey,...settings}=config.public(); config.save({...settings,memoryEnabled:false}); state=chat.state(); chat.send({...state,text:'继续聊天'}); for(let i=0;i<8;i++) await Promise.resolve();
  expect(requests[1].some(m=>m.content.startsWith('应用附加的用户确认记忆'))).toBe(false); expect(chat.state().contextStats?.memoryTrace).toMatchObject({enabled:false,confirmed:[],automatic:[]});
});
