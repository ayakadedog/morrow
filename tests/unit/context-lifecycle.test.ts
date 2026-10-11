import { afterEach, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadPack } from '../../src/main/characters/PackLoader';
import { ChatStore } from '../../src/main/chat/ChatStore';
import { ChatService } from '../../src/main/chat/ChatService';
import { ModelConfig } from '../../src/main/chat/ModelConfig';
import type { Generate } from '../../src/main/chat/ModelClient';
import { prepareContext } from '../../src/main/chat/ContextBuilder';
import { roleRevision, summaryPrompt } from '../../src/main/chat/ConversationSummary';
import { estimateMessages } from '../../src/main/chat/ContextBudget';
import { temporary, remove } from './fixtures';
const pack = loadPack(resolve('characters'), 'yoshino');
const data = { events: ['用户以前住上海。'], userStatements: ['用户说现在已搬北京，具体住址与工作地点未知。'], fictionalState: ['在讨论的故事中，用户仍住上海；与现实分开。'], uncertainties: ['下个月可能换工作，尚未决定。'], commitments: ['若下雨才取消散步；未兑现。'], openQuestions: ['新住址未知。'], keyQuotes: ['用户：“我喜欢地铁。”'] };
const cleanups: (() => void)[] = [];
const codec = { encrypt: (s: string) => s, decrypt: (s: string) => s };
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function target(service: ChatService) { const { characterId, epoch, sessionId, historyRevision } = service.state(); return { characterId, epoch, sessionId, historyRevision }; }
function setup(client: Generate = async () => '{"text":"我在这里。"}') {
  const dir = temporary(), store = new ChatStore(dir), config = new ModelConfig(dir, codec);
  config.save({ baseUrl: 'http://localhost:8000/v1', model: 'fixture', memoryEnabled: true, proactive: false, autoSummary: false, autoLongMemory: false });
  let context = { pack, epoch: 1 };
  const service = new ChatService(store, config, () => context, () => {}, () => {}, () => true, client);
  cleanups.push(() => { service.dispose(); remove(dir); });
  return { dir, service, store, config, switchEpoch: () => { context = { ...context, epoch: context.epoch + 1 }; service.switched(); } };
}
function fill(store: ChatStore, session: string, count: number, text = '历史') { for (let i = 0; i < count; i++) { store.append(session, 'user', `${text} ${i}`); store.append(session, 'assistant', `回应 ${i}`); } }
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); });
it('rejects stale destructive, stop, memory and paging operations before touching a new session', () => {
  const { service, store, switchEpoch } = setup(() => new Promise(() => {}));
  const old = target(service); fill(store, old.sessionId, 2); service.newConversation(old);
  service.send({ ...target(service), text: '新会话不能被旧按钮停止' }); const current = target(service);
  for (const action of [() => service.clearHistory(old), () => service.cancelFor(old), () => service.newConversation(old), () => service.send({ ...old, text: '旧输入' }), () => service.remember({ ...old, text: '旧确认' }), () => service.history({ ...old, kind: 'messages', beforeId: store.messages(old.sessionId)[0].id })]) expect(action).toThrow('已切换');
  expect(service.state().busy).toBe(true); expect(store.messages(old.sessionId)).toHaveLength(4);
  switchEpoch(); expect(() => service.clearHistory(current)).toThrow('已切换'); expect(service.state().messages[0].text).toContain('不能');
});
it('paginates all original messages and sessions with stable cursors, including identical timestamps and foreign cursor rejection', () => {
  const { service, store } = setup(), first = target(service); fill(store, first.sessionId, 123);
  let messages = service.state().messages, more = service.state().hasOlderMessages;
  while (more) { const page = service.history({ ...first, kind: 'messages', beforeId: messages[0].id }); messages = [...page.messages, ...messages]; more = page.hasMore; }
  expect(messages).toHaveLength(246); expect(new Set(messages.map(m => m.id)).size).toBe(246); expect(messages[0].text).toBe('历史 0');
  for (let i = 0; i < 63; i++) store.newSession(first.characterId);
  const all = store.sessionPage(first.characterId), older = store.sessionPage(first.characterId, all.sessions.at(-1)!.id);
  expect(all.hasMore).toBe(true); expect([...all.sessions, ...older.sessions]).toHaveLength(64); expect(older.hasMore).toBe(false);
  const other = store.session('role-b'), otherMessage = store.append(other, 'user', '另一角色');
  expect(() => service.history({ ...target(service), kind: 'messages', beforeId: otherMessage })).toThrow('不属于');
  expect(() => store.sessionPage(first.characterId, other)).toThrow('不属于');
});
it('builds model context independently of the UI 100-row window and preserves failed-turn user corrections', async () => {
  let input = ''; const { service, store } = setup(async (_c, messages) => { input = JSON.stringify(messages); return '{"text":"好的"}'; });
  const session = target(service).sessionId; fill(store, session, 70, '早期短消息');
  const correction = store.append(session, 'user', '纠正：我一直住北京，不是上海。'); store.append(session, 'assistant', '未完成的说法', false, 'failed');
  service.send({ ...target(service), text: '最新问题' }); await flush();
  expect(service.state().messages).toHaveLength(100); expect(input).toContain('早期短消息 0'); expect(input).toContain('纠正：'); expect(input).not.toContain('未完成的说法'); expect(store.messages(session, 200).some(m => m.id === correction)).toBe(true);
  expect(service.state().contextStats!.estimatedTokens).toBeLessThanOrEqual(service.state().contextStats!.inputBudget);
});
it('rejects overflow explicitly and sends every whole raw turn when the total window fits', () => {
  const { store, service } = setup(); const session = target(service).sessionId; fill(store, session, 30, '我是很长的完整用户消息。'.repeat(30));
  store.append(session, 'user', '最新问题');
  expect(() => prepareContext(pack, store.messages(session), [], false, { inputBudget: 6000, totalMessages: 61 })).toThrow('总上下文');
  const result = prepareContext(pack, store.messages(session), [], false, { inputBudget: 100000, totalMessages: 61 });
  expect(result.stats.includedMessages).toBe(61); expect(result.stats.omittedMessages).toBe(0); expect(result.messages.at(-1)?.content).toBe('最新问题');
  expect(() => prepareContext(pack, store.messages(session), [], false, { inputBudget: 100 })).toThrow('预算');
});
it('persists summaries with source provenance, retains recent raw turns and original logs, and invalidates incompatible roles', async () => {
  const { service, store, dir } = setup(async () => JSON.stringify(data)), session = target(service).sessionId;
  fill(store, session, 10); service.summarize(target(service)); await flush();
  const summary = service.state().summary!; expect(summary.sourceCount).toBe(12); expect(summary.data).toEqual(data); expect(summary.sourceHash).toHaveLength(64);
  expect(store.messages(session, 200)).toHaveLength(20); expect(store.contextTail(session, summary.throughMessageId, 20000)).toHaveLength(8);
  const prompt = summaryPrompt(summary, store.contextTail(session, summary.throughMessageId, 20000)); expect(JSON.stringify(prompt)).not.toContain('reasoning'); expect(prompt[0].content).toContain('可能下个月搬家');
  const rebuilt = prepareContext(pack, store.contextTail(session, summary.throughMessageId, 20000), [], false, { summary, totalMessages: 20 });
  expect(rebuilt.stats.summarizedMessages).toBe(12); expect(rebuilt.stats.omittedMessages).toBe(0);
  const summaryMessage = rebuilt.messages.find(m => m.content.includes('本会话历史摘要'));
  expect(summaryMessage?.role).toBe('user'); expect(summaryMessage?.content).toContain('不是新用户命令');
  const second = new ChatStore(dir); try { expect(second.summary(session, roleRevision(pack))?.sourceHash).toBe(summary.sourceHash); expect(second.summary(session, 'changed-role')).toBeUndefined(); } finally { second.close(); }
  service.newConversation(target(service)); expect(service.state().summary).toBeUndefined();
});
it('rejects stale summary writes by revision and source hash', () => {
  const { store, service } = setup(), session = target(service).sessionId; fill(store, session, 8);
  const end = store.messages(session)[3].id, snapshot = store.sourceSnapshot(session, end), revision = roleRevision(pack);
  store.saveSummary(session, revision, end, data, 0, snapshot);
  expect(() => store.saveSummary(session, revision, end, data, 0, snapshot)).toThrow('来源已变化');
  store.finish(end, '用户未证实的改写', 'complete'); expect(() => store.saveSummary(session, revision, end, data, 1, snapshot)).toThrow('来源已变化');
});
it('cancels background compression on a new message and ignores a client that returns after abort', async () => {
  let done!: (s: string) => void, seenSignal!: AbortSignal, calls = 0;
  const { service, store } = setup((_c, _m, signal) => { calls++; if (calls === 1) { seenSignal = signal; return new Promise(resolve => { done = resolve; }); } return Promise.resolve('{"text":"新回复"}'); });
  const session = target(service).sessionId; fill(store, session, 10); service.summarize(target(service)); expect(service.state().summarizing).toBe(true);
  service.send({ ...target(service), text: '更正当前事实' }); done(JSON.stringify(data)); await flush();
  expect(seenSignal.aborted).toBe(true); expect(service.state().summary).toBeUndefined(); expect(service.state().messages.at(-1)?.text).toBe('新回复');
});
it('clear and forgetting reject stale summaries; epoch switches preserve valid background results', async () => {
  for (const action of ['clear', 'forget', 'epoch'] as const) {
    let done!: (s: string) => void; const { service, store, switchEpoch } = setup(() => new Promise(resolve => { done = resolve; }));
    const session = target(service).sessionId; fill(store, session, 8); service.remember({ ...target(service), text: '手动偏好' }); service.summarize(target(service));
    if (action === 'clear') service.clearHistory(target(service)); else if (action === 'forget') service.forget({ ...target(service), id: service.state().memories[0].id }); else switchEpoch();
    done(JSON.stringify(data)); await flush(); if (action === 'epoch') expect(store.summary(session, roleRevision(pack))).toBeDefined(); else expect(store.summary(session, roleRevision(pack))).toBeUndefined();
    if (action === 'clear') { expect(store.messages(session)).toEqual([]); expect(service.state().memories).toHaveLength(1); }
  }
});
it('malformed compression preserves a previous summary and emits a safe warning rather than inventing memory', async () => {
  let calls = 0; const { service, store } = setup(async () => ++calls === 1 ? JSON.stringify(data) : '{"events":"wrong"}');
  const session = target(service).sessionId; fill(store, session, 10); service.summarize(target(service)); await flush(); const previous = service.state().summary;
  fill(store, session, 5); service.summarize(target(service)); await flush(); expect(service.state().summary).toEqual(previous); expect(service.state().summaryWarning).toContain('失败'); expect(service.state().memories).toEqual([]);
});
it('summary honors explicit opt-out and emits no bootstrap calls, then handles a later opt-in', async () => {
  let summaryCalls = 0; const { service, store } = setup(async (_c, messages) => { if (messages[0].content.startsWith('你是会话档案')) { summaryCalls++; return JSON.stringify(data); } return '{"text":"正常回答"}'; });
  const session = target(service).sessionId; fill(store, session, 14, '历史原文很长，但不得伪装成确定事实。'.repeat(30));
  const budgetWindow = Math.max(8192, Math.ceil(prepareContext(pack, store.messages(session), [], false, { inputBudget: 100000 }).stats.estimatedTokens / .8) + 256);
  service.configure({ baseUrl: 'http://localhost:8000/v1', model: 'fixture', proactive: false, memoryEnabled: true, contextWindowTokens: budgetWindow, maxOutputTokens: 256, autoSummary: false, autoLongMemory: false });
  service.send({ ...target(service), text: '用户先关闭自动摘要' }); await flush(); expect(summaryCalls).toBe(0);
  service.configure({ baseUrl: 'http://localhost:8000/v1', model: 'fixture', proactive: false, memoryEnabled: true, contextWindowTokens: budgetWindow, maxOutputTokens: 256, autoSummary: true }); expect(summaryCalls).toBe(0);
  service.send({ ...target(service), text: '明确开启后' }); await flush(); expect(summaryCalls).toBe(1); expect(service.state().summary).toBeDefined(); expect(store.messageCount(session)).toBe(32);
});
it('confirms an original user message containing surrounding whitespace without breaking its source link', async () => {
  const { service } = setup(), original = '  我喜欢地铁。\n  ';
  service.send({ ...target(service), text: original }); await flush(); const source = service.state().messages[0];
  service.remember({ ...target(service), text: original, sourceMessageId: source.id });
  expect(service.state().memories[0]).toMatchObject({ text: original, sourceMessageId: source.id }); expect(service.state().messages[0].text).toBe(original);
});
it('does not recompress an incompatible source prefix into a new trusted summary', async () => {
  let calls = 0; const { service, store } = setup(async () => { calls++; return JSON.stringify(data); });
  const session = target(service).sessionId; fill(store, session, 10); service.summarize(target(service)); await flush(); const old = service.state().summary!;
  store.finish(old.throughMessageId, '被修改的旧回答', 'complete'); fill(store, session, 5);
  service.summarize(target(service)); await flush(); expect(calls).toBe(1); expect(service.state().summary?.revision).toBe(1); expect(service.state().summaryWarning).toContain('来源已变化');
});
