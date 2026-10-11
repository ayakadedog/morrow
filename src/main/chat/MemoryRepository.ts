import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryJobView, MemoryObservation, SummaryEntry } from '../../shared/contracts';

export const MEMORY_SCHEMA_VERSION = 12;
function addColumn(db: DatabaseSync, table: string, column: string, definition: string) {
  if (!(db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
export function migrateMemory(db: DatabaseSync, upgradeLegacy = true) {
  addColumn(db, 'sessions', 'memory_generation', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'messages', 'revision', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'messages', 'turn_id', 'TEXT');
  for (const table of ['memories', 'conversation_memories']) {
    addColumn(db, table, 'metadata', 'TEXT'); addColumn(db, table, 'lifecycle_change_id', 'TEXT');
  }
  addColumn(db, 'memory_changes', 'previous_change_id', 'TEXT');
  addColumn(db, 'memories', 'scope', "TEXT NOT NULL DEFAULT 'real'");
  addColumn(db, 'memories', 'session_id', 'TEXT REFERENCES sessions(id) ON DELETE CASCADE');
  db.exec(`CREATE TABLE IF NOT EXISTS memory_events(id TEXT PRIMARY KEY,target_type TEXT NOT NULL,target_id TEXT NOT NULL,operation TEXT NOT NULL,revision INTEGER NOT NULL,source_ids TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS memory_events_target ON memory_events(target_type,target_id);
    CREATE TABLE IF NOT EXISTS memory_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('extract','consolidate','summary')),character_id TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,role_revision TEXT NOT NULL,generation INTEGER NOT NULL,history_revision INTEGER NOT NULL,payload TEXT NOT NULL DEFAULT '{}',dedupe_key TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('queued','running','retry_wait','succeeded','superseded','blocked')),attempts INTEGER NOT NULL DEFAULT 0,not_before INTEGER NOT NULL,lease_until INTEGER,run_token TEXT,error_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS memory_jobs_ready ON memory_jobs(state,not_before);
    CREATE INDEX IF NOT EXISTS memory_jobs_scope ON memory_jobs(dedupe_key,state);
    CREATE TABLE IF NOT EXISTS memory_observations(id TEXT PRIMARY KEY,character_id TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,role_revision TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('real','fiction','unknown')),topic_key TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','needs_review')),revision INTEGER NOT NULL DEFAULT 1,author TEXT NOT NULL DEFAULT 'model',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS memory_observations_scope ON memory_observations(character_id,role_revision,scope,session_id);
    CREATE TABLE IF NOT EXISTS summary_entries(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,category TEXT NOT NULL,text TEXT NOT NULL,scope TEXT NOT NULL,modality TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,author TEXT NOT NULL DEFAULT 'model',source_granularity TEXT NOT NULL DEFAULT 'exact');
    CREATE INDEX IF NOT EXISTS summary_entries_session ON summary_entries(session_id);
    CREATE TABLE IF NOT EXISTS memory_links(target_type TEXT NOT NULL,target_id TEXT NOT NULL,source_type TEXT NOT NULL,source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,PRIMARY KEY(target_type,target_id,source_type,source_id));
    CREATE INDEX IF NOT EXISTS memory_links_source ON memory_links(source_type,source_id);
    CREATE TABLE IF NOT EXISTS memory_suppressions(id TEXT PRIMARY KEY,character_id TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,fact_key TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS memory_suppressions_scope ON memory_suppressions(character_id,message_id,fact_key);
    CREATE TRIGGER IF NOT EXISTS purge_fact_derivatives BEFORE DELETE ON conversation_memories BEGIN
      UPDATE memory_observations SET status='needs_review',revision=revision+1 WHERE id IN(SELECT target_id FROM memory_links WHERE target_type='observation' AND source_type='fact' AND source_id=OLD.id);
      DELETE FROM memory_links WHERE source_type='fact' AND source_id=OLD.id;
      DELETE FROM memory_events WHERE target_type='fact' AND target_id=OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS purge_confirmed_derivatives BEFORE DELETE ON memories BEGIN
      UPDATE memory_observations SET status='needs_review',revision=revision+1 WHERE id IN(SELECT target_id FROM memory_links WHERE target_type='observation' AND source_type='confirmed' AND source_id=OLD.id);
      DELETE FROM memory_links WHERE source_type='confirmed' AND source_id=OLD.id;
      DELETE FROM memory_events WHERE target_type='confirmed' AND target_id=OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS purge_message_derivatives BEFORE DELETE ON messages BEGIN
      DELETE FROM summary_entries WHERE id IN(SELECT target_id FROM memory_links WHERE target_type='summary' AND source_type='message' AND source_id=OLD.id);
      DELETE FROM memory_events WHERE EXISTS(SELECT 1 FROM json_each(source_ids) WHERE value=OLD.id);
      DELETE FROM memory_links WHERE source_type='message' AND source_id=OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS purge_observation_links AFTER DELETE ON memory_observations BEGIN DELETE FROM memory_links WHERE target_type='observation' AND target_id=OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS purge_summary_links AFTER DELETE ON summary_entries BEGIN DELETE FROM memory_links WHERE target_type='summary' AND target_id=OLD.id; END;`);
  // Backfill stable turn IDs without rewriting either text archive.
  if (db.prepare('SELECT 1 FROM messages WHERE turn_id IS NULL LIMIT 1').get()) {
  let session = '', turn = '';
  for (const row of db.prepare('SELECT id,session_id,role,proactive,turn_id FROM messages ORDER BY session_id,rowid').iterate() as Iterable<{ id: string; session_id: string; role: string; proactive: number; turn_id: string | null }>) {
    if (session !== row.session_id || row.role === 'user' || row.proactive) turn = row.id;
    session = row.session_id; if (!row.turn_id) db.prepare('UPDATE messages SET turn_id=? WHERE id=?').run(turn, row.id);
  }
  }
  // Upgrade the old rollback chain once. New rewinds never decrement revisions.
  if (!upgradeLegacy) return;
  for (const table of ['memories', 'conversation_memories']) {
    const target = table === 'memories' ? 'confirmed' : 'automatic';
    const rows = db.prepare('SELECT id,memory_id,next_revision,previous_change_id FROM memory_changes WHERE target=? ORDER BY memory_id,next_revision').all(target) as { id: string; memory_id: string; next_revision: number; previous_change_id: string | null }[];
    let prior: typeof rows[number] | undefined;
    for (const row of rows) {
      if (prior?.memory_id === row.memory_id && row.next_revision === prior.next_revision + 1 && !row.previous_change_id) db.prepare('UPDATE memory_changes SET previous_change_id=? WHERE id=?').run(prior.id, row.id);
      db.prepare(`UPDATE ${table} SET lifecycle_change_id=? WHERE id=? AND revision=? AND lifecycle_change_id IS NULL`).run(row.id, row.memory_id, row.next_revision); prior = row;
    }
  }
}
export function recordMemoryEvent(db: DatabaseSync, type: string, id: string, operation: string, revision: number, sources: string[] = []) {
  db.prepare('INSERT INTO memory_events VALUES(?,?,?,?,?,?,?)').run(randomUUID(), type, id, operation, revision, JSON.stringify(sources), Date.now());
}
export function invalidateMemoryDependents(db: DatabaseSync, type: 'fact' | 'confirmed', id: string) {
  db.prepare("UPDATE memory_observations SET status='needs_review',revision=revision+1,updated_at=? WHERE id IN(SELECT target_id FROM memory_links WHERE target_type='observation' AND source_type=? AND source_id=?)").run(Date.now(), type, id);
}
export type MemoryJob = MemoryJobView & { roleRevision: string; generation: number; historyRevision: number; payload: { manual?: boolean }; runToken?: string };
type JobRow = { id: string; kind: MemoryJob['kind']; character_id: string; session_id: string; state: MemoryJob['state']; attempts: number; not_before: number; error_code?: string; updated_at: number; role_revision: string; generation: number; history_revision: number; payload: string; run_token?: string };
function jobView(r: JobRow): MemoryJob { return { id: r.id, kind: r.kind, characterId: r.character_id, sessionId: r.session_id, state: r.state, attempts: r.attempts, notBefore: r.not_before, errorCode: r.error_code ?? undefined, updatedAt: r.updated_at, roleRevision: r.role_revision, generation: r.generation, historyRevision: r.history_revision, payload: JSON.parse(r.payload), runToken: r.run_token ?? undefined }; }

export class MemoryRepository {
  constructor(readonly db: DatabaseSync) {}
  generation(sessionId: string) { return (this.db.prepare('SELECT memory_generation FROM sessions WHERE id=?').get(sessionId) as { memory_generation: number } | undefined)?.memory_generation; }
  changed(characterId: string) { this.db.prepare('UPDATE sessions SET memory_generation=memory_generation+1 WHERE character_id=?').run(characterId); }
  enqueue(kind: MemoryJob['kind'], characterId: string, sessionId: string, roleRevision: string, delay = 0, manual = false) {
    const session = this.db.prepare('SELECT character_id,memory_generation,history_revision FROM sessions WHERE id=?').get(sessionId) as { character_id: string; memory_generation: number; history_revision: number } | undefined;
    if (!session || session.character_id !== characterId) throw new Error('整理任务会话不属于角色');
    const key = JSON.stringify([kind, characterId, sessionId, roleRevision, session.memory_generation]);
    const existing = this.db.prepare("SELECT id,payload,not_before FROM memory_jobs WHERE dedupe_key=? AND state IN('queued','retry_wait') ORDER BY rowid LIMIT 1").get(key) as { id: string; payload: string; not_before: number } | undefined;
    const now = Date.now(), at = now + delay;
    if (existing) {
      const previous = JSON.parse(existing.payload); this.db.prepare("UPDATE memory_jobs SET state='queued',payload=?,not_before=?,updated_at=?,error_code=NULL WHERE id=?").run(JSON.stringify({ manual: manual || previous.manual }), manual || previous.manual ? now : kind === 'extract' && delay === 45000 && existing.not_before > now + 1500 ? at : Math.min(existing.not_before, at), now, existing.id); return existing.id;
    }
    const id = randomUUID(); this.db.prepare('INSERT INTO memory_jobs(id,kind,character_id,session_id,role_revision,generation,history_revision,payload,dedupe_key,state,not_before,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, kind, characterId, sessionId, roleRevision, session.memory_generation, session.history_revision, JSON.stringify({ manual }), key, 'queued', at, now, now); return id;
  }
  list(characterId?: string): MemoryJob[] { return (this.db.prepare(`SELECT * FROM memory_jobs ${characterId ? 'WHERE character_id=?' : ''} ORDER BY updated_at DESC LIMIT 100`).all(...(characterId ? [characterId] : [])) as JobRow[]).map(jobView); }
  nextDelay(allowed?: (kind: MemoryJob['kind'], manual: boolean) => boolean) {
    const rows = this.db.prepare("SELECT kind,payload,CASE WHEN state='running' THEN lease_until ELSE not_before END AS ready FROM memory_jobs WHERE state IN('queued','retry_wait','running') ORDER BY ready").all() as { kind: MemoryJob['kind']; payload: string; ready: number }[];
    const row = rows.find(r => !allowed || allowed(r.kind, Boolean(JSON.parse(r.payload).manual))); return row ? Math.max(0, row.ready - Date.now()) : undefined;
  }
  recover() { this.db.prepare("UPDATE memory_jobs SET state='queued',run_token=NULL,lease_until=NULL WHERE state='running' AND lease_until<=?").run(Date.now()); }
  claim(allowed?: (kind: MemoryJob['kind'], manual: boolean) => boolean): MemoryJob | undefined {
    this.db.exec('BEGIN IMMEDIATE'); try {
      this.recover(); const rows = this.db.prepare("SELECT * FROM memory_jobs WHERE state IN('queued','retry_wait') AND not_before<=? ORDER BY CASE kind WHEN 'summary' THEN 0 WHEN 'extract' THEN 1 ELSE 2 END,not_before,rowid").all(Date.now()) as JobRow[]; const row = rows.find(r => !allowed || allowed(r.kind, Boolean(JSON.parse(r.payload).manual)));
      if (!row) { this.db.exec('COMMIT'); return; }
      const token = randomUUID(); this.db.prepare("UPDATE memory_jobs SET state='running',attempts=attempts+1,run_token=?,lease_until=?,updated_at=? WHERE id=?").run(token, Date.now() + 900000, Date.now(), row.id); this.db.exec('COMMIT'); return jobView({ ...row, state: 'running', attempts: row.attempts + 1, run_token: token });
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  current(job: MemoryJob) {
    const row = this.db.prepare("SELECT 1 FROM memory_jobs j JOIN sessions s ON s.id=j.session_id WHERE j.id=? AND j.run_token=? AND j.state='running' AND j.lease_until>? AND s.character_id=j.character_id AND s.memory_generation=j.generation AND s.history_revision=j.history_revision").get(job.id, job.runToken!, Date.now()); return Boolean(row);
  }
  commit(job: MemoryJob, apply: () => void) {
    this.db.exec('BEGIN IMMEDIATE'); try { if (!this.current(job)) throw new Error('整理任务版本已变化'); apply(); this.complete(job, 'succeeded'); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  complete(job: MemoryJob, state: MemoryJob['state'], errorCode?: string) { this.db.prepare('UPDATE memory_jobs SET state=?,error_code=?,lease_until=NULL,run_token=NULL,updated_at=? WHERE id=? AND run_token=?').run(state, errorCode ?? null, Date.now(), job.id, job.runToken!); }
  retry(job: MemoryJob, code: string, permanent = false) {
    if (!this.current(job)) { this.complete(job, 'superseded', 'STALE_SOURCE'); return; }
    if (permanent || job.attempts >= 3) { this.complete(job, 'blocked', code); return; }
    const delay = [5000, 30000, 120000][job.attempts - 1]; this.db.prepare("UPDATE memory_jobs SET state='retry_wait',not_before=?,error_code=?,lease_until=NULL,run_token=NULL,updated_at=? WHERE id=? AND run_token=?").run(Date.now() + delay, code, Date.now(), job.id, job.runToken!);
  }
  release(job: MemoryJob) { this.db.prepare("UPDATE memory_jobs SET state='queued',not_before=?,lease_until=NULL,run_token=NULL WHERE id=? AND run_token=?").run(Date.now(), job.id, job.runToken!); }
  suppress(factId: string) {
    const row = this.db.prepare('SELECT s.character_id,b.session_id,t.lifecycle FROM conversation_memories t JOIN memory_batches b ON b.id=t.batch_id JOIN sessions s ON s.id=b.session_id WHERE t.id=?').get(factId) as { character_id: string; session_id: string; lifecycle: string | null } | undefined; if (!row) return;
    let key = '*'; try { const value = row.lifecycle ? JSON.parse(row.lifecycle).factKey : undefined; if (typeof value === 'string' && value) key = value; } catch { /* Unreadable metadata can still be deleted safely. */ }
    for (const s of this.db.prepare('SELECT message_id FROM memory_sources WHERE memory_id=?').all(factId) as { message_id: string }[]) this.db.prepare('INSERT INTO memory_suppressions VALUES(?,?,?,?,?,?)').run(randomUUID(), row.character_id, row.session_id, s.message_id, key, Date.now());
  }
  suppressed(characterId: string, messageIds: string[], key?: string) {
    return messageIds.some(id => Boolean(this.db.prepare("SELECT 1 FROM memory_suppressions WHERE character_id=? AND message_id=? AND (? IS NULL OR fact_key='*' OR fact_key=?)").get(characterId, id, key ?? null, key ?? '*')));
  }
  observations(characterId: string, sessionId: string, roleRevision: string, includeInvalid = false): MemoryObservation[] {
    const rows = this.db.prepare(`SELECT * FROM memory_observations WHERE character_id=? AND role_revision=? AND (scope='real' OR session_id=?) ${includeInvalid ? '' : "AND status='active'"} ORDER BY created_at,id`).all(characterId, roleRevision, sessionId) as { id: string; character_id: string; session_id: string; role_revision: string; scope: MemoryObservation['scope']; topic_key: string; text: string; status: MemoryObservation['status']; revision: number; author: MemoryObservation['author']; created_at: number; updated_at: number }[];
    return rows.map(r => ({ id: r.id, characterId: r.character_id, sessionId: r.session_id, roleRevision: r.role_revision, scope: r.scope, topicKey: r.topic_key, text: r.text, status: r.status, revision: r.revision, author: r.author, createdAt: r.created_at, updatedAt: r.updated_at, sources: (this.db.prepare("SELECT source_type AS type,source_id AS id,source_revision AS revision FROM memory_links WHERE target_type='observation' AND target_id=?").all(r.id) as MemoryObservation['sources']) }));
  }
  summaryEntries(sessionId: string): SummaryEntry[] {
    return (this.db.prepare('SELECT * FROM summary_entries WHERE session_id=? ORDER BY rowid').all(sessionId) as { id: string; category: SummaryEntry['category']; text: string; scope: SummaryEntry['scope']; modality: SummaryEntry['modality']; status: SummaryEntry['status']; revision: number; author: SummaryEntry['author']; source_granularity: SummaryEntry['sourceGranularity'] }[]).map(r => ({ id: r.id, revision: r.revision, category: r.category, text: r.text, scope: r.scope, modality: r.modality, status: r.status, author: r.author, sourceGranularity: r.source_granularity, sourceMessageIds: (this.db.prepare("SELECT source_id AS id FROM memory_links WHERE target_type='summary' AND target_id=? AND source_type='message'").all(r.id) as { id: string }[]).map(s => s.id) }));
  }
  sourceMessages(id: string): string[] {
    const direct = this.db.prepare("SELECT source_id AS id FROM memory_links WHERE target_type='summary' AND target_id=? AND source_type='message' UNION SELECT ms.message_id AS id FROM memory_links l JOIN memory_sources ms ON ms.memory_id=l.source_id WHERE l.target_type='observation' AND l.target_id=? AND l.source_type='fact' UNION SELECT m.source_message_id AS id FROM memory_links l JOIN memories m ON m.id=l.source_id WHERE l.target_type='observation' AND l.target_id=? AND l.source_type='confirmed' AND m.source_message_id IS NOT NULL").all(id, id, id) as { id: string }[]; return direct.map(s => s.id);
  }
  observation(id: string) {
    const r = this.db.prepare('SELECT character_id,session_id,role_revision FROM memory_observations WHERE id=?').get(id) as { character_id: string; session_id: string; role_revision: string } | undefined;
    return r ? this.observations(r.character_id, r.session_id, r.role_revision, true).find(o => o.id === id) : undefined;
  }
  observationSuppressed(characterId: string, roleRevision: string, topic: string, scope: string, refs: MemoryObservation['sources']) { const hash = this.stamp([roleRevision, topic, scope, [...refs].sort((a, b) => a.id.localeCompare(b.id))]); return Boolean(this.db.prepare('SELECT 1 FROM memory_events WHERE target_type=? AND target_id=? AND operation=?').get('observation_suppression:' + characterId, hash, 'suppress')); }
  suppressObservation(id: string) { const o = this.observation(id); if (!o) return; const hash = this.stamp([o.roleRevision, o.topicKey, o.scope, [...o.sources].sort((a, b) => a.id.localeCompare(b.id))]); recordMemoryEvent(this.db, 'observation_suppression:' + o.characterId, hash, 'suppress', 1, this.sourceMessages(id)); }
  assertObservation(characterId: string, id: string, revision: number) { const row = this.db.prepare('SELECT revision FROM memory_observations WHERE id=? AND character_id=?').get(id, characterId) as { revision: number } | undefined; if (!row || row.revision !== revision) throw new Error('归纳已改变或删除，请刷新后操作'); }
  retryManually(characterId: string, id: string) {
    const row = this.db.prepare('SELECT session_id FROM memory_jobs WHERE id=? AND character_id=?').get(id, characterId) as { session_id: string } | undefined;
    if (!row) throw new Error('整理任务不存在');
    this.db.prepare("UPDATE memory_jobs SET state='queued',attempts=0,payload=?,not_before=?,run_token=NULL,lease_until=NULL,error_code=NULL,generation=(SELECT memory_generation FROM sessions WHERE id=session_id),history_revision=(SELECT history_revision FROM sessions WHERE id=session_id),updated_at=? WHERE id=?").run(JSON.stringify({ manual: true }), Date.now(), Date.now(), id);
  }
  stamp(values: unknown) { return createHash('sha256').update(JSON.stringify(values)).digest('hex'); }
}
