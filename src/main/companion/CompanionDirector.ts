import type { CompanionState, Preferences, InteractionEvent, InteractionLine } from '../../shared/contracts';
import type { LoadedPack } from '../characters/PackLoader';
import { CompanionLedger } from './CompanionLedger';

export interface CompanionEnvironment { fullscreen: boolean; locked: boolean; settings: boolean; idleSeconds: number }
export class CompanionDirector {
  state: CompanionState;
  private environment: CompanionEnvironment = { fullscreen: false, locked: false, settings: false, idleSeconds: 0 };
  private actionTimer?: ReturnType<typeof setTimeout>; private bubbleTimer?: ReturnType<typeof setTimeout>;
  private hoverTimer?: ReturnType<typeof setTimeout>; private hoverTextTimer?: ReturnType<typeof setTimeout>;
  private leaveTimer?: ReturnType<typeof setTimeout>; private startupTimer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>; private sequence = 0; private ready = false; private greeted = false;
  private hovered = false; private hoverVisit = false; private lastHover = -Infinity; private lastClick = -Infinity;
  private lastCommands = new Map<string, number>();
  private lastUser: number; private nextBlink: number; private away = false; private previousLines = new Map<string, string>();
  constructor(private pack: LoadedPack, private preferences: () => Preferences, readonly ledger: CompanionLedger,
    private changed: () => void, private now = Date.now, private random = Math.random, private remoteProactive?: () => boolean) {
    this.state = { epoch: 1, expression: pack.view.defaultExpression, dragging: false, visible: true, fullscreenObserver: 'starting' };
    this.lastUser = this.now(); this.nextBlink = this.nextAmbient(true);
  }
  private nextAmbient(first = false) {
    const ambient = this.pack.view.behavior.ambient;
    return ambient ? this.now() + (first ? ambient.firstDelayMs : ambient.minIntervalMs + this.random() * (ambient.maxIntervalMs - ambient.minIntervalMs)) : Infinity;
  }
  private isAmbient() { return this.state.presentation?.action === this.pack.view.behavior.ambient?.action; }
  start() { if (!this.interval) this.interval = setInterval(() => this.tick(), 1000); }
  private emit() { this.updateQuiet(); this.changed(); }
  private updateQuiet() {
    this.state.quietReason = this.environment.locked ? 'locked' : this.environment.settings ? 'settings' :
      this.preferences().quietUntil > this.now() ? 'manual' : this.environment.fullscreen ? 'fullscreen' : undefined;
  }
  private automaticAllowed() {
    this.updateQuiet();
    return this.ready && this.state.visible && !this.state.dragging && !this.state.quietReason &&
      !this.state.bubble && !this.state.presentation && !this.hovered && this.environment.idleSeconds < 900;
  }
  canDeliverAutomatic() { return this.preferences().proactive && this.automaticAllowed(); }
  userActivity() { this.lastUser = this.now(); }
  speak(reply: { text: string; speaker?: string; expression: string; action?: string }, proactive = false) {
    if (!this.ready || !this.state.visible || this.environment.locked || this.state.dragging || proactive && !this.canDeliverAutomatic()) return;
    this.clearHover(); this.clearBubble(); this.clearMotion();
    const id = ++this.sequence, epoch = this.state.epoch, duration = this.preferences().bubbleDurationMs;
    this.state.expression = Object.hasOwn(this.pack.view.expressions, reply.expression) ? reply.expression : this.pack.view.defaultExpression;
    this.state.bubble = { id, source: proactive ? 'proactive' : 'chat', speaker: reply.speaker && this.pack.view.speakers[reply.speaker]?.displayName || this.pack.view.shortName,
      text: reply.text.length > 150 ? reply.text.slice(0, 149) + '…' : reply.text, choices: false, expiresAt: this.now() + duration };
    if (reply.action && Object.hasOwn(this.pack.view.actions, reply.action)) this.motion(reply.action, this.state.expression, duration - this.pack.view.expressionTransitionMs - 120);
    this.bubbleTimer = setTimeout(() => { if (this.state.epoch === epoch && this.state.bubble?.id === id) this.stop(); }, duration);
    if (!proactive) this.userActivity(); this.emit();
  }
  private clearMotion() { clearTimeout(this.actionTimer); this.state.presentation = undefined; }
  private clearHover() { clearTimeout(this.hoverTimer); clearTimeout(this.hoverTextTimer); clearTimeout(this.leaveTimer); }
  private clearBubble() { clearTimeout(this.bubbleTimer); this.state.bubble = undefined; }
  stop() { this.clearMotion(); this.clearHover(); this.clearBubble(); this.state.expression = this.pack.view.defaultExpression; this.emit(); }
  dismiss() { this.clearBubble(); this.clearMotion(); this.state.expression = this.pack.view.defaultExpression; this.lastUser = this.now(); this.emit(); }
  setObserver(status: CompanionState['fullscreenObserver']) { this.state.fullscreenObserver = status; this.emit(); }
  setEnvironment(patch: Partial<CompanionEnvironment>) {
    const previous = this.state.quietReason;
    this.environment = { ...this.environment, ...patch }; if (this.environment.idleSeconds >= 900) this.away = true;
    this.updateQuiet();
    if (this.state.quietReason && this.state.quietReason !== previous) {
      this.clearHover();
      if (this.environment.locked || this.environment.settings || this.state.bubble && ['startup', 'proactive', 'welcome', 'hover'].includes(this.state.bubble.source)) this.stop();
    }
    if (previous !== this.state.quietReason) this.emit();
  }
  preferencesChanged() {
    this.updateQuiet();
    if (this.preferences().animations === 'off') this.clearMotion();
    if (this.state.quietReason || !this.preferences().proactive) {
      if (this.state.bubble && ['startup', 'welcome', 'proactive', 'hover'].includes(this.state.bubble.source)) this.stop();
    }
    this.emit();
  }
  stageReady(epoch: number) {
    if (epoch !== this.state.epoch || this.ready) return;
    this.ready = true; this.nextBlink = this.nextAmbient(true);
    if (!this.greeted) {
      this.greeted = true;
      this.startupTimer = setTimeout(() => {
        if (this.pack.view.behavior.events.startup && this.preferences().greetings && this.automaticAllowed() && this.ledger.allows(this.now(), true)) {
          if (this.ledger.record(this.now(), true)) this.respond('startup', false);
        }
      }, this.pack.view.behavior.timing.startupDelayMs);
    }
  }
  setPack(pack: LoadedPack, epoch: number) {
    this.clearMotion(); this.clearBubble(); this.clearHover(); clearTimeout(this.startupTimer);
    this.pack = pack; this.ready = false; this.hovered = false; this.hoverVisit = false;
    this.lastCommands.clear(); this.previousLines.clear(); this.lastHover = this.lastClick = -Infinity; this.away = false; this.nextBlink = this.nextAmbient(true);
    this.state = { ...this.state, epoch, presentation: undefined, bubble: undefined, expression: pack.view.defaultExpression, dragging: false };
    this.lastUser = this.now(); this.emit();
  }
  visibility(visible: boolean) {
    this.state.visible = visible;
    if (!visible) { this.hovered = false; this.hoverVisit = false; this.stop(); }
    else { this.lastUser = this.now(); this.nextBlink = this.nextAmbient(true); this.emit(); }
  }
  private line(event: InteractionEvent): InteractionLine {
    const lines = this.pack.lines[event], key = `${this.pack.view.id}:${event}`, previous = this.previousLines.get(key);
    const options = lines.length > 1 ? lines.filter(line => line.id !== previous) : lines;
    const chosen = options[Math.min(options.length - 1, Math.floor(this.random() * options.length))];
    this.previousLines.set(key, chosen.id); return chosen;
  }
  private motion(action: string, expression: string, budget?: number) {
    this.clearMotion();
    const config = this.pack.view.actions[action], level = this.preferences().animations;
    if (!config || level === 'off' || level === 'subtle' && !this.pack.view.catalog.actions[action].allowInSubtle) return;
    const id = ++this.sequence;
    const durationMs = budget !== undefined && (config.kind === 'rig' || config.kind === 'mesh') ? Math.min(config.durationMs, Math.max(500, budget)) : config.durationMs;
    this.state.presentation = { id, epoch: this.state.epoch, action, expression, durationMs };
    this.actionTimer = setTimeout(() => this.animationFinished(this.state.epoch, id), durationMs + this.pack.view.expressionTransitionMs + 300);
  }
  animationFinished(epoch: number, id: number) {
    if (epoch !== this.state.epoch || this.state.presentation?.id !== id) return;
    this.clearMotion(); this.nextBlink = this.nextAmbient(); this.emit();
  }
  private respond(event: InteractionEvent, choices: boolean, response = this.pack.view.behavior.events[event as keyof typeof this.pack.view.behavior.events]) {
    if (!response) return;
    this.clearHover(); this.clearBubble(); this.clearMotion();
    const line = this.line(response), id = ++this.sequence;
    const duration = this.preferences().bubbleDurationMs;
    this.state.expression = line.expression;
    this.state.bubble = { id, source: event, speaker: this.pack.view.speakers[line.speaker].displayName,
      text: line.text, choices, expiresAt: this.now() + duration };
    if (line.action) this.motion(line.action, line.expression, duration - this.pack.view.expressionTransitionMs - 120);
    const epoch = this.state.epoch;
    this.bubbleTimer = setTimeout(() => {
      if (this.state.epoch !== epoch || this.state.bubble?.id !== id) return;
      this.clearBubble(); this.clearMotion(); this.state.expression = this.pack.view.defaultExpression; this.emit();
    }, duration);
    this.emit();
  }
  private welcome() {
    if (!this.away) return false;
    this.away = false; this.updateQuiet();
    if (!this.pack.view.behavior.events.welcome || !this.preferences().greetings || this.state.quietReason || !this.ledger.allows(this.now(), true)) return false;
    if (!this.ledger.record(this.now(), true)) return false;
    this.respond('welcome', true); return true;
  }
  interact(event: string) {
    const command = Object.hasOwn(this.pack.view.behavior.commands, event) ? this.pack.view.behavior.commands[event] : undefined;
    if (event !== 'click' && !command) throw new Error('当前角色没有这个互动指令');
    if (!this.ready || !this.state.visible || this.state.dragging || this.environment.locked) return;
    if (event === 'click' && this.now() - this.lastClick < this.pack.view.behavior.timing.clickCooldownMs || command && this.now() - (this.lastCommands.get(event) ?? -Infinity) < command.cooldownMs) return;
    if (event === 'click') this.lastClick = this.now(); else this.lastCommands.set(event, this.now());
    this.lastUser = this.now();
    if (event === 'click' && this.welcome()) return;
    this.respond(event, true, command?.response ?? this.pack.view.behavior.events.click);
  }
  setExpression(expression: string) {
    if (!Object.hasOwn(this.pack.view.expressions, expression)) throw new Error('没有这个表情');
    this.stop(); this.state.expression = expression; this.lastUser = this.now(); this.emit();
  }
  playAction(action: string) {
    if (!Object.hasOwn(this.pack.view.actions, action)) throw new Error('没有这个动作');
    this.stop(); this.lastUser = this.now();
    this.motion(action, this.pack.view.defaultExpression);
    this.emit();
  }
  hover(inside: boolean) {
    if (inside === this.hovered) return;
    this.hovered = inside;
    if (!inside) {
      this.clearHover(); this.hoverVisit = false;
      this.leaveTimer = setTimeout(() => {
        if (!this.hovered && (this.state.bubble?.source === 'hover' || !this.state.bubble && (!this.state.presentation || this.isAmbient()))) this.stop();
      }, this.pack.view.behavior.timing.leaveDelayMs); return;
    }
    clearTimeout(this.leaveTimer); this.lastUser = this.now();
    if (!this.pack.view.behavior.events.hover && !this.pack.view.behavior.states.hovering) return;
    if (this.hoverVisit || this.state.dragging || !this.ready || this.state.bubble || this.state.presentation && !this.isAmbient() || this.now() - this.lastHover < this.pack.view.behavior.timing.hoverCooldownMs) return;
    this.hoverVisit = true; const epoch = this.state.epoch;
    this.hoverTimer = setTimeout(() => {
      if (!this.hovered || this.state.dragging || this.state.bubble || this.state.presentation && !this.isAmbient() || epoch !== this.state.epoch) return;
      if (this.welcome()) return;
      this.lastHover = this.now();
      this.state.expression = this.pack.view.behavior.states.hovering ?? this.pack.view.defaultExpression; this.emit();
      this.hoverTextTimer = setTimeout(() => {
        this.updateQuiet();
        if (this.hovered && !this.state.bubble && !this.state.dragging && !this.state.quietReason && epoch === this.state.epoch) this.respond('hover', false);
      }, this.pack.view.behavior.timing.hoverTextDelayMs);
    }, this.pack.view.behavior.timing.hoverDelayMs);
  }
  bubbleHover(inside: boolean) {
    if (inside) clearTimeout(this.leaveTimer);
    else if (!this.hovered && this.state.bubble?.source === 'hover') this.leaveTimer = setTimeout(() => this.stop(), this.pack.view.behavior.timing.leaveDelayMs);
  }
  dragStart() {
    this.stop(); this.state.dragging = true; this.lastUser = this.now();
    this.state.expression = this.pack.view.behavior.states.dragging ?? this.pack.view.defaultExpression; this.emit();
  }
  dragEnd() {
    if (!this.state.dragging) return;
    this.state.dragging = false; this.lastUser = this.now();
    if (this.state.visible && !this.environment.locked && this.pack.view.behavior.events['drag-end']) this.respond('drag-end', false); else this.stop();
  }
  dragCancel() { this.state.dragging = false; this.stop(); }
  tick() {
    const reason = this.state.quietReason; this.updateQuiet(); if (reason !== this.state.quietReason) this.emit();
    if (!this.automaticAllowed()) return;
    const now = this.now();
    if (this.pack.view.behavior.events.proactive && this.preferences().proactive && now - this.ledger.lastAutomatic >= this.preferences().proactiveMinutes * 60000 &&
      now - this.lastUser >= 120000 && this.environment.idleSeconds >= 3 && this.environment.idleSeconds <= 120 && this.ledger.allows(now)) {
      if (this.ledger.record(now, false) && !this.remoteProactive?.()) this.respond('proactive', false); return;
    }
    const ambient = this.pack.view.behavior.ambient;
    if (ambient && now >= this.nextBlink && this.state.expression === this.pack.view.defaultExpression && this.preferences().animations !== 'off') {
      this.nextBlink = this.nextAmbient(); this.motion(ambient.action, this.pack.view.defaultExpression); this.emit();
    }
  }
  dispose() { clearInterval(this.interval); clearTimeout(this.startupTimer); this.clearMotion(); this.clearBubble(); this.clearHover(); }
}
