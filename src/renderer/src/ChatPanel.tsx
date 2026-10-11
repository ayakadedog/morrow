import React, { useEffect, useRef, useState } from 'react';
import { ArrowDownOutlined, ArrowUpOutlined, BookOutlined, CheckOutlined, CopyOutlined, DatabaseOutlined, DeleteOutlined, EditOutlined, InfoCircleOutlined, MessageOutlined, PictureOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, SettingOutlined, StopOutlined } from '@ant-design/icons';
import './chat-workspace.css';
import { ChatImageGallery } from './ChatImageGallery';
import { supportsImages } from '../../shared/imageInput';
import type { ChatImage, ApiResult, ChatState, DesktopState, ModelOptions, ChatTarget, SessionEntry } from '../../shared/contracts';

export function ChatPanel({ desktop, onOpenSessions }: { desktop: DesktopState; onOpenSessions?: () => void }) {
  const [state, setState] = useState<ChatState>(), [error, setError] = useState(''), [text, setText] = useState(''), [memory, setMemory] = useState('');
  const [section, setSection] = useState<'talk' | 'memory' | 'model'>('talk');
  const [sessionQuery, setSessionQuery] = useState(''), [searchRows, setSearchRows] = useState<SessionEntry[]>(), [searching, setSearching] = useState(false);
  const [showScroll, setShowScroll] = useState(false), [copied, setCopied] = useState('');
  const input = useRef<HTMLTextAreaElement>(null), copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [baseUrl, setBaseUrl] = useState(''), [model, setModel] = useState(''), [key, setKey] = useState('');
  const [proactive, setProactive] = useState(false), [memoryEnabled, setMemoryEnabled] = useState(true), [clearKey, setClearKey] = useState(false);
  const [streaming, setStreaming] = useState(true);
  const [contextWindowTokens, setContextWindowTokens] = useState(98304), [autoSummary, setAutoSummary] = useState(true), [autoLongMemory, setAutoLongMemory] = useState(true), [paging, setPaging] = useState(false);
  const [options, setOptions] = useState<ModelOptions>({ provider: 'openai-compatible', thinking: 'default', protocol: 'chat-completions', reasoningEffort: 'default', reasoningSummary: true, maxOutputTokens: 12288, timeoutSeconds: 120 });
  const [renaming, setRenaming] = useState(false), [sessionName, setSessionName] = useState(''), [nameSaving, setNameSaving] = useState(false), [nameRevision, setNameRevision] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false), [sending, setSending] = useState(false);
  const [modification, setModification] = useState<{ kind: 'edit' | 'retract' | 'regenerate'; messageId: string; target: ChatTarget }>(), [editText, setEditText] = useState(''), [mutating, setMutating] = useState(false);
  const log = useRef<HTMLDivElement>(null), alive = useRef(true);
  const sendInFlight = useRef(false), pickingRef = useRef(false);
  const [images, setImages] = useState<ChatImage[]>([]), [picking, setPicking] = useState(false);
  const imageRef = useRef<ChatImage[]>([]);
  function updateImages(next: ChatImage[]) { imageRef.current = next; setImages(next); }
  function discardImages() { const ids = imageRef.current.map(m => m.id); if (ids.length) void window.petAPI.discardChatImages({ ids }); updateImages([]); }
  const latest = useRef<ChatState | undefined>(undefined), scrollHold = useRef<{ top: number; height: number } | undefined>(undefined), pinned = useRef(true);
  function receive(value: ChatState) {
    if (!alive.current || value.characterId !== desktop.character.id || value.epoch !== desktop.companion.epoch) return false;
    const previous = latest.current;
    if (previous?.sessionId === value.sessionId && previous.epoch === value.epoch && previous.historyRevision > value.historyRevision) return false;
    if (previous?.sessionId === value.sessionId && previous.epoch === value.epoch && previous.historyRevision === value.historyRevision) {
      const messages = new Map(previous.messages.map(m => [m.id, m])); value.messages.forEach(m => messages.set(m.id, m));
      const sessions = new Map(previous.sessions.map(s => [s.id, s])); value.sessions.forEach(s => sessions.set(s.id, s));
      value = { ...value, messages: [...messages.values()], sessions: [...sessions.values()],
        hasOlderMessages: previous.messages.length > value.messages.length ? previous.hasOlderMessages : value.hasOlderMessages,
        hasOlderSessions: previous.sessions.length > value.sessions.length ? previous.hasOlderSessions : value.hasOlderSessions };
    } else { discardImages(); pinned.current = true; scrollHold.current = undefined; setConfirmClear(false); setModification(undefined); setRenaming(false); setShowScroll(false); }
    latest.current = value; setState(value); return true;
  }
  function accept(reply: ApiResult<ChatState>) {
    if (!alive.current) return;
    if (!reply.ok) { setError(reply.error.message); return; }
    if (reply.value.characterId !== desktop.character.id) return;
    if (!receive(reply.value)) return; setError(''); return reply.value;
  }
  useEffect(() => {
    alive.current = true;
    const unsubscribe = window.petAPI.onChat(receive);
    void window.petAPI.getChat().then(reply => {
      const value = accept(reply); if (!value) return;
      setBaseUrl(value.settings.baseUrl); setModel(value.settings.model); setProactive(value.settings.proactive); setMemoryEnabled(value.settings.memoryEnabled);
      setStreaming(value.settings.streaming);
      setContextWindowTokens(value.settings.contextWindowTokens); setAutoSummary(value.settings.autoSummary); setAutoLongMemory(Boolean(value.settings.autoLongMemory));
      const { imageInput, provider, thinking, protocol, reasoningEffort, reasoningSummary, maxOutputTokens, timeoutSeconds } = value.settings;
      setOptions({ imageInput: imageInput ?? 'auto', provider, thinking, protocol, reasoningEffort, reasoningSummary, maxOutputTokens, timeoutSeconds });
    });
    return () => { const ids = imageRef.current.map(m => m.id); if (ids.length) void window.petAPI.discardChatImages({ ids }); alive.current = false; unsubscribe(); };
  }, []);
  useEffect(() => { if (section !== 'talk' || !log.current) return; if (scrollHold.current) { const saved = scrollHold.current; log.current.scrollTop = saved.top + log.current.scrollHeight - saved.height; scrollHold.current = undefined; } else if (pinned.current) log.current.scrollTop = log.current.scrollHeight; }, [state?.draft, state?.messages.length, state?.sessionId, state?.historyRevision, section]);
  useEffect(() => {
    if (!input.current) return;
    input.current.style.height = 'auto'; input.current.style.height = `${Math.min(160, Math.max(66, input.current.scrollHeight))}px`;
  }, [text, section]);
  useEffect(() => {
    const query = sessionQuery.trim(), current = latest.current; let cancelled = false;
    if (!query || !current) { setSearchRows(undefined); setSearching(false); return; }
    setSearching(true); setSearchRows(undefined);
    const timer = setTimeout(() => {
      void window.petAPI.dataQuery({ section: 'sessions', characterId: current.characterId, query }).then(reply => {
        if (cancelled || !alive.current || latest.current?.characterId !== current.characterId || latest.current?.epoch !== current.epoch) return;
        if (!reply.ok) { setError(reply.error.message); setSearchRows([]); }
        else setSearchRows(reply.value.records.map(row => ({ id: row.id, title: row.sessionTitle || '新对话', titleRevision: row.titleRevision ?? 1, createdAt: row.createdAt })));
      }).catch(() => { if (!cancelled && alive.current) { setSearchRows([]); setError('会话搜索暂时失败，请重试'); } }).finally(() => { if (!cancelled && alive.current) setSearching(false); });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sessionQuery, state?.characterId, state?.epoch]);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  if (!state) return <p className="hint" role="status">{error || '正在打开本地会话…'}</p>;
  const target: ChatTarget = { characterId: state.characterId, epoch: state.epoch, sessionId: state.sessionId, historyRevision: state.historyRevision };
  const sessionTitle = state.sessions.find(s => s.id === state.sessionId)?.title || '新对话';
  const visibleSessions = sessionQuery.trim() ? searchRows ?? [] : state.sessions;
  const avatar = desktop.character.expressions[desktop.character.defaultExpression];
  const copyMessage = async (id: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(id); if (copyTimer.current) clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(''), 1800); }
    catch { setError('无法复制，请选中文字后复制'); }
  };
  const modify = async () => {
    if (!modification || mutating) return;
    const action = modification; setMutating(true);
    try {
      const input = { ...action.target, messageId: action.messageId };
      const reply = action.kind === 'edit' ? await window.petAPI.editMessage({ ...input, text: editText }) : action.kind === 'retract' ? await window.petAPI.retractMessage(input) : await window.petAPI.regenerateReply(input);
      if (accept(reply)) { setModification(undefined); setEditText(''); }
    } finally { if (alive.current) setMutating(false); }
  };
  const history = async (kind: 'messages' | 'sessions') => {
    if (paging) return; setPaging(true);
    const beforeId = kind === 'messages' ? state.messages[0]?.id : state.sessions.filter(s => s.id !== state.sessionId || state.sessions.length <= 50).at(-1)?.id;
    if (!beforeId) { setPaging(false); return; }
    try {
      const reply = await window.petAPI.chatHistory({ ...target, kind, beforeId }), current = latest.current;
      if (!reply.ok) { setError(reply.error.message); return; }
      if (!current || current.sessionId !== target.sessionId || current.epoch !== target.epoch || current.characterId !== target.characterId || current.historyRevision !== target.historyRevision || reply.value.target.historyRevision !== current.historyRevision) return;
      if (kind === 'messages') {
        if (log.current) scrollHold.current = { top: log.current.scrollTop, height: log.current.scrollHeight };
        const ids = new Set(current.messages.map(m => m.id)); const next = { ...current, messages: [...reply.value.messages.filter(m => !ids.has(m.id)), ...current.messages], hasOlderMessages: reply.value.hasMore }; latest.current = next; setState(next);
      } else {
        const ids = new Set(current.sessions.map(s => s.id)); const next = { ...current, sessions: [...current.sessions, ...reply.value.sessions.filter(s => !ids.has(s.id))], hasOlderSessions: reply.value.hasMore }; latest.current = next; setState(next);
      }
    } finally { if (alive.current) setPaging(false); }
  };
  const renameSession = async () => {
    const session = state.sessions.find(s => s.id === state.sessionId); if (!session || nameSaving) return;
    setNameSaving(true); setError('');
    try { const result = await window.petAPI.dataMutate({ action: 'rename-session', characterId: state.characterId, id: session.id, titleRevision: nameRevision, title: sessionName }); if (!result.ok) { setError(result.error.message); return; } accept(await window.petAPI.getChat()); setRenaming(false); }
    finally { if (alive.current) setNameSaving(false); }
  };
  const send = async () => {
    if ((!text.trim() && !images.length) || pickingRef.current || sendInFlight.current || sending || mutating || state.busy) return;
    sendInFlight.current = true; setSending(true); const value = text, imageIds = imageRef.current.map(m => m.id);
    try {
      const fresh = accept(await window.petAPI.getChat()); if (!fresh) return;
      if (fresh.characterId !== target.characterId || fresh.epoch !== target.epoch || fresh.sessionId !== target.sessionId || fresh.historyRevision !== target.historyRevision) { setError('会话已切换，输入已保留，请确认当前会话后发送'); return; }
      if (fresh.busy) { setError('正在回复，可先停止这一条'); return; }
      const current = { characterId: fresh.characterId, epoch: fresh.epoch, sessionId: fresh.sessionId, historyRevision: fresh.historyRevision };
      if (accept(await window.petAPI.sendChat({ ...current, text: value, ...(imageIds.length ? { imageIds } : {}) }))) { setText(''); updateImages([]); }
    } finally { sendInFlight.current = false; if (alive.current) setSending(false); }
  };
  const pickImages = async () => {
    if (pickingRef.current || imageRef.current.length >= 4) return; pickingRef.current = true; setPicking(true); setError('');
    try { const reply = await window.petAPI.pickChatImages({ ...target, remaining: 4 - imageRef.current.length });
      if (!reply.ok) { if (alive.current) setError(reply.error.message); return; }
      const current = latest.current;
      if (!alive.current || !current || current.characterId !== target.characterId || current.epoch !== target.epoch || current.sessionId !== target.sessionId || current.historyRevision !== target.historyRevision) { void window.petAPI.discardChatImages({ ids: reply.value.map(m => m.id) }); return; }
      updateImages([...imageRef.current, ...reply.value]);
    } finally { pickingRef.current = false; if (alive.current) setPicking(false); }
  };
  const save = async () => {
    const value = accept(await window.petAPI.configureModel({ baseUrl, model, apiKey: key || undefined, clearKey, proactive, memoryEnabled, streaming, contextWindowTokens, autoSummary, autoLongMemory, ...options }));
    if (value) { setKey(''); setClearKey(false); setBaseUrl(value.settings.baseUrl); }
  };
  return <section className="chat-panel" data-section={section}>
    <aside className="chat-sidebar" aria-label="会话导航">
      <div className="chat-companion"><div className="chat-avatar"><img src={avatar} alt="" /></div><div><strong>{desktop.character.shortName}</strong><span>留一点时间，聊聊今天</span></div></div>
      <button className="chat-new" aria-label="新对话" disabled={state.busy} onClick={() => { setSessionQuery(''); setSection('talk'); void window.petAPI.newConversation(target).then(accept); }}><PlusOutlined aria-hidden="true" />新对话<span aria-hidden="true">＋</span></button>
      <nav className="chat-tabs" aria-label="聊天功能">{([['talk', '对话', MessageOutlined], ['memory', '记忆', BookOutlined], ['model', '模型连接', SettingOutlined]] as const).map(([id, label, Icon]) => <button key={id} aria-pressed={section === id} onClick={() => setSection(id)}><Icon aria-hidden="true" />{label}</button>)}</nav>
      <div className="chat-session-heading"><span>最近的对话</span><button className="chat-icon-button" title="打开完整会话列表" aria-label="会话列表" onClick={onOpenSessions}><DatabaseOutlined aria-hidden="true" /></button></div>
      <label className="chat-session-search"><SearchOutlined aria-hidden="true" /><input aria-label="搜索会话名称" placeholder="搜索会话…" value={sessionQuery} onChange={event => setSessionQuery(event.target.value)} /></label>
      <div className="chat-session-list" aria-label="历史会话">
        {searching && <p className="chat-sidebar-empty" role="status">正在搜索…</p>}
        {!searching && !visibleSessions.length && <p className="chat-sidebar-empty">没有找到相关会话</p>}
        {visibleSessions.map(session => <button className="chat-session-item" data-session-id={session.id} key={session.id} aria-current={session.id === state.sessionId ? 'page' : undefined} title={session.title || '新对话'} onClick={() => { setSection('talk'); setSessionQuery(''); void window.petAPI.selectConversation({ ...target, selectedSessionId: session.id }).then(accept); }}><MessageOutlined aria-hidden="true" /><span><strong>{session.title || '新对话'}</strong><small>{new Date(session.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}</small></span></button>)}
        {!sessionQuery.trim() && state.hasOlderSessions && <button className="chat-load-sessions" disabled={paging} onClick={() => void history('sessions')}>更多历史会话</button>}
        {sessionQuery.trim() && !searching && visibleSessions.length >= 50 && <button className="chat-load-sessions" onClick={onOpenSessions}>到会话列表查看更多</button>}
      </div>
      <div className="chat-sidebar-footer"><span><i />对话保存在本机</span><button onClick={() => void window.petAPI.openDataAdmin()}><DatabaseOutlined aria-hidden="true" />数据管理后台 ↗</button></div>
    </aside>
    <div className="chat-main">
    <header className="chat-header"><div><span className="chat-header-eyebrow">{section === 'talk' ? '与你的片刻' : section === 'memory' ? '一点一点，记住你' : '连接与偏好'}</span><h2>{section === 'talk' ? sessionTitle : section === 'memory' ? '记忆手札' : '模型连接'}</h2></div><div className="chat-header-actions"><span className={`chat-connection ${state.settings.model ? '' : 'unconfigured'}`}><i />{state.busy ? state.generationPhase === 'thinking' ? '正在思考' : '正在回应' : state.settings.model ? '模型已配置' : '尚未连接模型'}</span>{section === 'talk' && <button className="chat-icon-button" title="重命名会话" aria-label="重命名会话" disabled={nameSaving} onClick={() => { setSessionName(sessionTitle); setNameRevision(state.sessions.find(s => s.id === state.sessionId)?.titleRevision ?? 0); setRenaming(true); setError(''); }}><EditOutlined aria-hidden="true" /></button>}</div></header>
    {section === 'talk' && <>
      <div className="chat-session-mobile"><label className="sr-only" htmlFor="chat-session-select">选择会话</label><select id="chat-session-select" aria-label="选择会话" value={state.sessionId} onChange={event => void window.petAPI.selectConversation({ ...target, selectedSessionId: event.target.value }).then(accept)}>{state.sessions.map(session => <option value={session.id} key={session.id}>{session.title || '新对话'} · {new Date(session.createdAt).toLocaleDateString('zh-CN')}</option>)}</select></div>
      {renaming && <form className="chat-session-rename" onSubmit={event => { event.preventDefault(); void renameSession(); }}><label htmlFor="chat-session-title">会话名称</label><input id="chat-session-title" type="text" autoFocus maxLength={80} value={sessionName} disabled={nameSaving} onChange={event => setSessionName(event.target.value)} /><button disabled={nameSaving || !sessionName.trim()}>保存名称</button><button type="button" disabled={nameSaving} onClick={() => setRenaming(false)}>取消改名</button></form>}
      <div className="chat-log" ref={log} aria-label="对话记录" onScroll={() => { if (log.current) { pinned.current = log.current.scrollHeight - log.current.scrollTop - log.current.clientHeight < 100; setShowScroll(!pinned.current); } }}>
        {state.hasOlderMessages && <button className="chat-load-history" disabled={paging} onClick={() => void history('messages')}>{paging ? '加载中…' : '更早的聊天记录'}</button>}
        {!state.messages.length && <div className="chat-empty"><div className="chat-welcome-mark"><img src={avatar} alt="" /><span>✦</span></div><span className="chat-empty-eyebrow">让日常，多一点回应</span><h3>今天，想聊些什么？</h3><p>和{desktop.character.shortName}分享一件小事，<br />或者把暂时说不清的心情放在这里。</p>{!state.settings.model ? <button className="chat-primary" onClick={() => setSection('model')}>先设置模型连接<ArrowUpOutlined aria-hidden="true" /></button> : <div className="chat-starters">{['今天有件事想和你说', '陪我随便聊一会儿', '帮我理一理今天的心情'].map(value => <button key={value} onClick={() => { setText(value); input.current?.focus(); }}><MessageOutlined aria-hidden="true" />{value}<span>↗</span></button>)}</div>}</div>}
        {state.messages.map((message, index) => <React.Fragment key={message.id}>
          {(index === 0 || new Date(state.messages[index - 1].createdAt).toDateString() !== new Date(message.createdAt).toDateString()) && <div className="chat-date"><span>{new Date(message.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })}</span></div>}
          <article className={`chat-message ${message.role}`} data-message-id={message.id}>
          <div className={`chat-avatar message-avatar ${message.role === 'user' ? 'user-avatar' : ''}`} aria-hidden="true">{message.role === 'user' ? '你' : <img src={avatar} alt="" />}</div>
          <div className="chat-message-stack"><div className="chat-author"><strong>{message.role === 'user' ? '你' : message.speaker && desktop.character.speakers[message.speaker]?.displayName || desktop.character.shortName}</strong><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>{message.proactive && <span>主动关心</span>}</div>
          <div className="chat-message-bubble" data-status={message.status}>
          {modification?.messageId === message.id && modification.kind === 'edit' ? <div className="chat-edit"><label htmlFor="edit-chat-message">编辑这条消息</label><textarea id="edit-chat-message" autoFocus rows={4} maxLength={6000} value={editText} onChange={event => setEditText(event.target.value)} disabled={mutating} /></div> : <p>{message.status === 'pending' ? state.draft || (state.generationPhase === 'thinking' ? '正在思考…' : '正在等待回复…') : message.text || (message.images?.length ? '' : (message.status === 'failed' ? '这一条没有完成。' : '已停止回复。'))}</p>}
          <ChatImageGallery images={message.images} />
          {modification?.messageId === message.id && modification.kind === 'edit' && Boolean(message.images?.length) && <small>重发会保留这些图片；可修改说明文字。</small>}
          {(message.status === 'pending' ? state.reasoningDraft : message.reasoning) && <details className="chat-reasoning">
            <summary>模型返回的推理 / 摘要{message.status === 'pending' && state.generationPhase === 'thinking' ? ' · 生成中' : ''}</summary>
            <div><p>{message.status === 'pending' ? state.reasoningDraft : message.reasoning}</p><small>服务返回的内容，单独保存；不作为角色台词、动作指令或长期记忆。</small></div>
          </details>}
          {message.status === 'cancelled' && <small>已停止 · 这条回复不进入后续上下文</small>}
          {message.status === 'failed' && <small>调用失败 · 可以重新生成</small>}
          </div>
          {message.status !== 'pending' && <div className="message-actions">
            {Boolean(message.text) && <button title="复制消息" aria-label={copied === message.id ? '已复制' : '复制消息'} onClick={() => void copyMessage(message.id, message.text)}>{copied === message.id ? <CheckOutlined aria-hidden="true" /> : <CopyOutlined aria-hidden="true" />}</button>}
            {message.role === 'user' && message.status === 'complete' && Boolean(message.text.trim()) && <button className="remember-message" onClick={() => void window.petAPI.addMemory({ ...target, text: message.text, sourceMessageId: message.id }).then(accept)}><BookOutlined aria-hidden="true" />记住这句话</button>}
            {message.role === 'user' && message.status === 'complete' && <button disabled={mutating} onClick={() => { setEditText(message.text); setModification({ kind: 'edit', messageId: message.id, target }); }}><EditOutlined aria-hidden="true" />编辑并重发</button>}
            {message.role === 'assistant' && !message.proactive && <button disabled={mutating || !state.settings.model} onClick={() => setModification({ kind: 'regenerate', messageId: message.id, target })}><ReloadOutlined aria-hidden="true" />重新生成</button>}
            <button disabled={mutating} onClick={() => setModification({ kind: 'retract', messageId: message.id, target })}><DeleteOutlined aria-hidden="true" />撤回</button>
          </div>}
          {modification?.messageId === message.id && <div className="message-confirm" role="group" aria-label="确认修改对话">
            <p>{modification.kind === 'regenerate' ? '保留原问题，删除这条回答和后续对话后重新生成。' : '这条消息及后续对话会移除；编辑重发会以新内容接续。'}对应用户原文副本、来源记忆和相关摘要同步清理，独立手动记忆保留。正在生成的回复将停止。{modification.kind !== 'retract' && '会调用模型并消耗额度。'}</p>
            <button disabled={mutating || modification.kind === 'edit' && ((!editText.trim() && !message.images?.length) || !state.settings.model)} onClick={() => void modify()}>{mutating ? '处理中…' : modification.kind === 'edit' ? '保存并重新发送' : modification.kind === 'retract' ? '确认撤回' : '确认重新生成'}</button>
            <button disabled={mutating} onClick={() => setModification(undefined)}>取消修改</button>
          </div>}
          </div></article></React.Fragment>)}
      </div>
      {showScroll && <button className="chat-scroll-bottom" aria-label="回到最新消息" onClick={() => { pinned.current = true; log.current?.scrollTo({ top: log.current.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); setShowScroll(false); }}><ArrowDownOutlined aria-hidden="true" />回到最新消息</button>}
      <form className="chat-compose" onSubmit={event => { event.preventDefault(); void send(); }}>
        <ChatImageGallery images={images} onRemove={id => { void window.petAPI.discardChatImages({ ids: [id] }); updateImages(imageRef.current.filter(m => m.id !== id)); }} disabled={sending || picking} />
        <label className="sr-only" htmlFor="chat-input">对角色说些什么</label>
        <textarea ref={input} id="chat-input" maxLength={6000} rows={2} value={text} placeholder={`对${desktop.character.shortName}说些什么…`} onChange={event => setText(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
        }} />
        <div className="chat-compose-actions"><button type="button" className="quiet image-add" title={supportsImages(state.settings) ? 'PNG / JPEG · 最多 4 张 · 每张原图 ≤ 10 MB' : '在模型连接中启用图片输入后可使用'} disabled={!supportsImages(state.settings) || state.busy || picking || sending || mutating || images.length >= 4} onClick={() => void pickImages()}><PictureOutlined aria-hidden="true" />{picking ? '处理图片…' : '添加图片'}</button><small>Enter 发送<span> · Shift + Enter 换行</span></small>{state.busy ? <button className="chat-send chat-stop" type="button" disabled={mutating} onClick={() => void window.petAPI.cancelChat(target).then(accept)}><StopOutlined aria-hidden="true" />停止回复</button> : <button className="chat-send" type="submit" disabled={sending || picking || mutating || (!text.trim() && !images.length) || !state.settings.model}>发送<ArrowUpOutlined aria-hidden="true" /></button>}</div>
      </form>
      <div className="chat-compose-footnote"><span><i />{state.settings.model || '先连接模型，再开始聊天'}</span><span>{state.settings.memoryEnabled ? '记忆已开启' : '记忆未启用'}</span></div>
      <details className="chat-inspector"><summary><InfoCircleOutlined aria-hidden="true" />会话详情与整理<span>上下文 · 记忆 · 诊断</span></summary><div className="chat-inspector-body">
      <p className="hint">模型收到完整角色设定、预算内全部会话原文，以及开启记忆时的全量确认与自动资料；摘要仅在原文超预算时替代已覆盖前缀。当前服务：{new URL(state.settings.baseUrl).hostname}。完整回复在这里，桌面气泡展示简短回应。</p>
      {state.contextStats && <p className="hint">最近请求：约 {state.contextStats.estimatedTokens} / {state.contextStats.inputBudget} 输入 Token（估算）。{state.contextStats.includedImages !== undefined && `本次实际携带 ${state.contextStats.includedImages} 张图片，未携带 ${state.contextStats.omittedImages} 张（模型能力或预算限制）。`}{state.contextStats.omittedMessages > 0 && `有 ${state.contextStats.omittedMessages} 条历史未进入该次上下文，原文仍在本机。`}</p>}
      {state.contextStats?.memoryTrace && <details className="chat-reasoning chat-memory-trace"><summary>本轮实际发送的记忆 · 确认 {state.contextStats.memoryTrace.confirmed.length} 条 · 自动 {state.contextStats.memoryTrace.automatic.length} 条</summary><div>
        <p className="hint">{state.contextStats.memoryTrace.enabled ? '这是本轮请求的真实资料快照，修改后下一轮重新读取。人工修订优先于同主题旧历史和自动记忆，当前明确纠正优先。' : '记忆发送开关已关闭，本轮没有发送记忆。'}</p>
        {state.contextStats.memoryTrace.confirmed.map(item => <article key={item.id}><strong>用户确认 · 第 {item.revision} 版</strong><p>{item.text}</p><small>{new Date(item.updatedAt).toLocaleString('zh-CN')} · {item.id}</small></article>)}
        {state.contextStats.memoryTrace.automatic.map(item => <article key={item.id}><strong>自动整理 · 第 {item.revision} 版</strong><p>{item.text}</p></article>)}
        {(state.contextStats.memoryTrace.omittedConfirmed > 0 || state.contextStats.memoryTrace.omittedAutomatic > 0) && <p className="hint">本轮预算内未选入：确认 {state.contextStats.memoryTrace.omittedConfirmed} 条、自动候选 {state.contextStats.memoryTrace.omittedAutomatic} 条。</p>}
      </div></details>}
      {state.lastRequest && <details className="chat-reasoning chat-request-diagnostic"><summary>请求诊断 · {({ completed: '已完成', failed: '失败', cancelled: '已停止' })[state.lastRequest.outcome]}</summary><div><p>模型 {state.lastRequest.model} · {state.lastRequest.elapsedMs} ms{state.lastRequest.attempts !== undefined && ` · HTTP 尝试 ${state.lastRequest.attempts} 次`}</p>{state.lastRequest.errorCode && <p>分类：{state.lastRequest.errorCode}{state.lastRequest.httpStatus && ` · HTTP ${state.lastRequest.httpStatus}`}{state.lastRequest.transportCode && ` · ${state.lastRequest.transportCode}`}</p>}<p className="hint">本地最多保留最近 100 条诊断元数据，不保存密钥或聊天正文。HTTP 瞬时故障最多自动重试一次；已输出的流式内容不会整段重播。</p></div></details>}
      <details className="chat-reasoning chat-summary"><summary>长期对话记忆 · {state.longMemoryCount ?? 0} 条{state.longMemoryRunning ? ' · 整理中' : ''}</summary><div><p className="hint">每轮回复后整理新增原文，并复核全部适用旧记忆；搬家、纠错会更新适用状态与出处。用户手写文字保留，当前适用、历史、撤销和待核实可在后台查看或修订。原文始终保留。</p><button disabled={state.busy || state.summarizing || state.longMemoryRunning || !state.settings.model} onClick={() => void window.petAPI.extractLongMemory(target).then(accept)}>整理一批长期记忆（调用模型）</button>{state.longMemoryRunning && <button onClick={() => void window.petAPI.cancelChat(target).then(accept)}>停止长期整理</button>}{state.longMemoryWarning && <p className="alert" role="status">{state.longMemoryWarning}</p>}</div></details>
      <details className="chat-reasoning chat-summary"><summary>会话摘要{state.summarizing ? ' · 整理中' : state.summary ? ` · 第 ${state.summary.revision} 版` : ' · 尚未生成'}</summary><div>
        <p className="hint">摘要有损，只用于当前会话，不会自动存成长期事实。每次整理会调用当前模型并消耗额度，保留最近四轮原文。长历史可分批整理。</p>
        {state.summary && <><small>覆盖 {state.summary.sourceCount} 条原始消息 · 截至 {new Date(state.summary.asOf).toLocaleString('zh-CN')}</small><div className="summary-content">{([['events', '经过与变更'], ['userStatements', '用户自述'], ['fictionalState', '剧情与假设'], ['uncertainties', '不确定与纠正'], ['commitments', '条件与承诺'], ['openQuestions', '尚未解决'], ['keyQuotes', '关键原话']] as const).map(([field, label]) => state.summary!.data[field].length > 0 && <section key={field}><strong>{label}</strong><ul>{state.summary!.data[field].map((item, i) => <li key={i}>{item}</li>)}</ul></section>)}</div></>}
        <button disabled={state.busy || state.summarizing || state.longMemoryRunning || !state.settings.model} onClick={() => void window.petAPI.summarizeChat(target).then(accept)}>整理一批历史（调用模型）</button>
        {state.summarizing && <button onClick={() => void window.petAPI.cancelChat(target).then(accept)}>停止整理</button>}
        {state.summary && <button disabled={state.busy} onClick={() => void window.petAPI.discardSummary(target).then(accept)}>丢弃摘要（保留原文）</button>}
      </div></details>
      {state.summaryWarning && <p className="hint" role="status">{state.summaryWarning}</p>}
      <div className="history-delete">{confirmClear ? <><span>删除此角色的全部对话、摘要及自动长期记忆？两份原始记录一起删除；用户确认记忆保留。</span><button onClick={() => void window.petAPI.clearChatHistory(target).then(reply => { accept(reply); setConfirmClear(false); })}>确认删除</button><button onClick={() => setConfirmClear(false)}>取消</button></> : <button className="quiet" onClick={() => setConfirmClear(true)}>删除此角色聊天记录</button>}</div>
      </div></details>
    </>}
    {section === 'memory' && <div className="controls chat-config-page">
      <div className="config-intro"><span>PERSONAL MEMORY</span><h3>让{desktop.character.shortName}记住</h3><p>留下一些关于你的细节，让下一次对话更熟悉。</p></div>
      <section className="config-card"><h4>添加一份记忆</h4><p className="hint">你确认的资料会随下一次对话发送给模型，每个角色单独保存。</p>
      <label className="field-label" htmlFor="memory-input">希望长期记住的资料</label><textarea id="memory-input" rows={3}  value={memory} placeholder="例如：我喜欢被叫小林；周末常去散步。" onChange={event => setMemory(event.target.value)} />
      <button disabled={!memory.trim()} onClick={() => void window.petAPI.addMemory({ ...target, text: memory }).then(reply => { if (accept(reply)) setMemory(''); })}>保存记忆</button>
      </section><section className="config-card"><div className="config-card-title"><h4>已保存的记忆 <span className="config-count">{state.memories.length}</span></h4><button className="quiet" onClick={() => void window.petAPI.openDataAdmin('memories')}>管理与编辑 ↗</button></div>
      <p className="hint">无条数上限 · {state.settings.memoryEnabled ? '已允许发送全量当前作用域记忆给模型' : '记忆已暂停发送，条目仍保存在本机'}</p>
      <div className="memory-list">{state.memories.map(item => <article key={item.id}><p>{item.text}</p><small>{({ active: '当前适用', historical: '历史资料', retracted: '纠错撤销', needs_review: '待核实' })[item.lifecycle?.status ?? 'active']} · {(item.revision ?? 1) > 1 ? '第 ' + item.revision + ' 版' : item.sourceMessageId ? '由你确认的用户消息' : '手动记录'} · {new Date(item.createdAt).toLocaleDateString('zh-CN')}</small><button aria-label={`忘记：${item.text}`} onClick={() => void window.petAPI.deleteMemory({ ...target, id: item.id }).then(accept)}>忘记</button></article>)}</div>
      {!state.memories.length && <p className="hint">现在没有长期记忆，聊天里的模型猜测不会自动存成事实。</p>}
      </section><details className="config-help"><summary>关于记忆、出处与删除</summary><p className="hint">本页列出你确认保存的内容；模型整理的资料在“后台 → 自动长期记忆”另行管理。每个角色单独记忆；可到“后台 → 用户长期记忆”直接编辑和查看来源。删除后下一次请求不再携带该记忆，正在生成的回复会停止。原聊天中可能仍有这句话；若需完全清除，请同时删除聊天记录。云端服务的数据需按其规则另行处理。</p></details>
    </div>}
    {section === 'model' && <div className="controls chat-config-page">
      <div className="config-intro"><span>MODEL CONNECTION</span><h3>给对话接上灵感</h3><p>连接模型，选择回复方式，也安排好她的记忆。</p></div>
      <section className="config-card"><h4>服务连接</h4><p className="hint">地址填写 API 根路径，例如服务商提供的 /v1。本地模型可用 localhost HTTP。</p>
      <label className="field-label" htmlFor="model-provider">模型适配</label><select id="model-provider" value={options.provider} onChange={event => {
        const provider = event.target.value as ModelOptions['provider']; setOptions({ ...options, provider, protocol: 'chat-completions', thinking: 'default', reasoningEffort: 'default' });
        if (provider === 'deepseek') { setContextWindowTokens(1000000); setBaseUrl('https://api.deepseek.com/v1'); setModel('deepseek-flash'); }
      }}><option value="openai-compatible">通用兼容服务</option><option value="deepseek">DeepSeek · LangChain 专用适配</option></select>
      <label className="field-label" htmlFor="model-protocol">接口协议</label><select id="model-protocol" disabled={options.provider === 'deepseek'} value={options.protocol} onChange={event => setOptions({ ...options, protocol: event.target.value as ModelOptions['protocol'] })}><option value="chat-completions">Chat Completions · 通用兼容接口</option><option value="responses">Responses · 服务明确支持时使用</option></select>
      <label className="field-label" htmlFor="model-url">API 根地址</label><input id="model-url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://你的服务商/v1" />
      <label className="field-label" htmlFor="model-name">模型名称</label><input id="model-name" value={model} onChange={event => setModel(event.target.value)} placeholder="服务商的准确模型 ID" />
      <label className="field-label" htmlFor="model-image-input">图片输入</label><select id="model-image-input" value={options.imageInput ?? 'auto'} onChange={event => setOptions({ ...options, imageInput: event.target.value as ModelOptions['imageInput'] })}><option value="auto">自动 · 已知 DeepSeek Flash 模型</option><option value="enabled">开启 · 服务明确支持图文时使用</option><option value="disabled">关闭图片输入</option></select><p className="hint">DeepSeek 官方 deepseek-flash 支持图片。其他兼容服务需确认模型支持看图后手动开启；切换到文字模型时旧图片仍可查看，但不会传入模型。</p>
      <label className="field-label" htmlFor="model-key">API Key · {state.settings.hasKey ? '已加密保存，留空保持' : '未保存，本地服务可留空'}</label><input id="model-key" type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} />
      <label className="toggle-row"><span>清除已保存密钥</span><input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)} /></label>
      </section><section className="config-card"><h4>回复与思考</h4><p className="hint">按服务支持的能力调整回复表现。</p>
      <label className="toggle-row"><span>逐字显示回复<small>服务不支持流式时关闭，等待完整回复</small></span><input id="model-streaming" type="checkbox" checked={streaming} onChange={event => setStreaming(event.target.checked)} /></label>
      {options.provider === 'deepseek' && <><label className="field-label" htmlFor="model-thinking">DeepSeek 思考模式</label><select id="model-thinking" value={options.reasoningEffort === 'none' ? 'disabled' : options.thinking} onChange={event => setOptions({ ...options, thinking: event.target.value as ModelOptions['thinking'], reasoningEffort: options.reasoningEffort === 'none' ? 'default' : options.reasoningEffort })}><option value="default">服务默认</option><option value="enabled">开启思考</option><option value="disabled">关闭思考</option></select></>}
      <label className="field-label" htmlFor="model-reasoning-effort">思考强度</label><select id="model-reasoning-effort" disabled={options.provider === 'deepseek' && options.thinking === 'disabled'} value={options.reasoningEffort} onChange={event => setOptions({ ...options, reasoningEffort: event.target.value as ModelOptions['reasoningEffort'] })}>{(options.provider === 'deepseek' ? [['default', '服务默认'], ['low', '低'], ['high', '高'], ['max', '最高']] : [['default', '服务默认（不发送额外开关）'], ['none', '不思考'], ['low', '低'], ['medium', '中'], ['high', '高'], ['max', '最高（服务支持时）']]).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
      <p className="hint">思考模型直接选服务默认即可。只有服务支持该参数时才调整强度；服务未公开推理内容时，仍可正常接收最终回答。</p>
      {options.protocol === 'responses' && <label className="toggle-row"><span>请求推理摘要<small>仅用于支持摘要的 Responses 模型</small></span><input id="model-reasoning-summary" type="checkbox" checked={options.reasoningSummary} onChange={event => setOptions({ ...options, reasoningSummary: event.target.checked })} /></label>}
      </section><section className="config-card"><h4>上下文与等待</h4><p className="hint">为完整设定、历史消息和模型回答留出空间。</p>
      <label className="field-label" htmlFor="model-output-budget">最大输出预算（Token）</label><input id="model-output-budget" type="number" min={256} max={393216} value={options.maxOutputTokens} onChange={event => setOptions({ ...options, maxOutputTokens: Number(event.target.value) })} />
      <label className="field-label" htmlFor="model-timeout">最长等待时间（秒）</label><input id="model-timeout" type="number" min={15} max={600} value={options.timeoutSeconds} onChange={event => setOptions({ ...options, timeoutSeconds: Number(event.target.value) })} />
      <p className="hint">推理模型的输出预算可能同时包含思考和回答。预算过小可能只思考而没有回答；具体上限以服务支持范围为准。</p>
      <label className="field-label" htmlFor="model-context-window">上下文窗口（Token）</label><input id="model-context-window" type="number" min={8192} max={1048576} value={contextWindowTokens} onChange={event => setContextWindowTokens(Number(event.target.value))} />
      <p className="hint">DeepSeek Flash 官方上限 1M，输入只扣除输出预留；角色设定、提示词和适用长期记忆完整发送，没有各自小预算。通用 Tokenizer 是保守估算，超总上限会明确提示，非服务商计费值。</p>
      </section><section className="config-card"><h4>记忆与主动陪伴</h4><p className="hint">这些开关保存后生效，自动整理会额外调用模型。</p>
      <label className="toggle-row"><span>自动整理长对话摘要<small>默认开启，可自行关闭；回复完成且上下文接近预算时额外调用一次当前模型。原文保留。</small></span><input id="model-auto-summary" type="checkbox" checked={autoSummary} onChange={event => setAutoSummary(event.target.checked)} /></label>
      <label className="toggle-row"><span>自动积累长期对话记忆<small>默认开启，可自行关闭；普通对话约45秒合并整理，明确纠正优先安排；复核已有资料，保留原文与出处。整理会额外调用当前模型。</small></span><input id="model-auto-long-memory" type="checkbox" checked={autoLongMemory} onChange={event => setAutoLongMemory(event.target.checked)} /></label>
      <label className="toggle-row"><span>聊天使用已确认及自动记忆<small>全部当前作用域资料随请求发送；历史/撤销条目标注状态，不当作当前事实</small></span><input type="checkbox" checked={memoryEnabled} onChange={event => setMemoryEnabled(event.target.checked)} /></label>
      <label className="toggle-row"><span>用模型生成主动关心<small>有过对话后才调用，共用桌宠频率与安静规则</small></span><input type="checkbox" checked={proactive} onChange={event => setProactive(event.target.checked)} /></label>
      </section><div className="config-save-area">
      <button onClick={() => void save()} disabled={!model.trim() || !baseUrl.trim()}>保存连接设置</button>
      <p className="hint">密钥用系统加密后保存在本机，不回显、不放入角色包。修改 API 地址时旧密钥会清除，请重新填写。保存设置本身不调用模型；发送消息、手动整理或已开启的自动整理会产生调用。</p>
      </div>
    </div>}
    {(error || state.error) && <p className="alert chat-alert" role="alert">{error || state.error}</p>}
    </div>
  </section>;
}
