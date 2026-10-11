import { z } from 'zod';
const characterId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), uuid = z.string().uuid(), revision = z.number().int().nonnegative();
const text = z.string().trim().min(1);
export const summaryDataSchema = z.object({ events: z.array(z.string().max(720)).max(16), userStatements: z.array(z.string().max(720)).max(16), fictionalState: z.array(z.string().max(720)).max(12), uncertainties: z.array(z.string().max(720)).max(16), commitments: z.array(z.string().max(720)).max(12), openQuestions: z.array(z.string().max(720)).max(12), keyQuotes: z.array(z.string().max(720)).max(8) }).strict();
const timestamp = z.number().int().nonnegative().max(8640000000000000);
const queryBase = z.object({ memoryLayer: z.enum(['facts', 'observations']).optional(), memoryStatus: z.enum(['active', 'historical', 'retracted', 'needs_review']).optional(), section: z.enum(['memories', 'long-memories', 'messages', 'inputs', 'summaries', 'sessions']), characterId: characterId.optional(), sessionId: uuid.optional(), query: z.string().trim().max(120).optional(), sourceMemoryId: uuid.optional(), before: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), offset: z.number().int().nonnegative().max(1000000).optional(), createdFrom: timestamp.optional(), createdBefore: timestamp.optional(), sessionContent: z.enum(['with-messages', 'empty']).optional() }).strict();
export const dataQuerySchema = queryBase.refine(q => !q.memoryLayer || q.section === 'long-memories', '分层筛选仅适用于自动记忆').refine(q => q.before === undefined || q.offset === undefined, '不能同时使用两种分页方式').refine(q => (q.createdFrom === undefined && q.createdBefore === undefined && q.sessionContent === undefined) || q.section === 'sessions', '日期和内容筛选仅适用于会话列表').refine(q => q.createdFrom === undefined || q.createdBefore === undefined || q.createdFrom < q.createdBefore, '开始日期不能晚于结束日期');
export const dataExportSchema = queryBase.omit({ before: true, offset: true }).refine(q => (q.createdFrom === undefined && q.createdBefore === undefined && q.sessionContent === undefined) || q.section === 'sessions', '日期和内容筛选仅适用于会话列表').refine(q => q.createdFrom === undefined || q.createdBefore === undefined || q.createdFrom < q.createdBefore, '开始日期不能晚于结束日期');
const item = z.object({ characterId, id: uuid, revision }).strict();
const items = z.array(item).min(1).max(100).refine(rows => new Set(rows.map(row => row.id)).size === rows.length, '不能重复选择');
const message = { characterId, sessionId: uuid, id: uuid, revision };
const stamp = z.string().regex(/^[a-f0-9]{64}$/);
export const dataMutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('retry-memory-job'), characterId, id: uuid }).strict(),
  z.object({ action: z.literal('edit-observation'), ...item.shape, text }).strict(),
  z.object({ action: z.literal('delete-observations'), items }).strict(),
  z.object({ action: z.literal('add-memory'), characterId, text, scope: z.enum(['real', 'fiction', 'unknown']).optional(), sessionId: uuid.optional() }).strict(),
  z.object({ action: z.literal('edit-memory'), ...item.shape, text }).strict(),
  z.object({ action: z.literal('delete-memories'), items }).strict(),
  z.object({ action: z.literal('edit-long-memory'), ...item.shape, text }).strict(),
  z.object({ action: z.literal('delete-long-memories'), items }).strict(),
  z.object({ action: z.literal('delete-sessions'), items }).strict(),
  z.object({ action: z.literal('rename-session'), characterId, id: uuid, titleRevision: z.number().int().positive(), title: z.string().trim().min(1).max(80).refine(s => !/[\r\n\x00-\x1f]/.test(s), '会话名称不能包含换行或控制字符') }).strict(),
  z.object({ action: z.literal('edit-input'), ...message, text: z.string().max(6000) }).strict(),
  z.object({ action: z.literal('retract-message'), ...message }).strict(),
  z.object({ action: z.literal('edit-summary'), characterId, sessionId: uuid, revision, stamp, data: summaryDataSchema.refine(s => JSON.stringify(s).length <= 15000, '摘要超过15000字符') }).strict(),
  z.object({ action: z.literal('discard-summary'), characterId, sessionId: uuid, revision, stamp }).strict()
]);
