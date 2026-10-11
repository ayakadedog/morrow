import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadPack } from '../../src/main/characters/PackLoader';
import { ModelConfig, endpointSchema } from '../../src/main/chat/ModelConfig';
import { ChatStore } from '../../src/main/chat/ChatStore';
import { ChatService, type ChatContext } from '../../src/main/chat/ChatService';
import { buildContext, prepareContext, parseReply, visibleDraft } from '../../src/main/chat/ContextBuilder';
import { type Generate } from '../../src/main/chat/ModelClient';
import { temporary, remove } from './fixtures';
import { chatSendInputSchema } from '../../src/shared/chatInput';
const pack = loadPack(resolve('characters'), 'yoshino');
const roots: string[] = [], services: ChatService[] = [], stores: ChatStore[] = [];
const codec = { encrypt: (s: string) => Buffer.from(s).toString('base64'), decrypt: (s: string) => Buffer.from(s, 'base64').toString() }; // Test codec only; production uses DPAPI.
function root() { const value = temporary(); roots.push(value); return value; }
function setup(client: Generate, timeout = 45000) {
  const dir = root(), config = new ModelConfig(dir, codec); config.save({ baseUrl: 'http://localhost:8000/v1', model: 'test-model', proactive: false, memoryEnabled: true, apiKey: 'test-secret-never-real' });
  const store = new ChatStore(dir), delivered: unknown[] = [];
  let ctx: ChatContext = { pack, epoch: 1 }, allowed = true;
  const service = new ChatService(store, config, () => ctx, () => {}, (reply, proactive) => delivered.push({ ...reply, proactive }), () => allowed, client, timeout); services.push(service);
  return { service, store, config, dir, delivered, switch: () => { ctx = { pack: { ...pack, view: { ...pack.view, id: 'role-b', defaultExpression: 'normal' } }, epoch: 2 }; service.switched(); }, quiet: () => { allowed = false; } };
}
async function flush() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
function target(service: ChatService) { const { characterId, epoch, sessionId, historyRevision } = service.state(); return { characterId, epoch, sessionId, historyRevision }; }
afterEach(() => { services.splice(0).forEach(s => s.dispose()); stores.splice(0).forEach(s => s.close()); roots.splice(0).forEach(remove); vi.restoreAllMocks(); vi.useRealTimers(); });
describe('chat and explicit memory lifecycle', () => {
  it('stores the submitted user source before generation without trimming spaces or line breaks', () => {
    const original = '  我可能下个月搬家。\n\n现在还没有决定。\n  ';
    const { service, store } = setup((_connection, messages) => {
      const persisted = store.messages(service.state().sessionId).find(m => m.role === 'user');
      expect(persisted?.text).toBe(original);
      expect(messages.at(-1)?.content).toBe(original);
      return new Promise(() => {});
    });
    const input = chatSendInputSchema.parse({ characterId: 'yoshino', epoch: 1, sessionId: service.state().sessionId, historyRevision: 0, text: original });
    service.send(input);
    expect(service.state().messages[0]).toMatchObject({ role: 'user', text: original, status: 'complete' });
    expect(service.state().memories).toEqual([]);
    expect(chatSendInputSchema.safeParse({ ...input, text: ' \n\t ' }).success).toBe(false);
    expect(chatSendInputSchema.safeParse({ ...input, text: '字'.repeat(6001) }).success).toBe(false);
  });
  it('keeps user source messages after a failed or cancelled answer and a database restart', async () => {
    const { service, dir } = setup(async () => { throw new Error('模拟模型失败'); });
    const original = '  这条输入不能因为回复失败而丢失。\n';
    service.send(chatSendInputSchema.parse({ characterId: 'yoshino', epoch: 1, sessionId: service.state().sessionId, historyRevision: 0, text: original })); await flush();
    const sessionId = service.state().sessionId;
    expect(service.state().messages.at(-1)?.status).toBe('failed');
    service.dispose(); services.splice(services.indexOf(service), 1);
    const reopened = new ChatStore(dir); stores.push(reopened);
    expect(reopened.session('yoshino')).toBe(sessionId);
    expect(reopened.messages(sessionId)[0]).toMatchObject({ text: original, role: 'user', status: 'complete' });
    const cancelled = setup(() => new Promise(() => {}));
    cancelled.service.send({ characterId: 'yoshino', epoch: 1, sessionId: cancelled.service.state().sessionId, historyRevision: 0, text: original }); cancelled.service.cancel();
    expect(cancelled.service.state().messages[0]).toMatchObject({ text: original, role: 'user', status: 'complete' });
    expect(cancelled.service.state().messages.at(-1)?.status).toBe('cancelled');
  });
  it('retains inputs older than the display window and repeated utterances as separate source events', () => {
    const dir = root(), store = new ChatStore(dir), sessionId = store.session('yoshino');
    const first = store.append(sessionId, 'user', '我暂时住上海。');
    const second = store.append(sessionId, 'user', '我暂时住上海。');
    expect(first).not.toBe(second);
    for (let i = 0; i < 110; i++) store.append(sessionId, 'user', `输入 ${i}`);
    expect(store.messages(sessionId)).toHaveLength(100); store.close();
    const reopened = new ChatStore(dir); stores.push(reopened);
    const all = reopened.messages(sessionId, 200);
    expect(all).toHaveLength(112);
    expect(all.slice(0, 2).map(m => m.id)).toEqual([first, second]);
    expect(all.slice(0, 2).map(m => m.text)).toEqual(['我暂时住上海。', '我暂时住上海。']);
    expect(reopened.messages(reopened.session('role-b'), 200)).toEqual([]);
    expect(reopened.messages(reopened.newSession('yoshino'))).toEqual([]);
    expect(reopened.messages(sessionId, 200)).toHaveLength(112);
  });
  it('persists reasoning separately, never delivers its actions, and excludes it from later prompts', async () => {
    let resolve!: (s: string) => void, think!: (s: string) => void, answer!: (s: string) => void, prompt = '', calls = 0;
    const { service, delivered, store, dir } = setup((_c, messages, _signal, delta, reasoning) => {
      prompt = JSON.stringify(messages); calls++; answer = delta; think = reasoning!;
      return calls === 1 ? new Promise(done => { resolve = done; }) : Promise.resolve('{"text":"第二句"}');
    });
    service.send({ characterId: 'yoshino', epoch: 1, sessionId: service.state().sessionId, historyRevision: 0, text: '你好' });
    think('{"text":"推理机密样例","action":"greet"}');
    expect(service.state()).toMatchObject({ generationPhase: 'thinking', draft: '', reasoningDraft: '{"text":"推理机密样例","action":"greet"}' }); expect(delivered).toEqual([]);
    answer('{"text":"真正台词"}'); expect(service.state().generationPhase).toBe('answering');
    resolve('{"text":"真正台词"}'); await flush();
    expect(delivered).toEqual([{ text: '真正台词', expression: 'normal', proactive: false }]);
    expect(service.state().messages.at(-1)).toMatchObject({ text: '真正台词', reasoning: '{"text":"推理机密样例","action":"greet"}', status: 'complete' });
    service.send({ characterId: 'yoshino', epoch: 1, sessionId: service.state().sessionId, historyRevision: 0, text: '继续' }); await flush();
    expect(prompt).not.toContain('推理机密样例'); expect(prompt).toContain('真正台词'); expect(service.state().memories).toEqual([]);
    const session = service.state().sessionId; service.dispose(); services.splice(services.indexOf(service), 1);
    const reopened = new ChatStore(dir); stores.push(reopened); expect(reopened.messages(session)[1].reasoning).toContain('推理机密样例');
  });
  it('keeps cancelled reasoning separate and blocks late reasoning after switching roles', async () => {
    let think!: (s: string) => void, done!: (s: string) => void;
    const { service, store, delivered, switch: switchRole } = setup((_c, _m, _s, _delta, reasoning) => { think = reasoning!; return new Promise(resolve => { done = resolve; }); });
    const session = service.state().sessionId; service.send({ characterId: 'yoshino', epoch: 1, sessionId: service.state().sessionId, historyRevision: 0, text: '等一等' }); think('正在思考'); switchRole();
    think('迟到污染'); done('{"text":"迟到台词"}'); await flush();
    expect(store.messages(session).at(-1)).toMatchObject({ status: 'cancelled', text: '', reasoning: '正在思考' });
    expect(service.state().reasoningDraft).toBeUndefined(); expect(service.state().messages).toEqual([]); expect(delivered).toEqual([]);
  });
  it('completes one streamed turn, supplies persona and confirmed memory, validates role actions', async () => {
    let prompt = ''; const { service, delivered } = setup(async (_c, messages, _signal, delta) => { prompt = JSON.stringify(messages); delta('{"text":"你好'); delta('，小林。","expression":"happy","action":"greet"}'); return '{"text":"你好，小林。","expression":"happy","action":"greet"}'; });
    service.remember({ ...target(service), text: '我叫小林' });
    service.send({ characterId: 'yoshino', epoch: 1, sessionId: service.state().sessionId, historyRevision: 0, text: '你好' }); expect(service.state().busy).toBe(true); await flush();
    expect(service.state().busy).toBe(false); expect(service.state().messages.map(m => m.status)).toEqual(['complete', 'complete']);
    expect(delivered).toEqual([{ text: '你好，小林。', expression: 'happy', action: 'greet', proactive: false }]); expect(prompt).toContain('我叫小林'); expect(JSON.parse(prompt)[0].content).toContain(pack.roleProfile?.identity.summary ?? pack.persona.slice(0, 20));
    expect(JSON.stringify(service.state())).not.toContain('test-secret');
  });
  it('cancel and switch invalidate late streams, replies and writes even if the client ignores abort', async () => {
    let done!: (s: string) => void, delta!: (s: string) => void; const { service, delivered, store, switch: switchRole } = setup((_c, _m, _s, onDelta) => { delta = onDelta; return new Promise(resolve => { done = resolve; }); });
    const oldSession = service.state().sessionId; service.send({ characterId: 'yoshino', epoch: 1, sessionId: service.state().sessionId, historyRevision: 0, text: '等一下' }); delta('{"text":"正在'); expect(service.state().draft).toBe('正在');
    switchRole(); delta('污染新角色"}'); done('{"text":"不能出现"}'); await flush();
    expect(service.state().characterId).toBe('role-b'); expect(service.state().messages).toEqual([]); expect(delivered).toEqual([]); expect(store.messages(oldSession).at(-1)?.status).toBe('cancelled');
    expect(() => service.send({ characterId: 'yoshino', epoch: 1, sessionId: service.state().sessionId, historyRevision: 0, text: '迟到输入' })).toThrow('角色已切换');
  });
  it('rejects overlapping turns, stops when forgetting, and never auto-saves model guesses', async () => {
    const { service } = setup(() => new Promise(() => {})); service.remember({ ...target(service), text: '我喜欢蓝色' });
    service.send({ characterId: 'yoshino', epoch: 1, sessionId: service.state().sessionId, historyRevision: 0, text: '聊聊' }); expect(() => service.send({ characterId: 'yoshino', epoch: 1, sessionId: service.state().sessionId, historyRevision: 0, text: '再聊' })).toThrow('正在回复');
    service.forget({ ...target(service), id: service.state().memories[0].id }); expect(service.state().busy).toBe(false); expect(service.state().memories).toEqual([]);
  });
  it('isolates memory sources and conversation access; deletes all role sessions without deleting memory', async () => {
    const { service, store, switch: switchRole } = setup(async () => '{"text":"好的"}'); service.send({ characterId: 'yoshino', epoch: 1, sessionId: service.state().sessionId, historyRevision: 0, text: '我喜欢散步' }); await flush();
    const first = service.state(), id = first.messages[0].id; service.remember({ ...target(service), text: '我喜欢散步', sourceMessageId: id });
    expect(() => service.remember({ ...target(service), text: '伪造资料', sourceMessageId: id })).toThrow('来源');
    const second = service.newConversation(target(service)); expect(second.sessionId).not.toBe(first.sessionId); expect(second.memories.length).toBe(1);
    service.selectConversation({ ...target(service), selectedSessionId: first.sessionId }); expect(service.state().messages.length).toBe(2);
    switchRole(); expect(() => service.selectConversation({ ...target(service), selectedSessionId: first.sessionId })).toThrow('不属于');
    expect(() => store.remember('role-b', '我喜欢散步', id)).toThrow('来源'); expect(service.state().memories).toEqual([]);
    store.clearHistory('yoshino'); expect(store.messages(first.sessionId)).toEqual([]); expect(store.memories('yoshino')[0].sourceMessageId).toBeUndefined();
  });
  it('recovers interrupted messages as cancelled after restart', () => {
    const dir = root(), one = new ChatStore(dir), session = one.session('yoshino'); one.append(session, 'assistant', '', false, 'pending'); one.remember('yoshino', '已确认事实'); one.close();
    const two = new ChatStore(dir); stores.push(two); expect(two.messages(session)[0].status).toBe('cancelled'); expect(two.memories('yoshino')[0].text).toBe('已确认事实');
  });
  it('timeout, malformed replies and secret-bearing provider errors do not become completed replies', async () => {
    vi.useFakeTimers(); const { service } = setup(() => new Promise(() => {}), 1000); service.send({ characterId: 'yoshino', epoch: 1, sessionId: service.state().sessionId, historyRevision: 0, text: '你好' }); vi.advanceTimersByTime(1000);
    expect(service.state().error).toContain('超时'); expect(service.state().messages.at(-1)?.status).toBe('cancelled');
    const bad = setup(async () => { throw new Error('provider leaked test-secret-never-real'); }); bad.service.send({ characterId: 'yoshino', epoch: 1, sessionId: bad.service.state().sessionId, historyRevision: 0, text: '你好' }); await flush();
    expect(bad.service.state().messages.at(-1)?.status).toBe('failed'); expect(JSON.stringify(bad.service.state())).not.toContain('test-secret');
    const malformed = setup(async () => '{"text":"unfinished'); malformed.service.send({ characterId: 'yoshino', epoch: 1, sessionId: malformed.service.state().sessionId, historyRevision: 0, text: '你好' }); await flush(); expect(malformed.delivered).toEqual([]);
  });
  it('requires opt-in, prior chat and local permission for remote proactive; suppresses responses after quiet', async () => {
    let done!: (s: string) => void, calls = 0; const { service, delivered, quiet } = setup(() => { calls++; return new Promise(resolve => { done = resolve; }); });
    expect(service.proactive()).toBe(false); service.configure({ baseUrl: 'http://localhost:8000/v1', model: 'test-model', proactive: true, memoryEnabled: true }); expect(service.proactive()).toBe(false);
    service.send({ characterId: 'yoshino', epoch: 1, sessionId: service.state().sessionId, historyRevision: 0, text: '今天有点累' }); done('{"text":"休息一下吧。"}'); await flush();
    expect(service.proactive()).toBe(true); quiet(); done('{"text":"我在这里陪你。"}'); await flush(); expect(delivered.length).toBe(1); expect(service.state().messages.at(-1)?.status).toBe('cancelled'); expect(calls).toBe(2);
  });
});
describe('provider, context and model configuration', () => {
  it('prepares canonical examples as isolated protocol-valid message pairs before real history', () => {
    const gojo = loadPack(resolve('characters'), 'gojo');
    const history = [{ id: 'query', role: 'user' as const, text: '你对我怎么看', status: 'complete' as const, createdAt: 1, proactive: false }];
    const prepared = prepareContext(gojo, history, [], false);
    const examples = prepared.messages.slice(1, -1);
    expect(examples).toHaveLength(gojo.roleProfile!.examples.length * 2);
    for (const [index, example] of gojo.roleProfile!.examples.entries()) {
      expect(examples[index * 2]).toEqual({ role: 'user', content: `【角色对白示例】情境：${example.situation}\n对方：${example.user}` });
      expect(examples[index * 2 + 1].role).toBe('assistant');
      const reply = JSON.parse(examples[index * 2 + 1].content);
      expect(reply).toEqual({ text: example.assistant, speaker: example.speaker, expression: gojo.view.defaultExpression, action: null });
      expect(parseReply(examples[index * 2 + 1].content, gojo).text).toBe(example.assistant);
    }
    expect(JSON.stringify(examples)).not.toContain('https://');
    expect(prepared.messages[0].content).not.toContain('原创说话示例');
    expect(prepared.messages.at(-1)).toEqual({ role: 'user', content: history[0].text });
    expect(prepared.stats.includedMessages).toBe(1);
    expect(() => prepareContext(gojo, history, [], false, { inputBudget: prepared.stats.estimatedTokens - 1 })).toThrow('预算');
  });
  it('keeps assistant history consistent with the JSON output contract without inventing past actions', () => {
    const history = [{ id: '1', role: 'user' as const, text: '你好', status: 'complete' as const, createdAt: 1, proactive: false }, { id: '2', role: 'assistant' as const, text: '你好\n{"text":"引用内容"}', speaker: 'yoshino', reasoning: '不携带推理', status: 'complete' as const, createdAt: 2, proactive: false }];
    const messages = buildContext(pack, history, [], false), assistant = messages.filter(m => m.role === 'assistant').at(-1);
    expect(JSON.parse(assistant!.content)).toEqual({ text: history[1].text, speaker: 'yoshino' }); expect(JSON.stringify(messages)).not.toContain('不携带推理'); expect(messages[0].content).toContain('JSON 格式示例');
  });
  it('encrypts persisted keys, never returns them, clears them when endpoints change', () => {
    const dir = root(), config = new ModelConfig(dir, codec); config.save({ baseUrl: 'https://example.com/v1', model: 'test', apiKey: 'secret-key-for-test', proactive: false, memoryEnabled: true });
    expect(readFileSync(join(dir, 'chat-model.json'), 'utf8')).not.toContain('secret-key-for-test'); expect(config.public().hasKey).toBe(true); expect(JSON.stringify(config.public())).not.toContain('secret-key');
    config.save({ baseUrl: 'https://other.example/v1', model: 'test', proactive: false, memoryEnabled: true }); expect(config.public().hasKey).toBe(false);
    expect(endpointSchema.safeParse('http://external.example/v1').success).toBe(false); expect(endpointSchema.safeParse('https://user:pass@example.com/v1').success).toBe(false);
    expect(endpointSchema.safeParse('https://example.com/v1?key=private').success).toBe(false); expect(endpointSchema.safeParse('http://127.0.0.1:9000/v1').success).toBe(true);
  });
  it('migrates old connection settings without losing keys and persists nonstream mode', () => {
    const dir = root(), file = join(dir, 'chat-model.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, baseUrl: 'http://localhost:8000/v1', model: 'fixture', encryptedKey: codec.encrypt('fixture-secret'), proactive: false, memoryEnabled: true }));
    const config = new ModelConfig(dir, codec); expect(config.warning).toBeUndefined(); expect(config.public().streaming).toBe(true); expect(config.public().hasKey).toBe(true);
    expect(config.public()).toMatchObject({ provider: 'openai-compatible', thinking: 'default', protocol: 'chat-completions', reasoningEffort: 'default', reasoningSummary: true, maxOutputTokens: 12288, timeoutSeconds: 120 });
    config.save({ baseUrl: 'http://localhost:8000/v1', model: 'fixture', proactive: false, memoryEnabled: true, streaming: false });
    const reopened = new ModelConfig(dir, codec); expect(reopened.connection()).toMatchObject({ apiKey: 'fixture-secret', streaming: false });
    expect(JSON.stringify(reopened.public())).not.toContain('fixture-secret');
  });
  it('persists reasoning options and rejects invalid budgets or waiting times', () => {
    const dir = root(), config = new ModelConfig(dir, codec), input = { baseUrl: 'http://localhost:8000/v1', model: 'fixture', proactive: false, memoryEnabled: true, protocol: 'responses' as const, reasoningEffort: 'high' as const, reasoningSummary: false, maxOutputTokens: 8192, timeoutSeconds: 300 };
    config.save(input); expect(new ModelConfig(dir, codec).public()).toMatchObject(input);
    expect(() => config.save({ ...input, timeoutSeconds: 0 })).toThrow(); expect(() => config.save({ ...input, maxOutputTokens: 393217 })).toThrow();
    expect(() => config.save({ ...input, provider: 'deepseek' })).toThrow('专用适配');
    config.save({ ...input, provider: 'deepseek', protocol: 'chat-completions', thinking: 'disabled' }); expect(new ModelConfig(dir, codec).public()).toMatchObject({ provider: 'deepseek', thinking: 'disabled' });
  });
  it('enables both automatic features by default, upgrades the old policy once and preserves later opt-outs', () => {
    const dir = root(), file = join(dir, 'chat-model.json'); const fresh = new ModelConfig(dir, codec);
    expect(fresh.public()).toMatchObject({ autoSummary: true, autoLongMemory: true });
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, baseUrl: 'http://localhost:8000/v1', model: 'fixture', encryptedKey: codec.encrypt('fixture-secret'), proactive: false, memoryEnabled: true, autoSummary: false, autoLongMemory: false }));
    const migrated = new ModelConfig(dir, codec); expect(migrated.public()).toMatchObject({ autoSummary: true, autoLongMemory: true, hasKey: true }); expect(JSON.parse(readFileSync(file, 'utf8')).schemaVersion).toBe(3);
    migrated.save({ baseUrl: 'http://localhost:8000/v1', model: 'fixture', proactive: false, memoryEnabled: true, autoSummary: false, autoLongMemory: false });
    const reopened = new ModelConfig(dir, codec); expect(reopened.public()).toMatchObject({ autoSummary: false, autoLongMemory: false }); expect(reopened.connection().apiKey).toBe('fixture-secret');
  });
  it('bounds context, excludes cancelled answers, ranks matching memories, falls back for invalid actions', () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({ id: String(i), role: i % 2 ? 'assistant' as const : 'user' as const, text: i === 98 ? '蓝色' : 'x'.repeat(1000), status: i === 99 ? 'cancelled' as const : 'complete' as const, createdAt: i, proactive: false }));
    const memories = Array.from({ length: 100 }, (_, i) => ({ id: String(i), text: i === 99 ? '我最喜欢蓝色' : '无关资料'.repeat(60), createdAt: i }));
    const context = buildContext(pack, messages, memories, false, { inputBudget: 300000 }); expect(JSON.stringify(context)).toContain('我最喜欢蓝色');
    expect(context.at(-1)?.content).toBe('蓝色'); expect(context.some(m => m.role === 'assistant' && m.content === messages[99].text)).toBe(false);
    expect(parseReply('{"text":"你好","expression":"unknown","action":"evil"}', pack)).toEqual({ text: '你好', expression: 'normal', action: undefined });
    expect(parseReply('{"text":"你好","action":"idle"}', pack).action).toBeUndefined(); expect(visibleDraft('{"text":"第一行\\n\\u4f60')).toBe('第一行\n你');
  }, 20000);
});

it('reserves recently corrected old entries and reports the exact budgeted snapshot', () => {
  const memories=Array.from({length:100},(_,i)=>({id:String(i),text:'无关资料'.repeat(50),createdAt:1000+i,revision:1,updatedAt:1000+i}));
  memories[0]={id:'0',text:'人工纠正：目前住北京，地址未知。',createdAt:1000,revision:2,updatedAt:5000};
  const prepared=prepareContext(pack,[{id:'query',role:'user',text:'你好',status:'complete',createdAt:9000,proactive:false}],memories,false,{inputBudget:300000});
  expect(prepared.stats.memoryTrace?.confirmed[0]).toMatchObject({id:'0',revision:2}); expect(prepared.stats.memoryTrace?.omittedConfirmed).toBe(100-prepared.stats.memoryTrace!.confirmed.length); expect(prepared.stats.estimatedTokens).toBeLessThanOrEqual(300000); expect(prepared.messages.at(-1)?.content).toBe('你好');
});
