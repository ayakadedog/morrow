import { z } from 'zod';

// Validate submitted text without normalizing the stored source message.
export const userInputTextSchema = z.string().min(1).max(6000)
  .refine(text => text.trim().length > 0, '输入不能只有空白');
export const chatSendInputSchema = z.object({
  characterId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  epoch: z.number().int().positive(),
  sessionId: z.string().uuid(),
  historyRevision: z.number().int().nonnegative(),
  text: z.string().max(6000),
  imageIds: z.array(z.string().uuid()).max(4).optional()
}).strict().refine(value => Boolean(value.text.trim() || value.imageIds?.length), '请填写文字或添加图片').refine(value => new Set(value.imageIds).size === (value.imageIds?.length ?? 0), '图片不能重复');
