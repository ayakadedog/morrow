import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { loadPack } from '../../src/main/characters/PackLoader';
import { ChatStore } from '../../src/main/chat/ChatStore';
import { ChatService } from '../../src/main/chat/ChatService';
import { ModelConfig } from '../../src/main/chat/ModelConfig';
import type { Generate } from '../../src/main/chat/ModelClient';
import { roleRevision } from '../../src/main/chat/ConversationSummary';
import { temporary, remove } from './fixtures';
const pack = loadPack(resolve('characters'), 'yoshino'), cleanups: (() => void)[] = [];
const data = { events: ['旧经过'], userStatements: ['旧用户陈述'], fictionalState: [], uncertainties: [], commitments: [], openQuestions: [], keyQuotes: [] };
const codec = { encrypt: (s: string) => s, decrypt: (s: string) => s };
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function target(service: ChatService) { const { characterId, epoch, sessionId, historyRevision } = service.state(); return { characterId, epoch, sessionId, historyRevision }; }
function setup(client: Generate = async () => '{"text":"新回答"}') {
  const dir = temporary(), store = new ChatStore(dir), config = new ModelConfig(dir, codec), delivered: string[] = []; let invalidated = 0;
  config.save({ baseUrl: 'http://localhost:8000/v1', model: 'fixture', proactive: false, memoryEnabled: true });
  const service = new ChatService(store, config, () => ({ pack, epoch: 1 }), () => {}, reply => delivered.push(reply.text), () => true, client, undefined, () => { invalidated++; });
  cleanups.push(() => { service.dispose(); remove(dir); });
  return { service, store, config, dir, delivered, invalidated: () => invalidated };
}
function pair(store: ChatStore, session: string, text: string) { return { user: store.append(session, 'user', text), assistant: store.append(session, 'assistant', `旧回答:${text}`) }; }
function archive(dir: string) { const db = new DatabaseSync(join(dir, 'chat.sqlite'), { readOnly: true }); try { return db.prepare('SELECT message_id,text FROM user_inputs ORDER BY sequence').all(); } finally { db.close(); } }
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()));
it('edits an earlier input by rewinding dependent turns and atomically replacing both text copies, with one model call', async () => {
  let calls = 0, prompt = ''; const { service, store, dir, invalidated } = setup(async (_c, messages) => { calls++; prompt = JSON.stringify(messages); return '{"text":"按新事实回答"}'; });
  const initial = target(service), before = pair(store, initial.sessionId, '保留前文'), old = pair(store, initial.sessionId, '我住上海'), later = pair(store, initial.sessionId, '旧后续');
  const raw = '  更正：我一直住北京。\n '; service.edit({ ...initial, messageId: old.user, text: raw }); await flush();
  expect(calls).toBe(1); expect(service.state().historyRevision).toBe(1); expect(invalidated()).toBe(1);
  expect(service.state().messages.map(m => m.text)).toEqual(['保留前文', '旧回答:保留前文', raw, '按新事实回答']);
  expect(archive(dir)).toEqual([{ message_id: before.user, text: '保留前文' }, { message_id: service.state().messages[2].id, text: raw }]);
  expect(service.state().messages.some(m => m.id === old.user || m.id === later.user)).toBe(false); expect(prompt).not.toContain('我住上海'); expect(prompt).not.toContain('旧后续');
});
it('regenerates an answer without duplicating its original user input, source memory or archive, and omits discarded reasoning', async () => {
  let prompt = ''; const { service, store, dir } = setup(async (_c, messages, _signal, _delta, reasoning) => { prompt = JSON.stringify(messages); reasoning?.('新公开推理'); return '{"text":"新回答"}'; });
  const initial = target(service), old = pair(store, initial.sessionId, '原问题'); store.finish(old.assistant, '旧最终回答', 'complete', undefined, '旧推理不可回传');
  service.remember({ ...initial, text: '原问题', sourceMessageId: old.user }); const sourceArchive = archive(dir);
  service.regenerate({ ...initial, messageId: old.assistant }); await flush();
  expect(archive(dir)).toEqual(sourceArchive); expect(service.state().messages[0].id).toBe(old.user); expect(service.state().memories).toHaveLength(1);
  expect(service.state().messages[1]).toMatchObject({ text: '新回答', reasoning: '新公开推理' }); expect(service.state().messages[1].id).not.toBe(old.assistant);
  expect(prompt).not.toContain('旧最终回答'); expect(prompt).not.toContain('旧推理不可回传');
});
it('retraction removes source-derived memory and summary while preserving independent memory and unrelated sessions/characters', () => {
  const { service, store, dir } = setup(), initial = target(service), old = pair(store, initial.sessionId, '会被撤回'); pair(store, initial.sessionId, '后续');
  const otherSession = store.newSession(initial.characterId); const other = pair(store, otherSession, '独立会话'); store.selectSession(initial.characterId, initial.sessionId);
  const roleB = store.session('role-b'); pair(store, roleB, '角色B');
  service.remember({ ...initial, text: '会被撤回', sourceMessageId: old.user }); service.remember({ ...initial, text: '手动独立偏好' });
  store.saveSummary(initial.sessionId, roleRevision(pack), old.assistant, data, 0, store.sourceSnapshot(initial.sessionId, old.assistant));
  service.retract({ ...initial, messageId: old.user });
  expect(service.state().messages).toEqual([]); expect(service.state().summary).toBeUndefined(); expect(service.state().memories.map(m => m.text)).toEqual(['手动独立偏好']);
  expect(store.messages(otherSession)[0].id).toBe(other.user); expect(store.messages(roleB)).toHaveLength(2); expect(archive(dir)).toHaveLength(2);
});
it('old revision targets and paging cannot restore removed messages or mutate the rewritten session', () => {
  const { service, store } = setup(), initial = target(service), old = pair(store, initial.sessionId, '原来');
  service.retract({ ...initial, messageId: old.assistant });
  for (const action of [() => service.clearHistory(initial), () => service.send({ ...initial, text: '过期输入' }), () => service.retract({ ...initial, messageId: old.user }), () => service.history({ ...initial, kind: 'messages', beforeId: old.user })]) expect(action).toThrow('记录已更新');
  expect(service.state().messages[0].id).toBe(old.user); expect(service.state().historyRevision).toBe(1);
});
it('editing aborts an active old reply and rejects its late answer/reasoning and presentation callbacks', async () => {
  let done!: (s: string) => void, think!: (s: string) => void, oldSignal!: AbortSignal, calls = 0;
  const { service, delivered } = setup((_c, _m, signal, _delta, reasoning) => ++calls === 1 ? new Promise(resolve => { done = resolve; think = reasoning!; oldSignal = signal; }) : Promise.resolve('{"text":"新的回复"}'));
  service.send({ ...target(service), text: '旧问题' }); const oldUser = service.state().messages[0]; think('旧思考');
  service.edit({ ...target(service), messageId: oldUser.id, text: '新问题' }); think('迟到思考'); done('{"text":"迟到回答"}'); await flush();
  expect(oldSignal.aborted).toBe(true); expect(delivered).toEqual(['新的回复']); expect(JSON.stringify(service.state())).not.toContain('迟到');
});
it('retraction invalidates an active summary even if its client ignores abort', async () => {
  let done!: (s: string) => void; const { service, store } = setup(() => new Promise(resolve => { done = resolve; }));
  const initial = target(service), first = pair(store, initial.sessionId, '先说'); for (let i = 0; i < 8; i++) pair(store, initial.sessionId, `轮次${i}`);
  service.summarize(initial); service.retract({ ...initial, messageId: first.user }); done(JSON.stringify(data)); await flush(); expect(service.state().summary).toBeUndefined(); expect(service.state().messages).toEqual([]);
});
it('validates edit text, reply ownership and provider availability before deleting existing history', () => {
  const { service, store } = setup(), initial = target(service), old = pair(store, initial.sessionId, '原问题');
  expect(() => service.edit({ ...initial, messageId: old.user, text: ' \n ' })).toThrow(); expect(() => service.edit({ ...initial, messageId: old.assistant, text: '不能编辑回答' })).toThrow('用户消息');
  const proactive = store.append(initial.sessionId, 'assistant', '主动关心', true); expect(() => service.regenerate({ ...initial, messageId: proactive })).toThrow('普通模型回答');
  const otherSession = store.session('role-b'), other = pair(store, otherSession, '别的角色'); expect(() => service.retract({ ...initial, messageId: other.user })).toThrow('不属于');
  expect(service.state().messages).toHaveLength(3); expect(service.state().historyRevision).toBe(0);
});
it('a replacement archive failure rolls back messages, archive, memories, summary and history revision together', () => {
  const { store, service, dir } = setup(), initial = target(service), old = pair(store, initial.sessionId, '来源事实');
  service.remember({ ...initial, text: '来源事实', sourceMessageId: old.user }); store.saveSummary(initial.sessionId, roleRevision(pack), old.assistant, data, 0, store.sourceSnapshot(initial.sessionId, old.assistant));
  const before = service.state(), archiveBefore = archive(dir); const fault = new DatabaseSync(join(dir, 'chat.sqlite'));
  try { fault.exec("CREATE TRIGGER fail_replacement BEFORE INSERT ON user_inputs BEGIN SELECT RAISE(ABORT,'replacement archive failed'); END;"); expect(() => service.edit({ ...initial, messageId: old.user, text: '新的事实' })).toThrow('replacement archive failed'); }
  finally { fault.exec('DROP TRIGGER fail_replacement'); fault.close(); }
  expect(service.state().messages).toEqual(before.messages); expect(service.state().memories).toEqual(before.memories); expect(service.state().summary).toEqual(before.summary); expect(service.state().historyRevision).toBe(0); expect(archive(dir)).toEqual(archiveBefore);
});
it('a failed regenerated answer preserves the original user and can be regenerated again', async () => {
  let calls = 0; const { service, store, dir } = setup(async () => { if (++calls === 1) throw new Error('provider-secret-test'); return '{"text":"成功重试"}'; });
  const initial = target(service), old = pair(store, initial.sessionId, '保留原问题'); service.regenerate({ ...initial, messageId: old.assistant }); await flush();
  expect(service.state().messages[1].status).toBe('failed'); expect(JSON.stringify(service.state())).not.toContain('provider-secret-test');
  service.regenerate({ ...target(service), messageId: service.state().messages[1].id }); await flush(); expect(service.state().messages[1].text).toBe('成功重试'); expect(archive(dir)).toEqual([{ message_id: old.user, text: '保留原问题' }]);
});
it('revised history and the revision survive reopening the database', () => {
  const { service, store, dir } = setup(), initial = target(service), old = pair(store, initial.sessionId, '原问题'); service.retract({ ...initial, messageId: old.assistant });
  const reopened = new ChatStore(dir); try { expect(reopened.historyRevision(initial.sessionId)).toBe(1); expect(reopened.messages(initial.sessionId).map(m => m.id)).toEqual([old.user]); } finally { reopened.close(); }
});
