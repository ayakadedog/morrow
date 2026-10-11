import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Preferences } from '../../shared/contracts';
export const pointSchema = z.object({ x: z.number().int().min(-100000).max(100000), y: z.number().int().min(-100000).max(100000) }).strict();
export const patchSchema = z.object({
  height: z.number().int().min(240).max(680).optional(), alwaysOnTop: z.boolean().optional(),
  interaction: z.enum(['auto', 'interactive', 'passthrough']).optional(),
  proactive: z.boolean().optional(), greetings: z.boolean().optional(), animations: z.enum(['full', 'subtle', 'off']).optional(),
  proactiveMinutes: z.number().int().min(45).max(120).optional(), quietUntil: z.number().int().min(0).max(4102444800000).optional(),
  bubbleDurationMs: z.number().int().min(1500).max(6000).optional()
}).strict();
const preferencesSchema = patchSchema.extend({ position: pointSchema.optional(), selectedCharacterId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional() });
export class PreferenceStore {
  readonly file: string; value: Preferences; warning?: string;
  constructor(dataRoot: string) {
    this.file = join(dataRoot, 'preferences.json');
    let parsed: Partial<Preferences> = {};
    if (existsSync(this.file)) {
      try { parsed = preferencesSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))); }
      catch {
        copyFileSync(this.file, `${this.file}.invalid-${Date.now()}.bak`);
        this.warning = '上次的设置无法读取，已保留备份并恢复默认设置。';
      }
    }
    this.value = { height: 460, alwaysOnTop: true, interaction: 'auto', proactive: true, greetings: true,
      animations: 'full', proactiveMinutes: 60, quietUntil: 0, bubbleDurationMs: 3000, ...parsed };
  }
  save() {
    writeFileSync(`${this.file}.tmp`, `${JSON.stringify(this.value, null, 2)}\n`, 'utf8');
    renameSync(`${this.file}.tmp`, this.file);
  }
}
