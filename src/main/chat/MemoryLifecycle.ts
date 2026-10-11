import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { ChatMessage, MemoryLifecycle } from '../../shared/contracts';
import { newLifecycleSchema, mergeLifecycle } from './MemoryPolicy';
import { invalidateMemoryDependents, recordMemoryEvent } from './MemoryRepository';

export const lifecycleSchema = newLifecycleSchema;
export const updateSchema = z.object({ id: z.string().uuid(), target: z.enum(['automatic', 'confirmed']), expectedRevision: z.number().int().positive(), lifecycle: lifecycleSchema, sourceMessageIds: z.array(z.string().uuid()).min(1), clearLifecycleFields: z.array(z.enum(['reason', 'factKey', 'changeType', 'eventTime', 'validFrom', 'validTo', 'conditions', 'dependsOn', 'dependencies'])).optional() }).strict();
export type MemoryUpdate = z.infer<typeof updateSchema>;
export type MemorySnapshot = { automatic: object[]; confirmed: object[]; stamp: string };
const legacyLifecycle = z.object({ status: z.enum(['active', 'historical', 'retracted', 'needs_review']), reason: z.string().optional(), factKey: z.string().optional(), changeType: z.enum(['fact_change', 'correction', 'temporary', 'plan', 'history', 'fiction']).optional(), eventTime: z.string().optional(), validFrom: z.string().optional(), validTo: z.string().optional(), conditions: z.array(z.string()).optional(), dependsOn: z.array(z.string().uuid()).optional(), dependencies: z.array(z.object({ id: z.string().uuid(), revision: z.number().int().positive() })).optional() });
export function lifecycleView(raw: { lifecycle?: string | null }): { lifecycle?: MemoryLifecycle } {
  if (!raw.lifecycle) return {};
  try { return { lifecycle: legacyLifecycle.parse(JSON.parse(raw.lifecycle)) }; }
  catch { return { lifecycle: { status: 'needs_review', reason: '存储元数据不可读取，暂不作为现状' } }; }
}
const table = (target: MemoryUpdate['target']) => target === 'confirmed' ? 'memories' : 'conversation_memories';

export function migrateLifecycle(db: DatabaseSync) {
  for (const name of ['memories', 'conversation_memories']) {
    if (!(db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).some(c => c.name === 'lifecycle')) db.exec(`ALTER TABLE ${name} ADD COLUMN lifecycle TEXT`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS memory_changes(id TEXT PRIMARY KEY, target TEXT NOT NULL, memory_id TEXT NOT NULL, previous_lifecycle TEXT, previous_updated_at INTEGER, next_revision INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS memory_changes_target ON memory_changes(memory_id);
    CREATE TRIGGER IF NOT EXISTS cleanup_confirmed_changes AFTER DELETE ON memories BEGIN DELETE FROM memory_changes WHERE memory_id=OLD.id AND target='confirmed'; END;
    CREATE TRIGGER IF NOT EXISTS cleanup_automatic_changes AFTER DELETE ON conversation_memories BEGIN DELETE FROM memory_changes WHERE memory_id=OLD.id AND target='automatic'; END;
    CREATE TABLE IF NOT EXISTS memory_change_sources(change_id TEXT NOT NULL REFERENCES memory_changes(id) ON DELETE CASCADE, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, PRIMARY KEY(change_id,message_id));`);
}
export function changeSources(db: DatabaseSync, id: string): string[] { return (db.prepare('SELECT DISTINCT x.message_id AS id FROM memory_changes c JOIN memory_change_sources x ON x.change_id=c.id WHERE c.memory_id=?').all(id) as { id: string }[]).map(r => r.id); }
export function memorySnapshot(db: DatabaseSync, characterId: string, sessionId: string, revision: string): MemorySnapshot {
  const automatic = db.prepare(`SELECT t.id,t.text,t.kind,t.scope,t.subject,t.revision,t.author,t.lifecycle,t.metadata,t.updated_at FROM conversation_memories t JOIN memory_batches b ON b.id=t.batch_id JOIN sessions s ON s.id=b.session_id WHERE s.character_id=? AND b.role_revision=? AND (t.scope='real' OR b.session_id=?) ORDER BY t.id`).all(characterId, revision, sessionId);
  const confirmed = db.prepare('SELECT id,text,scope,session_id,revision,lifecycle,metadata,coalesce(updated_at,created_at) AS updated_at FROM memories WHERE character_id=? AND (scope=\'real\' OR session_id=?) ORDER BY id').all(characterId, sessionId);
  return { automatic, confirmed, stamp: createHash('sha256').update(JSON.stringify([automatic, confirmed])).digest('hex') };
}
export function validateDependencyGraph(snapshot: MemorySnapshot) {
  const rows = new Map([...snapshot.automatic, ...snapshot.confirmed].map(r => { const row = r as { id: string; lifecycle?: string | MemoryLifecycle }; const lifecycle = typeof row.lifecycle === 'string' ? lifecycleView({ lifecycle: row.lifecycle }).lifecycle : row.lifecycle; return [row.id, lifecycle] as const; }));
  const done = new Set<string>();
  const visit = (id: string, path: Set<string>) => { if (path.has(id)) throw new Error('记忆依赖形成循环'); if (done.has(id)) return; const l = rows.get(id); const next = new Set(path).add(id); for (const target of [...(l?.dependsOn ?? []), ...(l?.dependencies ?? []).map(r => r.id)]) { if (!rows.has(target)) throw new Error('记忆依赖不属于当前作用域'); visit(target, next); } done.add(id); };
  for (const id of rows.keys()) visit(id, new Set());
}
// Called inside the same transaction as insertion of newly extracted memories.
export function applyUpdates(db: DatabaseSync, updates: MemoryUpdate[], source: ChatMessage[], snapshot: MemorySnapshot) {
  const allowed = new Map(source.filter(m => m.status === 'complete').map(m => [m.id, m]));
  const automatic = new Set(snapshot.automatic.map(r => (r as { id: string }).id)), confirmed = new Set(snapshot.confirmed.map(r => (r as { id: string }).id));
  const ids = new Set<string>();
  for (const update of updates) {
    updateSchema.parse(update);
    if (ids.has(update.id) || !(update.target === 'automatic' ? automatic : confirmed).has(update.id)) throw new Error('记忆更新重复或不属于当前作用域');
    ids.add(update.id);
    if (new Set(update.sourceMessageIds).size !== update.sourceMessageIds.length || update.sourceMessageIds.some(id => !allowed.has(id)) || !update.sourceMessageIds.some(id => allowed.get(id)?.role === 'user')) throw new Error('记忆更新必须引用本批确切用户原文');
    if ([...(update.lifecycle.dependsOn ?? []), ...(update.lifecycle.dependencies ?? []).map(r => r.id)].some(id => id === update.id || !automatic.has(id) && !confirmed.has(id))) throw new Error('记忆依赖不属于当前作用域或指向自身');
    const name = table(update.target);
    const row = db.prepare(`SELECT revision,lifecycle,updated_at,lifecycle_change_id FROM ${name} WHERE id=?`).get(update.id) as { revision: number; lifecycle: string | null; updated_at: number | null; lifecycle_change_id: string | null } | undefined;
    if (!row || row.revision !== update.expectedRevision) throw new Error('记忆版本已更新，拒绝旧任务覆盖');
    const now = Date.now(), changeId = randomUUID();
    const lifecycle = mergeLifecycle(lifecycleView(row).lifecycle, update.lifecycle);
    for (const field of update.clearLifecycleFields ?? []) delete lifecycle[field];
    lifecycleSchema.parse(lifecycle);
    db.prepare('INSERT INTO memory_changes(id,target,memory_id,previous_lifecycle,previous_updated_at,next_revision,created_at,previous_change_id) VALUES(?,?,?,?,?,?,?,?)').run(changeId, update.target, update.id, row.lifecycle, row.updated_at, row.revision + 1, now, row.lifecycle_change_id);
    for (const id of update.sourceMessageIds) db.prepare('INSERT INTO memory_change_sources VALUES(?,?)').run(changeId, id);
    db.prepare(`UPDATE ${name} SET lifecycle=?,revision=revision+1,updated_at=?,lifecycle_change_id=? WHERE id=?`).run(JSON.stringify(lifecycle), now, changeId, update.id);
    const type = update.target === 'confirmed' ? 'confirmed' : 'fact'; invalidateMemoryDependents(db, type, update.id); recordMemoryEvent(db, type, update.id, 'patch_lifecycle', row.revision + 1, update.sourceMessageIds);
  }
}
// Rewind evidence before deleting source messages. Never overwrite a later user edit.
export function undoChanges(db: DatabaseSync, sessionId: string, cutoff: number) {
  const rows = db.prepare(`SELECT c.* FROM memory_changes c WHERE c.id IN (SELECT x.change_id FROM memory_change_sources x JOIN messages m ON m.id=x.message_id WHERE m.session_id=? AND m.rowid>=?) ORDER BY c.rowid DESC`).all(sessionId, cutoff) as { id: string; target: MemoryUpdate['target']; memory_id: string; next_revision: number; previous_lifecycle: string | null; previous_updated_at: number | null; previous_change_id: string | null }[];
  for (const row of rows) {
    const name = table(row.target);
    const changed = db.prepare(`UPDATE ${name} SET lifecycle=?,revision=revision+1,updated_at=?,lifecycle_change_id=? WHERE id=? AND lifecycle_change_id=?`).run(row.previous_lifecycle, Date.now(), row.previous_change_id, row.memory_id, row.id).changes;
    if (changed) { invalidateMemoryDependents(db, row.target === 'confirmed' ? 'confirmed' : 'fact', row.memory_id); const current = db.prepare(`SELECT revision FROM ${name} WHERE id=?`).get(row.memory_id) as { revision: number }; recordMemoryEvent(db, row.target === 'confirmed' ? 'confirmed' : 'fact', row.memory_id, 'compensate', current.revision); }
    db.prepare('UPDATE memory_changes SET previous_lifecycle=?,previous_updated_at=?,previous_change_id=? WHERE target=? AND memory_id=? AND previous_change_id=?').run(row.previous_lifecycle, row.previous_updated_at, row.previous_change_id, row.target, row.memory_id, row.id);
    db.prepare('DELETE FROM memory_changes WHERE id=?').run(row.id);
  }
}
