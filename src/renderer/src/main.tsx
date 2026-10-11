import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ApiResult, DesktopState, Point, PreferencePatch } from '../../shared/contracts';
import { dragExceeded } from '../../shared/geometry';
import { FramePlayer, preloadCharacter } from './FramePlayer';
import './style.css';
import { ChatPanel } from './ChatPanel';
import './settings-workspace.css';
const AdminApp = lazy(() => import('./admin/AdminApp'));

function useDesktop() {
  const [state, setState] = useState<DesktopState>(), [error, setError] = useState('');
  const alive = useRef(true);
  function result<T>(reply: ApiResult<T>): T | undefined {
    if (!alive.current) return;
    if (!reply.ok) { setError(reply.error.message); return; }
    setError(''); return reply.value;
  }
  useEffect(() => {
    alive.current = true; const unsubscribe = window.petAPI.onState(setState);
    void window.petAPI.getState().then(reply => { const value = result(reply); if (value) setState(value); });
    return () => { alive.current = false; unsubscribe(); };
  }, []);
  return { state, setState, error, setError, result };
}
function CharacterStage({ state, setError }: { state: DesktopState; setError: (value: string) => void }) {
  const first = useRef<HTMLImageElement>(null), second = useRef<HTMLImageElement>(null), motion = useRef<HTMLDivElement>(null);
  const eyes = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const rigCanvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLElement>(null), player = useRef<FramePlayer>(null);
  const gesture = useRef<{ start: Point; pointerId: number; dragging: boolean; ready?: Promise<unknown> }>(null);
  const draggingFrame = useRef<number>(undefined), latestPoint = useRef<Point>(undefined), lastHover = useRef(false);
  const [ready, setReady] = useState(false), [reduced, setReduced] = useState(matchMedia('(prefers-reduced-motion: reduce)').matches);
  const paused = !state.companion.visible || state.companion.dragging || state.companion.quietReason === 'locked' || state.companion.quietReason === 'settings' && !state.companion.presentation;
  useEffect(() => {
    if (state.companion.visible && state.companion.quietReason !== 'locked') return;
    const active = gesture.current; gesture.current = null;
    if (draggingFrame.current) { cancelAnimationFrame(draggingFrame.current); draggingFrame.current = undefined; }
    if (active && stage.current?.hasPointerCapture(active.pointerId)) stage.current.releasePointerCapture(active.pointerId);
  }, [state.companion.visible, state.companion.quietReason]);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)'), changed = () => setReduced(media.matches);
    media.addEventListener('change', changed); return () => media.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    let active = true;
    void preloadCharacter(state.character).then(() => {
      if (!active) return;
      player.current = new FramePlayer(first.current!, second.current!, eyes.current!, canvas.current!, rigCanvas.current!, motion.current!, state.character);
      setReady(true); setError(''); void window.petAPI.stageReady(state.companion.epoch);
    }).catch(() => setError('素材加载失败，请从托盘打开设置并恢复角色。'));
    return () => { active = false; player.current?.dispose(); if (draggingFrame.current) cancelAnimationFrame(draggingFrame.current); void window.petAPI.setHover(false); };
  }, []);
  useEffect(() => {
    if (!ready || !player.current) return;
    const presentation = state.companion.presentation;
    const dynamic = !reduced && !paused && state.preferences.animations !== 'off';
    void player.current.run(async signal => {
      const original = presentation && state.character.actions[presentation.action];
      const action = original && (original.kind === 'mesh' || original.kind === 'rig') ? { ...original, durationMs: presentation!.durationMs } : original;
      if (action && dynamic && (state.preferences.animations === 'full' || state.character.catalog.actions[presentation!.action].allowInSubtle)) {
        if (action.kind === 'frames') await player.current!.frames(action, signal, state.expression);
        else { await player.current!.show(state.expression, state.character.expressionTransitionMs, signal); if (!signal.aborted) { if (action.kind === 'mesh') await player.current!.mesh(action, signal, state.companion.bubble?.expiresAt); else if (action.kind === 'rig') await player.current!.rig(action, signal, state.companion.bubble?.expiresAt); else await player.current!.transform(action, signal); } }
      }
      if (signal.aborted) return;
      await player.current!.show(state.expression, dynamic ? state.character.expressionTransitionMs : 0, signal);
      if (!signal.aborted && presentation) await window.petAPI.animationFinished({ epoch: presentation.epoch, id: presentation.id });
    }).catch(error => { if (error.name !== 'AbortError') { setError('动作暂时没有播放成功，已恢复待机。'); void window.petAPI.stopAction(); } });
    return () => player.current?.cancel();
  }, [ready, state.companion.presentation?.id, state.expression, state.preferences.animations, paused, reduced]);
  const notifyHover = (inside: boolean) => {
    if (inside === lastHover.current) return; lastHover.current = inside; void window.petAPI.setHover(inside);
  };
  const point = (event: React.PointerEvent): Point => ({ x: Math.round(event.screenX), y: Math.round(event.screenY) });
  const finish = async (event: React.PointerEvent) => {
    const active = gesture.current, target = event.currentTarget, id = event.pointerId, next = point(event), released = event.type === 'pointerup';
    gesture.current = null; if (draggingFrame.current) { cancelAnimationFrame(draggingFrame.current); draggingFrame.current = undefined; }
    if (!active) return; if (target.hasPointerCapture(id)) target.releasePointerCapture(id);
    if (active.dragging) { await active.ready; if (released) { await window.petAPI.dragMove(next); await window.petAPI.dragEnd(); } else await window.petAPI.dragCancel(); }
    else if (released) await window.petAPI.interact('click');
  };
  const idle = ready && !paused && !reduced && state.preferences.animations === 'full' && Boolean(state.character.behavior.idleAction) && (!state.companion.presentation || state.companion.presentation.action === state.character.behavior.ambient?.action);
  useEffect(() => { player.current?.setIdle(idle); return () => player.current?.setIdle(false); }, [idle, state.preferences.height]);
  return <main ref={stage} className="pet-stage" aria-label={state.character.name}
    onPointerMove={event => {
      const active = gesture.current;
      notifyHover(Boolean(active) || Boolean(player.current?.hit(event.clientX, event.clientY)));
      if (!active) return; const next = point(event);
      if (!active.dragging && dragExceeded(active.start, next)) { active.dragging = true; active.ready = window.petAPI.dragStart(active.start); }
      if (active.dragging) { latestPoint.current = next;
        if (!draggingFrame.current) draggingFrame.current = requestAnimationFrame(async () => {
          draggingFrame.current = undefined; await active.ready;
          if (gesture.current === active && latestPoint.current) await window.petAPI.dragMove(latestPoint.current);
        });
      }
    }}
    onPointerLeave={() => { if (!gesture.current) notifyHover(false); }}
    onPointerDown={event => {
      if (event.button !== 0 || !ready || state.preferences.interaction === 'passthrough' || !player.current?.hit(event.clientX, event.clientY)) return;
      event.preventDefault(); gesture.current = { start: point(event), pointerId: event.pointerId, dragging: false }; event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerUp={finish} onPointerCancel={finish}
    onContextMenu={event => { event.preventDefault(); if (player.current?.hit(event.clientX, event.clientY)) void window.petAPI.openMenu(); }}>
    <div ref={motion} className="character-motion" data-idle={idle} data-dragging={state.companion.dragging}>
      <img ref={first} className="portrait" alt={state.character.name} draggable={false} crossOrigin="anonymous" />
      <img ref={second} className="portrait" alt="" aria-hidden="true" draggable={false} crossOrigin="anonymous" />
      <img ref={eyes} className="portrait eye-overlay" alt="" aria-hidden="true" draggable={false} crossOrigin="anonymous" data-active="false" />
      <canvas ref={canvas} className="motion-canvas" aria-hidden="true" />
      <canvas ref={rigCanvas} className="rig-canvas" aria-hidden="true" />
    </div>
  </main>;
}
function BubbleView({ state }: { state: DesktopState }) {
  const last = useRef<boolean>(undefined);
  const hover = (inside: boolean) => { if (last.current !== inside) { last.current = inside; void window.petAPI.setBubbleHover(inside); } };
  const bubble = state.companion.bubble;
  const config = state.character.bubble, theme = config.theme;
  const style = { '--bubble-bg': theme.background, '--bubble-bg-end': theme.backgroundEnd, '--bubble-text': theme.text,
    '--bubble-accent': theme.accent, '--bubble-border': theme.border, '--bubble-button': theme.buttonBackground,
    '--bubble-radius': `${theme.radius}px` } as React.CSSProperties;
  return <main className="bubble-surface" onPointerMove={event => hover(Boolean((event.target as HTMLElement).closest('.speech-card')))} onPointerLeave={() => hover(false)}>
    {bubble && <section key={bubble.id} className="speech-card" role="status" style={style} onPointerEnter={() => hover(true)}>
      <div className="speech-heading"><span><i />{bubble.speaker}</span><button aria-label="关闭气泡" className="close-bubble" onClick={() => void window.petAPI.dismissBubble()}>×</button></div>
      <p className="speech-text">{bubble.text}</p>
      {bubble.choices && <div className="quick-actions">{config.choices.map(id => <button key={id} onClick={() => void window.petAPI.interact(id)}>{state.character.behavior.commands[id].label}</button>)}</div>}
      <div className="speech-foot"><span>{bubble.choices ? config.choiceHint : config.passiveHint}</span><button onClick={() => void window.petAPI.openChat()}>聊天</button><button onClick={() => void window.petAPI.openSettings()}>设置</button></div>
    </section>}
  </main>;
}
function Settings({ state, update, setState, result, error, setError }: { state: DesktopState; update: (patch: PreferencePatch) => Promise<void>;
  setState: (state: DesktopState) => void; result: <T>(reply: ApiResult<T>) => T | undefined; error: string; setError: (value: string) => void }) {
  const [tab, setTab] = useState(new URLSearchParams(location.search).get('tab') === 'chat' ? 'chat' : 'company'), [switching, setSwitching] = useState(false);
  const settingsScroll = useRef<HTMLDivElement>(null);
  useEffect(() => { settingsScroll.current?.scrollTo({ top: 0 }); }, [tab]);
  const quiet = state.preferences.quietUntil > Date.now(), p = state.preferences;
  const switchRole = async (id: string) => {
    setSwitching(true);
    try {
      const prepared = result(await window.petAPI.prepareCharacter(id)); if (!prepared) return;
      await preloadCharacter(prepared.character);
      const committed = result(await window.petAPI.commitCharacter(prepared.token)); if (committed) setState(committed);
    } catch { setError('新角色素材没有加载成功，已保留当前角色。'); } finally { setSwitching(false); }
  };
  const pages: Record<string, [string, string, string]> = {
    company: ['COMPANIONSHIP', '舒服的陪伴节奏', '安排问候与安静时间，让她自然地融入你的日常。'],
    appearance: ['APPEARANCE', '适合你的桌面', '调整大小、动作和鼠标交互，找到舒服的相处方式。'],
    character: ['CHARACTER STUDIO', '认识她的每一面', '角色、表情和动作来自同一个角色包，可以随时预览。']
  };
  return <main className={`panel ${tab === 'chat' ? 'chat-mode' : 'settings-mode'}`}>
    <div className="workspace-toolbar"><div className="workspace-brand"><span>m</span><strong>Morrow<small>暮伴</small></strong></div><nav className="tabs" aria-label="设置分类">{[['chat', '聊天'], ['company', '陪伴'], ['appearance', '外观'], ['character', '角色与动作']].map(([id, name]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{name}</button>)}</nav><span className="workspace-caption">A LITTLE COMPANY</span></div>
    {tab === 'chat' && <ChatPanel key={`${state.character.id}:${state.companion.epoch}`} desktop={state} onOpenSessions={() => { void window.petAPI.openDataAdmin('sessions'); }} />}
    {tab !== 'chat' && <div className="settings-workspace"><aside className="settings-companion">
      <div className="companion-preview"><span className="preview-label">YOUR COMPANION</span><img src={state.character.expressions[state.expression]} alt={state.character.shortName} /></div>
      <div className="companion-about"><span className="tag">{state.character.work}</span><h2>{state.character.name}</h2><p>{state.character.description}</p><span className="companion-status"><i />{quiet ? '暂时安静陪伴' : p.proactive ? '主动陪伴已开启' : '安静陪伴'}</span></div>
      <div className="companion-shortcuts"><button onClick={() => setTab('chat')}>和{state.character.shortName}聊一会儿 <span aria-hidden="true">↗</span></button><button onClick={() => void window.petAPI.openDataAdmin()}>数据管理后台 ↗</button></div>
      <p className="companion-help">点击人物有回应，拖动可以移动位置。<br />右键或托盘随时打开设置。</p><small className="settings-version">Morrow · {state.version}</small>
    </aside><div className="settings-content" ref={settingsScroll}><header className="settings-heading"><span className="eyebrow">{pages[tab][0]}</span><h1>{pages[tab][1]}</h1><p>{pages[tab][2]}</p><span className="settings-save-status">● 修改后自动保存</span></header>
    {tab === 'company' && <section className="controls settings-grid">
      <SettingsCard title="日常问候" description="给回应留一点空间" className="settings-span">
      <label className="toggle-row" htmlFor="proactive"><span>偶尔主动关心<small>低频搭话，不要求你回应</small></span><input id="proactive" type="checkbox" checked={p.proactive} onChange={event => void update({ proactive: event.target.checked })} /></label>
      <label className="toggle-row" htmlFor="greetings"><span>见面时打招呼<small>启动或离开较久后再次互动，不反复问候</small></span><input id="greetings" type="checkbox" checked={p.greetings} onChange={event => void update({ greetings: event.target.checked })} /></label>
      </SettingsCard><SettingsCard title="陪伴频率" description="慢一点，也很自在">
      <label className="field-label" htmlFor="frequency">主动关心的间隔</label><select id="frequency" value={p.proactiveMinutes} onChange={event => void update({ proactiveMinutes: Number(event.target.value) })}>{[45, 60, 90, 120].map(value => <option value={value} key={value}>至少 {value} 分钟</option>)}</select><p className="hint">主动文字每小时最多一次、每天最多六次。</p></SettingsCard>
      <SettingsCard title="气泡显示" description="留出刚好的阅读时间">
      <label className="field-label" htmlFor="bubble-duration">气泡停留时间</label><select id="bubble-duration" value={p.bubbleDurationMs} onChange={event => void update({ bubbleDurationMs: Number(event.target.value) })}>{[[2000,'短 · 2 秒'],[3000,'自然 · 3 秒'],[4500,'慢一点 · 4.5 秒'],[6000,'读完再走 · 6 秒']].map(([value,label]) => <option value={value} key={value}>{label}</option>)}</select>
      <p className="hint">气泡结束后，角色继续留在桌面陪伴。</p></SettingsCard>
      <SettingsCard title="专注时间" description="需要安静的时候，她会等你" className="settings-span">
      <div className="quiet-card"><div><strong>{quiet ? '安静时间已开启' : '需要专注一会儿？'}</strong><p>{quiet ? '到 ' + new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' }).format(p.quietUntil) + ' 为止暂停主动搭话。' : '她会留在旁边，仍然回应你的点击。'}</p></div><button onClick={() => void update({ quietUntil: quiet ? 0 : Date.now() + 30 * 60000 })}>{quiet ? '结束安静' : '安静 30 分钟'}</button></div>
      <p className="hint">全屏应用、锁屏和设置打开时暂停主动搭话。全屏安静：{state.companion.fullscreenObserver === 'ready' ? '已就绪' : state.companion.fullscreenObserver === 'starting' ? '正在准备' : '自动检测暂不可用，请使用安静按钮'}</p></SettingsCard>
    </section>}
    {tab === 'appearance' && <section className="controls settings-grid">
      <SettingsCard title="桌面展示" description="找到适合屏幕的比例" className="settings-span">
      <label className="size-label" htmlFor="height">角色大小 <strong>{p.height}px</strong></label><input id="height" type="range" min="240" max="680" step="20" value={p.height} onChange={event => void update({ height: Number(event.target.value) })} />
      <div className="size-scale"><span>小巧 · 240px</span><span>醒目 · 680px</span></div>
      <label className="toggle-row" htmlFor="top"><span>保持置顶<small>让她留在其他窗口前面</small></span><input id="top" type="checkbox" checked={p.alwaysOnTop} onChange={event => void update({ alwaysOnTop: event.target.checked })} /></label>
      </SettingsCard><SettingsCard title="动作表现" description="选择喜欢的活跃程度">
      <label className="field-label" htmlFor="animations">动作程度</label><select id="animations" value={p.animations} onChange={event => void update({ animations: event.target.value as typeof p.animations })}><option value="full">完整 · 挥手、角色动作与轻微待机</option><option value="subtle">轻量 · 眨眼与表情</option><option value="off">静态 · 只显示表情和文字</option></select><p className="hint">系统开启减少动态效果时保持静态。</p></SettingsCard>
      <SettingsCard title="鼠标与窗口" description="让桌面操作保持顺手">
      <label className="field-label" htmlFor="interaction">鼠标交互</label><select id="interaction" value={p.interaction} onChange={event => void update({ interaction: event.target.value as typeof p.interaction })}><option value="auto">自动 · 人物以外区域穿透</option><option value="interactive">始终可以点击</option><option value="passthrough">完全穿透 · 使用托盘恢复</option></select>
      <p className="hint">拖动和隐藏时暂停演出。完全穿透时，可从托盘恢复。</p></SettingsCard>
    </section>}
    {tab === 'character' && <section className="controls settings-grid">
      <SettingsCard title="角色库" description="加载属于她的设定与素材" className="settings-span">
      <label className="field-label" htmlFor="character">当前角色</label><select id="character" disabled={switching || state.characters.length < 2} value={state.character.id} onChange={event => void switchRole(event.target.value)}>{state.characters.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select>
      <p className="hint">{switching ? '正在准备新角色，当前角色会保留到素材加载成功。' : state.characters.length < 2 ? '目前只有这一位角色，切换入口已准备好。' : '角色的台词、表情与动作会一起切换。'}</p>
      </SettingsCard><SettingsCard title="表情画廊" description={`${Object.keys(state.character.expressions).length} 种表情 · 点击在桌面预览`} className="settings-span">
      <div className="expression-buttons">{Object.entries(state.character.expressions).map(([name, source]) => <button key={name} aria-pressed={state.expression === name} onClick={() => void window.petAPI.setExpression(name).then(reply => { const value = result(reply); if (value) setState(value); })}><img src={source} alt="" loading="lazy" /><span>{state.character.catalog.expressions[name].label}</span></button>)}</div>
      </SettingsCard><SettingsCard title="动作舞台" description={`${Object.keys(state.character.actions).length} 项动作 · 点击即刻演出`} className="settings-span">
      <div className="action-buttons">{Object.entries(state.character.actions).map(([name, action], index) => <button key={name} onClick={() => void window.petAPI.playAction(name).then(result)}><span className="action-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><span>{state.character.catalog.actions[name].label}<small>{action.kind === 'rig' ? '分层动作' : action.kind === 'mesh' ? '连续动作' : action.kind === 'frames' ? '姿态帧' : '轻微演出'}</small></span><span className="action-play" aria-hidden="true">▷</span></button>)}</div>
      <button className="secondary wide" onClick={() => void window.petAPI.stopAction().then(result)}>停止动作 · 恢复待机</button>
      </SettingsCard>
    </section>}
    {(error || state.warnings.length > 0) && <p className="alert" role="alert">{error || state.warnings.join(' ')}</p>}
    <div className="settings-bottom"><p>设置即时生效，下次启动也会保留。</p><div className="panel-actions"><button onClick={() => void window.petAPI.resetPosition().then(reply => { const value = result(reply); if (value) setState(value); })}>找回角色</button><button className="quiet" onClick={() => void window.petAPI.hide().then(result)}>收起</button><button className="quiet" onClick={() => void window.petAPI.quit()}>退出</button></div></div>
    </div></div>}
    {tab === 'chat' && (error || state.warnings.length > 0) && <p className="alert" role="alert">{error || state.warnings.join(' ')}</p>}
  </main>;
}
function SettingsCard({ title, description, className = '', children }: { title: string; description: string; className?: string; children: React.ReactNode }) {
  return <section className={`settings-card ${className}`}><div className="settings-card-heading"><h2>{title}</h2><p>{description}</p></div>{children}</section>;
}
function App() {
  const { state, setState, error, setError, result } = useDesktop();
  const view = new URLSearchParams(location.search).get('view');
  useEffect(() => { document.body.classList.toggle('settings-body', view === 'settings'); document.body.classList.toggle('admin-body', view === 'admin'); }, [view]);
  if (!state) return ['settings', 'admin'].includes(view ?? '') ? <div className="loading">{error || '正在准备桌宠…'}</div> : null;
  if (view === 'bubble') return <BubbleView state={state} />;
  const update = async (patch: PreferencePatch) => { const value = result(await window.petAPI.setPreferences(patch)); if (value) setState(value); };
  if (view === 'admin') return <Suspense fallback={<div className="loading">正在打开数据管理后台…</div>}><AdminApp desktop={state} /></Suspense>;
  if (view === 'settings') return <Settings {...{ state, update, setState, result, error, setError }} />;
  return <><CharacterStage key={state.companion.epoch} state={state} setError={setError} />{error && <div className="pet-error" role="alert">{error}</div>}</>;
}
createRoot(document.getElementById('root')!).render(<App />);
