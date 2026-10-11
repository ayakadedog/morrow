import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ChatState, ModelSettingsInput, ChatTarget, ContextStats, HistoryPage, ChatRequestDiagnostic } from '../../shared/contracts';
import type { LoadedPack } from '../characters/PackLoader';
import { ChatStore } from './ChatStore';
import { ModelConfig } from './ModelConfig';
import { generate, ModelCallError, type Generate } from './ModelClient';
import { prepareContext, parseReply, visibleDraft } from './ContextBuilder';
import { inputBudget, estimateMessages } from './ContextBudget';
import { roleRevision, promptRevision } from './ConversationSummary';
import { longMemoryPrompt, parseMemoryPlan } from './LongMemory';
import { supportsImages, IMAGE_CONTEXT_BYTES } from '../../shared/imageInput';
import { type StoredImage } from './MessageImages';
import { type ModelMessage } from './ModelClient';
import { chatSendInputSchema } from '../../shared/chatInput';
import { MemoryJobRunner } from './MemoryJobRunner';
import type { MemoryJob } from './MemoryRepository';
import { consolidationPrompt, saveConsolidation } from './MemoryConsolidator';
import { summaryEntriesPrompt, storeSummaryEntries } from './SummaryService';
export interface ChatContext { pack: LoadedPack; epoch: number }
type Active = { promptRevision: string; trace: ContextStats['memoryTrace']; coreRevision: string; summaryRevision?: number; id: string; characterId: string; epoch: number; sessionId: string; assistantId: string; controller: AbortController; proactive: boolean; raw: string; reasoning: string; timer: ReturnType<typeof setTimeout>; lastEmit: number; started: number; model: string; attempts?: number };
export class ChatService {
  private active?: Active; private error?: string;
  private summaryWarning?: string;
  private longMemoryWarning?: string;
  private jobs: MemoryJobRunner;
  private waiting?: ChatTarget;
  private stats = new Map<string, ContextStats>();
  private diagnostics = new Map<string, ChatRequestDiagnostic>();
  private selected = new Map<string, string>();
  private session(id: string) { return this.selected.get(id) ?? this.store.session(id); }
  constructor(readonly store: ChatStore, readonly config: ModelConfig, private context: () => ChatContext,
    private changed: () => void, private deliver: (reply: ReturnType<typeof parseReply>, proactive: boolean) => void,
    private automaticAllowed: () => boolean, private client: Generate = generate, private timeoutMs?: number, private invalidatePresentation: () => void = () => {}, private recordDiagnostic: (value: ChatRequestDiagnostic) => void = () => {}, private resolvePack?: (id: string) => LoadedPack | undefined) {
    this.jobs = new MemoryJobRunner(store.memory, (kind, manual) => {
      const settings = config.public(); return !this.active && config.ready && (manual || (kind === 'summary' ? settings.autoSummary : settings.memoryEnabled && settings.autoLongMemory !== false));
    }, (job, signal) => this.runMemoryJob(job, signal), changed, () => timeoutMs ?? config.public().timeoutSeconds * 1000, (job, warning) => { if (job.kind === 'summary') { this.summaryWarning = warning; if (this.waiting?.sessionId === job.sessionId) { this.waiting = undefined; this.error = '历史压缩暂未完成，本轮原文已保存，可重试。'; if (this.store.messages(job.sessionId, 1).at(-1)?.role === 'user') this.store.append(job.sessionId, 'assistant', '', false, 'failed'); } } else this.longMemoryWarning = warning; });
    this.scheduleLongMemory(true); this.jobs.wake();
  }
  state(): ChatState {
    const { pack, epoch } = this.context(), characterId = pack.view.id, sessionId = this.session(characterId), messages = this.store.messagePage(sessionId), sessions = this.store.sessionPage(characterId);
    if (!sessions.sessions.some(s => s.id === sessionId)) sessions.sessions.push(this.store.sessionEntry(sessionId));
    return { characterId, epoch, sessionId, historyRevision: this.store.historyRevision(sessionId), sessions: sessions.sessions, messages: messages.messages, hasOlderMessages: messages.hasMore, hasOlderSessions: sessions.hasMore, memories: this.store.memories(characterId, sessionId), settings: this.config.public(),
      contextStats: this.stats.get(sessionId), lastRequest: this.diagnostics.get(sessionId), summary: this.store.summary(sessionId, roleRevision(pack)), longMemoryRunning: this.jobs.current?.kind === 'extract' || this.jobs.current?.kind === 'consolidate', longMemoryCount: this.store.longMemory.count(characterId), longMemoryWarning: this.longMemoryWarning, summarizing: this.jobs.current?.kind === 'summary', summaryWarning: this.summaryWarning,
      busy: Boolean(this.active || this.waiting), draft: this.active ? visibleDraft(this.active.raw) : '', reasoningDraft: this.active?.reasoning,
      generationPhase: this.active ? this.active.raw ? 'answering' : this.active.reasoning ? 'thinking' : 'waiting' : this.waiting ? 'waiting' : undefined, error: this.error ?? this.config.warning };
  }
  private current(run: Active) { const ctx = this.context(); return this.active?.id === run.id && !run.controller.signal.aborted && ctx.epoch === run.epoch && ctx.pack.view.id === run.characterId && this.session(run.characterId) === run.sessionId; }
  private assertTarget(target: ChatTarget) { const ctx = this.context(); if (target.characterId !== ctx.pack.view.id || target.epoch !== ctx.epoch || target.sessionId !== this.session(ctx.pack.view.id)) throw new Error('角色或会话已切换，请在当前会话中操作'); if (target.historyRevision !== this.store.historyRevision(target.sessionId)) throw new Error('聊天记录已更新，请在当前记录中操作'); }
  cancelFor(target: ChatTarget) { this.assertTarget(target); this.jobs.pause(); return this.cancel(); }
  history(raw: ChatTarget & { kind: 'messages' | 'sessions'; beforeId: string }): HistoryPage {
    this.assertTarget(raw);
    return { target: { characterId: raw.characterId, epoch: raw.epoch, sessionId: raw.sessionId, historyRevision: raw.historyRevision }, messages: [], sessions: [], ...(raw.kind === 'messages' ? this.store.messagePage(raw.sessionId, raw.beforeId) : this.store.sessionPage(raw.characterId, raw.beforeId)) };
  }
  retract(raw: ChatTarget & { messageId: string }) {
    this.assertTarget(raw); const message = this.store.message(raw.sessionId, z.string().uuid().parse(raw.messageId));
    if (message.status === 'pending') throw new Error('请先停止正在生成的回答');
    this.cancel(); this.store.rewind(raw.characterId, raw.sessionId, message.id, raw.historyRevision); this.afterRewind(raw.sessionId); this.changed(); return this.state();
  }
  edit(raw: ChatTarget & { messageId: string; text: string }) {
    this.assertTarget(raw); const message = this.store.message(raw.sessionId, z.string().uuid().parse(raw.messageId)), text = z.string().max(6000).parse(raw.text);
    if (!text.trim() && !message.images?.length) throw new Error('请输入文字或保留图片');
    if (message.images?.length) this.requireImageTarget(raw);
    if (message.role !== 'user' || message.status !== 'complete') throw new Error('只能编辑完整用户消息');
    this.config.connection(); this.cancel(); this.store.rewind(raw.characterId, raw.sessionId, message.id, raw.historyRevision, text); this.afterRewind(raw.sessionId); this.begin(false); this.changed(); return this.state();
  }
  regenerate(raw: ChatTarget & { messageId: string }) {
    this.assertTarget(raw); const source = this.store.regenerationSource(raw.sessionId, z.string().uuid().parse(raw.messageId)); if (source.images?.length) this.requireImageTarget(raw);
    this.config.connection(); this.cancel(); this.store.rewind(raw.characterId, raw.sessionId, raw.messageId, raw.historyRevision); this.afterRewind(raw.sessionId); this.begin(false); this.changed(); return this.state();
  }
  private afterRewind(sessionId: string) { this.longMemoryWarning = undefined; this.stats.delete(sessionId); this.summaryWarning = undefined; this.error = undefined; this.invalidatePresentation(); }
  dataChanged() { this.longMemoryWarning = undefined; this.selected.clear(); this.stats.clear(); this.summaryWarning = undefined; this.error = undefined; this.invalidatePresentation(); this.changed(); this.scheduleLongMemory(true); this.jobs.wake(); }
  configure(raw: ModelSettingsInput) { this.jobs.pause(); this.config.save(raw); this.cancel(); this.error = undefined; this.changed(); this.scheduleLongMemory(true); this.jobs.wake(); return this.state(); }
  requireImageTarget(target: ChatTarget) { this.assertTarget(target); if (!supportsImages(this.config.public())) throw new Error('当前模型未启用图片输入，请在模型连接中选择支持看图的模型'); }
  private hydrate(messages: ModelMessage[]): ModelMessage[] {
    return messages.map(message => ({ ...message, ...(message.images?.length ? { images: message.images.map(image => {
      const url = new URL(image.url); if (url.protocol !== 'pet-image:' || url.hostname !== 'image') throw new Error('图片来源无效');
      const stored = this.store.image(url.pathname.slice(1)); if (!stored) throw new Error('图片附件已删除，请重新添加');
      return { url: `data:${stored.mime};base64,${stored.data.toString('base64')}`, byteLength: stored.byteLength };
    }) } : {}) }));
  }
  private archivePrompt(messages: ModelMessage[]): ModelMessage[] {
    const enabled = supportsImages(this.config.public());
    return messages.map(m => enabled ? m : { role: m.role, content: m.content + (m.images?.length ? '\n图片附件未提供给当前模型，不得猜测其内容。' : '') });
  }
  private fitsImages(messages: ModelMessage[]) { return messages.reduce((n, m) => n + (m.images ?? []).reduce((sum, image) => sum + image.byteLength, 0), 0) <= IMAGE_CONTEXT_BYTES; }
  send(input: ChatTarget & { text: string; imageIds?: string[] }, images: StoredImage[] = []) {
    const ctx = this.context(), { text } = chatSendInputSchema.parse({ characterId: input.characterId, epoch: input.epoch, sessionId: input.sessionId, historyRevision: input.historyRevision, text: input.text, ...(input.imageIds ? { imageIds: input.imageIds } : {}) });
    if (images.length !== (input.imageIds?.length ?? 0) || images.some((image, i) => image.id !== input.imageIds![i])) throw new Error('图片附件未准备完成');
    if (images.length) this.requireImageTarget(input);
    if (input.characterId !== ctx.pack.view.id || input.epoch !== ctx.epoch) throw new Error('角色已切换，请在当前角色中发送');
    this.assertTarget(input);
    if (this.active?.proactive) this.cancel();
    if (this.active) throw new Error('正在回复，可先停止这一条'); this.config.connection();
    if (this.waiting) throw new Error('正在整理历史以继续本轮，可先停止');
    this.jobs.pause(); const sessionId = this.session(ctx.pack.view.id);
    const latest = this.store.messages(sessionId, 2);
    const retry = this.error && !images.length && latest.at(-2)?.role === 'user' && latest.at(-2)?.text === text && latest.at(-1)?.role === 'assistant' && latest.at(-1)?.status === 'failed';
    if (retry) this.store.rewind(ctx.pack.view.id, sessionId, latest.at(-1)!.id, input.historyRevision); else this.store.append(sessionId, 'user', text, false, 'complete', images);
    this.begin(false); return this.state();
  }
  proactive() {
    if (this.active || this.waiting || this.jobs.current || !this.config.ready || !this.config.public().proactive || !this.automaticAllowed()) return false;
    // A new character without conversation history should not consume remote calls simply by sitting on the desktop.
    if (!this.store.messages(this.session(this.context().pack.view.id)).some(m => m.role === 'user' && m.status === 'complete')) return false;
    this.begin(true); return true;
  }
  private begin(proactive: boolean) {
    const ctx = this.context(), sessionId = this.session(ctx.pack.view.id), settings = this.config.public(), budget = inputBudget(settings);
    let summary = this.store.summary(sessionId, roleRevision(ctx.pack));
    if (summary && this.store.sourceSnapshot(sessionId, summary.throughMessageId).sourceHash !== summary.sourceHash) { summary = undefined; this.summaryWarning = '摘要来源已变化，暂不使用旧摘要。请丢弃后重新整理。'; }
    let history = this.store.contextTail(sessionId, undefined, budget);
    const archivedSummary = summary; summary = undefined;
    let prepared: ReturnType<typeof prepareContext>;
    try { prepared = prepareContext(ctx.pack, history, this.store.memories(ctx.pack.view.id, sessionId), proactive, { observations: this.store.memory.observations(ctx.pack.view.id, sessionId, roleRevision(ctx.pack)), imageInput: supportsImages(settings), memoryEnabled: settings.memoryEnabled, inputBudget: budget, summary, totalMessages: this.store.messageCount(sessionId), longMemories: settings.memoryEnabled ? this.store.longMemory.candidates(ctx.pack.view.id, sessionId, roleRevision(ctx.pack), history.filter(m => m.role === 'user').at(-1)?.text ?? '') : [] }); }
    catch (error) {
      if (archivedSummary && error instanceof Error && (error.message.includes('预算') || error.message.includes('总上下文'))) {
        try { summary = archivedSummary; history = this.store.contextTail(sessionId, summary!.throughMessageId, budget); prepared = prepareContext(ctx.pack, history, this.store.memories(ctx.pack.view.id, sessionId), proactive, { observations: this.store.memory.observations(ctx.pack.view.id, sessionId, roleRevision(ctx.pack)), imageInput: supportsImages(settings), memoryEnabled: settings.memoryEnabled, inputBudget: budget, summary, totalMessages: this.store.messageCount(sessionId), longMemories: settings.memoryEnabled ? this.store.longMemory.candidates(ctx.pack.view.id, sessionId, roleRevision(ctx.pack), '') : [] }); }
        catch (fallback) { this.contextFailure(fallback, sessionId, ctx, proactive); return; }
      } else { this.contextFailure(error, sessionId, ctx, proactive); return; } }
    this.stats.set(sessionId, prepared.stats);
    const controller = new AbortController(), run: Active = { promptRevision: promptRevision(ctx.pack), trace: prepared.stats.memoryTrace, coreRevision: roleRevision(ctx.pack), summaryRevision: summary?.revision, id: randomUUID(), characterId: ctx.pack.view.id, epoch: ctx.epoch, sessionId,
      assistantId: this.store.append(sessionId, 'assistant', '', proactive, 'pending'), controller, proactive, raw: '', reasoning: '', lastEmit: 0, started: Date.now(), model: settings.model,
      timer: setTimeout(() => { if (this.active?.id === run.id) { this.cancel(false, 'TIMEOUT'); this.error = '模型回复超时，请调整等待时间或重试'; this.changed(); } }, this.timeoutMs ?? this.config.public().timeoutSeconds * 1000) };
    this.active = run; this.error = undefined; this.changed();
    const messages = this.hydrate(prepared.messages);
    void this.client(this.config.connection(), messages, controller.signal, delta => {
      if (!this.current(run)) return; run.raw += delta;
      if (run.raw.length > 36000) { this.cancel(); this.error = '模型回复过长'; this.changed(); return; }
      if (Date.now() - run.lastEmit >= 80) { run.lastEmit = Date.now(); this.changed(); }
    }, delta => {
      if (!this.current(run)) return;
      run.reasoning += delta.slice(0, Math.max(0, 192000 - run.reasoning.length));
      if (Date.now() - run.lastEmit >= 80) { run.lastEmit = Date.now(); this.changed(); }
    }, value => { if (this.current(run)) run.attempts = value.attempts; }).then(raw => {
      if (!this.current(run)) return;
      if (proactive && !this.automaticAllowed()) { this.cancel(); return; }
      const reply = parseReply(raw, ctx.pack);
      if (proactive && history.filter(m => m.role === 'assistant' && m.status === 'complete').slice(-3).some(m => m.text === reply.text)) { this.cancel(); return; }
      this.store.finish(run.assistantId, reply.text, 'complete', reply.speaker, run.reasoning); clearTimeout(run.timer); this.active = undefined;
      this.recordOutcome(run, 'completed'); this.deliver(reply, proactive); this.changed();
      if (!proactive && this.config.public().autoSummary && (prepared.stats.estimatedTokens >= budget * .75 || prepared.stats.omittedMessages > 0)) {
        try { this.startSummary(); } catch { this.summaryWarning = '暂时无法启动摘要整理，聊天与原始记录已保留。'; this.changed(); }
      }
      if (!proactive) this.scheduleLongMemory();
    }).catch(error => {
      if (!this.current(run)) return;
      // All provider/network errors are replaced with a safe local message; no body, URL or key is broadcast.
      this.store.finish(run.assistantId, '', 'failed', undefined, run.reasoning); clearTimeout(run.timer); this.active = undefined;
      this.recordOutcome(run, 'failed', error instanceof ModelCallError ? error : new ModelCallError('回复结构无效'));
      this.error = error instanceof ModelCallError ? error.message : '模型回复结构无效，请重试'; this.changed();
    });
  }
  private contextFailure(error: unknown, sessionId: string, ctx: ChatContext, proactive: boolean) {
    const budgetError = error instanceof Error && /预算|总上下文/.test(error.message);
    const previous = this.store.summary(sessionId, roleRevision(ctx.pack));
    let compressible = true;
    if (budgetError) {
      const settings = this.config.public(), latest = this.store.messages(sessionId, 1);
      try { prepareContext(ctx.pack, latest, this.store.memories(ctx.pack.view.id, sessionId), proactive, { memoryEnabled: settings.memoryEnabled, imageInput: supportsImages(settings), inputBudget: inputBudget(settings), longMemories: settings.memoryEnabled ? this.store.longMemory.candidates(ctx.pack.view.id, sessionId, roleRevision(ctx.pack), '') : [], observations: this.store.memory.observations(ctx.pack.view.id, sessionId, roleRevision(ctx.pack)) }); }
      catch { compressible = false; }
    }
    if (!proactive && budgetError && compressible && this.config.public().autoSummary && this.store.summaryBatch(sessionId, previous?.throughMessageId).length) {
      this.waiting = { characterId: ctx.pack.view.id, epoch: ctx.epoch, sessionId, historyRevision: this.store.historyRevision(sessionId) };
      this.summaryWarning = '正在压缩旧历史，完成后继续本轮；原文已保存。'; this.startSummary(); this.changed(); return;
    }
    this.error = error instanceof Error ? error.message : '无法准备模型上下文';
    if (!proactive && this.store.messages(sessionId, 1).at(-1)?.role === 'user') this.store.append(sessionId, 'assistant', '', false, 'failed');
    this.changed();
  }
  private recordOutcome(run: Active, outcome: ChatRequestDiagnostic['outcome'], error?: ModelCallError) {
    const trace = run.trace;
    const value: ChatRequestDiagnostic = { at: Date.now(), sessionId: run.sessionId, assistantId: run.assistantId, model: run.model, outcome, attempts: error?.attempts ?? run.attempts, errorCode: error?.errorCode, httpStatus: error?.httpStatus, transportCode: error?.transportCode, elapsedMs: Date.now() - run.started, promptRevision: run.promptRevision, roleRevision: run.coreRevision, summaryRevision: run.summaryRevision, memoryVersions: [...(trace?.confirmed.map(m => ({ id: m.id, revision: m.revision, type: 'confirmed' as const })) ?? []), ...(trace?.automatic.map(m => ({ id: m.id, revision: m.revision, type: 'fact' as const })) ?? []), ...(trace?.observations?.map(m => ({ ...m, type: 'observation' as const })) ?? [])], confirmedMemoryIds: trace?.confirmed.map(m => m.id) ?? [], automaticMemoryIds: trace?.automatic.map(m => m.id) ?? [] };
    this.diagnostics.set(run.sessionId, value); try { this.recordDiagnostic(value); } catch { /* Optional metadata logging cannot affect replies. */ }
  }
  cancel(automaticOnly = false, reason = 'CANCELLED') {
    if (!automaticOnly) this.waiting = undefined;
    const run = this.active; if (!run || automaticOnly && !run.proactive) return this.state();
    this.active = undefined; clearTimeout(run.timer); run.controller.abort(); this.store.finish(run.assistantId, visibleDraft(run.raw), 'cancelled', undefined, run.reasoning); this.recordOutcome(run, 'cancelled', new ModelCallError('请求已取消', reason)); this.changed(); return this.state();
  }
  switched() { this.cancel(); this.error = undefined; this.summaryWarning = undefined; this.longMemoryWarning = undefined; this.changed(); this.scheduleLongMemory(); }
  newConversation(target: ChatTarget) { this.assertTarget(target); this.cancel(); const id = target.characterId; this.selected.set(id, this.store.newSession(id)); this.scheduleLongMemory(); this.error = undefined; this.summaryWarning = undefined; this.changed(); return this.state(); }
  selectConversation(raw: ChatTarget & { selectedSessionId: string }) {
    this.assertTarget(raw); if (!this.store.ownsSession(raw.characterId, raw.selectedSessionId)) throw new Error('此会话不属于当前角色');
    this.cancel(); this.store.selectSession(raw.characterId, raw.selectedSessionId); this.selected.set(raw.characterId, raw.selectedSessionId); this.scheduleLongMemory(); this.error = undefined; this.summaryWarning = undefined; this.changed(); return this.state();
  }
  clearHistory(target: ChatTarget) { this.assertTarget(target); this.cancel(); const id = target.characterId; this.selected.delete(id); this.store.clearHistory(id); this.stats.clear(); this.error = undefined; this.summaryWarning = undefined; this.changed(); return this.state(); }
  remember(raw: ChatTarget & { text: string; sourceMessageId?: string; scope?: import('../../shared/contracts').LongMemoryScope }) {
    this.assertTarget(raw);
    const text = raw.sourceMessageId ? z.string().min(1).refine(t => Boolean(t.trim())).parse(raw.text) : z.string().trim().min(1).parse(raw.text);
    this.cancel(); this.store.remember(raw.characterId, text, raw.sourceMessageId, raw.scope, raw.sessionId); this.changed(); return this.state();
  }
  forget(raw: ChatTarget & { id: string }) { this.assertTarget(raw); const id = z.string().uuid().parse(raw.id); this.cancel(); this.store.forget(raw.characterId, id); this.stats.clear(); this.changed(); return this.state(); }
  summarize(target: ChatTarget) { this.assertTarget(target); if (this.active) throw new Error('请等回复结束后再整理摘要'); this.startSummary(true); return this.state(); }
  discardSummary(target: ChatTarget) { this.assertTarget(target); this.cancel(); this.store.discardSummary(target.sessionId); this.store.memory.changed(target.characterId); this.stats.delete(target.sessionId); this.summaryWarning = undefined; this.changed(); return this.state(); }
  private startSummary(manual = false) {
    if (this.active) return;
    const { pack } = this.context(), sessionId = this.session(pack.view.id);
    this.store.memory.enqueue('summary', pack.view.id, sessionId, roleRevision(pack), 0, manual); void this.jobs.pump();
  }
  extractLongMemory(target: ChatTarget) {
    this.assertTarget(target); if (this.active) throw new Error('请先等当前回复结束');
    this.store.memory.enqueue('extract', target.characterId, target.sessionId, roleRevision(this.context().pack), 0, true); void this.jobs.pump(); return this.state();
  }
  private scheduleLongMemory(startup = false) {
    const settings = this.config.public(); if (!settings.autoLongMemory || !settings.memoryEnabled || !this.config.ready) return;
    const current = this.context().pack;
    const sessions = startup ? this.store.allSessions() : [{ id: this.session(current.view.id), characterId: current.view.id }];
    for (const session of sessions) {
      const pack = session.characterId === current.view.id ? current : this.resolvePack?.(session.characterId); if (!pack) continue;
      const revision = roleRevision(pack), cursor = this.store.longMemory.cursor(session.id, revision);
      const source = this.store.summaryBatch(session.id, cursor?.throughMessageId, 0);
      const users = source.filter(m => m.role === 'user' && m.status === 'complete');
      if (this.store.memory.observations(session.characterId, session.id, revision, true).some(o => o.status === 'needs_review')) this.store.memory.enqueue('consolidate', session.characterId, session.id, revision, 120000);
      if (!users.length) continue;
      const urgent = users.some(m => /搬到|搬家|你记错|更正|纠正|一直住/.test(m.text)); // scheduling hint only; never commits facts.
      this.store.memory.enqueue('extract', session.characterId, session.id, revision, urgent ? 1500 : users.length >= 6 ? 0 : 45000);
    }
    this.jobs.wake();
  }
  private async runMemoryJob(job: MemoryJob, signal: AbortSignal) {
    const current = this.context().pack;
    const pack = job.characterId === current.view.id ? current : this.resolvePack?.(job.characterId);
    if (!pack || roleRevision(pack) !== job.roleRevision) throw new Error('角色不可用或版本已改变');
    if (!this.store.memory.current(job)) { this.store.memory.complete(job, 'superseded', 'STALE_SOURCE'); this.scheduleLongMemory(true); return; }
    const budget = inputBudget(this.config.public()), connection = this.config.connection();
    if (job.kind === 'extract') {
      const cursor = this.store.longMemory.cursor(job.sessionId, job.roleRevision);
      const source = this.store.summaryBatch(job.sessionId, cursor?.throughMessageId, 0);
      if (source.length === 480) { const last = source.findLastIndex(m => m.role === 'user'); if (last >= 0) source.splice(last); }
      if (!source.some(m => m.role === 'user' && m.status === 'complete')) { this.store.memory.commit(job, () => {}); if (job.payload.manual) this.longMemoryWarning = '尚无可整理的完整新增原文'; return; }
      const snapshot = this.store.longMemory.snapshot(job.characterId, job.sessionId, job.roleRevision);
      this.fitArchive(source, () => longMemoryPrompt(source, snapshot), budget);
      this.store.longMemory.attempted(job.sessionId);
      const raw = await this.client({ ...connection, purpose: 'memory' }, this.hydrate(this.archivePrompt(longMemoryPrompt(source, snapshot))), signal, () => {});
      if (signal.aborted) throw new Error('整理已暂停');
      const plan = parseMemoryPlan(raw, source);
      this.store.memory.commit(job, () => {
        this.store.longMemory.save(job.sessionId, job.roleRevision, cursor?.id, job.historyRevision, source, plan.memories, plan.updates, snapshot);
        const updated = this.store.longMemory.snapshot(job.characterId, job.sessionId, job.roleRevision);
        if (updated.stamp !== snapshot.stamp) this.store.memory.enqueue('consolidate', job.characterId, job.sessionId, job.roleRevision, 120000);
        if (this.store.summaryBatch(job.sessionId, source.at(-1)!.id, 0).some(m => m.role === 'user' && m.status === 'complete')) this.store.memory.enqueue('extract', job.characterId, job.sessionId, job.roleRevision);
      });
      this.longMemoryWarning = undefined;
    } else if (job.kind === 'consolidate') {
      const snapshot = this.store.longMemory.snapshot(job.characterId, job.sessionId, job.roleRevision);
      const facts = this.store.longMemory.candidates(job.characterId, job.sessionId, job.roleRevision, '');
      const confirmed = this.store.memories(job.characterId, job.sessionId);
      const previous = this.store.memory.observations(job.characterId, job.sessionId, job.roleRevision, true);
      const prompt = consolidationPrompt(facts, confirmed, previous);
      if (estimateMessages(prompt) > budget) throw new Error('归纳资料超过输入预算');
      const raw = await this.client({ ...connection, purpose: 'memory' }, prompt, signal, () => {});
      if (signal.aborted) throw new Error('整理已暂停');
      this.store.memory.commit(job, () => {
        if (this.store.longMemory.snapshot(job.characterId, job.sessionId, job.roleRevision).stamp !== snapshot.stamp) throw new Error('归纳来源版本已更新');
        saveConsolidation(this.store.memory, job.characterId, job.sessionId, job.roleRevision, raw, facts, confirmed, previous);
      });
      this.longMemoryWarning = undefined;
    } else {
      const previous = this.store.summary(job.sessionId, job.roleRevision), baseRevision = this.store.summaryRevision(job.sessionId);
      if (previous && this.store.sourceSnapshot(job.sessionId, previous.throughMessageId).sourceHash !== previous.sourceHash) throw new Error('摘要来源已变化，须丢弃旧摘要重建');
      const source = this.store.summaryBatch(job.sessionId, previous?.throughMessageId);
      if (source.length === 480 || source.at(-1)?.role === 'user') { const last = source.findLastIndex(m => m.role === 'user'); if (last >= 0) source.splice(last); }
      if (!source.length) { if (this.waiting?.sessionId === job.sessionId) throw new Error('可压缩历史不足，不能缩减核心设定与长期记忆'); this.store.memory.commit(job, () => {}); if (job.payload.manual) this.summaryWarning = '可整理的完整历史不足，至少保留最近四轮原文。'; return; }
      let summaryPrevious = previous, rebase = false;
      // Re-read original evidence periodically, only when it fits a single archive request.
      if (previous && previous.revision % 5 === 0) {
        const through = source.at(-1)!.id, all = this.store.summaryBatch(job.sessionId, undefined, 4);
        if (all.some(m => m.id === through)) { const prefix = all.slice(0, all.findIndex(m => m.id === through) + 1);
          const manual = previous.entries?.filter(e => e.author === 'user') ?? [];
          const seed = { ...previous, entries: manual, data: { events: [], userStatements: [], fictionalState: [], uncertainties: [], commitments: [], openQuestions: [], keyQuotes: [] } };
          const prompt = this.archivePrompt(summaryEntriesPrompt(seed, prefix));
          if (estimateMessages(prompt) <= budget && this.fitsImages(prompt)) { source.splice(0, source.length, ...prefix); summaryPrevious = seed; rebase = true; }
        }
      }
      this.fitArchive(source, () => summaryEntriesPrompt(summaryPrevious, source), budget);
      const end = source.at(-1)!.id, snapshot = this.store.sourceSnapshot(job.sessionId, end);
      const raw = await this.client({ ...connection, purpose: 'summary' }, this.hydrate(this.archivePrompt(summaryEntriesPrompt(summaryPrevious, source))), signal, () => {});
      if (signal.aborted) throw new Error('整理已暂停');
      this.store.memory.commit(job, () => {
        if (rebase) this.store.memory.db.prepare("DELETE FROM summary_entries WHERE session_id=? AND author='model'").run(job.sessionId);
        const data = storeSummaryEntries(this.store.memory, job.sessionId, raw, source, summaryPrevious);
        this.store.saveSummary(job.sessionId, job.roleRevision, end, data, baseRevision, snapshot);
        if (this.store.summaryBatch(job.sessionId, end).length) this.store.memory.enqueue('summary', job.characterId, job.sessionId, job.roleRevision, 0, Boolean(job.payload.manual));
      });
      this.summaryWarning = undefined;
    }
    this.stats.delete(job.sessionId);
    if (this.waiting?.sessionId === job.sessionId && job.kind === 'summary') {
      const waiting = this.waiting; this.waiting = undefined;
      const ctx = this.context();
      if (ctx.epoch === waiting.epoch && ctx.pack.view.id === waiting.characterId && this.session(waiting.characterId) === waiting.sessionId && this.store.historyRevision(waiting.sessionId) === waiting.historyRevision) this.begin(false);
    }
  }
  private fitArchive(source: ReturnType<ChatStore['messages']>, prompt: () => ModelMessage[], budget: number) {
    while (source.length && (estimateMessages(this.archivePrompt(prompt())) > budget || !this.fitsImages(this.archivePrompt(prompt())))) {
      const last = source.findLastIndex(m => m.role === 'user'); if (last <= 0) source.length = 0; else source.splice(last);
    }
    if (!source.length) throw new Error('全量记忆与单轮原文超过整理预算，原文保留，不能静默截断资料');
  }
  dispose() { this.jobs.dispose(); this.cancel(); this.store.close(); }
}
