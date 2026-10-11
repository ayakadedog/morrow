import { afterEach, expect, it, vi } from 'vitest';
import { resolve, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ChatStore } from '../../src/main/chat/ChatStore';
import { ChatService } from '../../src/main/chat/ChatService';
import { ModelConfig } from '../../src/main/chat/ModelConfig';
import { inputBudget } from '../../src/main/chat/ContextBudget';
import { prepareContext } from '../../src/main/chat/ContextBuilder';
import { roleRevision } from '../../src/main/chat/ConversationSummary';
import { parseMemoryPlan, longMemoryPrompt, type ExtractedMemory } from '../../src/main/chat/LongMemory';
import { loadPack } from '../../src/main/characters/PackLoader';
import type { MemoryUpdate } from '../../src/main/chat/MemoryLifecycle';
import { temporary, remove } from './fixtures';
const pack = loadPack(resolve('characters'), 'yoshino'), revision = roleRevision(pack);
const cleanup: (() => void)[] = [], codec = { encrypt: (s: string) => s, decrypt: (s: string) => s };
afterEach(() => { cleanup.splice(0).reverse().forEach(f => f()); vi.useRealTimers(); });
function setup() {
  const dir = temporary(), store = new ChatStore(dir), session = store.session('yoshino');
  cleanup.push(() => { store.close(); remove(dir); });
  return { dir, store, session };
}
function pair(store: ChatStore, session: string, text: string) { const id = store.append(session, 'user', text); store.append(session, 'assistant', '知道了'); return id; }
function seed() {
  const fixture = setup(), { store, session } = fixture;
  const id = pair(store, session, '我住上海，走上海旧路线通勤，喜欢地铁。');
  const source = store.messages(session);
  const memories: ExtractedMemory[] = ['用户现住上海', '用户上海旧通勤路线', '用户喜欢地铁'].map((text, i) => ({ text, kind: i === 2 ? 'preference' : 'user_statement', scope: 'real', subject: 'user', sourceMessageIds: [id], lifecycle: { status: 'active', factKey: ['user.residence.city', 'user.commute', 'user.preference.transport'][i] } }));
  store.longMemory.save(session, revision, undefined, 0, source, memories);
  store.remember('yoshino', '我的常住城市是上海');
  return { ...fixture, previous: store.longMemory.candidates('yoshino', session, revision, ''), confirmed: store.memories('yoshino')[0] };
}
function moving() {
  const fixture = seed(), { store, session, previous, confirmed } = fixture;
  const evidence = pair(store, session, '以前住上海，现在搬到北京住了，新的住址和工作地点还没告诉你。');
  const source = store.messages(session).slice(2), snapshot = store.longMemory.snapshot('yoshino', session, revision);
  const updates: MemoryUpdate[] = [
    { id: previous[0].id, target: 'automatic', expectedRevision: 1, lifecycle: { status: 'historical', reason: '搬家前的城市', factKey: 'user.residence.city', changeType: 'fact_change' }, sourceMessageIds: [evidence] },
    { id: previous[1].id, target: 'automatic', expectedRevision: 1, lifecycle: { status: 'needs_review', reason: '上海路线不作为北京当前通勤方案', dependsOn: [previous[0].id] }, sourceMessageIds: [evidence] },
    { id: confirmed.id, target: 'confirmed', expectedRevision: 1, lifecycle: { status: 'historical', reason: '用户明确搬到了北京' }, sourceMessageIds: [evidence] }
  ];
  const memories: ExtractedMemory[] = [{ text: '用户自述现在已搬北京，具体新住址与工作地点未知', kind: 'user_statement', scope: 'real', subject: 'user', sourceMessageIds: [evidence], lifecycle: { status: 'active', factKey: 'user.residence.city', changeType: 'fact_change' } }];
  return { ...fixture, evidence, source, snapshot, updates, memories };
}
it('atomically replaces current applicability, retains historical evidence and leaves cross-city preferences alone', () => {
  const { store, session, source, snapshot, updates, memories, previous, confirmed, evidence } = moving();
  store.longMemory.save(session, revision, store.longMemory.cursor(session, revision)?.id, 0, source, memories, updates, snapshot);
  expect(store.longMemory.record(previous[0].id)).toMatchObject({ text: '用户现住上海', revision: 2, lifecycle: { status: 'historical' }, updateSourceMessageIds: [evidence] });
  expect(store.longMemory.record(previous[1].id)?.lifecycle?.status).toBe('needs_review');
  expect(store.longMemory.record(previous[2].id)?.lifecycle?.status).toBe('active');
  expect(store.memories('yoshino')[0]).toMatchObject({ id: confirmed.id, text: confirmed.text, revision: 2, lifecycle: { status: 'historical' } });
  expect(store.dataPage({ section: 'messages', sourceMemoryId: previous[0].id }).total).toBe(2);
  const context = prepareContext(pack, store.messages(session), store.memories('yoshino'), false, { inputBudget: 975424, longMemories: store.longMemory.candidates('yoshino', session, revision, '') });
  expect(context.stats.memoryTrace?.omittedAutomatic).toBe(0); expect(JSON.stringify(context.messages)).toContain('historical'); expect(JSON.stringify(context.messages)).toContain('工作地点未知');
});
it('rewinding update evidence restores old applicability and removes newly derived facts and update sources', () => {
  const { store, session, source, snapshot, updates, memories, previous, evidence } = moving();
  store.longMemory.save(session, revision, store.longMemory.cursor(session, revision)?.id, 0, source, memories, updates, snapshot);
  store.rewind('yoshino', session, evidence, 0);
  expect(store.longMemory.record(previous[0].id)).toMatchObject({ revision: 3, lifecycle: { status: 'active' } });
  expect(store.longMemory.record(previous[0].id)?.updateSourceMessageIds).toBeUndefined();
  expect(store.memories('yoshino')[0].lifecycle).toBeUndefined(); expect(store.longMemory.count('yoshino')).toBe(3);
});
it('rejects a stale full snapshot after a concurrent user edit without partial writes', () => {
  const { store, session, source, snapshot, updates, memories, previous, confirmed } = moving();
  store.mutateData({ action: 'edit-memory', characterId: 'yoshino', id: confirmed.id, revision: 1, text: '用户最新人工修订' });
  expect(() => store.longMemory.save(session, revision, store.longMemory.cursor(session, revision)?.id, 0, source, memories, updates, snapshot)).toThrow('快照已变化');
  expect(store.longMemory.record(previous[0].id)?.revision).toBe(1); expect(store.longMemory.count('yoshino')).toBe(3);
});
it('invalid update target, revision, citations or dependency rolls back all changes and new facts', () => {
  const f = moving(), { store, session, source, snapshot, updates, memories, previous } = f;
  for (const invalid of [{ ...updates[2], id: randomUUID() }, { ...updates[2], expectedRevision: 99 }, { ...updates[2], sourceMessageIds: [source[1].id] }, { ...updates[2], lifecycle: { status: 'historical' as const, dependsOn: [randomUUID()] } }]) {
    expect(() => store.longMemory.save(session, revision, store.longMemory.cursor(session, revision)?.id, 0, source, memories, [updates[0], invalid], snapshot)).toThrow();
    expect(store.longMemory.record(previous[0].id)?.revision).toBe(1); expect(store.longMemory.count('yoshino')).toBe(3);
  }
});
it('later user edits survive source rewind, and deleting the updating session restores independent hand-written memory', () => {
  const { store, session, source, snapshot, updates, memories, confirmed, evidence } = moving();
  store.longMemory.save(session, revision, store.longMemory.cursor(session, revision)?.id, 0, source, memories, updates, snapshot);
  store.mutateData({ action: 'edit-memory', characterId: 'yoshino', id: confirmed.id, revision: 2, text: '我自己刚修订的资料' });
  store.rewind('yoshino', session, evidence, 0);
  expect(store.memories('yoshino')[0]).toMatchObject({ text: '我自己刚修订的资料', revision: 3 });
  expect(store.memories('yoshino')[0].lifecycle?.status).toBe('historical');
});
it('sends more than 100 confirmed and more than 20 long memories, preserving long core and full prompt', () => {
  const { store, session } = setup(), evidence = pair(store, session, '用户证据');
  for (let i = 0; i < 125; i++) store.remember('yoshino', `资料${i}：` + (i === 0 ? '完整保留。'.repeat(130) : '用户确认信息'));
  const source = store.messages(session), items: ExtractedMemory[] = Array.from({ length: 45 }, (_, i) => ({ text: `自动${i}：` + (i === 0 ? '完整保留。'.repeat(120) : '用户原文整理'), kind: 'user_statement', scope: 'real', subject: 'user', sourceMessageIds: [evidence] }));
  expect(parseMemoryPlan(JSON.stringify({ memories: items, updates: [] }), source).memories).toHaveLength(45);
  store.longMemory.save(session, revision, undefined, 0, source, items);
  const fullPack = { ...pack, roleProfile: { ...pack.roleProfile!, identity: { ...pack.roleProfile!.identity, summary: '核心内容'.repeat(1500) + '核心尾巴' } }, prompt: '角色提示词'.repeat(1500) + '提示尾巴' };
  const prepared = prepareContext(fullPack, source, store.memories('yoshino'), false, { inputBudget: 975424, longMemories: store.longMemory.candidates('yoshino', session, revision, '') });
  expect(prepared.stats.memoryTrace?.confirmed).toHaveLength(125); expect(prepared.stats.memoryTrace?.automatic).toHaveLength(45);
  expect(prepared.messages[0].content).toContain('核心尾巴'); expect(prepared.messages[0].content).toContain('提示尾巴'); expect(prepared.stats.memoryTrace?.omittedConfirmed).toBe(0);
}, 20000);
it('migrates official DeepSeek to 1M and triples output once, retaining encrypted key and explicit opt-outs', () => {
  const { dir } = setup(), file = join(dir, 'chat-model.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 2, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', provider: 'deepseek', encryptedKey: 'fixture', proactive: false, memoryEnabled: true, contextWindowTokens: 32768, maxOutputTokens: 8192, autoSummary: false, autoLongMemory: false }));
  const config = new ModelConfig(dir, codec);
  expect(config.public()).toMatchObject({ contextWindowTokens: 1000000, maxOutputTokens: 24576, autoSummary: false, autoLongMemory: false, hasKey: true });
  expect(inputBudget(config.public())).toBe(975424); expect(new ModelConfig(dir, codec).public().maxOutputTokens).toBe(24576);
  expect(JSON.parse(readFileSync(file, 'utf8')).encryptedKey).toBe('fixture');
});
it('distinguishes all six temporal cases in the actual maintenance system prompt', () => {
  const prompt = longMemoryPrompt([])[0].content;
  for (const term of ['fact_change', 'correction', 'temporary', 'plan', 'history', 'fiction', '本周北京出差', '工作地点', '跨城市地铁偏好']) expect(prompt).toContain(term);
});
it('an unrelated new memory in another session does not erase an existing session summary', () => {
  const { store, session } = setup(); pair(store, session, '第一会话');
  const end = store.messages(session).at(-1)!.id;
  store.saveSummary(session, revision, end, { events: ['会话经过'], userStatements: [], fictionalState: [], uncertainties: [], commitments: [], openQuestions: [], keyQuotes: [] }, 0, store.sourceSnapshot(session, end));
  const other = store.newSession('yoshino'), user = pair(store, other, '我喜欢坐公交');
  store.longMemory.save(other, revision, undefined, 0, store.messages(other), [{ text: '用户喜欢公交', kind: 'preference', scope: 'real', subject: 'user', sourceMessageIds: [user] }]);
  expect(store.summary(session, revision)?.data.events).toEqual(['会话经过']);
});
it('deleting an older cross-session update preserves a later update and lets its later rewind restore the original state', () => {
  const { store, session, confirmed } = seed();
  const updateSession = store.newSession('yoshino'), first = pair(store, updateSession, '我搬到北京了');
  let snapshot = store.longMemory.snapshot('yoshino', updateSession, revision);
  store.longMemory.save(updateSession, revision, undefined, 0, store.messages(updateSession), [], [{ id: confirmed.id, target: 'confirmed', expectedRevision: 1, lifecycle: { status: 'historical', reason: '搬北京' }, sourceMessageIds: [first] }], snapshot);
  const later = store.newSession('yoshino'), last = pair(store, later, '以前搬北京那段话也不准确，我一直住杭州');
  snapshot = store.longMemory.snapshot('yoshino', later, revision);
  store.longMemory.save(later, revision, undefined, 0, store.messages(later), [], [{ id: confirmed.id, target: 'confirmed', expectedRevision: 2, lifecycle: { status: 'retracted', reason: '用户纠错' }, sourceMessageIds: [last] }], snapshot);
  store.mutateData({ action: 'delete-sessions', items: [{ characterId: 'yoshino', id: updateSession, revision: 0 }] });
  expect(store.memories('yoshino')[0].lifecycle?.status).toBe('retracted');
  store.rewind('yoshino', later, last, 0);
  expect(store.memories('yoshino')[0].lifecycle).toBeUndefined(); expect(store.messages(session)).toHaveLength(2);
});
it('automatically reconciles a finished single turn against all previous memory after 1.5 seconds', async () => {
  vi.useFakeTimers(); const { store, session, dir, confirmed } = seed();
  const config = new ModelConfig(dir, codec); config.save({ baseUrl: 'http://localhost/v1', model: 'fixture', proactive: false, memoryEnabled: true, autoSummary: false, autoLongMemory: true });
  let maintenanceCalls = 0;
  const service = new ChatService(store, config, () => ({ pack, epoch: 1 }), () => {}, () => {}, () => true, async (_c, messages) => {
    if (!messages[0].content.includes('长期对话记忆维护器')) return '{"text":"北京的新住址你还没告诉我。"}';
    maintenanceCalls++;
    const data = JSON.parse(messages[1].content); expect(data.existing.automatic).toHaveLength(3); expect(data.existing.confirmed[0].id).toBe(confirmed.id);
    return JSON.stringify({ memories: [], updates: [{ id: confirmed.id, target: 'confirmed', expectedRevision: 1, lifecycle: { status: 'historical', reason: '搬家了' }, sourceMessageIds: [data.source[0].id] }] });
  });
  // The fixture owns the store; dispose only once through this service.
  cleanup.pop(); cleanup.push(() => { service.dispose(); remove(dir); });
  const state = service.state(); service.send({ characterId: state.characterId, epoch: state.epoch, sessionId: session, historyRevision: state.historyRevision, text: '现在搬到北京了' });
  await vi.advanceTimersByTimeAsync(1499); expect(maintenanceCalls).toBe(0);
  await vi.advanceTimersByTimeAsync(1); expect(maintenanceCalls).toBe(1); expect(store.memories('yoshino')[0].lifecycle?.status).toBe('historical');
});
