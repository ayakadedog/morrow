import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ModelSettingsInput, ModelSettings } from '../../shared/contracts';

export const endpointSchema = z.string().max(400).transform(value => value.trim().replace(/\/+$/, '')).refine(value => {
  try { const u = new URL(value); return !u.username && !u.password && !u.search && !u.hash && (u.protocol === 'https:' || u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)); }
  catch { return false; }
}, '模型地址需要 HTTPS；本地服务允许 localhost HTTP');
export const modelInputSchema = z.object({ baseUrl: endpointSchema, model: z.string().trim().min(1).max(120),
  apiKey: z.string().trim().max(512).regex(/^[^\r\n]*$/).optional(), clearKey: z.boolean().optional(), proactive: z.boolean(), memoryEnabled: z.boolean(), streaming: z.boolean().default(true),
  imageInput: z.enum(['auto', 'enabled', 'disabled']).default('auto'), provider: z.enum(['openai-compatible', 'deepseek']).default('openai-compatible'), thinking: z.enum(['default', 'enabled', 'disabled']).default('default'),
  protocol: z.enum(['chat-completions', 'responses']).default('chat-completions'), reasoningEffort: z.enum(['default', 'none', 'low', 'medium', 'high', 'max']).default('default'),
  reasoningSummary: z.boolean().default(true), maxOutputTokens: z.number().int().min(256).max(393216).default(12288), timeoutSeconds: z.number().int().min(15).max(600).default(120),
  contextWindowTokens: z.number().int().min(8192).max(1048576).default(98304), autoSummary: z.boolean().default(true), autoLongMemory: z.boolean().default(true) }).strict();
const optionsSchema = modelInputSchema.pick({ imageInput: true, provider: true, thinking: true, streaming: true, protocol: true, reasoningEffort: true, reasoningSummary: true, maxOutputTokens: true, timeoutSeconds: true }).strip();
const contextSchema = modelInputSchema.pick({ contextWindowTokens: true, autoSummary: true, autoLongMemory: true }).strip();
const storedSchema = z.object({ schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]), baseUrl: endpointSchema, model: z.string().min(1).max(120),
  encryptedKey: z.string().max(4096), proactive: z.boolean(), memoryEnabled: z.boolean(), ...optionsSchema.shape, ...contextSchema.shape }).strict();
export interface SecretCodec { encrypt(value: string): string; decrypt(value: string): string }
export class ModelConfig {
  private file: string; private key = '';
  private value = { schemaVersion: 3 as 1 | 2 | 3, baseUrl: 'https://api.example.com/v1', model: '', encryptedKey: '', proactive: false, memoryEnabled: true, ...optionsSchema.parse({}), ...contextSchema.parse({}) };
  warning?: string;
  constructor(root: string, private codec: SecretCodec) {
    this.file = join(root, 'chat-model.json');
    if (existsSync(this.file)) try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      const stored = storedSchema.parse(raw.schemaVersion < 3 ? { maxOutputTokens: 4096, contextWindowTokens: 32768, ...raw } : raw);
      this.key = stored.encryptedKey ? codec.decrypt(stored.encryptedKey) : '';
      // Apply the requested new policy once. Subsequent explicit opt-outs survive restart.
      this.value = stored.schemaVersion < 3 ? { ...stored, schemaVersion: 3,
        ...(stored.schemaVersion === 1 ? { autoSummary: true, autoLongMemory: true } : {}),
        contextWindowTokens: officialDeepSeekWindow(stored) ?? Math.min(1048576, stored.contextWindowTokens * 3),
        maxOutputTokens: Math.min(393216, stored.maxOutputTokens * 3) } : stored;
      if (stored.schemaVersion < 3) this.persist(this.value);
    }
    catch { this.warning = '模型配置读取失败，请重新保存连接设置。'; }
  }
  public(): ModelSettings { const { encryptedKey: _encrypted, schemaVersion: _version, ...value } = this.value; return { ...value, hasKey: Boolean(this.key) }; }
  connection() { if (!this.value.model) throw new Error('请先设置模型地址和模型名称'); return { baseUrl: this.value.baseUrl, model: this.value.model, apiKey: this.key, ...optionsSchema.parse(this.value) }; }
  get ready() { return Boolean(this.value.model) && !this.warning; }
  save(raw: ModelSettingsInput) {
    const { hasKey: _hasKey, ...previous } = this.public();
    const input = modelInputSchema.parse({ ...previous, ...raw }), key = input.clearKey ? '' : input.apiKey || (input.baseUrl === this.value.baseUrl ? this.key : '');
    if (input.contextWindowTokens - input.maxOutputTokens < 4096) throw new Error('上下文窗口需要为输入和输出留出空间，请调大窗口或调小输出预算');
    if (input.provider === 'deepseek' && input.protocol !== 'chat-completions') throw new Error('DeepSeek 专用适配目前使用 Chat Completions 协议');
    if (input.provider !== 'deepseek' && input.thinking !== 'default') throw new Error('此思考模式开关用于 DeepSeek，通用服务请使用思考强度设置');
    const limit = officialDeepSeekWindow(input);
    if (limit && input.contextWindowTokens > limit) throw new Error('当前 DeepSeek 官方模型上下文上限为 1M，请勿填写更大的窗口');
    const next = { schemaVersion: 3 as const, baseUrl: input.baseUrl, model: input.model, proactive: input.proactive, memoryEnabled: input.memoryEnabled, ...optionsSchema.parse(input), ...contextSchema.parse(input),
      encryptedKey: key ? this.codec.encrypt(key) : '' };
    this.persist(next);
    this.key = key; this.value = next; this.warning = undefined;
  }
  private persist(value: typeof this.value) { writeFileSync(`${this.file}.tmp`, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 }); renameSync(`${this.file}.tmp`, this.file); }
}

// Official docs specify 1M; use decimal 1,000,000 conservatively, not an assumed binary 1Mi.
export function officialDeepSeekWindow(value: { baseUrl: string; model: string }) {
  return new URL(value.baseUrl).hostname === 'api.deepseek.com' && /^(deepseek-flash|deepseek-v4-pro|deepseek-v4-pro-0813|deepseek-v4-flash|deepseek-v4-flash-vision-exp)$/.test(value.model) ? 1_000_000 : undefined;
}
