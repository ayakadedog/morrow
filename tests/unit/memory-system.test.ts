import { afterEach, expect, it, vi } from 'vitest';
import { resolve, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { ChatStore } from '../../src/main/chat/ChatStore';
import { ChatService } from '../../src/main/chat/ChatService';
import { ModelConfig } from '../../src/main/chat/ModelConfig';
import { parseLongMemory, type ExtractedMemory } from '../../src/main/chat/LongMemory';
import { evaluateMemories, memoryTime } from '../../src/main/chat/MemoryPolicy';
import { saveConsolidation } from '../../src/main/chat/MemoryConsolidator';
import { storeSummaryEntries } from '../../src/main/chat/SummaryService';
import { loadPack } from '../../src/main/characters/PackLoader';
import { roleRevision } from '../../src/main/chat/ConversationSummary';
import { prepareContext } from '../../src/main/chat/ContextBuilder';
import { lifecycleView } from '../../src/main/chat/MemoryLifecycle';
import type { Generate } from '../../src/main/chat/ModelClient';
import { temporary, remove } from './fixtures';
it('explicit evidence-backed clearing removes expiry while omitted metadata survives', () => {
  const { store, session } = setup(), fact = save(store, session, pair(store, session), '旧临时偏好', { status: 'active', factKey: 'user.transport', validTo: '2025-01-01', conditions: ['本周'] });
  const newId = pair(store, session, '这个偏好现在稳定了，旧截止日期和条件取消'), cursor = store.longMemory.cursor(session, role)!;
  store.longMemory.save(session, role, cursor.id, 0, store.contextTail(session, cursor.throughMessageId, 100000), [], [{ id: fact.id, target: 'automatic', expectedRevision: 1, lifecycle: { status: 'active' }, clearLifecycleFields: ['validTo', 'conditions'], sourceMessageIds: [newId] }], store.longMemory.snapshot('yoshino', session, role));
  expect(store.longMemory.record(fact.id)?.lifecycle).toEqual({ status: 'active', factKey: 'user.transport' });
});
it('periodic summary rebuilding rereads raw evidence while preserving manual entries', async () => {
  let promptSourceIds: string[] = [];
  const { chat, store, session } = service(async (connection, prompt) => {
    expect(connection.purpose).toBe('summary'); const input = JSON.parse(prompt[1].content); promptSourceIds = input.source.map((m: { id: string }) => m.id);
    return JSON.stringify({ entries: [{ category: 'events', text: '从原始消息重新总结', scope: 'unknown', modality: 'conditional', status: 'active', sourceMessageIds: [promptSourceIds[0]] }] });
  });
  for (let i = 0; i < 12; i++) pair(store, session, '经历' + i);
  const oldSource = store.messages(session).slice(0, 4), end = oldSource.at(-1)!.id;
  const data = storeSummaryEntries(store.memory, session, JSON.stringify({ entries: [{ category: 'events', text: '待回查的旧摘要', scope: 'unknown', modality: 'conditional', status: 'active', sourceMessageIds: [oldSource[0].id] }, { category: 'userStatements', text: '人工整理的特殊称呼', scope: 'unknown', modality: 'conditional', status: 'active', sourceMessageIds: [oldSource[2].id] }] }), oldSource);
  store.memory.db.prepare("UPDATE summary_entries SET author='user' WHERE category='userStatements' AND session_id=?").run(session);
  for (let n = 0; n < 5; n++) store.saveSummary(session, role, end, data, n, store.sourceSnapshot(session, end));
  chat.summarize(target(chat)); await flush();
  expect(promptSourceIds).toContain(oldSource[0].id); expect(store.memory.summaryEntries(session).map(e => e.text)).toEqual(['人工整理的特殊称呼', '从原始消息重新总结']); expect(store.summary(session, role)?.revision).toBe(6);
});
it('manual fictional memory is visible only in its bound conversation and role', () => {
  const { store, session } = setup(), other = store.newSession('yoshino'), foreign = store.session('other');
  store.remember('yoshino', '现实喜欢地铁');
  store.remember('yoshino', '这条世界线住上海', undefined, 'fiction', session);
  const otherSource = pair(store, other, '另一个剧情原文'); expect(() => store.remember('yoshino', '另一个剧情原文', otherSource, 'fiction', session)).toThrow('来源');
  expect(store.memories('yoshino', session)).toHaveLength(2);
  expect(store.memories('yoshino', other).map(m => m.text)).toEqual(['现实喜欢地铁']);
  expect(store.memories('other', foreign)).toEqual([]);
  expect(() => store.remember('yoshino', '串线内容', undefined, 'fiction', foreign)).toThrow('绑定');
  store.mutateData({ action: 'delete-sessions', items: [{ characterId: 'yoshino', id: session, revision: 0 }] });
  expect(store.memories('yoshino')).toHaveLength(1);
});
it('deleted observations cannot regenerate from unchanged evidence, but new evidence revisions allow refresh', () => {
  const { store, session } = setup(), fact = save(store, session, pair(store, session), '喜欢地铁');
  const raw = (revision: number) => JSON.stringify({ observations: [{ topicKey: 'transport', text: '喜欢公共交通', scope: 'real', sources: [{ type: 'fact', id: fact.id, revision }] }] });
  saveConsolidation(store.memory, 'yoshino', session, role, raw(1), [fact], [], []);
  const o = store.memory.observations('yoshino', session, role)[0];
  store.mutateData({ action: 'delete-observations', items: [{ characterId: 'yoshino', id: o.id, revision: 1 }] });
  saveConsolidation(store.memory, 'yoshino', session, role, raw(1), [fact], [], []);
  expect(store.memory.observations('yoshino', session, role)).toEqual([]);
  store.longMemory.edit(fact.id, '偏好地铁和公交'); const updated = store.longMemory.record(fact.id)!;
  saveConsolidation(store.memory, 'yoshino', session, role, raw(2), [updated], [], []);
  expect(store.memory.observations('yoshino', session, role)).toHaveLength(1);
});
it('summary merges retain all source links and an existing stable ID', () => {
  const { store, session } = setup(), a = pair(store, session), b = pair(store, session);
  const make = (text: string, sourceMessageIds: string[]) => ({ category: 'events', text, scope: 'real', modality: 'asserted', status: 'active', sourceMessageIds });
  storeSummaryEntries(store.memory, session, JSON.stringify({ entries: [make('第一段经历', [a]), make('第二段经历', [b])] }), store.messages(session));
  const [x, y] = store.memory.summaryEntries(session), c = pair(store, session);
  storeSummaryEntries(store.memory, session, JSON.stringify({ entries: [{ ...make('合并经历', [a, b, c]), id: x.id, expectedRevision: 1, mergeFrom: [{ id: y.id, expectedRevision: 1 }] }] }), store.messages(session).slice(4));
  expect(store.memory.summaryEntries(session)).toHaveLength(1);
  expect(store.memory.summaryEntries(session)[0]).toMatchObject({ id: x.id, revision: 2 });
  expect(new Set(store.memory.sourceMessages(x.id))).toEqual(new Set([a, b, c]));
});
it('manual summary edits are protected entries with honest batch provenance', () => {
  const { store, session } = setup(), id = pair(store, session), data = { events: ['经历'], userStatements: [], fictionalState: [], uncertainties: [], commitments: [], openQuestions: [], keyQuotes: [] };
  store.saveSummary(session, role, store.messages(session).at(-1)!.id, data, 0, store.sourceSnapshot(session, store.messages(session).at(-1)!.id));
  const row = store.dataPage({ section: 'summaries' }).records[0];
  store.mutateData({ action: 'edit-summary', characterId: 'yoshino', sessionId: session, revision: 1, stamp: row.stamp!, data: { ...data, events: ['人工整理'] } });
  const entry = store.memory.summaryEntries(session)[0]; expect(entry).toMatchObject({ author: 'user', sourceGranularity: 'batch' }); expect(entry.sourceMessageIds).toContain(id);
  const second = pair(store, session);
  expect(() => storeSummaryEntries(store.memory, session, JSON.stringify({ entries: [{ ...entry, text: '自动覆盖', expectedRevision: 1, sourceMessageIds: [second], sourceGranularity: undefined, author: undefined, revision: undefined }] }), store.messages(session).slice(2))).toThrow();
  store.invalidateSummaries('yoshino'); expect(store.memory.summaryEntries(session)).toEqual([]);
});
it('pending crash leases schedule recovery instead of becoming permanently stranded', () => {
  vi.useFakeTimers(); const { dir, store, session } = setup(); store.memory.enqueue('extract', 'yoshino', session, role); store.memory.claim();
  const resumed = new ChatStore(dir); try { expect(resumed.memory.nextDelay()).toBeGreaterThan(0); vi.advanceTimersByTime(900001); expect(resumed.memory.claim()?.attempts).toBe(2); } finally { resumed.close(); }
});
it('malformed legacy metadata is quarantined without preventing ordinary context preparation', () => {
  const { store, session } = setup(), f = save(store, session, pair(store, session), '合成资料');
  store.memory.db.prepare('UPDATE conversation_memories SET metadata=?,lifecycle=? WHERE id=?').run('{bad', '{bad', f.id);
  expect(lifecycleView({ lifecycle: '{bad' }).lifecycle?.status).toBe('needs_review');
  const facts = store.longMemory.candidates('yoshino', session, role, '');
  expect(facts[0].metadata?.evidenceClass).toBe('model_inferred');
  expect(() => prepareContext(pack, store.messages(session), [], false, { inputBudget: 100000, longMemories: facts })).not.toThrow();
});
it('budget overflow compresses old history then continues the saved turn automatically', async () => {
  vi.useFakeTimers(); let summaries = 0, chats = 0;
  const { chat, store, session, config } = service(async (connection, prompt) => {
    if (connection.purpose === 'summary') { summaries++; const ids = (JSON.parse(prompt[1].content).source as { id: string }[]).map(m => m.id); return JSON.stringify({ entries: [{ category: 'events', text: '合成旧日经历已压缩，原文可回查', scope: 'unknown', modality: 'conditional', status: 'active', sourceMessageIds: [ids[0]] }] }); }
    chats++; return '{"text":"压缩后继续成功"}';
  });
  for (let i = 0; i < 12; i++) pair(store, session, ('第' + i + '轮旧话题').repeat(i < 8 ? 350 : 2));
  config.save({ baseUrl: 'http://localhost/v1', model: 'fixture', proactive: false, memoryEnabled: true, contextWindowTokens: 8192, maxOutputTokens: 256, autoSummary: true, autoLongMemory: false });
  chat.send({ ...target(chat), text: '当前问题' }); expect(chat.state().busy).toBe(true);
  for (let i = 0; i < 40 && chat.state().busy; i++) await vi.advanceTimersByTimeAsync(25);
  expect(summaries).toBeGreaterThan(0); expect(chats, JSON.stringify({ error: chat.state().error, warning: chat.state().summaryWarning, busy: chat.state().busy, jobs: store.memory.list() })).toBe(1); expect(chat.state().messages.at(-1)?.text).toBe('压缩后继续成功');
  expect(store.dataPage({ section: 'inputs' }).total).toBe(13);
});
it('oversized fixed memory stops without spending archive calls or getting stuck waiting', async () => {
  let calls = 0; const { chat, store, session, config } = service(async () => { calls++; return '{}'; });
  for (let i = 0; i < 7; i++) pair(store, session);
  store.remember('yoshino', '不能截断的长期资料'.repeat(7000));
  config.save({ baseUrl: 'http://localhost/v1', model: 'fixture', proactive: false, memoryEnabled: true, contextWindowTokens: 8192, maxOutputTokens: 256, autoSummary: true, autoLongMemory: false });
  chat.send({ ...target(chat), text: '当前问题' }); await flush();
  expect(chat.state().busy).toBe(false); expect(calls).toBe(0); expect(chat.state().error).toContain('预算');
});
const pack = loadPack(resolve('characters'), 'yoshino'), role = roleRevision(pack), cleanups: (() => void)[] = [];
const flush = async () => { for (let i = 0; i < 14; i++) await Promise.resolve(); };
function setup() { const dir = temporary(), store = new ChatStore(dir), session = store.session('yoshino'); cleanups.push(() => { store.close(); remove(dir); }); return { dir, store, session }; }
function pair(store: ChatStore, session: string, text = '用户合成证据') { const id = store.append(session, 'user', text); store.append(session, 'assistant', '合成回应'); return id; }
function save(store: ChatStore, session: string, sourceId: string, text: string, lifecycle: ExtractedMemory['lifecycle'] = { status: 'active' }) {
  const cursor = store.longMemory.cursor(session, role), source = store.contextTail(session, cursor?.throughMessageId, 1000000);
  store.longMemory.save(session, role, cursor?.id, store.historyRevision(session), source, [{ text, kind: 'user_statement', scope: 'real', subject: 'user', sourceMessageIds: [sourceId], lifecycle }]);
  return store.longMemory.candidates('yoshino', session, role, '').find(m => m.text === text)!;
}
function service(client: Generate, auto = false) {
  const f = setup(), config = new ModelConfig(f.dir, { encrypt: s => s, decrypt: s => s }); config.save({ baseUrl: 'http://localhost/v1', model: 'fixture', proactive: false, memoryEnabled: true, autoSummary: false, autoLongMemory: auto });
  const chat = new ChatService(f.store, config, () => ({ pack, epoch: 1 }), () => {}, () => {}, () => true, client);
  cleanups.pop(); cleanups.push(() => { chat.dispose(); remove(f.dir); }); return { ...f, chat, config };
}
function target(chat: ChatService) { const { characterId, sessionId, epoch, historyRevision } = chat.state(); return { characterId, sessionId, epoch, historyRevision }; }
afterEach(() => { cleanups.splice(0).reverse().forEach(f => f()); vi.useRealTimers(); });

it.each([
  [{ status: 'active', validTo: '2026-10-01' }, 'expired'],
  [{ status: 'active', validFrom: '2026-11-01' }, 'future'],
  [{ status: 'active', changeType: 'plan' }, 'unknown'],
  [{ status: 'active', changeType: 'temporary' }, 'unknown'],
  [{ status: 'historical' }, 'historical'],
  [{ status: 'retracted' }, 'retracted'],
  [{ status: 'active', validTo: '这周之后' }, 'unknown']
] as const)('evaluates temporal applicability in code: %j -> %s', (lifecycle, expected) => {
  expect(evaluateMemories([{ id: 'fixture', lifecycle }], Date.parse('2026-10-07T00:00:00Z'))[0].applicability.status).toBe(expected);
});
it('rejects invalid calendar dates and locale-dependent dates', () => { for (const s of ['2026-02-31', '2026-02-31T12:00:00Z', '10/07/2026', '明天', '2026-10-07T12:00:00']) expect(memoryTime(s)).toBeUndefined(); expect(memoryTime('2026-10-07T12:00:00+08:00')).toBe(Date.parse('2026-10-07T04:00:00Z')); });
it('marks old routes inapplicable but leaves independent preferences, and checks dependency revisions', () => {
  const city = { id: randomUUID(), revision: 2, lifecycle: { status: 'historical' as const } }, route = { id: randomUUID(), lifecycle: { status: 'active' as const, dependsOn: [city.id] } }, preference = { id: randomUUID(), lifecycle: { status: 'active' as const } };
  expect(evaluateMemories([city, route, preference]).map(m => m.applicability.status)).toEqual(['historical', 'condition_failed', 'current']);
  expect(evaluateMemories([{ ...city, lifecycle: { status: 'active' as const } }, { ...route, lifecycle: { status: 'active' as const, dependencies: [{ id: city.id, revision: 1 }] } }])[1].applicability.status).toBe('needs_review');
});
it('cannot promote assistant-only joint experiences into real memories, but labels character beliefs', () => {
  const { store, session } = setup(); pair(store, session); const source = store.messages(session), assistant = source[1];
  const item = { text: '我们一起去了北京', kind: 'experience', scope: 'real', subject: 'interaction', sourceMessageIds: [assistant.id] };
  expect(() => parseLongMemory(JSON.stringify({ memories: [item] }), source)).toThrow('不能只引用模型');
  expect(parseLongMemory(JSON.stringify({ memories: [{ ...item, kind: 'belief', subject: 'character', metadata: { evidenceClass: 'character_belief' } }] }), source)).toHaveLength(1);
});
it('merges lifecycle patches and keeps metadata when users edit fact text', () => {
  const { store, session } = setup(), id = pair(store, session), fact = save(store, session, id, '上海路线', { status: 'active', factKey: 'user.commute', validTo: '2026-10-01', conditions: ['仅在上海时'] });
  const update = pair(store, session, '这是过去的路线'), cursor = store.longMemory.cursor(session, role)!;
  store.longMemory.save(session, role, cursor.id, 0, store.contextTail(session, cursor.throughMessageId, 100000), [], [{ id: fact.id, target: 'automatic', expectedRevision: 1, lifecycle: { status: 'historical' }, sourceMessageIds: [update] }], store.longMemory.snapshot('yoshino', session, role));
  store.mutateData({ action: 'edit-long-memory', characterId: 'yoshino', id: fact.id, revision: 2, text: '人工补充的上海路线' });
  expect(store.longMemory.record(fact.id)).toMatchObject({ revision: 3, author: 'user', lifecycle: { status: 'historical', factKey: 'user.commute', validTo: '2026-10-01', conditions: ['仅在上海时'] } });
});
it('rejects dependency cycles atomically', () => {
  const { store, session } = setup(), a = save(store, session, pair(store, session), 'A'), b = save(store, session, pair(store, session), 'B');
  const newSource = pair(store, session), cursor = store.longMemory.cursor(session, role)!;
  const updates = [a, b].map((f, i) => ({ id: f.id, target: 'automatic' as const, expectedRevision: 1, lifecycle: { status: 'active' as const, dependsOn: [i ? a.id : b.id] }, sourceMessageIds: [newSource] }));
  expect(() => store.longMemory.save(session, role, cursor.id, 0, store.contextTail(session, cursor.throughMessageId, 100000), [], updates, store.longMemory.snapshot('yoshino', session, role))).toThrow('循环'); expect(store.longMemory.record(a.id)?.revision).toBe(1);
});
it('reconfirmation reactivates a retracted manual record without silently dropping conditions', () => {
  const { store, session } = setup(); store.remember('yoshino', '稳定偏好'); const manual = store.memories('yoshino')[0];
  store.memory.db.prepare('UPDATE memories SET lifecycle=? WHERE id=?').run(JSON.stringify({ status: 'retracted', conditions: ['仅限周末'] }), manual.id); store.remember('yoshino', '稳定偏好');
  expect(store.memories('yoshino')[0]).toMatchObject({ id: manual.id, revision: 2, lifecycle: { status: 'active', conditions: ['仅限周末'] } }); expect(store.memories('yoshino')).toHaveLength(1);
});
it('deleted facts stay suppressed during re-extraction from the same sources', () => {
  const { store, session } = setup(), sourceId = pair(store, session), fact = save(store, session, sourceId, '常住上海', { status: 'active', factKey: 'user.residence.city' });
  store.mutateData({ action: 'delete-long-memories', items: [{ characterId: 'yoshino', id: fact.id, revision: 1 }] });
  store.memory.db.prepare('DELETE FROM memory_batches WHERE session_id=?').run(session);
  save(store, session, sourceId, '用户长期居住上海', { status: 'active', factKey: 'user.residence.city' }); expect(store.longMemory.count('yoshino')).toBe(0); expect(store.dataPage({ section: 'inputs' }).total).toBe(1);
  expect(store.memory.suppressed('yoshino', [sourceId], undefined)).toBe(true);
});
it('task claim tokens block a stale worker after lease recovery', () => {
  vi.useFakeTimers(); const { store, session } = setup(); store.memory.enqueue('extract', 'yoshino', session, role); const old = store.memory.claim()!;
  vi.advanceTimersByTime(900001); const next = store.memory.claim()!; expect(next.runToken).not.toBe(old.runToken); expect(store.memory.current(old)).toBe(false);
  expect(() => store.memory.commit(old, () => { throw new Error('must not run'); })).toThrow('版本'); store.memory.commit(next, () => {}); expect(store.memory.list()[0].state).toBe('succeeded');
});
it('task commit and evidence changes are atomic, with deduplicated pending jobs', () => {
  const { store, session } = setup(); const first = store.memory.enqueue('extract', 'yoshino', session, role); expect(store.memory.enqueue('extract', 'yoshino', session, role)).toBe(first);
  const job = store.memory.claim()!; expect(() => store.memory.commit(job, () => { store.memory.db.prepare('UPDATE sessions SET title=? WHERE id=?').run('bad', session); throw new Error('failure'); })).toThrow('failure'); expect(store.sessionEntry(session).title).not.toBe('bad');
  store.memory.changed('yoshino'); expect(() => store.memory.commit(job, () => {})).toThrow('版本');
});
it('paused automatic jobs are not claimed or repeatedly counted as attempts', () => {
  const { store, session } = setup(); store.memory.enqueue('extract', 'yoshino', session, role); expect(store.memory.claim(() => false)).toBeUndefined(); expect(store.memory.nextDelay(() => false)).toBeUndefined(); expect(store.memory.list()[0].attempts).toBe(0);
});
it('observations point to exact fact revisions and become unusable after source changes', () => {
  const { store, session } = setup(), fact = save(store, session, pair(store, session), '喜欢地铁');
  const jobId = store.memory.enqueue('consolidate', 'yoshino', session, role), job = store.memory.claim()!; expect(job.id).toBe(jobId);
  store.memory.commit(job, () => saveConsolidation(store.memory, 'yoshino', session, role, JSON.stringify({ observations: [{ topicKey: 'transport', scope: 'real', text: '交通出行偏向地铁', sources: [{ type: 'fact', id: fact.id, revision: 1 }] }] }), [fact], [], []));
  const observation = store.memory.observations('yoshino', session, role)[0]; expect(store.memory.sourceMessages(observation.id)).toEqual(fact.sourceMessageIds);
  store.mutateData({ action: 'edit-long-memory', characterId: 'yoshino', id: fact.id, revision: 1, text: '偏好发生变化' }); expect(store.memory.observations('yoshino', session, role)).toEqual([]); expect(store.memory.observation(observation.id)?.status).toBe('needs_review');
});
it('rejects fictional observations built from other worldlines or reality', () => {
  const { store, session } = setup(), fact = save(store, session, pair(store, session), '现实偏好');
  // Real evidence may support a real observation; turning it into fiction must be explicit.
  const raw = JSON.stringify({ observations: [{ topicKey: 'fiction', scope: 'fiction', text: '剧情关系', sources: [{ type: 'confirmed', id: fact.id, revision: 1 }] }] });
  expect(() => saveConsolidation(store.memory, 'yoshino', session, role, raw, [fact], [], [])).toThrow('来源');
});
it('summary patches keep unchanged IDs and uncertainty while exposing exact provenance', () => {
  const { store, session } = setup(), sourceId = pair(store, session, '下个月可能搬北京'), source = store.messages(session);
  const entry = { category: 'uncertainties', text: '下个月可能搬北京，未决定', scope: 'real', modality: 'possible', status: 'active', sourceMessageIds: [sourceId] };
  storeSummaryEntries(store.memory, session, JSON.stringify({ entries: [entry] }), source);
  const original = store.memory.summaryEntries(session)[0]; const second = pair(store, session, '还没决定');
  storeSummaryEntries(store.memory, session, JSON.stringify({ entries: [] }), store.messages(session).slice(2)); expect(store.memory.summaryEntries(session)[0].id).toBe(original.id);
  storeSummaryEntries(store.memory, session, JSON.stringify({ entries: [{ ...entry, id: original.id, expectedRevision: 1, text: '仍未决定搬家', sourceMessageIds: [sourceId, second] }] }), store.messages(session).slice(2));
  expect(store.memory.summaryEntries(session)[0]).toMatchObject({ id: original.id, revision: 2, modality: 'possible', sourceGranularity: 'exact' }); expect(new Set(store.memory.sourceMessages(original.id))).toEqual(new Set([sourceId, second]));
});
it('summary source deletion removes entry contents and links', () => {
  const { store, session } = setup(), id = pair(store, session); storeSummaryEntries(store.memory, session, JSON.stringify({ entries: [{ category: 'events', text: '合成事件', scope: 'unknown', modality: 'conditional', status: 'active', sourceMessageIds: [id] }] }), store.messages(session));
  store.rewind('yoshino', session, id, 0); expect(store.memory.summaryEntries(session)).toEqual([]); expect(store.memory.db.prepare('SELECT COUNT(*) AS n FROM memory_links').get()?.n).toBe(0);
});
it('snapshot includes expired memories with explicit computed labels rather than treating them as current', () => {
  const { store, session } = setup(); save(store, session, pair(store, session), '去年出差', { status: 'active', validTo: '2025-01-01' });
  const facts = store.longMemory.candidates('yoshino', session, role, ''), context = prepareContext(pack, store.messages(session), [], false, { inputBudget: 975424, longMemories: facts }); expect(context.stats.memoryTrace?.automatic).toHaveLength(1); expect(JSON.stringify(context.messages)).toContain('expired');
});
it('role authors can explicitly opt into stable memory compatibility without mixing character IDs', () => { const compatible = { ...pack, memoryCompatibilityVersion: 'canon-v1' }; expect(roleRevision(compatible)).toBe(roleRevision({ ...compatible, prompt: 'style edit' })); expect(roleRevision(compatible)).not.toBe(roleRevision({ ...compatible, view: { ...compatible.view, id: 'other' } })); expect(roleRevision(pack)).not.toBe(roleRevision({ ...pack, prompt: 'strict edit' })); });
it('partial settings updates preserve explicit memory opt-outs', () => { const { dir } = setup(), codec = { encrypt: (s: string) => s, decrypt: (s: string) => s }, config = new ModelConfig(dir, codec); config.save({ baseUrl: 'http://localhost/v1', model: 'fixture', proactive: false, memoryEnabled: true, autoLongMemory: false, autoSummary: false }); config.save({ baseUrl: 'http://localhost/v1', model: 'fixture', proactive: false, memoryEnabled: true, streaming: false }); expect(config.public()).toMatchObject({ autoLongMemory: false, autoSummary: false }); });
it('background extraction survives selecting a different conversation', async () => {
  let done!: (s: string) => void; const { chat, store, session } = service(async () => new Promise(r => { done = r; })); const id = pair(store, session); chat.extractLongMemory(target(chat)); chat.newConversation(target(chat));
  done(JSON.stringify({ memories: [{ text: '该会话明确的偏好', kind: 'preference', scope: 'real', subject: 'user', sourceMessageIds: [id] }] })); await flush(); expect(store.longMemory.count('yoshino')).toBe(1); expect(chat.state().sessionId).not.toBe(session);
});
it('failed context preparation can be retried without duplicating user archives', async () => {
  const { chat, store, session, config } = service(async () => '{"text":"恢复成功"}'); store.remember('yoshino', '长资料'.repeat(13000)); config.save({ baseUrl: 'http://localhost/v1', model: 'fixture', proactive: false, memoryEnabled: true, contextWindowTokens: 8192, maxOutputTokens: 256 });
  chat.send({ ...target(chat), text: '原问题' }); expect(chat.state().error).toBeDefined(); expect(chat.state().messages.at(-1)?.status).toBe('failed');
  store.forget('yoshino', store.memories('yoshino')[0].id); chat.send({ ...target(chat), text: '原问题' }); await flush(); expect(store.dataPage({ section: 'inputs' }).total).toBe(1); expect(store.messages(session).at(-1)?.text).toBe('恢复成功');
});
it('schema migration creates a consistent backup that includes both text archives', () => {
  const { store, session, dir } = setup(); pair(store, session, '保留的合成输入'); store.memory.db.exec('PRAGMA user_version=8'); const other = new ChatStore(dir); try { const backup = readdirSync(dir).find(n => n.endsWith('.sqlite.bak'))!; expect(backup).toBeDefined(); const db = new DatabaseSync(join(dir, backup), { readOnly: true }); try { expect(db.prepare('SELECT text FROM user_inputs').get()?.text).toBe('保留的合成输入'); expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n).toBe(2); } finally { db.close(); } } finally { other.close(); }
});
