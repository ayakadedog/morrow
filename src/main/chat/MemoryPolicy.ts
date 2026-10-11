import { z } from 'zod';
import type { MemoryApplicability, MemoryLifecycle, MemoryMetadata } from '../../shared/contracts';

// New dates must be unambiguous ISO dates/timestamps. Legacy free text is kept,
// but evaluated as unknown instead of letting Date.parse guess a locale.
export function memoryTime(value?: string): number | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== value.slice(0, 10)) return;
  const time = Date.parse(value.length === 10 ? value + 'T00:00:00Z' : value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value.slice(0, 10) && value.length === 10) return;
  return time;
}
export function storedMetadata(raw: string | undefined, fallback?: MemoryMetadata): MemoryMetadata | undefined {
  if (!raw) return fallback;
  try { return metadataSchema.parse(JSON.parse(raw)); } catch { return { evidenceClass: 'model_inferred', validityBasis: 'unknown' }; }
}
const time = z.string().refine(s => memoryTime(s) !== undefined, '时间必须是明确 ISO 日期或含时区时间');
export const metadataSchema = z.object({ evidenceClass: z.enum(['user_asserted', 'user_confirmed', 'fiction_event', 'character_belief', 'hypothesis', 'quoted', 'model_inferred']), assertedAt: z.number().int().nonnegative().optional(), validityBasis: z.enum(['explicit', 'as_of_assertion', 'unknown']).optional() }).strict();
export const newLifecycleSchema = z.object({ status: z.enum(['active', 'historical', 'retracted', 'needs_review']), reason: z.string().min(1).optional(), factKey: z.string().min(1).optional(), changeType: z.enum(['fact_change', 'correction', 'temporary', 'plan', 'history', 'fiction']).optional(), eventTime: time.optional(), validFrom: time.optional(), validTo: time.optional(), conditions: z.array(z.string()).optional(), dependsOn: z.array(z.string().uuid()).optional(), dependencies: z.array(z.object({ id: z.string().uuid(), revision: z.number().int().positive() }).strict()).optional() }).strict().refine(l => !l.validFrom || !l.validTo || memoryTime(l.validFrom)! < memoryTime(l.validTo)!, '有效期起点必须早于终点');

export function mergeLifecycle(previous: MemoryLifecycle | undefined, patch: MemoryLifecycle): MemoryLifecycle { return { ...previous, ...patch }; }
type PolicyItem = { id: string; revision?: number; lifecycle?: MemoryLifecycle; metadata?: MemoryMetadata };
export function evaluateMemories<T extends PolicyItem>(items: T[], asOf = Date.now()): (T & { applicability: MemoryApplicability })[] {
  const indexed = new Map(items.map(item => [item.id, item])), memo = new Map<string, MemoryApplicability>();
  const evaluate = (item: T, visiting: Set<string>): MemoryApplicability => {
    const existing = memo.get(item.id); if (existing) return existing;
    const value = (status: MemoryApplicability['status'], reason?: string) => ({ status, reason, evaluatedAt: asOf });
    const l = item.lifecycle;
    if (visiting.has(item.id)) return value('needs_review', '依赖形成循环');
    if (l && l.status !== 'active') return value(l.status, l.reason);
    if (l?.validFrom && memoryTime(l.validFrom) === undefined || l?.validTo && memoryTime(l.validTo) === undefined) return value('unknown', '旧时间说明无法确定生效日期');
    if (l?.validFrom && memoryTime(l.validFrom)! > asOf) return value('future', '尚未进入生效区间');
    if (l?.validTo && memoryTime(l.validTo)! <= asOf) return value('expired', '有效期已结束');
    if (l?.changeType === 'plan' || item.metadata && ['hypothesis', 'quoted', 'model_inferred'].includes(item.metadata.evidenceClass)) return value('unknown', '计划、引用或推断不能当作已确认现状');
    if (l?.conditions?.length) return value('needs_review', '自然语言条件尚未验证');
    if (l?.changeType === 'temporary' && !l.validTo) return value('unknown', '临时状态缺少明确截止时间');
    const path = new Set(visiting).add(item.id);
    const dependencies = [...(l?.dependsOn ?? []).map(id => ({ id, revision: undefined as number | undefined })), ...(l?.dependencies ?? [])];
    for (const ref of dependencies) {
      const target = indexed.get(ref.id);
      if (!target) return value('condition_failed', '依赖资料已删除、不可用或不在本作用域');
      if (ref.revision !== undefined && target.revision !== ref.revision) return value('needs_review', '依赖版本已更新');
      if (evaluate(target, path).status !== 'current') return value('condition_failed', '依赖资料已不再当前适用');
    }
    const result = value('current'); memo.set(item.id, result); return result;
  };
  return items.map(item => ({ ...item, applicability: evaluate(item, new Set()) }));
}
