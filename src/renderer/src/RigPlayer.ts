import type { CharacterRig, Point, RigAction } from '../../shared/contracts';
import { boneMatrices, multiply, rigPose, rigHit, type Matrix } from '../../shared/rig';

// All compositing happens in the renderer; original PNG files stay untouched.
export class RigPlayer {
  private context: CanvasRenderingContext2D;
  private frame = document.createElement('canvas'); private clean = document.createElement('canvas');
  private rig?: CharacterRig; private matrices = new Map<string, Matrix>(); private blend = 0;
  private imageWidth = 0; private imageHeight = 0;
  private disposed = false;
  constructor(private canvas: HTMLCanvasElement, private sourceHit: (texture: string, x: number, y: number) => boolean) {
    this.context = canvas.getContext('2d')!;
  }
  hit(x: number, y: number) { return Boolean(this.rig && rigHit(this.rig,this.matrices,this.blend,{x,y},this.imageWidth,this.imageHeight,this.sourceHit)); }
  async play(image: HTMLImageElement, rig: CharacterRig, textures: Record<string, HTMLImageElement>, action: RigAction, signal: AbortSignal, deadline?: number) {
    if (signal.aborted || this.disposed) return;
    const rect = this.canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio, 2);
    this.canvas.width = this.frame.width = this.clean.width = Math.round(rect.width * dpr);
    this.canvas.height = this.frame.height = this.clean.height = Math.round(rect.height * dpr);
    const iw = image.naturalWidth, ih = image.naturalHeight, fit = Math.min(this.canvas.width / iw, this.canvas.height / ih);
    this.rig = rig; this.imageWidth = iw; this.imageHeight = ih;
    const dx = (this.canvas.width - iw * fit) / 2, dy = this.canvas.height - ih * fit;
    const layout = { a: fit, b: 0, c: 0, d: fit, e: dx, f: dy };
    const apply = (ctx: CanvasRenderingContext2D, m: typeof layout) => ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    const path = (ctx: CanvasRenderingContext2D, points: Point[]) => {
      ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x * iw, p.y * ih) : ctx.moveTo(p.x * iw, p.y * ih)); ctx.closePath();
    };
    const clean = this.clean.getContext('2d')!;
    apply(clean, layout);
    clean.save(); path(clean, rig.patch.polygon); clean.clip();
    clean.drawImage(textures[rig.patch.texture], 0, 0); clean.restore();
    const ctx = this.context, frame = this.frame.getContext('2d')!;
    const render = (progress: number) => {
      const pose = rigPose(action, progress), matrices = boneMatrices(rig, pose.rotations, iw, ih);
      this.matrices = matrices; this.blend = pose.blend;
      frame.resetTransform(); frame.clearRect(0, 0, this.frame.width, this.frame.height); frame.drawImage(this.clean, 0, 0);
      for (const bone of rig.bones) {
        frame.save(); apply(frame, multiply(layout, matrices.get(bone.id)!));
        frame.translate(bone.pivot.x * iw, bone.pivot.y * ih); frame.scale(bone.scale, bone.scale); frame.translate(-bone.sourcePivot.x * iw, -bone.sourcePivot.y * ih);
        if (bone.polygon) { path(frame, bone.polygon); frame.clip(); }
        const texture = bone.texture === 'current' ? image : textures[bone.texture], box = bone.sourceRect;
        if (box) frame.drawImage(texture, box.x * iw, box.y * ih, box.width * iw, box.height * ih, box.x * iw, box.y * ih, box.width * iw, box.height * ih);
        else frame.drawImage(texture, 0, 0);
        frame.restore();
      }
      ctx.resetTransform(); ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      // Complementary additive blending keeps unchanged body/feet and alpha stable.
      ctx.save(); apply(ctx, layout); path(ctx, rig.patch.polygon); ctx.clip(); ctx.globalAlpha = 1 - pose.blend; ctx.drawImage(image, 0, 0); ctx.restore();
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = pose.blend; ctx.drawImage(this.frame, 0, 0);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      // The original DOM image owns all fixed body pixels; this canvas owns only the local patch/arm.
      ctx.clearRect(0, dy + ih * fit * rig.fixedBelow, this.canvas.width, this.canvas.height);
      this.canvas.dataset.progress = progress.toFixed(4); this.canvas.dataset.blend = pose.blend.toFixed(4); this.canvas.dataset.action = 'rig';
    };
    render(0);
    await new Promise<void>((resolve, reject) => {
      const start = performance.now(), duration = deadline === undefined ? action.durationMs : Math.min(action.durationMs, Math.max(100, deadline - Date.now() - 120)); let raf = 0;
      const aborted = () => { cancelAnimationFrame(raf); signal.removeEventListener('abort', aborted); reject(new DOMException('已取消', 'AbortError')); };
      const tick = (time: number) => {
        if (signal.aborted || this.disposed) return aborted();
        const progress = Math.min(1, Math.max(0, (time - start) / duration));
        try { render(progress); } catch (error) { signal.removeEventListener('abort', aborted); reject(error); return; }
        if (progress === 1) { signal.removeEventListener('abort', aborted); resolve(); } else raf = requestAnimationFrame(tick);
      };
      signal.addEventListener('abort', aborted, { once: true }); raf = requestAnimationFrame(tick);
    });
  }
  dispose() { this.disposed = true; this.rig = undefined; this.clean.width = this.frame.width = 0; }
}
