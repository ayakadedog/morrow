import { ModelCallError } from './ModelClient';
import type { MemoryJob, MemoryRepository } from './MemoryRepository';

export class MemoryJobRunner {
  private timer?: ReturnType<typeof setTimeout>;
  private active?: { job: MemoryJob; controller: AbortController; timeout: ReturnType<typeof setTimeout>; paused: boolean };
  private stopped = false;
  constructor(private repository: MemoryRepository, private allowed: (kind: MemoryJob['kind'], manual: boolean) => boolean, private run: (job: MemoryJob, signal: AbortSignal) => Promise<void>, private changed: () => void, private timeout: () => number, private warning: (job: MemoryJob, text: string) => void) { repository.recover(); }
  get current() { return this.active?.job; }
  wake(delay?: number) {
    if (this.stopped) return; if (this.timer) clearTimeout(this.timer);
    const next = delay ?? this.repository.nextDelay(this.allowed); if (next === undefined) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.pump(); }, Math.max(next, 20));
  }
  async pump() {
    if (this.stopped || this.active) return;
    const job = this.repository.claim(this.allowed); if (!job) { this.wake(); return; }
    if (!this.allowed(job.kind, Boolean(job.payload.manual))) { this.repository.release(job); this.wake(1000); return; }
    const controller = new AbortController(), active = { job, controller, paused: false, timeout: setTimeout(() => controller.abort(), this.timeout()) };
    this.active = active; this.changed();
    try { await this.run(job, controller.signal); }
    catch (error) {
      if (this.stopped || active.paused) return;
      const stale = !this.repository.current(job);
      if (stale) this.repository.complete(job, 'superseded', 'STALE_SOURCE');
      else if (controller.signal.aborted) this.repository.retry(job, 'TIMEOUT');
      else if (error instanceof ModelCallError) this.repository.retry(job, error.errorCode, error.httpStatus === 401 || error.httpStatus === 403 || error.httpStatus === 404);
      else this.repository.retry(job, 'INVALID_RESULT', true);
      this.warning(job, stale ? '整理来源已更新，旧结果未写入。' : error instanceof Error && error.message.includes('摘要来源已变化') ? '摘要来源已变化，请丢弃后重建。' : '整理失败或超时，整批未写入；原文与已有资料保留，可在后台查看状态或重试。');
    } finally {
      clearTimeout(active.timeout); if (this.active === active) this.active = undefined;
      if (!this.stopped) { this.changed(); this.wake(); }
    }
  }
  pause() {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    const run = this.active; if (run) { run.paused = true; this.repository.release(run.job); run.controller.abort(); }
  }
  dispose() { this.stopped = true; this.pause(); }
}
