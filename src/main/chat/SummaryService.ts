import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseJsonMarkdown } from '@langchain/core/output_parsers';
import type { ChatMessage, ConversationSummary, SummaryData, SummaryEntry } from '../../shared/contracts';
import { parseSummary, summaryPrompt } from './ConversationSummary';
import type { MemoryRepository } from './MemoryRepository';
const categories = ['events', 'userStatements', 'fictionalState', 'uncertainties', 'commitments', 'openQuestions', 'keyQuotes'] as const;
const itemSchema = z.object({ id: z.string().uuid().optional(), expectedRevision: z.number().int().positive().optional(), category: z.enum(categories), text: z.string().trim().min(1).max(720), scope: z.enum(['real', 'fiction', 'unknown']), modality: z.enum(['asserted', 'possible', 'negated', 'conditional']), status: z.enum(['active', 'resolved']), sourceMessageIds: z.array(z.string().uuid()).min(1), mergeFrom: z.array(z.object({ id: z.string().uuid(), expectedRevision: z.number().int().positive() }).strict()).optional() }).strict();
const schema = z.object({ entries: z.array(itemSchema) }).strict();
export function summaryEntriesPrompt(previous: ConversationSummary | undefined, messages: ChatMessage[]) {
  const prompt = summaryPrompt(previous, messages);
  prompt[0].content += '\n本版输出协议覆盖旧数组协议：只输出 {"entries":[{"id":"已有条目可选","expectedRevision":1,"category":"events等七类","text":"条目","scope":"real/fiction/unknown","modality":"asserted/possible/negated/conditional","status":"active/resolved","sourceMessageIds":["确切原文ID"]}]}。新增条目不填 id；旧条目只输出需要变化的项，必须带 id 与 expectedRevision。未变化条目由程序保留，不重写人工条目。同主题需要合并时，保留主条目的 id，填 mergeFrom:[{id,expectedRevision}]，必须包括被合并条目的全部出处；仅合并同类别同作用域的自动条目，程序删除被合并的旧摘要条目，原文仍保留。摘要是有损压缩，合并同主题条目时保留全部必要出处与时间/否定/条件；总量遵守旧协议七类数组的预算，不要为了新增条目无限累加。来源必须引用新增原文或该条旧来源，不引用其他会话；关键纠正需引用新增用户原文。保留可能、否定、条件及现实/剧情边界，resolved 表示已解决而非抹除历史。';
  prompt[1].content = JSON.stringify({ previous: previous ? { asOf: previous.asOf, data: previous.data, entries: previous.entries } : null, source: messages.map(m => ({ id: m.id, role: m.role, text: m.status === 'complete' ? m.text : '', status: m.status, createdAt: m.createdAt, images: m.images?.map(i => ({ id: i.id, name: i.name })) })) });
  return prompt;
}
export function storeSummaryEntries(repository: MemoryRepository, sessionId: string, raw: string, source: ChatMessage[], previous?: ConversationSummary): SummaryData {
  const decoded = parseJsonMarkdown(raw, JSON.parse) as { entries?: unknown };
  const db = repository.db, old = repository.summaryEntries(sessionId), indexed = new Map(old.map(e => [e.id, e]));
  if (!decoded || !('entries' in decoded)) {
    // Compatibility output is explicitly marked batch provenance, never exact.
    if (old.some(e => e.author === 'user')) throw new Error('旧格式输出不能覆盖人工摘要条目');
    const data = parseSummary(raw); db.prepare('DELETE FROM summary_entries WHERE session_id=?').run(sessionId);
    const ids = [...new Set([...(previous?.entries?.length ? previous.entries.flatMap(e => e.sourceMessageIds) : previous ? (db.prepare("SELECT id FROM messages WHERE session_id=? AND rowid<=(SELECT rowid FROM messages WHERE id=?) AND status='complete'").all(sessionId, previous.throughMessageId) as { id: string }[]).map(m => m.id) : []), ...source.filter(m => m.status === 'complete').map(m => m.id)])];
    for (const category of categories) for (const text of data[category]) insert({ id: randomUUID(), revision: 1, category, text, scope: category === 'fictionalState' ? 'fiction' : 'unknown', modality: 'conditional', status: 'active', sourceMessageIds: ids, sourceGranularity: 'batch', author: 'model' });
    return data;
  }
  const parsed = schema.parse(decoded), seen = new Set<string>();
  const newlyAllowed = new Set(source.filter(m => m.status === 'complete').map(m => m.id));
  for (const item of parsed.entries) {
    const existing = item.id ? indexed.get(item.id) : undefined;
    if (item.id && (!existing || existing.revision !== item.expectedRevision || existing.author === 'user' || seen.has(item.id))) throw new Error('摘要条目版本无效或受人工保护');
    const merged = (item.mergeFrom ?? []).map(ref => { const oldEntry = indexed.get(ref.id); if (!existing || !oldEntry || oldEntry.id === existing.id || oldEntry.revision !== ref.expectedRevision || oldEntry.author === 'user' || oldEntry.category !== item.category || oldEntry.scope !== item.scope || seen.has(ref.id)) throw new Error('摘要合并目标或版本无效'); seen.add(ref.id); return oldEntry; });
    const allowed = new Set([...newlyAllowed, ...(existing?.sourceMessageIds ?? []), ...merged.flatMap(e => e.sourceMessageIds)]);
    if (merged.some(e => e.sourceMessageIds.some(id => !item.sourceMessageIds.includes(id)))) throw new Error('摘要合并必须保留被合并条目出处');
    if (new Set(item.sourceMessageIds).size !== item.sourceMessageIds.length || item.sourceMessageIds.some(id => !allowed.has(id))) throw new Error('摘要出处不属于本条目或新增原文');
    if (!item.sourceMessageIds.some(id => newlyAllowed.has(id))) throw new Error('摘要更新必须引用新增原文');
    for (const id of item.sourceMessageIds) if (!db.prepare("SELECT 1 FROM messages WHERE id=? AND session_id=? AND status='complete'").get(id, sessionId)) throw new Error('摘要来源已失效');
    const id = existing?.id ?? randomUUID(); seen.add(id);
    for (const entry of merged) db.prepare('DELETE FROM summary_entries WHERE id=?').run(entry.id);
    if (existing) db.prepare('DELETE FROM summary_entries WHERE id=?').run(id);
    insert({ ...item, id, revision: (existing?.revision ?? 0) + 1, sourceGranularity: 'exact', author: 'model' });
  }
  const data: SummaryData = { events: [], userStatements: [], fictionalState: [], uncertainties: [], commitments: [], openQuestions: [], keyQuotes: [] };
  for (const entry of repository.summaryEntries(sessionId)) data[entry.category].push(entry.text);
  return parseSummary(JSON.stringify(data)); // bounded compression artifact, never silently slice.
  function insert(entry: SummaryEntry) {
    db.prepare('INSERT INTO summary_entries VALUES(?,?,?,?,?,?,?,?,?,?)').run(entry.id, sessionId, entry.category, entry.text, entry.scope, entry.modality, entry.status, entry.revision, entry.author, entry.sourceGranularity);
    for (const id of entry.sourceMessageIds) {
      const row = db.prepare('SELECT revision FROM messages WHERE id=? AND session_id=?').get(id, sessionId) as { revision: number } | undefined; if (!row) throw new Error('摘要来源已删除');
      db.prepare("INSERT INTO memory_links VALUES('summary',?,'message',?,?)").run(entry.id, id, row.revision);
    }
  }
}
