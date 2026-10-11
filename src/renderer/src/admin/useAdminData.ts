import { useEffect, useRef, useState } from 'react';
import type { ApiResult, DataMutation, DataOverview, DataPage, DataRecord, DataSection, DesktopState, SummaryData } from '../../../shared/contracts';
const sessionTitle = (record?: DataRecord) => record?.sessionTitle || '新对话';
import { summaryDataSchema } from '../../../shared/dataAdmin';
const scopedSections = new Set<string>(['messages', 'inputs', 'long-memories', 'summaries']);
type Editor = { kind: 'memory' | 'long-memory' | 'input' | 'summary' | 'session'; characterId: string; record?: DataRecord };
export function useAdminData({ desktop, onOpenChat, initialSection = 'overview' }: { desktop: DesktopState; onOpenChat: () => void; initialSection?: DataSection | 'overview' }) {
  const [newMemoryScope, setNewMemoryScope] = useState<import('../../../shared/contracts').LongMemoryScope>('real'), [newMemorySession, setNewMemorySession] = useState<string>();
  const [memoryLayer, setMemoryLayer] = useState<'facts' | 'observations'>('facts'), [memoryStatus, setMemoryStatus] = useState<import('../../../shared/contracts').MemoryLifecycle['status']>();
  const [section, setSection] = useState<DataSection | 'overview'>(initialSection), [overview, setOverview] = useState<DataOverview>(), [page, setPage] = useState<DataPage>();
  const [characterId, setCharacterId] = useState(''), [sessionId, setSessionId] = useState<string>(), [query, setQuery] = useState(''), [search, setSearch] = useState('');
  const [createdFrom, setCreatedFrom] = useState(''), [createdTo, setCreatedTo] = useState(''), [sessionContent, setSessionContent] = useState<'all' | 'with-messages' | 'empty'>('all');
  const [sessionInfo, setSessionInfo] = useState<DataRecord>();
  const [inputSessions, setInputSessions] = useState<DataRecord[]>([]), [inputSessionSearch, setInputSessionSearch] = useState(''), [inputSessionPage, setInputSessionPage] = useState(0), [inputSessionMore, setInputSessionMore] = useState(false), [inputSessionLoading, setInputSessionLoading] = useState(false);
  const [sourceMemoryId, setSourceMemoryId] = useState<string>();
  const [pageIndex, setPageIndex] = useState(0), [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0), [dirty, setDirty] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [editor, setEditor] = useState<Editor>(), [draft, setDraft] = useState(''), [summaryDraft, setSummaryDraft] = useState<SummaryData>();
  const [confirmation, setConfirmation] = useState<{ mutation: DataMutation; description: string }>();
  const alive = useRef(true), request = useRef(0);
  const accept = <T,>(result: ApiResult<T>) => { if (!result.ok) throw new Error(result.error.message); return result.value; };
  const optionRequest = useRef(0);
  useEffect(() => {
    if (section !== 'inputs' && !(editor?.kind === 'memory' && !editor.record)) return;
    const run = ++optionRequest.current; setInputSessionLoading(true);
    const timer = setTimeout(() => { void window.petAPI.dataQuery({ section: 'sessions', characterId: editor?.kind === 'memory' && !editor.record ? editor.characterId : characterId || undefined, query: inputSessionSearch.trim() || undefined, offset: inputSessionPage * 50 }).then(result => {
      if (optionRequest.current !== run || !alive.current) return;
      const rows = accept(result); setInputSessions(previous => inputSessionPage ? [...previous, ...rows.records.filter(row => !previous.some(old => old.id === row.id))] : rows.records); setInputSessionMore(rows.hasMore);
    }).catch(reason => { if (optionRequest.current === run) setError(reason.message); }).finally(() => { if (optionRequest.current === run) setInputSessionLoading(false); }); }, inputSessionSearch ? 250 : 0);
    return () => { clearTimeout(timer); optionRequest.current++; };
  }, [section, characterId, inputSessionSearch, inputSessionPage, refresh, editor?.kind, editor?.characterId, editor?.record]);
  useEffect(() => {
    if (section !== 'inputs' || sessionId) return;
    let current = true;
    void window.petAPI.getChat().then(result => { if (!current || !result.ok) return; const c = result.value; setCharacterId(c.characterId); setSessionId(c.sessionId); });
    return () => { current = false; };
    // Only choose the current chat on entering the page; changing role deliberately requires a new selection.
  }, [section]);
  const sessionScoped = scopedSections.has(section), sessionGallery = section === 'sessions' || sessionScoped && !sessionId && !sourceMemoryId && section !== 'inputs';
  const querySection = sessionGallery ? 'sessions' : section;
  const scope = { ...(!sessionGallery && section === 'long-memories' ? { memoryLayer, memoryStatus } : {}), ...(sessionGallery ? { createdFrom: createdFrom ? new Date(createdFrom + 'T00:00:00').getTime() : undefined, createdBefore: createdTo ? new Date(new Date(createdTo + 'T00:00:00').setDate(new Date(createdTo + 'T00:00:00').getDate() + 1)).getTime() : undefined, sessionContent: sessionContent === 'all' ? undefined : sessionContent } : {}), characterId: characterId || undefined, sessionId, sourceMemoryId, query: query || undefined };
  function reset() { setPageIndex(0); setSelected([]); setPage(undefined); }
  function navigate(next: typeof section) { setInputSessionSearch(''); setInputSessionPage(0); setSection(next); if (!scopedSections.has(next) || !sessionScoped) { setSessionId(undefined); setSessionInfo(undefined); } setSourceMemoryId(undefined); setQuery(''); setSearch(''); reset(); setEditor(undefined); setConfirmation(undefined); setError(''); setNotice(''); }
  function sessionList() { setInputSessionSearch(''); setInputSessionPage(0); setSessionId(undefined); setSessionInfo(undefined); setSourceMemoryId(undefined); setQuery(''); setSearch(''); reset(); setEditor(undefined); setConfirmation(undefined); setError(''); setNotice(''); }
  function openSession(row: DataRecord) { setCharacterId(row.characterId); setSessionId(row.id); setSessionInfo(row); if (!sessionScoped) setSection('messages'); setSourceMemoryId(undefined); setQuery(''); setSearch(''); reset(); setError(''); setNotice(''); }

  useEffect(() => { if (!sessionGallery) return; const timer = setTimeout(() => { if (search.trim() !== query) { reset(); setQuery(search.trim()); } }, 300); return () => clearTimeout(timer); }, [search, sessionGallery, query]);
  useEffect(() => { alive.current = true; const off = window.petAPI.onChat(() => setDirty(true)); return () => { alive.current = false; request.current++; off(); }; }, []);
  useEffect(() => {
    const run = ++request.current; setLoading(true); setSelected([]); setError('');
    void Promise.all([window.petAPI.dataOverview(), querySection === 'overview' || section === 'inputs' && !sessionId ? Promise.resolve(undefined) : window.petAPI.dataQuery({ section: querySection, ...scope, offset: pageIndex * 50 }), sessionScoped && sessionId ? window.petAPI.dataQuery({ section: 'sessions', characterId: characterId || undefined, sessionId }) : Promise.resolve(undefined)]).then(([info, rows, session]) => {
      if (!alive.current || request.current !== run) return;
      setOverview(accept(info));
      if (session) { const current = accept(session).records[0]; if (!current) { sessionList(); setNotice('该会话已删除或不属于所选角色，请重新选择。'); setDirty(false); return; } setSessionInfo(current); }
      const next = rows ? accept(rows) : undefined; if (next && pageIndex > 0 && !next.records.length) { setPageIndex(Math.max(0, Math.ceil(next.total / 50) - 1)); return; } setPage(next); setDirty(false);
    }).catch(reason => { if (alive.current && request.current === run) { setError(reason.message); setPage(undefined); } }).finally(() => { if (alive.current && request.current === run) setLoading(false); });
  }, [section, characterId, sessionId, sourceMemoryId, query, pageIndex, refresh, createdFrom, createdTo, sessionContent, memoryLayer, memoryStatus]);
  const change = async (mutation: DataMutation) => {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { accept(await window.petAPI.dataMutate(mutation)); if (alive.current) { setEditor(undefined); setConfirmation(undefined); reset(); setRefresh(n => n + 1); setNotice('已保存到本机数据库。'); } }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : '保存失败，请重试'); }
    finally { if (alive.current) setBusy(false); }
  };
  const save = () => {
    if (!editor) return; const row = editor.record;
    if (editor.kind === 'session' && row) void change({ action: 'rename-session', characterId: row.characterId, id: row.id, titleRevision: row.titleRevision!, title: draft });
    else if (editor.kind === 'memory') { if (!row && newMemoryScope !== 'real' && !newMemorySession) { setError('请选择绑定的会话'); return; } void change(row ? { action: 'edit-memory', characterId: row.characterId, id: row.id, revision: row.revision, text: draft } : { action: 'add-memory', characterId: editor.characterId, text: draft, scope: newMemoryScope, sessionId: newMemoryScope === 'real' ? undefined : newMemorySession }); }
    else if (editor.kind === 'long-memory' && row) void change({ action: row.observation ? 'edit-observation' : 'edit-long-memory', characterId: row.characterId, id: row.id, revision: row.revision, text: draft });
    else if (editor.kind === 'input' && row) void change({ action: 'edit-input', characterId: row.characterId, sessionId: row.sessionId!, id: row.id, revision: row.revision, text: draft });
    else if (row && summaryDraft) { const parsed = summaryDataSchema.safeParse(summaryDraft); if (!parsed.success || JSON.stringify(summaryDraft).length > 15000) { setError('摘要格式或长度超过限制：每项最多720字，总计最多15000字符。'); return; } void change({ action: 'edit-summary', characterId: row.characterId, sessionId: row.sessionId!, revision: row.revision, stamp: row.stamp!, data: parsed.data }); }
  };
  const edit = (kind: Editor['kind'], row?: DataRecord) => { setNewMemoryScope('real'); setNewMemorySession(undefined); setInputSessionSearch(''); setInputSessionPage(0); setError(''); setConfirmation(undefined); setEditor({ kind, record: row, characterId: row?.characterId ?? (characterId || desktop.character.id) }); setDraft(kind === 'session' ? sessionTitle(row) : row?.text ?? ''); setSummaryDraft(row?.summary?.data); };
  const source = (row: DataRecord) => { setSection('messages'); setSessionInfo(undefined); setCharacterId(row.characterId); setSessionId(row.observation || row.updateSourceMessageIds?.length ? undefined : row.sourceSessionId ?? row.sessionId); const linked = row.observation || row.longMemory || row.updateSourceMessageIds?.length; setSourceMemoryId(linked ? row.id : undefined); setQuery(linked ? '' : row.sourceMessageId ?? row.id); setSearch(linked ? '' : row.sourceMessageId ?? row.id); reset(); setEditor(undefined); };
  const openChat = async (row: DataRecord) => {
    setBusy(true); setError('');
    try { const current = accept(await window.petAPI.getChat()); if (current.characterId !== row.characterId) throw new Error('请先切换到此角色，再进入聊天'); const { characterId, epoch, sessionId, historyRevision } = current; accept(await window.petAPI.selectConversation({ characterId, epoch, sessionId, historyRevision, selectedSessionId: row.sessionId! })); onOpenChat(); }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : '打开会话失败'); } finally { if (alive.current) setBusy(false); }
  };
  const exportData = async () => {
    if (querySection === 'overview') return; setBusy(true); setError('');
    try { const result = accept(await window.petAPI.dataExport({ section: querySection, ...scope })); if (!result.cancelled && alive.current) setNotice(`已导出 ${result.count} 条筛选数据：${result.path}`); }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : '导出失败'); } finally { if (alive.current) setBusy(false); }
  };
  const selectedRows = page?.records.filter(row => selected.includes(row.id)).map(row => ({ id: row.id, characterId: row.characterId, revision: row.revision })) ?? [];
  const roleName = (id: string) => overview?.roles.find(role => role.id === id)?.name ?? id;
  return { newMemoryScope, setNewMemoryScope, newMemorySession, setNewMemorySession, memoryLayer, setMemoryLayer, memoryStatus, setMemoryStatus, section, overview, page, characterId, setCharacterId, sessionId, sessionInfo, inputSessions, inputSessionSearch, inputSessionMore, inputSessionLoading, searchInputSessions: (text: string) => { setInputSessionSearch(text); setInputSessionPage(0); }, loadMoreInputSessions: () => { if (inputSessionMore && !inputSessionLoading) setInputSessionPage(n => n + 1); }, query, search, setQuery, setSearch, createdFrom, setCreatedFrom, createdTo, setCreatedTo, sessionContent, setSessionContent, sourceMemoryId, setSourceMemoryId, pageIndex, setPageIndex, selected, setSelected, loading, busy, dirty, error, setError, notice, editor, setEditor, draft, setDraft, summaryDraft, setSummaryDraft, confirmation, setConfirmation, sessionScoped, sessionGallery, querySection, reset, navigate, sessionList, openSession, change, save, edit, source, openChat, exportData, selectedRows, roleName, refreshData: () => { setRefresh(n => n + 1); } };
}
