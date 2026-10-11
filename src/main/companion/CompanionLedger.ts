import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
const schema = z.object({ lastGreetingAt: z.number().finite().min(0), automaticTimes: z.array(z.number().finite().min(0)).max(100) });
export class CompanionLedger {
  value = { lastGreetingAt: 0, automaticTimes: [] as number[] }; warning?: string;
  private file: string;
  constructor(root: string) {
    this.file = join(root, 'companion-ledger.json');
    if (existsSync(this.file)) {
      try { this.value = schema.parse(JSON.parse(readFileSync(this.file, 'utf8'))); }
      catch { this.warning = '主动问候记录无法读取，本次暂停自动搭话；手动互动仍可使用。'; }
    }
  }
  allows(now: number, greeting = false) {
    if (this.warning || greeting && now - this.value.lastGreetingAt < 30 * 60000) return false;
    const date = new Date(now); date.setHours(0, 0, 0, 0);
    return this.value.automaticTimes.filter(t => t >= now - 3600000).length < 1 && this.value.automaticTimes.filter(t => t >= date.getTime()).length < 6;
  }
  record(now: number, greeting: boolean) {
    this.value.automaticTimes = this.value.automaticTimes.filter(t => t >= now - 48 * 3600000).slice(-20);
    this.value.automaticTimes.push(now);
    if (greeting) this.value.lastGreetingAt = now;
    try { writeFileSync(`${this.file}.tmp`, JSON.stringify(this.value), 'utf8'); renameSync(`${this.file}.tmp`, this.file); return true; }
    catch { this.warning = '主动问候记录无法保存，本次暂停自动搭话；手动互动仍可使用。'; return false; }
  }
  get lastAutomatic() { return Math.max(0, ...this.value.automaticTimes); }
}
