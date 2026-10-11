import { app, BrowserWindow, Menu, Tray, nativeImage, protocol, screen, session, ipcMain, dialog, powerMonitor, safeStorage } from 'electron';
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { z } from 'zod';
import { runtimePaths, safeResource } from './platform/paths';
import { stableId, loadPack } from './characters/PackLoader';
import { CharacterService } from './characters/CharacterService';
import { CompanionDirector } from './companion/CompanionDirector';
import { CompanionLedger } from './companion/CompanionLedger';
import { FullscreenObserver } from './platform/FullscreenObserver';
import { StartupProbe } from './storage/startupProbe';
import { PreferenceStore, pointSchema, patchSchema } from './settings/preferences';
import { channels } from '../shared/contracts';
import type { DesktopState, Point, Bounds } from '../shared/contracts';
import { petSize, bottomRight, clampBounds, bubbleBounds } from '../shared/geometry';
import { ModelConfig, modelInputSchema } from './chat/ModelConfig';
import { ChatStore } from './chat/ChatStore';
import { ChatService } from './chat/ChatService';
import { chatSendInputSchema } from '../shared/chatInput';
import { DataAdminService } from './chat/DataAdminService';
import { ImageDrafts } from './chat/ImageDrafts';
import { ChatDiagnostics } from './chat/ChatDiagnostics';
import { dataExportSchema } from '../shared/dataAdmin';

protocol.registerSchemesAsPrivileged([
  { scheme: 'pet-app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'pet-image', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'pet-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);
const paths = runtimePaths(app.getAppPath(), app.isPackaged, process.resourcesPath, app.getPath('userData'));
app.setPath('userData', paths.dataRoot);
if (process.platform === 'win32') app.setAppUserModelId('app.morrow.desktop');
const single = app.requestSingleInstanceLock(); if (!single) app.quit();
let pet: BrowserWindow | undefined, panel: BrowserWindow | undefined, bubble: BrowserWindow | undefined, admin: BrowserWindow | undefined;
let tray: Tray | undefined, probe: StartupProbe | undefined, prefs: PreferenceStore;
let characters: CharacterService, director: CompanionDirector, observer: FullscreenObserver | undefined;
let ledger: CompanionLedger, mouseIgnored = false, hover = false, quitting = false, bubbleReady = false;
const imageDrafts = new ImageDrafts();
let chat: ChatService | undefined;
let dataAdmin: DataAdminService | undefined;
let drag: { origin: Bounds; cursor: Point } | undefined;
let clampTimer: ReturnType<typeof setTimeout> | undefined, environmentTimer: ReturnType<typeof setInterval> | undefined;
const devURL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const pageURL = devURL ?? 'pet-app://ui/index.html';
const webPreferences = () => ({ preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false });

function state(): DesktopState {
  return { character: characters.current.view, characters: characters.list(), preferences: { ...prefs.value },
    expression: director.state.expression, companion: { ...director.state }, window: pet!.getBounds(), mouseIgnored,
    database: probe!.result, version: app.getVersion(), warnings: [prefs.warning, ledger.warning, ...characters.current.view.warnings].filter((v): v is string => Boolean(v)) };
}
function positionBubble() {
  if (pet && bubble && !bubble.isDestroyed()) bubble.setBounds(bubbleBounds(pet.getBounds(), screen.getDisplayMatching(pet.getBounds()).workArea));
}
function syncBubble() {
  if (!bubble || bubble.isDestroyed()) return;
  if (director.state.bubble && director.state.visible && director.state.quietReason !== 'locked') {
    positionBubble(); if (bubbleReady && !bubble.isVisible()) bubble.showInactive();
  } else bubble.hide();
}
function broadcast() {
  if (!pet || pet.isDestroyed() || !director) return;
  const value = state();
  for (const win of [pet, panel, bubble, admin]) if (win && !win.isDestroyed()) win.webContents.send(channels.changed, value);
  syncBubble();
}
function broadcastChat() { if (chat) for (const win of [panel, admin]) if (win && !win.isDestroyed()) win.webContents.send(channels.chatChanged, chat.state()); }
function syncInteraction() {
  const ignore = !drag && (prefs.value.interaction === 'passthrough' || prefs.value.interaction === 'auto' && !hover);
  if (ignore !== mouseIgnored && pet) { pet.setIgnoreMouseEvents(ignore, { forward: true }); mouseIgnored = ignore; broadcast(); }
}
function persistPosition() {
  const { x, y } = pet!.getBounds(); prefs.value.position = { x, y }; prefs.save();
}
function resizeAndClamp(reset = false) {
  const area = reset ? screen.getPrimaryDisplay().workArea : screen.getDisplayMatching(pet!.getBounds()).workArea;
  const current = pet!.getBounds(), view = characters.current.view;
  const size = petSize(prefs.value.height, view.canvas.width / view.canvas.height, area);
  pet!.setBounds(reset ? bottomRight(size, area) : clampBounds({ ...size,
    x: current.x + Math.round((current.width - size.width) / 2), y: current.y + current.height - size.height }, area));
  persistPosition(); positionBubble(); broadcast();
}
function updatePreferences(raw: unknown) {
  const patch = patchSchema.parse(raw); prefs.value = { ...prefs.value, ...patch };
  pet!.setAlwaysOnTop(prefs.value.alwaysOnTop); bubble?.setAlwaysOnTop(prefs.value.alwaysOnTop);
  if (patch.height !== undefined) resizeAndClamp();
  director.preferencesChanged(); if (!prefs.value.proactive || director.state.quietReason) chat?.cancel(true); syncInteraction(); prefs.save(); refreshTray(); broadcast(); return state();
}
function showPet() { director.visibility(true); pet!.showInactive(); syncInteraction(); }
function hidePet() { chat?.cancel(); director.visibility(false); closeDrag(false); pet!.hide(); refreshTray(); }
function recover() {
  closeDrag(false); hover = false; director.stop();
  updatePreferences({ interaction: 'auto' }); resizeAndClamp(true); showPet(); refreshTray();
}
function closeDrag(feedback = true) {
  if (!drag) return;
  drag = undefined; feedback ? director.dragEnd() : director.dragCancel();
  syncInteraction(); persistPosition(); positionBubble(); broadcast();
}
function menuItems(): MenuItemConstructorOptions[] {
  return [
    { label: `显示${characters.current.view.shortName}`, click: showPet },
    ...Object.entries(characters.current.view.behavior.commands).map(([id, command]) => ({ label: command.label, click: () => { showPet(); director.interact(id); } })),
    { label: '停止动作与气泡', click: () => director.stop() },
    { label: '和角色聊天', click: () => openPanel('chat') },
    { label: '数据管理后台', click: () => openAdmin() },
    { label: '桌宠设置', click: () => openPanel() },
    { type: 'separator' },
    { label: '安静 30 分钟', click: () => updatePreferences({ quietUntil: Date.now() + 30 * 60000 }) },
    { label: '恢复主动陪伴', click: () => updatePreferences({ quietUntil: 0, proactive: true }) },
    { label: '置顶显示', type: 'checkbox', checked: prefs.value.alwaysOnTop, click: item => updatePreferences({ alwaysOnTop: item.checked }) },
    { label: '鼠标完全穿透', type: 'checkbox', checked: prefs.value.interaction === 'passthrough', click: item => updatePreferences({ interaction: item.checked ? 'passthrough' : 'auto' }) },
    { label: '收起桌宠', click: hidePet }, { label: '恢复位置与交互', click: recover },
    { type: 'separator' }, { label: '退出桌宠', click: () => app.quit() }
  ];
}
function refreshTray() { tray?.setContextMenu(Menu.buildFromTemplate(menuItems())); }
function configureMacMenu() {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Morrow', submenu: [
      { label: '和角色聊天', click: () => openPanel('chat') },
      { label: '桌宠设置…', accelerator: 'Cmd+,', click: () => openPanel() },
      { label: '数据管理后台', click: () => openAdmin() },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' }
    ] },
    { role: 'editMenu' }, { role: 'windowMenu' }
  ]));
}
function isPage(url: string) {
  try { const actual = new URL(url), expected = new URL(pageURL); return actual.protocol === expected.protocol && actual.host === expected.host && !actual.username && !actual.password; }
  catch { return false; }
}
function protectWindow(win: BrowserWindow) {
  win.on('page-title-updated', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault()); win.webContents.on('will-attach-webview', event => event.preventDefault());
}
function syncPanelEnvironment() { director.setEnvironment({ settings: Boolean(panel?.isVisible() || admin?.isVisible()) }); }
function openAdmin(section: string = 'overview') {
  if (admin && !admin.isDestroyed()) { admin.webContents.send(channels.adminNavigate, section); admin.show(); admin.focus(); return; }
  const area = screen.getPrimaryDisplay().workArea, url = new URL(pageURL); url.searchParams.set('view', 'admin'); url.searchParams.set('section', section);
  admin = new BrowserWindow({ title: 'Morrow · 数据管理后台', width: Math.min(1280, area.width), height: Math.min(880, area.height), minWidth: 760, minHeight: 600, show: false, backgroundColor: '#fcfdfb', autoHideMenuBar: true, webPreferences: webPreferences() });
  protectWindow(admin); admin.once('ready-to-show', () => admin?.show());
  admin.on('show', syncPanelEnvironment); admin.on('hide', syncPanelEnvironment); admin.on('closed', () => { admin = undefined; syncPanelEnvironment(); });
  void admin.loadURL(url.href);
}
function openPanel(tab = 'company') {
  const url = new URL(pageURL); url.searchParams.set('view', 'settings'); url.searchParams.set('tab', tab);
  if (panel && !panel.isDestroyed()) { if (tab === 'chat') void panel.loadURL(url.href); panel.show(); panel.focus(); return; }
  chat?.cancel(true);
  director.setEnvironment({ settings: true });
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workAreaSize;
  panel = new BrowserWindow({ title: 'Morrow · 暮伴', width: Math.min(1040, area.width), height: Math.min(820, area.height),
    minWidth: 440, minHeight: 600, show: false, backgroundColor: '#f7f8f6', autoHideMenuBar: true, webPreferences: webPreferences() });
  protectWindow(panel); panel.once('ready-to-show', () => panel?.show());
  panel.on('show', syncPanelEnvironment);
  panel.on('hide', () => { chat?.cancel(); syncPanelEnvironment(); });
  panel.on('closed', () => { chat?.cancel(); panel = undefined; syncPanelEnvironment(); });
  void panel.loadURL(url.href);
}
function authorize(event: IpcMainInvokeEvent, kind?: 'pet' | 'bubble' | 'panel' | 'admin' | 'data') {
  const win = BrowserWindow.fromWebContents(event.sender), frame = event.senderFrame;
  if (!win || !frame || frame !== event.sender.mainFrame || !isPage(frame.url) ||
    (kind === 'pet' ? win !== pet : kind === 'bubble' ? win !== bubble : kind === 'panel' ? win !== panel : kind === 'admin' ? win !== admin : kind === 'data' ? ![panel, admin].includes(win) : ![pet, panel, bubble, admin].includes(win))) throw new Error('调用来源不受支持');
}
function handle(channel: string, fn: (value: unknown) => unknown, kind?: 'pet' | 'bubble' | 'panel' | 'admin' | 'data') {
  ipcMain.handle(channel, async (event, value: unknown) => {
    try { authorize(event, kind); return { ok: true, value: await fn(value) }; }
    catch (error) { return { ok: false, error: { code: error instanceof z.ZodError ? 'INVALID_INPUT' : 'ACTION_FAILED',
      message: error instanceof z.ZodError ? '设置参数无效' : error instanceof Error ? error.message : '操作未完成' } }; }
  });
}
function registerIPC() {
  handle(channels.openDataAdmin, raw => { openAdmin(z.enum(['overview', 'sessions', 'messages', 'inputs', 'memories', 'long-memories', 'summaries']).default('overview').parse(raw)); return null; });
  handle(channels.dataOverview, () => dataAdmin!.overview(), 'data');
  handle(channels.dataQuery, raw => dataAdmin!.query(raw as Parameters<DataAdminService['query']>[0]), 'data');
  handle(channels.dataMutate, raw => dataAdmin!.mutate(raw as Parameters<DataAdminService['mutate']>[0]), 'data');
  handle(channels.dataExport, async raw => {
    const exported = dataAdmin!.export(dataExportSchema.parse(raw));
    const selected = await dialog.showSaveDialog(admin && !admin.isDestroyed() ? admin : panel!, { title: '导出筛选数据', defaultPath: `桌宠-${exported.scope.section}-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON 数据', extensions: ['json'] }] });
    if (selected.canceled || !selected.filePath) return { cancelled: true };
    writeFileSync(selected.filePath, JSON.stringify(exported, null, 2), 'utf8');
    return { cancelled: false, path: selected.filePath, count: exported.count };
  }, 'data');
  const target = z.object({ characterId: stableId, epoch: z.number().int().positive(), sessionId: z.string().uuid(), historyRevision: z.number().int().nonnegative() }).strict();
  const messageTarget = target.extend({ messageId: z.string().uuid() });
  handle(channels.retractMessage, raw => chat!.retract(messageTarget.parse(raw)), 'panel');
  handle(channels.editMessage, raw => chat!.edit(messageTarget.extend({ text: z.string().max(6000) }).parse(raw)), 'panel');
  handle(channels.regenerateReply, raw => { director.userActivity(); return chat!.regenerate(messageTarget.parse(raw)); }, 'panel');
  handle(channels.getChat, () => chat!.state(), 'data');
  handle(channels.configureModel, raw => chat!.configure(modelInputSchema.parse(raw)), 'panel');
  handle(channels.pickChatImages, async raw => {
    const input = target.extend({ remaining: z.number().int().min(1).max(4) }).parse(raw); chat!.requireImageTarget(input);
    const selected = await dialog.showOpenDialog(panel!, { title: '添加聊天图片', properties: ['openFile', 'multiSelections'], filters: [{ name: 'PNG / JPEG 图片', extensions: ['png', 'jpg', 'jpeg'] }] });
    chat!.requireImageTarget(input); if (selected.canceled) return [];
    if (selected.filePaths.length > input.remaining) throw new Error(`本条还可添加 ${input.remaining} 张图片`);
    return imageDrafts.stage(input, selected.filePaths);
  }, 'panel');
  handle(channels.discardChatImages, raw => { imageDrafts.discard(z.object({ ids: z.array(z.string().uuid()).max(12) }).strict().parse(raw).ids); return null; }, 'panel');
  handle(channels.sendChat, raw => { const input = chatSendInputSchema.parse(raw); director.userActivity(); const images = imageDrafts.resolve(input, input.imageIds ?? []); const value = chat!.send(input, images); imageDrafts.discard(input.imageIds ?? []); return value; }, 'panel');
  handle(channels.cancelChat, raw => chat!.cancelFor(target.parse(raw)), 'panel');
  handle(channels.newConversation, raw => chat!.newConversation(target.parse(raw)), 'panel');
  handle(channels.selectConversation, raw => chat!.selectConversation(target.extend({ selectedSessionId: z.string().uuid() }).parse(raw)), 'data');
  handle(channels.clearChatHistory, raw => chat!.clearHistory(target.parse(raw)), 'panel');
  handle(channels.addMemory, raw => chat!.remember(target.extend({ text: z.string().min(1).refine(t => Boolean(t.trim())), sourceMessageId: z.string().uuid().optional(), scope: z.enum(['real', 'fiction', 'unknown']).optional() }).parse(raw)), 'panel');
  handle(channels.deleteMemory, raw => chat!.forget(target.extend({ id: z.string().uuid() }).parse(raw)), 'panel');
  handle(channels.chatHistory, raw => chat!.history(target.extend({ kind: z.enum(['messages', 'sessions']), beforeId: z.string().uuid() }).parse(raw)), 'panel');
  handle(channels.summarizeChat, raw => chat!.summarize(target.parse(raw)), 'panel');
  handle(channels.extractLongMemory, raw => chat!.extractLongMemory(target.parse(raw)), 'panel');
  handle(channels.discardSummary, raw => chat!.discardSummary(target.parse(raw)), 'panel');
  handle(channels.openChat, () => { openPanel('chat'); return null; });
  handle(channels.getState, () => state()); handle(channels.setPreferences, updatePreferences);
  handle(channels.setExpression, raw => { director.setExpression(z.string().max(64).parse(raw)); return state(); });
  handle(channels.interact, raw => { chat?.cancel(true); director.interact(stableId.parse(raw)); return null; });
  handle(channels.playAction, raw => { director.playAction(z.string().max(64).parse(raw)); return null; });
  handle(channels.stopAction, () => { director.stop(); return null; });
  handle(channels.dismissBubble, () => { director.dismiss(); return null; });
  handle(channels.stageReady, raw => { director.stageReady(z.number().int().min(1).parse(raw)); return null; }, 'pet');
  handle(channels.animationFinished, raw => { const value = z.object({ epoch: z.number().int().min(1), id: z.number().int().min(1) }).strict().parse(raw); director.animationFinished(value.epoch, value.id); return null; }, 'pet');
  handle(channels.prepareCharacter, raw => characters.prepare(z.string().max(64).parse(raw)));
  handle(channels.commitCharacter, raw => {
    const token = z.string().uuid().parse(raw); characters.validatePrepared(token); closeDrag(false); hover = false;
    const pack = characters.commit(token);
    chat?.switched(); director.setPack(pack, characters.epoch); prefs.value.selectedCharacterId = pack.view.id; prefs.save();
    pet!.setTitle(`${pack.view.shortName} · Morrow`); panel?.setTitle(`${pack.view.shortName} · 桌宠设置`);
    tray?.setToolTip(`${pack.view.shortName} · Morrow`); resizeAndClamp(); syncInteraction(); refreshTray(); broadcast(); return state();
  });
  handle(channels.setHover, raw => { hover = z.boolean().parse(raw); director.hover(hover); syncInteraction(); return null; }, 'pet');
  handle(channels.setBubbleHover, raw => { const inside = z.boolean().parse(raw); bubble?.setIgnoreMouseEvents(!inside, { forward: true }); director.bubbleHover(inside); return null; }, 'bubble');
  handle(channels.dragStart, raw => {
    if (prefs.value.interaction === 'passthrough') throw new Error('请先从托盘恢复交互');
    chat?.cancel(true); drag = { cursor: pointSchema.parse(raw), origin: pet!.getBounds() }; director.dragStart(); syncInteraction(); return null;
  }, 'pet');
  handle(channels.dragMove, raw => {
    const cursor = pointSchema.parse(raw); if (!drag) return null;
    const target = { ...drag.origin, x: drag.origin.x + cursor.x - drag.cursor.x, y: drag.origin.y + cursor.y - drag.cursor.y };
    pet!.setBounds(clampBounds(target, screen.getDisplayMatching(target).workArea)); positionBubble(); return null;
  }, 'pet');
  handle(channels.dragEnd, () => { closeDrag(); return null; }, 'pet');
  handle(channels.dragCancel, () => { closeDrag(false); return null; }, 'pet');
  handle(channels.openSettings, () => { openPanel(); return null; });
  handle(channels.openMenu, () => {
    director.setEnvironment({ settings: true });
    Menu.buildFromTemplate(menuItems()).popup({ window: pet, callback: syncPanelEnvironment }); return null;
  }, 'pet');
  handle(channels.hide, () => { hidePet(); return null; }); handle(channels.resetPosition, () => { recover(); return state(); });
  handle(channels.quit, () => { setTimeout(() => app.quit(), 0); return null; });
}
function registerProtocols() {
  protocol.handle('pet-image', request => {
    try { const url = new URL(request.url), id = z.string().uuid().parse(url.pathname.slice(1));
      if (request.method !== 'GET' || url.hostname !== 'image' || url.search || url.hash || url.username || url.password) return new Response('Not found', { status: 404 });
      const image = imageDrafts.read(id) ?? chat?.store.image(id); if (!image) return new Response('Not found', { status: 404 });
      return new Response(new Uint8Array(image.data), { headers: { 'Content-Type': image.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  protocol.handle('pet-asset', request => {
    const file = characters.resource(request.url); if (request.method !== 'GET' || !file) return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(readFileSync(file)), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' } });
  });
  protocol.handle('pet-app', request => {
    try {
      const url = new URL(request.url); if (request.method !== 'GET' || url.host !== 'ui') return new Response('Not found', { status: 404 });
      const file = safeResource(paths.renderer, decodeURIComponent(url.pathname).replace(/^\//, ''));
      const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
      return new Response(new Uint8Array(readFileSync(file)), { headers: { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' pet-asset: pet-image:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'" } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
}
function inspectImage(path: string) {
  const image = nativeImage.createFromPath(path); if (image.isEmpty()) throw new Error('PNG 无法解码');
  const size = image.getSize(), width = 96, height = Math.round(width * size.height / size.width);
  const rgba = image.resize({ width, height, quality: 'good' }).toBitmap();
  const bits = Buffer.alloc(Math.ceil(width * height / 8));
  for (let i = 0; i < width * height; i++) if (rgba[i * 4 + 3] >= 32) bits[i >> 3] |= 1 << (i & 7);
  return { ...size, mask: { width, height, bits: bits.toString('base64') } };
}
async function start() {
  prefs = new PreferenceStore(paths.dataRoot); characters = new CharacterService(paths.characters, inspectImage, prefs.value.selectedCharacterId);
  ledger = new CompanionLedger(paths.dataRoot); director = new CompanionDirector(characters.current, () => prefs.value, ledger, broadcast, Date.now, Math.random, () => chat?.proactive() ?? false);
  const modelConfig = new ModelConfig(paths.dataRoot, {
    encrypt: value => { if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥加密不可用，请使用无密钥本地模型或修复系统加密'); return safeStorage.encryptString(value).toString('base64'); },
    decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64'))
  });
  chat = new ChatService(new ChatStore(paths.dataRoot), modelConfig, () => ({ pack: characters.current, epoch: characters.epoch }), broadcastChat,
    (reply, proactive) => director.speak(reply, proactive), () => director.canDeliverAutomatic(), undefined, undefined, () => director.dismiss(), value => new ChatDiagnostics(paths.dataRoot).record(value), id => { try { return loadPack(paths.characters, id); } catch { return undefined; } });
  probe = new StartupProbe(paths.dataRoot);
  dataAdmin = new DataAdminService(chat.store, modelConfig, () => ({ dataRoot: paths.dataRoot, databaseSizeBytes: ['chat.sqlite', 'chat.sqlite-wal', 'desktop.sqlite', 'desktop.sqlite-wal'].reduce((size, name) => { const file = join(paths.dataRoot, name); return size + (existsSync(file) ? statSync(file).size : 0); }, 0), launches: probe!.result.currentLaunches, characters: characters.list() }), () => { chat!.cancel(); }, () => chat!.dataChanged());
  registerProtocols();
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false)); session.defaultSession.setPermissionCheckHandler(() => false);
  const view = characters.current.view, area = screen.getPrimaryDisplay().workArea;
  const size = petSize(prefs.value.height, view.canvas.width / view.canvas.height, area);
  const bounds = prefs.value.position ? clampBounds({ ...size, ...prefs.value.position }, screen.getDisplayNearestPoint(prefs.value.position).workArea) : bottomRight(size, area);
  pet = new BrowserWindow({ ...bounds, title: `${view.shortName} · Morrow`, transparent: true, frame: false,
    focusable: false,
    backgroundColor: '#00000000', resizable: false, maximizable: false, minimizable: false,
    alwaysOnTop: prefs.value.alwaysOnTop, skipTaskbar: true, show: false, webPreferences: webPreferences() });
  bubble = new BrowserWindow({ ...bubbleBounds(bounds, area), title: '桌宠 · 轻声回应', transparent: true, frame: false,
    backgroundColor: '#00000000', resizable: false, maximizable: false, minimizable: false, focusable: false,
    alwaysOnTop: prefs.value.alwaysOnTop, skipTaskbar: true, show: false, webPreferences: webPreferences() });
  protectWindow(pet); protectWindow(bubble); registerIPC();
  if (process.platform === 'darwin') {
    // Follow regular desktop Spaces while keeping fullscreen work unobstructed.
    pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    bubble.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  }
  pet.on('close', event => { if (!quitting) { event.preventDefault(); hidePet(); } });
  pet.on('blur', () => { if (drag) closeDrag(false); }); pet.on('move', positionBubble);
  pet.webContents.on('render-process-gone', () => { closeDrag(false); director.stop(); hover = false; syncInteraction(); });
  const icon = process.platform === 'darwin' ? nativeImage.createFromPath(join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'), 'icons/trayTemplate.png')) :
    nativeImage.createFromPath(characters.current.assets.get(view.expressions[view.defaultExpression])!).resize({ width: 32, height: 32 });
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon); tray.setToolTip(`${view.shortName} · Morrow`); refreshTray(); tray.on('double-click', () => openPanel());
  configureMacMenu();
  screen.on('display-removed', () => resizeAndClamp()); screen.on('display-metrics-changed', () => {
    clearTimeout(clampTimer); clampTimer = setTimeout(() => resizeAndClamp(), 150);
  });
  const pauseForLock = () => { chat?.cancel(); closeDrag(false); hover = false; director.hover(false); syncInteraction(); director.setEnvironment({ locked: true }); };
  powerMonitor.on('lock-screen', pauseForLock);
  powerMonitor.on('unlock-screen', () => director.setEnvironment({ locked: false }));
  powerMonitor.on('suspend', pauseForLock);
  powerMonitor.on('resume', () => director.setEnvironment({ locked: false }));
  await pet.loadURL(pageURL);
  const bubbleURL = new URL(pageURL); bubbleURL.searchParams.set('view', 'bubble');
  await bubble.loadURL(bubbleURL.href); bubbleReady = true;
  showPet(); director.start();
  const helper = app.isPackaged ? join(process.resourcesPath, 'helpers/foreground-observer.exe') : join(app.getAppPath(), 'native/foreground-observer.exe');
  observer = new FullscreenObserver(helper, value => { director.setEnvironment({ fullscreen: value }); if (value) chat?.cancel(true); }, value => director.setObserver(value));
  environmentTimer = setInterval(() => director.setEnvironment({ idleSeconds: powerMonitor.getSystemIdleTime() }), 1000);
  writeFileSync(join(paths.dataRoot, 'startup-status.json'), JSON.stringify({ version: app.getVersion(), packaged: app.isPackaged,
    database: probe.result, startedAt: new Date().toISOString() }, null, 2), 'utf8');
}
app.on('second-instance', () => { if (pet && !pet.isDestroyed()) recover(); });
app.on('activate', () => {
  if (process.platform === 'darwin' && pet && !pet.isDestroyed()) { showPet(); openPanel('chat'); }
});
app.on('before-quit', () => {
  quitting = true; imageDrafts.clear(); clearTimeout(clampTimer); clearInterval(environmentTimer); const closingChat = chat; chat = undefined; closingChat?.dispose(); director?.dispose(); observer?.dispose(); characters?.invalidate();
  try { if (pet && !pet.isDestroyed() && prefs) persistPosition(); } finally { probe?.close(); tray?.destroy(); }
});
app.on('window-all-closed', () => { if (!tray) app.quit(); });
if (single) void app.whenReady().then(start).catch(error => {
  const message = error instanceof Error ? error.message : String(error); writeFileSync(join(paths.dataRoot, 'startup-error.txt'), message, 'utf8');
  dialog.showErrorBox('桌宠启动失败', `请保留运行数据并检查素材或依赖。\n${message}`); app.quit();
});
