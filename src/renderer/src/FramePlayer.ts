import type { CharacterView, FrameAction, TransformAction, MeshAction, RigAction } from '../../shared/contracts';
import { MeshPlayer } from './MeshPlayer';
import { RigPlayer } from './RigPlayer';
import { maskHit } from '../../shared/geometry';

const imageCache = new Map<string, Promise<HTMLImageElement>>();
export async function preloadCharacter(view: CharacterView) {
  await Promise.all([...new Set([...Object.values(view.frames), ...Object.values(view.rig?.assets ?? {})])].map(url => {
    if (!imageCache.has(url)) {
      if (imageCache.size >= 64) imageCache.delete(imageCache.keys().next().value!);
      imageCache.set(url, (async () => { const image = new Image(); image.crossOrigin = 'anonymous'; image.src = url; await image.decode(); return image; })().catch(error => { imageCache.delete(url); throw error; }));
    }
    return imageCache.get(url)!;
  }));
}
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('已取消', 'AbortError'));
    const abort = () => { clearTimeout(timer); reject(new DOMException('已取消', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export class FramePlayer {
  private controller?: AbortController; private animation?: Animation;
  private idleAnimation?: Animation;
  private overlaySignal?: AbortSignal;
  private meshPlayer?: MeshPlayer; private meshSignal?: AbortSignal;
  private rigPlayer?: RigPlayer; private rigSignal?: AbortSignal;
  private current: string; private incoming?: string;
  private masks: Record<string, Uint8Array> = {};
  constructor(private visible: HTMLImageElement, private hidden: HTMLImageElement,
    private overlay: HTMLImageElement, private canvas: HTMLCanvasElement, private rigCanvas: HTMLCanvasElement, private motion: HTMLElement, readonly character: CharacterView) {
    this.current = character.defaultExpression;
    for (const [name, mask] of Object.entries(character.hitMasks)) this.masks[name] = Uint8Array.from(atob(mask.bits), char => char.charCodeAt(0));
    visible.src = character.expressions[this.current]; visible.style.opacity = '1'; visible.dataset.active = 'true'; visible.dataset.frame = this.current;
    hidden.style.opacity = '0'; hidden.dataset.active = 'false';
  }
  cancel() {
    this.controller?.abort(); this.animation?.cancel(); this.animation = undefined; this.incoming = undefined;
    this.visible.style.transition = this.hidden.style.transition = 'none'; this.visible.style.opacity = '1'; this.hidden.style.opacity = '0';
    this.overlaySignal = undefined; this.overlay.style.opacity = '0'; this.overlay.dataset.active = 'false'; this.visible.dataset.active = 'true';
    this.meshSignal = undefined; this.canvas.style.opacity = '0';
    this.rigSignal = undefined; this.rigCanvas.style.opacity = '0';
    this.visible.style.clipPath = this.hidden.style.clipPath = 'none';
  }
  run(fn: (signal: AbortSignal) => Promise<void>) {
    this.cancel(); this.controller = new AbortController(); return fn(this.controller.signal);
  }
  setIdle(enabled: boolean) {
    if (!enabled) { this.idleAnimation?.cancel(); this.idleAnimation = undefined; return; }
    if (this.idleAnimation) return;
    const name = this.character.behavior.idleAction, action = name && this.character.actions[name];
    if (!action || action.kind !== 'transform') return;
    const height = this.visible.getBoundingClientRect().height;
    this.idleAnimation = this.motion.animate(action.keyframes.map(frame => ({ offset: frame.offset,
      transform: `translateY(${frame.translateY * height}px) rotate(${frame.rotate}deg)` })),
      { duration: action.durationMs, iterations: Infinity, easing: 'ease-in-out' });
  }
  async show(frame: string, ms: number, signal: AbortSignal) {
    if (signal.aborted || frame === this.current) return;
    const url = this.character.frames[frame] ?? this.character.expressions[this.character.fallbackExpression];
    this.hidden.src = url;
    try { await this.hidden.decode(); }
    catch (error) { if (signal.aborted) return; throw error; }
    if (signal.aborted) return;
    this.incoming = frame; this.visible.style.zIndex = '1'; this.visible.style.opacity = '1';
    this.hidden.style.zIndex = '2'; this.hidden.style.transition = 'none'; this.hidden.style.opacity = '0'; void this.hidden.offsetWidth;
    this.hidden.style.transition = `opacity ${ms}ms ease-in-out`; this.hidden.style.opacity = '1';
    this.visible.style.transition = `opacity ${ms}ms ease-in-out`; this.visible.style.opacity = '0';
    if (ms) await delay(ms, signal); if (signal.aborted) return;
    [this.visible, this.hidden] = [this.hidden, this.visible]; this.current = frame; this.incoming = undefined;
    this.visible.dataset.active = 'true'; this.visible.dataset.frame = frame; this.visible.style.zIndex = '1';
    this.hidden.dataset.active = 'false'; this.hidden.style.transition = 'none'; this.hidden.style.opacity = '0'; this.hidden.style.zIndex = '0';
  }
  async frames(action: FrameAction, signal: AbortSignal, restingExpression = this.character.defaultExpression) {
    if (action.overlayRegions) {
      const base = action.frames[0].frame;
      await this.show(base, this.character.expressionTransitionMs, signal);
      if (signal.aborted) return;
      this.overlaySignal = signal;
      this.overlay.style.maskImage = action.overlayRegions.map(region => `radial-gradient(ellipse ${region.radiusX * 100}% ${region.radiusY * 100}% at ${region.x * 100}% ${region.y * 100}%,#000 82%,transparent 100%)`).join(',');
      try {
        for (const frame of action.frames) {
          if (signal.aborted) return;
          if (frame.frame === base) {
            this.overlay.style.opacity = '0'; this.overlay.dataset.active = 'false'; this.visible.dataset.active = 'true';
          } else {
            this.overlay.src = this.character.frames[frame.frame]; await this.overlay.decode(); if (signal.aborted) return;
            this.overlay.dataset.frame = frame.frame; this.overlay.dataset.active = 'true'; this.visible.dataset.active = 'false'; this.overlay.style.opacity = '1';
          }
          await delay(frame.holdMs, signal);
        }
      } finally {
        if (this.overlaySignal === signal) { this.overlaySignal = undefined; this.overlay.style.opacity = '0'; this.overlay.dataset.active = 'false'; this.visible.dataset.active = 'true'; }
      }
      return;
    }
    for (const [index, frame] of action.frames.entries()) {
      const name = (index === 0 || index === action.frames.length - 1) && frame.frame === this.character.defaultExpression ? restingExpression : frame.frame;
      await this.show(name, action.transitionMs, signal); await delay(frame.holdMs, signal);
    }
  }
  async transform(action: TransformAction, signal: AbortSignal) {
    const height = this.visible.getBoundingClientRect().height;
    const animation = this.motion.animate(action.keyframes.map(frame => ({ offset: frame.offset,
      transform: `translateY(${frame.translateY * height}px) rotate(${frame.rotate}deg)` })),
      { duration: action.durationMs, iterations: 1, easing: 'ease-in-out' });
    this.animation = animation;
    const abort = () => animation.cancel(); signal.addEventListener('abort', abort, { once: true });
    try { await animation.finished; } finally { signal.removeEventListener('abort', abort); animation.cancel(); if (this.animation === animation) this.animation = undefined; }
  }
  async mesh(action: MeshAction, signal: AbortSignal, deadline?: number) {
    if (signal.aborted) return;
    this.meshPlayer ??= new MeshPlayer(this.canvas); this.meshSignal = signal;
    const playing = this.meshPlayer.play(this.visible, action, signal, deadline);
    this.canvas.style.opacity = '1'; this.visible.style.opacity = '0'; this.hidden.style.opacity = '0';
    try { await playing; }
    finally { if (this.meshSignal === signal) { this.meshSignal = undefined; this.visible.style.opacity = '1'; this.canvas.style.opacity = '0'; } }
  }
  async rig(action: RigAction, signal: AbortSignal, deadline?: number) {
    const rig = this.character.rig; if (!rig || signal.aborted) return;
    const entries = await Promise.all(Object.entries(rig.assets).map(async ([name, url]) => [name, await imageCache.get(url)!] as const));
    if (signal.aborted) return;
    this.rigPlayer ??= new RigPlayer(this.rigCanvas, (texture, x, y) => {
      const name = texture === 'current' ? this.current : `rig-${texture}`, mask = this.character.hitMasks[name], bytes = this.masks[name];
      return Boolean(mask && bytes && maskHit(bytes, mask.width, mask.height, x, y));
    }); this.rigSignal = signal;
    const playing = this.rigPlayer.play(this.visible, rig, Object.fromEntries(entries), action, signal, deadline);
    const rect = this.visible.getBoundingClientRect(), width = Math.min(rect.width, rect.height * this.character.canvas.width / this.character.canvas.height), height = width * this.character.canvas.height / this.character.canvas.width;
    const dx = (rect.width - width) / 2, dy = rect.height - height;
    const hole = rig.patch.polygon.map((p, i) => `${i ? 'L' : 'M'}${dx + p.x * width},${dy + p.y * height}`).join(' ') + ' Z';
    this.visible.style.clipPath = `path(evenodd, "M0,0 H${rect.width} V${rect.height} H0 Z ${hole}")`;
    this.rigCanvas.style.opacity = '1'; this.visible.style.opacity = '1'; this.hidden.style.opacity = '0';
    try { await playing; }
    finally { if (this.rigSignal === signal) { this.rigSignal = undefined; this.visible.style.clipPath = 'none'; this.visible.style.opacity = '1'; this.rigCanvas.style.opacity = '0'; } }
  }
  hit(clientX: number, clientY: number) {
    const rect = this.visible.getBoundingClientRect(), ratio = this.character.canvas.width / this.character.canvas.height;
    const width = Math.min(rect.width, rect.height * ratio), height = width / ratio;
    const x = (clientX - rect.left - (rect.width - width) / 2) / width, y = (clientY - rect.bottom + height) / height;
    if (this.rigSignal && this.rigPlayer) return this.rigPlayer.hit(x, y);
    return [this.current, this.incoming].some(name => {
      if (!name) return false;
      const mask = this.character.hitMasks[name], bytes = this.masks[name];
      return mask && bytes ? maskHit(bytes, mask.width, mask.height, x, y) : x >= 0 && x < 1 && y >= 0 && y < 1;
    });
  }
  dispose() { this.setIdle(false); this.cancel(); this.meshPlayer?.dispose(); this.rigPlayer?.dispose(); }
}
