import { Tiktoken } from 'js-tiktoken/lite';
import cl100k from 'js-tiktoken/ranks/cl100k_base';
import type { ModelMessage } from './ModelClient';
import type { ModelSettings } from '../../shared/contracts';
const tokenizer = new Tiktoken(cl100k);
const cache = new Map<string, number>();
const chunkCache = new Map<string, number>();
// Compatible providers do not expose a universal tokenizer. This is a deliberately
// conservative estimate, not DeepSeek's billable token count. No network tokenizer.
export function estimateText(text: string): number {
  const known = cache.get(text); if (known !== undefined) return known;
  // Bound individual BPE work: very repetitive megabyte text can otherwise block the UI process.
  let tokens = 0;
  for (let offset = 0; offset < text.length; offset += 512) {
    const chunk = text.slice(offset, offset + 512); let count = chunkCache.get(chunk);
    if (count === undefined) { count = tokenizer.encode(chunk, [], []).length; if (chunkCache.size >= 512) chunkCache.delete(chunkCache.keys().next().value!); chunkCache.set(chunk, count); }
    tokens += count;
  }
  const size = Math.max(Math.ceil(tokens * 1.15), Math.ceil(Buffer.byteLength(text, 'utf8') / 3));
  if (text.length > 65536) return size; // Avoid retaining multiple megabyte-scale prompt copies.
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(text, size); return size;
}
export function estimateMessages(messages: ModelMessage[]): number { return 3 + messages.reduce((n, m) => n + 8 + estimateText(m.content) + (m.images?.length ?? 0) * 4096, 0); }
export function inputBudget(settings: Pick<ModelSettings, 'contextWindowTokens' | 'maxOutputTokens'>): number {
  return settings.contextWindowTokens - settings.maxOutputTokens;
}
