import type { ModelOptions } from './contracts';

export const IMAGE_LIMIT = 4;
export const IMAGE_CONTEXT_BYTES = 16 * 1024 * 1024;
export function supportsImages(settings: Pick<ModelOptions, 'provider' | 'imageInput'> & { model: string; baseUrl?: string }): boolean {
  if (settings.imageInput === 'disabled') return false;
  if (settings.imageInput === 'enabled') return true;
  const official = settings.provider === 'deepseek' || (() => { try { return new URL(settings.baseUrl ?? '').hostname === 'api.deepseek.com'; } catch { return false; } })();
  return official && ['deepseek-flash', 'deepseek-v4-flash-vision-exp'].includes(settings.model);
}
