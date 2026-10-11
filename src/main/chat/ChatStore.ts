import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ChatMessage, MemoryItem, ConversationSummary, SummaryData, SessionEntry, DataQuery, DataPage, DataRecord, DataSection, DataMutation } from '../../shared/contracts';
import { migrateImages, withImages, listImages, readImage, copyImages, insertImages, imageSourceStamp, type StoredImage } from './MessageImages';
import { estimateText } from './ContextBudget';
import { lifecycleView, changeSources } from './MemoryLifecycle';
import { LongMemoryStore } from './LongMemory';
import { parseSummary } from './ConversationSummary';
import { evaluateMemories } from './MemoryPolicy';
import { automaticSessionTitle } from '../../shared/sessionTitle';
import { MemoryRepository, migrateMemory, MEMORY_SCHEMA_VERSION, invalidateMemoryDependents, recordMemoryEvent } from './MemoryRepository';
type MessageRow = { revision?: number; turn_id?: string; id: string; role: ChatMessage['role']; text: string; reasoning?: string; speaker?: string; status: ChatMessage['status']; created_at: number; proactive: number };
type MemoryRow = { scope?: 'real' | 'fiction' | 'unknown'; session_id?: string; lifecycle?: string; id: string; text: string; source_message_id: string | null; created_at: number; revision: number; updated_at: number | null };
function messageView(row: MessageRow): ChatMessage { return { id: row.id, revision: row.revision ?? 1, turnId: row.turn_id, role: row.role, text: row.text, reasoning: row.reasoning ?? undefined, speaker: row.speaker ?? undefined, status: row.status, createdAt: row.created_at, proactive: Boolean(row.proactive) }; }
export class ChatStore {
  private db: DatabaseSync;
  readonly longMemory: LongMemoryStore;
  readonly memory: MemoryRepository;
  constructor(root: string) {
    this.db = new DatabaseSync(join(root, 'chat.sqlite'));
    const priorVersion = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (priorVersion > MEMORY_SCHEMA_VERSION) { this.db.close(); throw new Error('聊天数据库由更新版本创建，请使用新版程序'); }
    if (priorVersion > 0 && priorVersion < MEMORY_SCHEMA_VERSION) this.db.prepare('VACUUM INTO ?').run(join(root, `chat-before-v${MEMORY_SCHEMA_VERSION}-${Date.now()}.sqlite.bak`));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, character_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_role ON sessions(character_id,created_at);
      CREATE TABLE IF NOT EXISTS active_sessions(character_id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, proactive INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,created_at);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, character_id TEXT NOT NULL, text TEXT NOT NULL, source_message_id TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS memories_role ON memories(character_id,created_at);
      UPDATE messages SET status='cancelled' WHERE status='pending';`);
    if (!(this.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).some(c => c.name === 'speaker')) this.db.exec('ALTER TABLE messages ADD COLUMN speaker TEXT');
    if (!(this.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).some(c => c.name === 'reasoning')) this.db.exec('ALTER TABLE messages ADD COLUMN reasoning TEXT');
    this.migrateUserInputs();
    this.db.exec('BEGIN IMMEDIATE'); try { this.db.exec(`CREATE TABLE IF NOT EXISTS session_summaries(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, role_revision TEXT NOT NULL, through_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      source_count INTEGER NOT NULL, source_hash TEXT NOT NULL, as_of INTEGER NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL);
      `);
      if (!(this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(c => c.name === 'history_revision')) this.db.exec('ALTER TABLE sessions ADD COLUMN history_revision INTEGER NOT NULL DEFAULT 0');
      const memoryColumns = this.db.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
      if (!memoryColumns.some(c => c.name === 'revision')) this.db.exec('ALTER TABLE memories ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
      if (!memoryColumns.some(c => c.name === 'updated_at')) this.db.exec('ALTER TABLE memories ADD COLUMN updated_at INTEGER');
      if (!(this.db.prepare('PRAGMA table_info(session_summaries)').all() as { name: string }[]).some(c => c.name === 'author')) this.db.exec("ALTER TABLE session_summaries ADD COLUMN author TEXT NOT NULL DEFAULT 'model'");
      if (!(this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(c => c.name === 'memory_attempt_at')) this.db.exec('ALTER TABLE sessions ADD COLUMN memory_attempt_at INTEGER NOT NULL DEFAULT 0');
      LongMemoryStore.migrate(this.db); migrateImages(this.db);
      const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
      if (!columns.some(c => c.name === 'title')) {
        this.db.exec("ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT ''; ALTER TABLE sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT 'auto'; ALTER TABLE sessions ADD COLUMN title_revision INTEGER NOT NULL DEFAULT 1;");
        for (const row of this.db.prepare('SELECT id,created_at FROM sessions').all() as { id: string; created_at: number }[]) this.updateAutomaticTitle(row.id, row.created_at);
      }
      migrateMemory(this.db, priorVersion < 9);
      this.db.exec(`PRAGMA user_version=${MEMORY_SCHEMA_VERSION}; COMMIT`); } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
    this.longMemory = new LongMemoryStore(this.db);
    this.memory = new MemoryRepository(this.db);
  }
  private messageView(row: MessageRow) { return withImages(this.db, messageView(row)); }
  image(id: string) { return readImage(this.db, id); }
  private migrateUserInputs() {
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS user_inputs(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL,
        origin TEXT NOT NULL CHECK(origin IN ('live','backfill')));
        CREATE INDEX IF NOT EXISTS user_inputs_character ON user_inputs(character_id,sequence);
        CREATE INDEX IF NOT EXISTS user_inputs_session ON user_inputs(session_id,sequence);
        CREATE TRIGGER IF NOT EXISTS archive_user_input AFTER INSERT ON messages
        WHEN NEW.role='user' AND NEW.status='complete'
        BEGIN
          INSERT INTO user_inputs(message_id,session_id,character_id,text,created_at,origin)
          SELECT NEW.id,NEW.session_id,s.character_id,NEW.text,NEW.created_at,'live'
          FROM sessions s WHERE s.id=NEW.session_id;
        END;`);
      // Backfill the entire existing log once, not just the UI's last 100 messages.
      if (version < 1) this.db.exec(`INSERT INTO user_inputs(message_id,session_id,character_id,text,created_at,origin)
        SELECT m.id,m.session_id,s.character_id,m.text,m.created_at,'backfill'
        FROM messages m JOIN sessions s ON s.id=m.session_id
        WHERE m.role='user' AND m.status='complete' ORDER BY m.rowid
        ON CONFLICT(message_id) DO NOTHING;
        PRAGMA user_version=1;`);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
  }
  session(characterId: string) {
    const selected = this.db.prepare('SELECT s.id FROM active_sessions a JOIN sessions s ON s.id=a.session_id WHERE a.character_id=? AND s.character_id=?').get(characterId, characterId) as { id: string } | undefined;
    if (selected) return selected.id;
    const row = this.db.prepare('SELECT id FROM sessions WHERE character_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(characterId) as { id: string } | undefined;
    if (row) { this.selectSession(characterId, row.id); return row.id; } return this.newSession(characterId);
  }
  newSession(characterId: string) {
    const id = randomUUID(), now = Date.now(); this.db.exec('BEGIN'); try { this.db.prepare('INSERT INTO sessions(id,character_id,created_at,title) VALUES(?,?,?,?)').run(id, characterId, now, automaticSessionTitle(undefined, now)); this.selectSession(characterId, id); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; } return id;
  }
  selectSession(characterId: string, sessionId: string) { if (!this.ownsSession(characterId, sessionId)) throw new Error('会话不属于当前角色'); this.db.prepare('INSERT INTO active_sessions VALUES(?,?) ON CONFLICT(character_id) DO UPDATE SET session_id=excluded.session_id').run(characterId, sessionId); }
  sessions(characterId: string) { return (this.db.prepare('SELECT id,created_at AS createdAt,title,title_revision AS titleRevision FROM sessions WHERE character_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50').all(characterId) as unknown as SessionEntry[]); }
  allSessions() { return this.db.prepare('SELECT id,character_id AS characterId FROM sessions ORDER BY rowid').all() as { id: string; characterId: string }[]; }
  ownsSession(characterId: string, sessionId: string) { return Boolean(this.db.prepare('SELECT id FROM sessions WHERE id=? AND character_id=?').get(sessionId, characterId)); }
  historyRevision(sessionId: string) { const row = this.db.prepare('SELECT history_revision AS revision FROM sessions WHERE id=?').get(sessionId) as { revision: number } | undefined; if (!row) throw new Error('会话不存在'); return row.revision; }
  message(sessionId: string, id: string) { const row = this.db.prepare('SELECT * FROM messages WHERE session_id=? AND id=?').get(sessionId, id) as MessageRow | undefined; if (!row) throw new Error('消息已删除或不属于当前会话'); return this.messageView(row); }
  regenerationSource(sessionId: string, id: string) {
    const reply = this.message(sessionId, id);
    if (reply.role !== 'assistant' || reply.proactive || reply.status === 'pending') throw new Error('请选择已结束的普通模型回答重新生成');
    const row = this.db.prepare("SELECT * FROM messages WHERE session_id=? AND rowid<? AND role='user' AND status='complete' ORDER BY rowid DESC LIMIT 1").get(sessionId, this.messageSequence(sessionId, id)) as MessageRow | undefined;
    if (!row) throw new Error('这条回答没有对应用户问题'); return this.messageView(row);
  }
  rewind(characterId: string, sessionId: string, messageId: string, expectedRevision: number, replacement?: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.ownsSession(characterId, sessionId) || this.historyRevision(sessionId) !== expectedRevision) throw new Error('聊天记录已更新，请重新选择消息');
      const cutoff = this.messageSequence(sessionId, messageId);
      const replacementImages = replacement === undefined ? [] : copyImages(this.db, messageId);
      const removedMemories = this.db.prepare('DELETE FROM memories WHERE character_id=? AND source_message_id IN (SELECT id FROM messages WHERE session_id=? AND rowid>=?)').run(characterId, sessionId, cutoff).changes;
      if (removedMemories) this.invalidateSummaries(characterId); else this.discardSummary(sessionId);
      this.longMemory.invalidateFrom(sessionId, cutoff);
      // FK cascades remove the independent user archive and any summary coverage.
      this.db.prepare('DELETE FROM messages WHERE session_id=? AND rowid>=?').run(sessionId, cutoff);
      this.db.prepare('UPDATE sessions SET history_revision=history_revision+1,memory_generation=memory_generation+1 WHERE id=?').run(sessionId);
      const replacementId = replacement === undefined ? undefined : this.append(sessionId, 'user', replacement, false, 'complete', replacementImages);
      this.updateAutomaticTitle(sessionId);
      this.db.exec('COMMIT'); return replacementId;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  sessionEntry(sessionId: string) { return this.db.prepare('SELECT id,created_at AS createdAt,title,title_revision AS titleRevision FROM sessions WHERE id=?').get(sessionId) as unknown as SessionEntry; }
  messages(sessionId: string, limit = 100): ChatMessage[] {
    const rows = this.db.prepare('SELECT * FROM (SELECT rowid AS seq,* FROM messages WHERE session_id=? ORDER BY seq DESC LIMIT ?) ORDER BY seq').all(sessionId, limit) as MessageRow[];
    return rows.map(row => this.messageView(row));
  }
  messageCount(sessionId: string) { return (this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id=?').get(sessionId) as { n: number }).n; }
  private messageSequence(sessionId: string, id: string) { const row = this.db.prepare('SELECT rowid AS seq FROM messages WHERE session_id=? AND id=?').get(sessionId, id) as { seq: number } | undefined; if (!row) throw new Error('消息游标不属于当前会话'); return row.seq; }
  messagePage(sessionId: string, beforeId?: string, limit = 100) {
    const before = beforeId ? this.messageSequence(sessionId, beforeId) : Number.MAX_SAFE_INTEGER;
    const rows = this.db.prepare('SELECT * FROM messages WHERE session_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?').all(sessionId, before, limit + 1) as MessageRow[];
    return { messages: rows.slice(0, limit).reverse().map(row => this.messageView(row)), hasMore: rows.length > limit };
  }
  sessionPage(characterId: string, beforeId?: string, limit = 50) {
    let before = Number.MAX_SAFE_INTEGER;
    if (beforeId) { const row = this.db.prepare('SELECT rowid AS seq FROM sessions WHERE character_id=? AND id=?').get(characterId, beforeId) as { seq: number } | undefined; if (!row) throw new Error('会话游标不属于当前角色'); before = row.seq; }
    const rows = this.db.prepare('SELECT id,created_at AS createdAt,title,title_revision AS titleRevision FROM sessions WHERE character_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?').all(characterId, before, limit + 1) as unknown as SessionEntry[];
    return { sessions: rows.slice(0, limit), hasMore: rows.length > limit };
  }
  contextTail(sessionId: string, throughId: string | undefined, budget: number): ChatMessage[] {
    const after = throughId ? this.messageSequence(sessionId, throughId) : 0;
    return (this.db.prepare('SELECT * FROM messages WHERE session_id=? AND rowid>? ORDER BY rowid').all(sessionId, after) as MessageRow[]).map(row => this.messageView(row));
  }
  summaryBatch(sessionId: string, throughId?: string, keepTurns = 4): ChatMessage[] {
    const after = throughId ? this.messageSequence(sessionId, throughId) : 0;
    // Keep at least the four most recent user turns in original form.
    const cutoff = keepTurns ? this.db.prepare("SELECT rowid AS seq FROM messages WHERE session_id=? AND role='user' AND status='complete' ORDER BY rowid DESC LIMIT 1 OFFSET ?").get(sessionId, keepTurns - 1) as { seq: number } | undefined : { seq: Number.MAX_SAFE_INTEGER };
    if (!cutoff) return [];
    return (this.db.prepare('SELECT * FROM messages WHERE session_id=? AND rowid>? AND rowid<? ORDER BY rowid LIMIT 480').all(sessionId, after, cutoff.seq) as MessageRow[]).map(row => this.messageView(row));
  }
  sourceSnapshot(sessionId: string, throughId: string) {
    const end = this.messageSequence(sessionId, throughId), hash = createHash('sha256'); let sourceCount = 0, asOf = 0;
    for (const raw of this.db.prepare('SELECT * FROM messages WHERE session_id=? AND rowid<=? ORDER BY rowid').iterate(sessionId, end)) {
      const m = this.messageView(raw as MessageRow); hash.update(JSON.stringify([m.id, m.role, m.text, m.status, m.createdAt, m.proactive, m.speaker ?? null, ...imageSourceStamp(m)]) + '\n'); sourceCount++; asOf = m.createdAt;
    }
    return { sourceHash: hash.digest('hex'), sourceCount, asOf };
  }
  summary(sessionId: string, roleRevision: string): ConversationSummary | undefined {
    const row = this.db.prepare('SELECT revision,role_revision AS roleRevision,through_message_id AS throughMessageId,source_count AS sourceCount,source_hash AS sourceHash,as_of AS asOf,created_at AS createdAt,data,author FROM session_summaries WHERE session_id=? AND role_revision=?').get(sessionId, roleRevision) as unknown as (Omit<ConversationSummary, 'data'> & { data: string }) | undefined;
    if (!row) return undefined; try { return { ...row, data: parseSummary(row.data), entries: this.memory.summaryEntries(sessionId) }; } catch { return undefined; }
  }
  summaryRevision(sessionId: string) { return (this.db.prepare('SELECT revision FROM session_summaries WHERE session_id=?').get(sessionId) as { revision: number } | undefined)?.revision ?? 0; }
  saveSummary(sessionId: string, roleRevision: string, throughMessageId: string, data: SummaryData, expectedRevision: number, snapshot: ReturnType<ChatStore['sourceSnapshot']>) {
    const next = this.sourceSnapshot(sessionId, throughMessageId);
    if (this.summaryRevision(sessionId) !== expectedRevision || next.sourceHash !== snapshot.sourceHash) throw new Error('摘要来源已变化，请重新整理');
    const encoded = JSON.stringify(parseSummary(JSON.stringify(data)));
    this.db.prepare(`INSERT INTO session_summaries(session_id,revision,role_revision,through_message_id,source_count,source_hash,as_of,created_at,data,author) VALUES(?,?,?,?,?,?,?,?,?,'model') ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision,role_revision=excluded.role_revision,through_message_id=excluded.through_message_id,source_count=excluded.source_count,source_hash=excluded.source_hash,as_of=excluded.as_of,created_at=excluded.created_at,data=excluded.data,author='model'`).run(sessionId, expectedRevision + 1, roleRevision, throughMessageId, next.sourceCount, next.sourceHash, next.asOf, Date.now(), encoded);
  }
  discardSummary(sessionId: string) { this.db.prepare('DELETE FROM summary_entries WHERE session_id=?').run(sessionId); this.db.prepare('DELETE FROM session_summaries WHERE session_id=?').run(sessionId); }
  invalidateSummaries(characterId: string) {
    this.db.prepare('DELETE FROM summary_entries WHERE session_id IN (SELECT id FROM sessions WHERE character_id=?)').run(characterId);
    this.db.prepare('DELETE FROM session_summaries WHERE session_id IN (SELECT id FROM sessions WHERE character_id=?)').run(characterId);
  }
  append(sessionId: string, role: ChatMessage['role'], text: string, proactive = false, status: ChatMessage['status'] = 'complete', images: StoredImage[] = []) {
    // archive_user_input keeps user source + full chat atomic in this INSERT.
      const id = randomUUID(); this.db.exec('SAVEPOINT append_message'); try {
      const prior = role === 'assistant' && !proactive ? this.db.prepare("SELECT turn_id FROM messages WHERE session_id=? AND role='user' ORDER BY rowid DESC LIMIT 1").get(sessionId) as { turn_id: string } | undefined : undefined;
      this.db.prepare('INSERT INTO messages(id,session_id,role,text,status,created_at,proactive,turn_id) VALUES(?,?,?,?,?,?,?,?)').run(id, sessionId, role, text, status, Date.now(), proactive ? 1 : 0, prior?.turn_id ?? id);
      if (images.length && (role !== 'user' || status !== 'complete')) throw new Error('图片只能关联完整用户消息');
      insertImages(this.db, id, images);
      if (role === 'user' && status === 'complete') this.updateAutomaticTitle(sessionId);
      this.db.exec('RELEASE append_message'); return id;
    } catch (error) { this.db.exec('ROLLBACK TO append_message; RELEASE append_message'); throw error; }
  }
  private updateAutomaticTitle(sessionId: string, createdAt?: number) {
    const row = this.db.prepare('SELECT created_at,title,title_source FROM sessions WHERE id=?').get(sessionId) as { created_at: number; title: string; title_source: string } | undefined;
    if (!row || row.title_source === 'manual') return;
    const first = this.db.prepare("SELECT id,text FROM messages WHERE session_id=? AND role='user' AND status='complete' ORDER BY rowid LIMIT 1").get(sessionId) as { id: string; text: string } | undefined;
    const imageName = first ? listImages(this.db, first.id)[0]?.name : undefined;
    const title = automaticSessionTitle(first?.text || (imageName ? '图片 · ' + imageName : undefined), createdAt ?? row.created_at);
    if (row.title !== title) this.db.prepare('UPDATE sessions SET title=?,title_revision=title_revision+1 WHERE id=?').run(title, sessionId);
  }
  finish(id: string, text: string, status: ChatMessage['status'], speaker?: string, reasoning?: string) { this.db.prepare('UPDATE messages SET text=?,status=?,speaker=?,reasoning=?,revision=revision+1 WHERE id=?').run(text, status, speaker ?? null, reasoning || null, id); }
  memories(characterId: string, sessionId?: string): MemoryItem[] {
    return (this.db.prepare('SELECT * FROM memories WHERE character_id=? AND (? IS NULL OR scope=\'real\' OR session_id=?) ORDER BY coalesce(updated_at,created_at) DESC,rowid DESC').all(characterId, sessionId ?? null, sessionId ?? null) as MemoryRow[])
      .map(row => ({ id: row.id, scope: row.scope ?? 'real', sessionId: row.session_id ?? undefined, text: row.text, sourceMessageId: row.source_message_id ?? undefined, createdAt: row.created_at, revision: row.revision, updatedAt: row.updated_at ?? row.created_at, ...lifecycleView(row), ...(changeSources(this.db, row.id).length ? { updateSourceMessageIds: changeSources(this.db, row.id) } : {}) }));
  }
  remember(characterId: string, text: string, sourceMessageId?: string, scope: 'real' | 'fiction' | 'unknown' = 'real', sessionId?: string) {
    if (scope !== 'real' && (!sessionId || !this.ownsSession(characterId, sessionId))) throw new Error('剧情或未明确记忆必须绑定当前角色的会话');
    if (sourceMessageId) {
      const row = this.db.prepare("SELECT m.text,m.session_id FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.id=? AND s.character_id=? AND m.role='user' AND m.status='complete'").get(sourceMessageId, characterId) as { text: string; session_id: string } | undefined;
      if (!row || row.text !== text || scope !== 'real' && row.session_id !== sessionId) throw new Error('记忆来源必须是当前角色的完整用户消息');
    }
    const duplicate = this.db.prepare('SELECT id,lifecycle FROM memories WHERE character_id=? AND text=? AND scope=? AND (scope=\'real\' OR session_id=?) LIMIT 1').get(characterId, text, scope, sessionId ?? null) as { id: string; lifecycle?: string } | undefined;
    if (duplicate) { if (duplicate.lifecycle && lifecycleView(duplicate).lifecycle?.status !== 'active') { const lifecycle = { ...lifecycleView(duplicate).lifecycle, status: 'active', reason: '用户重新确认', validTo: undefined, validFrom: undefined }; this.db.prepare('UPDATE memories SET lifecycle=?,revision=revision+1,updated_at=?,lifecycle_change_id=NULL WHERE id=?').run(JSON.stringify(lifecycle), Date.now(), duplicate.id); invalidateMemoryDependents(this.db, 'confirmed', duplicate.id); this.memory.changed(characterId); } return; }
    this.db.prepare('INSERT INTO memories(id,character_id,text,source_message_id,created_at,scope,session_id) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), characterId, text, sourceMessageId ?? null, Date.now(), scope, scope === 'real' ? null : sessionId!);
    this.memory.changed(characterId);
  }
  forget(characterId: string, id: string) { this.db.exec('BEGIN'); try { this.db.prepare('DELETE FROM memories WHERE character_id=? AND id=?').run(characterId, id); this.memory.changed(characterId); this.invalidateSummaries(characterId); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  clearHistory(characterId: string) {
    this.db.exec('BEGIN'); try {
      for (const r of this.db.prepare('SELECT id FROM sessions WHERE character_id=?').all(characterId) as { id: string }[]) this.longMemory.invalidateFrom(r.id, 0);
      this.db.prepare('UPDATE memories SET source_message_id=NULL WHERE character_id=?').run(characterId);
      this.db.prepare('DELETE FROM sessions WHERE character_id=?').run(characterId); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  dataRoleIds(): string[] { return (this.db.prepare('SELECT character_id AS id FROM sessions UNION SELECT character_id AS id FROM memories ORDER BY id').all() as { id: string }[]).map(row => row.id); }
  get schemaVersion() { return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version; }
  private summaryStamp(sessionId: string) { return createHash('sha256').update(JSON.stringify(this.db.prepare('SELECT * FROM session_summaries WHERE session_id=?').get(sessionId) ?? null)).digest('hex'); }
  dataCounts(characterId?: string): Record<DataSection, number> {
    const count = (table: string, joined = false) => (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} t ${joined ? 'JOIN sessions s ON s.id=t.session_id' : ''} ${characterId ? `WHERE ${joined ? 's' : 't'}.character_id=?` : ''}`).get(...(characterId ? [characterId] : [])) as { n: number }).n;
    return { 'long-memories': (this.db.prepare(`SELECT COUNT(*) AS n FROM conversation_memories t JOIN memory_batches b ON b.id=t.batch_id JOIN sessions s ON s.id=b.session_id ${characterId ? 'WHERE s.character_id=?' : ''}`).get(...(characterId ? [characterId] : [])) as { n: number }).n, memories: count('memories'), messages: count('messages', true), inputs: count('user_inputs'), summaries: count('session_summaries', true), sessions: count('sessions') };
  }
  dataPage(query: DataQuery, limit = 50): DataPage {
    const { section } = query;
    const definitions = {
      'long-memories': { from: 'conversation_memories t JOIN memory_batches b ON b.id=t.batch_id JOIN sessions s ON s.id=b.session_id', select: 't.*,b.session_id,s.character_id', character: 's.character_id', session: 'b.session_id', text: 't.text', id: 't.id', sequence: 't.rowid' },
      memories: { from: 'memories t LEFT JOIN messages m ON m.id=t.source_message_id', select: 't.*,m.session_id AS source_session_id', character: 't.character_id', session: 'coalesce(t.session_id,m.session_id)', text: 't.text', id: 't.id', sequence: 't.rowid' },
      messages: { from: 'messages t JOIN sessions s ON s.id=t.session_id', select: 't.*,s.character_id,s.history_revision AS revision', character: 's.character_id', session: 't.session_id', text: 't.text', id: 't.id', sequence: 't.rowid' },
      inputs: { from: 'user_inputs t JOIN sessions s ON s.id=t.session_id', select: 't.*,t.message_id AS id,s.history_revision AS revision', character: 't.character_id', session: 't.session_id', text: 't.text', id: 't.message_id', sequence: 't.sequence' },
      summaries: { from: 'session_summaries t JOIN sessions s ON s.id=t.session_id', select: 't.*,t.session_id AS id,s.character_id', character: 's.character_id', session: 't.session_id', text: 't.data', id: 't.session_id', sequence: 't.rowid' },
      sessions: { from: 'sessions t LEFT JOIN active_sessions a ON a.session_id=t.id AND a.character_id=t.character_id', select: 't.*,t.id AS session_id,t.history_revision AS revision,(SELECT COUNT(*) FROM messages WHERE session_id=t.id) AS message_count,t.title AS session_title,(SELECT MAX(created_at) FROM messages WHERE session_id=t.id) AS last_message_at,(SELECT COUNT(*) FROM user_inputs WHERE session_id=t.id) AS input_count,(SELECT COUNT(*) FROM conversation_memories c JOIN memory_batches b ON b.id=c.batch_id WHERE b.session_id=t.id) AS long_memory_count,EXISTS(SELECT 1 FROM session_summaries WHERE session_id=t.id) AS has_summary,CASE WHEN a.session_id IS NULL THEN 0 ELSE 1 END AS is_active', character: 't.character_id', session: 't.id', text: 't.title', id: 't.id', sequence: 't.rowid' }
    };
    if (section === 'long-memories' && query.memoryLayer === 'observations') definitions['long-memories'] = { from: 'memory_observations t', select: 't.*', character: 't.character_id', session: 't.session_id', text: 't.text', id: 't.id', sequence: 't.rowid' };
    const d = definitions[section], where: string[] = [], params: (string | number)[] = [];
    if (section === 'sessions') {
      if (query.createdFrom !== undefined) { where.push('t.created_at>=?'); params.push(query.createdFrom); }
      if (query.createdBefore !== undefined) { where.push('t.created_at<?'); params.push(query.createdBefore); }
      if (query.sessionContent) where.push(`${query.sessionContent === 'empty' ? 'NOT ' : ''}EXISTS(SELECT 1 FROM messages WHERE session_id=t.id)`);
    }
    if (query.memoryStatus && ['memories', 'long-memories'].includes(section)) { where.push(query.memoryLayer === 'observations' ? 't.status=?' : "coalesce(json_extract(t.lifecycle,'$.status'),'active')=?"); params.push(query.memoryStatus); }
    if (query.characterId) { where.push(`${d.character}=?`); params.push(query.characterId); }
    if (query.sessionId) { where.push(`${d.session}=?`); params.push(query.sessionId); }
    if (query.sourceMemoryId) {
      if (section !== 'messages') throw new Error('来源筛选仅适用于聊天原文');
      where.push('t.id IN (SELECT message_id FROM memory_sources WHERE memory_id=? UNION SELECT source_message_id FROM memories WHERE id=? AND source_message_id IS NOT NULL UNION SELECT x.message_id FROM memory_change_sources x JOIN memory_changes c ON c.id=x.change_id WHERE c.memory_id=? UNION SELECT value FROM json_each(?))'); params.push(query.sourceMemoryId, query.sourceMemoryId, query.sourceMemoryId, JSON.stringify(this.memory.sourceMessages(query.sourceMemoryId)));
    }
    if (query.query) { where.push(`(instr(lower(${d.text}),lower(?))>0 OR ${d.id}=?)`); params.push(query.query, query.query); }
    const clause = () => where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${d.from} ${clause()}`).get(...params) as { n: number }).n;
    if (query.before !== undefined) { where.push(`${d.sequence}<?`); params.push(query.before); }
    type Row = { scope?: 'real' | 'fiction' | 'unknown'; lifecycle?: string; seq: number; id: string; character_id: string; session_id?: string; created_at: number; revision: number; updated_at?: number; source_message_id?: string; source_session_id?: string; text?: string; role?: ChatMessage['role']; status?: ChatMessage['status']; proactive?: number; speaker?: string; reasoning?: string; origin?: 'live' | 'backfill'; data?: string; role_revision?: string; through_message_id?: string; source_count?: number; source_hash?: string; as_of?: number; author?: 'model' | 'user'; message_count?: number; is_active?: number; session_title?: string; last_message_at?: number; input_count?: number; long_memory_count?: number; has_summary?: number; title_revision?: number; title_source?: 'auto' | 'manual' };
    const rows = this.db.prepare(`SELECT ${d.sequence} AS seq,${d.select} FROM ${d.from} ${clause()} ORDER BY ${d.sequence} DESC LIMIT ? OFFSET ?`).all(...params, limit + 1, query.offset ?? 0) as Row[];
    const applicabilityCache = new Map<string, ReturnType<typeof evaluateMemories>>();
    const records: DataRecord[] = rows.slice(0, limit).map(row => {
      const record: DataRecord = { memoryScope: section === 'memories' ? row.scope ?? 'real' : undefined, section, id: row.id, sequence: row.seq, characterId: row.character_id, sessionId: row.session_id, text: row.text ?? row.data ?? row.id, createdAt: row.created_at, revision: row.revision, updatedAt: row.updated_at ?? (section === 'memories' ? row.created_at : undefined), sourceMessageId: row.source_message_id ?? undefined, sourceSessionId: row.source_session_id ?? undefined, role: row.role, status: row.status, proactive: Boolean(row.proactive), speaker: row.speaker ?? undefined, reasoning: row.reasoning ?? undefined, origin: row.origin, messageCount: row.message_count, isActive: Boolean(row.is_active), sessionTitle: row.session_title || undefined, titleRevision: row.title_revision, titleSource: row.title_source, lastMessageAt: row.last_message_at ?? undefined, inputCount: row.input_count, longMemoryCount: row.long_memory_count, hasSummary: row.has_summary === undefined ? undefined : Boolean(row.has_summary) };
      if (section === 'memories' || section === 'long-memories') { Object.assign(record, lifecycleView(row)); const ids = changeSources(this.db, row.id); if (ids.length) record.updateSourceMessageIds = ids; }
      if (section === 'messages' || section === 'inputs') { const images = listImages(this.db, row.id); if (images.length) record.images = images; }
      if (section === 'long-memories') { if (query.memoryLayer === 'observations') { record.observation = this.memory.observation(row.id); record.status = undefined; record.lifecycle = { status: record.observation?.status ?? 'needs_review' }; } else { record.longMemory = this.longMemory.record(row.id); if (!record.longMemory) record.summaryError = '来源已丢失，不会注入模型。'; } }
      if (record.longMemory) { const key = JSON.stringify([record.characterId, record.longMemory.sessionId, record.longMemory.roleRevision]); let all = applicabilityCache.get(key); if (!all) { all = evaluateMemories([...this.memories(record.characterId), ...this.longMemory.candidates(record.characterId, record.longMemory.sessionId, record.longMemory.roleRevision, '')]); applicabilityCache.set(key, all); } record.applicability = all.find(m => m.id === row.id)?.applicability; }
      if (section === 'summaries') record.stamp = this.summaryStamp(row.session_id!);
      if (section === 'summaries') try {
        record.summary = { revision: row.revision, roleRevision: row.role_revision!, throughMessageId: row.through_message_id!, sourceCount: row.source_count!, sourceHash: row.source_hash!, asOf: row.as_of!, createdAt: row.created_at, author: row.author, data: parseSummary(row.data!), entries: this.memory.summaryEntries(row.session_id!) };
        record.text = JSON.stringify(record.summary.data, null, 2);
        if (this.sourceSnapshot(row.session_id!, row.through_message_id!).sourceHash !== row.source_hash) record.summaryError = '来源已变化，当前不可使用；请丢弃后重新整理。';
      } catch { record.summaryError = '摘要格式或来源不可读取；可丢弃，原文仍保留。'; }
      return record;
    });
    return { records, total, hasMore: rows.length > limit, nextBefore: rows.length > limit ? records.at(-1)?.sequence : undefined };
  }
  assertDataMutation(input: DataMutation) {
    if (input.action === 'retry-memory-job') { if (!this.memory.list(input.characterId).some(j => j.id === input.id && j.state !== 'running')) throw new Error('任务正在运行、已删除或不属于角色'); return; }
    if (input.action === 'edit-observation') { this.memory.assertObservation(input.characterId, input.id, input.revision); return; }
    if (input.action === 'delete-observations') { for (const i of input.items) this.memory.assertObservation(i.characterId, i.id, i.revision); return; }
    if (input.action === 'rename-session') { const row = this.db.prepare('SELECT title_revision FROM sessions WHERE id=? AND character_id=?').get(input.id, input.characterId) as { title_revision: number } | undefined; if (!row || row.title_revision !== input.titleRevision) throw new Error('会话名称已改变或会话已删除，请刷新后重命名'); return; }
    const session = (characterId: string, id: string, revision: number) => { if (!this.ownsSession(characterId, id) || this.historyRevision(id) !== revision) throw new Error('会话已改变或已删除，请刷新后操作'); };
    const memory = (characterId: string, id: string, revision: number) => { const row = this.db.prepare('SELECT revision FROM memories WHERE id=? AND character_id=?').get(id, characterId) as { revision: number } | undefined; if (!row || row.revision !== revision) throw new Error('记忆已改变或已删除，请刷新后操作'); };
    if (input.action === 'edit-long-memory') { this.longMemory.assertItem(input.characterId, input.id, input.revision); return; }
    if (input.action === 'delete-long-memories') { for (const item of input.items) this.longMemory.assertItem(item.characterId, item.id, item.revision, true); return; }
    if (input.action === 'add-memory') { if (input.scope && input.scope !== 'real' && (!input.sessionId || !this.ownsSession(input.characterId, input.sessionId))) throw new Error('剧情记忆必须绑定本角色会话'); return; }
    if (input.action === 'edit-memory') { memory(input.characterId, input.id, input.revision); if (this.db.prepare('SELECT id FROM memories WHERE character_id=? AND text=? AND id<>?').get(input.characterId, input.text, input.id)) throw new Error('已经有相同文本的记忆，请合并或删除重复项'); return; }
    if (input.action === 'delete-memories' || input.action === 'delete-sessions') { for (const row of input.items) (input.action === 'delete-memories' ? memory : session)(row.characterId, row.id, row.revision); return; }
    if (input.action === 'edit-input' || input.action === 'retract-message') {
      session(input.characterId, input.sessionId, input.revision); const message = this.message(input.sessionId, input.id);
      if (message.status === 'pending') throw new Error('请先在聊天页停止正在生成的回答');
      if (input.action === 'edit-input' && (message.role !== 'user' || message.status !== 'complete')) throw new Error('只能修订完整用户原文');
      if (input.action === 'edit-input' && !input.text.trim() && !message.images?.length) throw new Error('请输入文字，或保留消息图片'); return;
    }
    if (!this.ownsSession(input.characterId, input.sessionId) || this.summaryRevision(input.sessionId) !== input.revision || input.revision < 1 || this.summaryStamp(input.sessionId) !== input.stamp) throw new Error('摘要已改变或已删除，请刷新后操作');
    if (input.action === 'edit-summary') { const row = this.db.prepare('SELECT through_message_id,source_hash FROM session_summaries WHERE session_id=?').get(input.sessionId) as { through_message_id: string; source_hash: string }; if (this.sourceSnapshot(input.sessionId, row.through_message_id).sourceHash !== row.source_hash) throw new Error('摘要来源已变化，请丢弃后重新整理'); }
  }
  mutateData(input: DataMutation) {
    this.assertDataMutation(input);
    if (input.action === 'edit-input' || input.action === 'retract-message') { this.rewind(input.characterId, input.sessionId, input.id, input.revision, input.action === 'edit-input' ? input.text : undefined); return; }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.assertDataMutation(input);
      if (input.action === 'retry-memory-job') this.memory.retryManually(input.characterId, input.id);
      else if (input.action === 'edit-observation') this.db.prepare("UPDATE memory_observations SET text=?,author='user',revision=revision+1,updated_at=? WHERE id=?").run(input.text, Date.now(), input.id);
      else if (input.action === 'delete-observations') for (const i of input.items) { this.memory.suppressObservation(i.id); this.db.prepare('DELETE FROM memory_observations WHERE id=?').run(i.id); }
      else if (input.action === 'rename-session') this.db.prepare("UPDATE sessions SET title=?,title_source='manual',title_revision=title_revision+1 WHERE id=? AND character_id=?").run(input.title, input.id, input.characterId);
      else if (input.action === 'edit-long-memory') { this.longMemory.edit(input.id, input.text); this.invalidateSummaries(input.characterId); }
      else if (input.action === 'delete-long-memories') { for (const item of input.items) this.longMemory.delete(item.id); for (const role of new Set(input.items.map(row => row.characterId))) this.invalidateSummaries(role); }
      else if (input.action === 'add-memory') this.remember(input.characterId, input.text, undefined, input.scope, input.sessionId);
      else if (input.action === 'edit-memory') { this.db.prepare('UPDATE memories SET text=?,revision=revision+1,updated_at=?,lifecycle_change_id=NULL WHERE id=? AND character_id=?').run(input.text, Date.now(), input.id, input.characterId); invalidateMemoryDependents(this.db, 'confirmed', input.id); recordMemoryEvent(this.db, 'confirmed', input.id, 'user_edit', input.revision + 1); this.invalidateSummaries(input.characterId); }
      else if (input.action === 'delete-memories') { for (const item of input.items) this.db.prepare('DELETE FROM memories WHERE id=? AND character_id=?').run(item.id, item.characterId); for (const role of new Set(input.items.map(row => row.characterId))) this.invalidateSummaries(role); }
      else if (input.action === 'delete-sessions') {
        for (const item of input.items) {
          const removed = this.db.prepare('DELETE FROM memories WHERE character_id=? AND source_message_id IN (SELECT id FROM messages WHERE session_id=?)').run(item.characterId, item.id).changes;
          if (removed) this.invalidateSummaries(item.characterId);
          this.longMemory.invalidateFrom(item.id, 0);
          this.db.prepare('DELETE FROM sessions WHERE id=? AND character_id=?').run(item.id, item.characterId);
        }
      } else if (input.action === 'edit-summary') {
        const data = parseSummary(JSON.stringify(input.data));
        const summary = this.db.prepare('SELECT through_message_id FROM session_summaries WHERE session_id=?').get(input.sessionId) as { through_message_id: string };
        const sources = this.db.prepare("SELECT id,revision FROM messages WHERE session_id=? AND rowid<=(SELECT rowid FROM messages WHERE id=?) AND status='complete'").all(input.sessionId, summary.through_message_id) as { id: string; revision: number }[];
        this.db.prepare('DELETE FROM summary_entries WHERE session_id=?').run(input.sessionId);
        for (const [category, texts] of Object.entries(data)) for (const text of texts) {
          const id = randomUUID(); this.db.prepare('INSERT INTO summary_entries VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, input.sessionId, category, text, category === 'fictionalState' ? 'fiction' : 'unknown', 'conditional', 'active', 1, 'user', 'batch');
          for (const s of sources) this.db.prepare("INSERT INTO memory_links VALUES('summary',?,'message',?,?)").run(id, s.id, s.revision);
        }
        this.db.prepare("UPDATE session_summaries SET data=?,revision=revision+1,author='user',created_at=? WHERE session_id=?").run(JSON.stringify(data), Date.now(), input.sessionId);
      }
      else this.discardSummary(input.sessionId);
      if (input.action !== 'rename-session' && input.action !== 'retry-memory-job') for (const role of new Set('items' in input ? input.items.map(i => i.characterId) : [input.characterId])) this.memory.changed(role);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
