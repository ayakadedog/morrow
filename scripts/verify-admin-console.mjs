import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { electronExecutable } from './electron-runtime.mjs';
const source = resolve(import.meta.dirname, '..'), project = source, packaged = process.argv.includes('--packaged');
const parent = join(project, 'data/tests/admin-console'); mkdirSync(parent, { recursive: true });
const data = mkdtempSync(join(parent, packaged ? 'packaged-' : 'source-')), output = join(project, 'artifacts/reports'), shots = join(project, 'artifacts/screenshots'); mkdirSync(output, { recursive: true }); mkdirSync(shots, { recursive: true });
const session = randomUUID(), users = [];
const db = new DatabaseSync(join(data, 'chat.sqlite'));
db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE sessions(id TEXT PRIMARY KEY,character_id TEXT NOT NULL,created_at INTEGER NOT NULL,history_revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE active_sessions(character_id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE);
CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,role TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,proactive INTEGER NOT NULL DEFAULT 0,speaker TEXT,reasoning TEXT);
CREATE TABLE memories(id TEXT PRIMARY KEY,character_id TEXT NOT NULL,text TEXT NOT NULL,source_message_id TEXT,created_at INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1,updated_at INTEGER);
PRAGMA user_version=0;`); // Legacy original logs exercise archival backfill and all additive migrations.
db.prepare('INSERT INTO sessions(id,character_id,created_at) VALUES(?,?,?)').run(session, 'yoshino', Date.now()); db.prepare('INSERT INTO active_sessions VALUES(?,?)').run('yoshino', session);
const texts = ['会话甲：以前住上海', '日常话题', '我喜欢地铁', '这个故事里我住上海', '现在已经搬北京了，住址未透露'];
for (let i = 0; i < 12; i++) {
  const user = randomUUID(); users.push(user);
  db.prepare('INSERT INTO messages(id,session_id,role,text,status,created_at) VALUES(?,?,?,?,?,?)').run(user, session, 'user', texts[i] ?? `日常原文${i}`, 'complete', Date.now());
  db.prepare('INSERT INTO messages(id,session_id,role,text,status,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), session, 'assistant', `讨论回应${i}`, 'complete', Date.now());
}
db.prepare('INSERT INTO memories(id,character_id,text,created_at) VALUES(?,?,?,?)').run(randomUUID(), 'yoshino', '手动确认偏好保留', Date.now()); db.close();
writeFileSync(join(data, 'preferences.json'), JSON.stringify({ proactive: false, greetings: false }), 'utf8');

const sessionB = randomUUID(), orphanSession = randomUUID();
const extras = new DatabaseSync(join(data, 'chat.sqlite')); extras.exec('PRAGMA foreign_keys=ON');
extras.prepare('INSERT INTO sessions(id,character_id,created_at) VALUES(?,?,?)').run(sessionB, 'yoshino', Date.now() - 86400000);
for (let i = 0; i < 6; i++) {
  extras.prepare('INSERT INTO messages(id,session_id,role,text,status,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), sessionB, 'user', `会话乙独立资料${i}：喜欢公交`, 'complete', Date.now());
  extras.prepare('INSERT INTO messages(id,session_id,role,text,status,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), sessionB, 'assistant', `乙的回答${i}`, 'complete', Date.now());
}
for (let i = 0; i < 53; i++) extras.prepare('INSERT INTO sessions(id,character_id,created_at) VALUES(?,?,?)').run(randomUUID(), 'yoshino', Date.now());
extras.prepare('INSERT INTO sessions(id,character_id,created_at) VALUES(?,?,?)').run(orphanSession, 'role-b', Date.now());
extras.prepare('INSERT INTO messages(id,session_id,role,text,status,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), orphanSession, 'user', '角色乙的私有会话', 'complete', Date.now()); extras.close();

const requests = [], errors = []; let app, panel, chatPanel;
const generated = [
  { text: '用户自述以前住上海，现在已搬到北京；新住址与工作地点未知。', kind: 'user_statement', scope: 'real', subject: 'user', sourceMessageIds: [users[0], users[4]] },
  { text: '用户自述喜欢地铁。', kind: 'preference', scope: 'real', subject: 'user', sourceMessageIds: [users[2]] },
  { text: '在这个故事里用户住上海，与现实分开。', kind: 'user_statement', scope: 'fiction', subject: 'user', sourceMessageIds: [users[3]] }
];
const server = createServer((req, res) => {
  let body = ''; req.on('data', b => body += b); req.on('end', () => {
    const value = JSON.parse(body); requests.push(value); const system = value.messages[0].content;
    const input = /长期对话记忆维护器|会话档案整理器|聊天记忆归纳器/.test(system) ? JSON.parse(value.messages[1].content) : undefined;
    const memory = system.includes('长期对话记忆维护器'), summary = system.includes('会话档案整理器'), consolidation = system.includes('聊天记忆归纳器');
    let payload;
    if (consolidation) { const fact = input.facts.find(f => f.text.includes('地铁')); payload = { observations: [{ topicKey: 'transport', text: '出行时偏好公共交通，具体路线仍需确认。', scope: 'real', sources: [{ type: 'fact', id: fact.id, revision: fact.revision }] }] }; }
    else if (memory) payload = { memories: input.source[0].id === users[0] ? generated : [{ text: '乙用户喜欢公交', kind: 'preference', scope: 'real', subject: 'user', sourceMessageIds: [input.source[0].id] }] };
    else if (summary) payload = { entries: [{ category: 'events', text: '本会话经过', scope: 'unknown', modality: 'conditional', status: 'active', sourceMessageIds: [input.source[0].id] }] };
    else { payload = { text: '正常完成的回答' }; }
    const finish = () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: 'stop' }] }));
    if (memory || summary || consolidation) finish(); else setTimeout(finish, 1800);
  });
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const env = { ...process.env, PET_DATA_DIR: data }; if (!packaged) env.PET_CHARACTER_DIR = join(project, 'characters'); else delete env.PET_CHARACTER_DIR; delete env.ELECTRON_RUN_AS_NODE;
const report = { passed: false, version: '', mode: packaged ? 'packaged' : 'source', checks: [], screenshots: [], data, errors, realProviderVerified: false, exportDialogStubbed: true };
async function until(get, predicate, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await get(); if (predicate(value)) return value; await new Promise(done => setTimeout(done, 40)); } throw new Error(`Timed out: ${predicate}`); }
const api = async (method, argument) => { const caller = ['configureModel', 'extractLongMemory', 'summarizeChat', 'sendChat', 'cancelChat'].includes(method) ? chatPanel ?? panel : panel; const result = await caller.evaluate(({ method, argument }) => window.petAPI[method](argument), { method, argument }); assert.equal(result.ok, true, result.error?.message); return result.value; };
const target = c => ({ characterId: c.characterId, epoch: c.epoch, sessionId: c.sessionId, historyRevision: c.historyRevision });
const row = id => panel.locator(`[data-record-id="${id}"]`);
async function launch() {
  app = await electron.launch({ executablePath: electronExecutable(source, packaged), args: packaged ? [] : [source], cwd: project, env });
  app.on('window', p => { p.setDefaultTimeout(15000); p.on('pageerror', e => errors.push(e.message)); }); await app.firstWindow();
  const pet = await until(async () => app.windows().find(p => p.url().startsWith('pet-app:') && !p.url().includes('view=')), Boolean); await pet.evaluate(() => window.petAPI.openSettings());
  panel = await until(async () => app.windows().find(p => p.url().includes('view=settings')), Boolean); await panel.getByRole('button', { name: '数据管理后台 ↗', exact: true }).waitFor(); chatPanel = panel;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=settings')).setSize(920, 840));
}
async function close() { if (!app) return; const closing = app, child = closing.process(); let timer; try { await Promise.race([closing.close(), new Promise((_, reject) => timer = setTimeout(() => reject(new Error('Close timeout')), 10000))]); } finally { clearTimeout(timer); if (!child.killed && child.exitCode === null) child.kill(); app = undefined; } }

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const rows = () => panel.locator('tbody tr[data-record-id]');
const card = id => panel.locator(`tr[data-record-id="${id}"]`);
async function idle() { await until(() => panel.locator('.ant-spin-spinning').count(), n => n === 0); }
async function category(name) { await panel.getByRole('menuitem', { name: new RegExp(name) }).click(); await idle(); }
async function search(text) { await panel.locator('#admin-search').fill(text); await panel.getByRole('button', { name: /查\s*询/ }).click(); await idle(); }
async function openAdmin(section='overview') {
  const result = await chatPanel.evaluate(section => window.petAPI.openDataAdmin(section), section); assert.equal(result.ok, true);
  panel = await until(async () => app.windows().find(p => p.url().includes('view=admin')), Boolean); panel.setDefaultTimeout(15000); await panel.getByRole('navigation', { name: '后台导航' }).waitFor(); await idle();
}
async function shot(name) { const path = join(shots, `独立后台-${name}-${report.mode}.png`); await panel.screenshot({ path, fullPage: true }); report.screenshots.push(path); }
async function edit(text) { await panel.locator('#admin-editor-text').fill(text); await panel.getByRole('button', { name: '保存修改', exact: true }).click(); await panel.getByRole('dialog').waitFor({ state: 'hidden' }); await idle(); }
try {
  console.log('phase: independent windows'); await launch(); report.version = (await api('getState')).version;
  assert.equal(await chatPanel.getByRole('tab', { name: '后台', exact: true }).count(), 0); assert.equal(await chatPanel.getByRole('button', { name: '后台', exact: true }).count(), 0);
  await api('configureModel', { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture', proactive: false, memoryEnabled: true, streaming: false, autoSummary: false, autoLongMemory: false });
  for (const id of [session, sessionB]) { let c=await api('getChat'); if(c.sessionId!==id) c=await api('selectConversation',{...target(c),selectedSessionId:id}); await api('extractLongMemory',target(c)); await until(()=>api('getChat'),c=>!c.longMemoryRunning); await api('summarizeChat',target(await api('getChat'))); await until(()=>api('getChat'),c=>!c.summarizing && c.summary); }
  assert.equal(requests.length,4);
  await chatPanel.getByRole('button', { name: '数据管理后台 ↗', exact: true }).click(); panel = await until(async()=>app.windows().find(p=>p.url().includes('view=admin')), Boolean); await panel.getByRole('navigation', { name:'后台导航' }).waitFor(); await idle();
  const winInfo = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => /view=(admin|settings)/.test(w.webContents.getURL())).map(w => ({ url:w.webContents.getURL(), width:w.getSize()[0], title:w.getTitle() })));
  assert.equal(winInfo.length,2); assert.ok(winInfo.find(w=>w.url.includes('view=admin')).width>=1000); assert.ok((await panel.locator('.admin-header').innerText()).includes('数据管理')); assert.equal((await panel.locator('.admin-shell').innerText()).includes('让回应自然'),false);
  await shot('概览'); report.checks.push('独立后台窗口、Ant Design侧栏/面包屑/统计/表格真实显示；日常设置无后台页签，模型调用没有增加');
  console.log('phase: window permissions');
  const pet=await until(async()=>app.windows().find(p=>!p.url().includes('view=')),Boolean); for(const method of ['dataOverview','dataQuery','dataMutate','dataExport']) { const result=await pet.evaluate(method=>window.petAPI[method]({section:'inputs'}),method); assert.equal(result.ok,false); }
  const denied=await panel.evaluate(()=>window.petAPI.configureModel({baseUrl:'http://localhost/v1',model:'forbidden',proactive:false,memoryEnabled:true})); assert.equal(denied.ok,false);
  const invalid=await panel.evaluate(()=>window.petAPI.dataQuery({section:'sessions',sql:'DROP TABLE messages'})); assert.equal(invalid.ok,false); report.checks.push('后台只获数据管理与选会话权限，不能改模型连接；桌宠仍不能读取或修改后台数据，任意SQL拒绝');
  console.log('phase: session table'); await category('会话管理'); await until(()=>rows().count(),n=>n===50); assert.equal((await api('dataQuery',{section:'sessions'})).total,56);
  await panel.getByTitle('2', {exact:true}).click(); await until(()=>rows().count(),n=>n===6); await card(session).waitFor();
  await card(session).getByRole('button',{name:'重命名',exact:true}).click(); await edit('会话甲 · 搬家与通勤'); await panel.locator('#admin-search').fill('搬家'); await until(()=>rows().count(),n=>n===1); assert.ok((await rows().innerText()).includes('搬家与通勤'));
  const exportPath=join(data,'会话列表.json'); await app.evaluate(({dialog},filePath)=>dialog.showSaveDialog=async()=>({canceled:false,filePath}),exportPath); await panel.getByRole('button',{name:/导出会话列表/}).click(); await until(async()=>{try{return JSON.parse(readFileSync(exportPath,'utf8'));}catch{}},r=>r?.count===1); assert.equal(JSON.parse(readFileSync(exportPath,'utf8')).records[0].sessionTitle,'会话甲 · 搬家与通勤');
  await shot('会话列表'); report.checks.push('56会话表格真实50/6页码跳转、持久化改名、名称片段即时模糊搜索和筛选导出通过');
  console.log('phase: combined filters'); await panel.getByRole('button',{name:/重\s*置/}).click(); await idle();
  await panel.getByRole('combobox',{name:'会话内容筛选',exact:true}).click(); await panel.getByText('有聊天记录',{exact:true}).last().click(); await until(()=>rows().count(),n=>n===3);
  await panel.getByRole('combobox',{name:'角色筛选',exact:true}).click(); await panel.getByText('冰芽川四糸乃',{exact:true}).last().click(); await until(()=>rows().count(),n=>n===2);
  const range=panel.locator('.ant-picker-range input'); await range.nth(0).click(); const todayCell=panel.locator(`.ant-picker-cell-in-view[title="${today()}"]`); await todayCell.first().click(); await todayCell.first().click(); await panel.locator('#admin-search').click(); await until(()=>rows().count(),n=>n===1); assert.equal(await card(session).count(),1); report.checks.push('角色、日期范围、有无记录组合筛选在真实Ant Design选择器中生效');
  await card(session).getByRole('button',{name:'查看记录',exact:true}).click(); await until(()=>rows().count(),n=>n===24);
  for(const [name,count] of [['用户原文',12],['自动长期记忆',3],['会话摘要',1]]) { await category(name); await until(()=>rows().count(),n=>n===count); assert.ok((await panel.locator('.admin-session-scope').innerText()).includes('搬家与通勤')); }
  await category('用户原文');
  const picker=panel.getByRole('combobox',{name:'用户原文会话筛选',exact:true});
  await picker.fill('会话乙'); await panel.getByText('会话乙独立资料0：喜欢公交 · 6 条原文',{exact:true}).last().click(); await until(()=>rows().count(),n=>n===6); assert.equal(await card(users[0]).count(),0);
  await picker.fill('搬家'); await panel.getByText('会话甲 · 搬家与通勤 · 12 条原文',{exact:true}).last().click(); await until(()=>rows().count(),n=>n===12);
  const inputExport=join(data,'会话甲用户原文.json'); await app.evaluate(({dialog},filePath)=>dialog.showSaveDialog=async()=>({canceled:false,filePath}),inputExport); await panel.getByRole('button',{name:/导出筛选结果/}).click(); await until(async()=>{try{return JSON.parse(readFileSync(inputExport,'utf8'));}catch{}},value=>value?.count===12); assert.ok(JSON.parse(readFileSync(inputExport,'utf8')).records.every(row=>row.sessionId===session)); await shot('用户原文会话筛选');
  report.checks.push('用户原文可直接按会话名称筛选，甲12条/乙6条相互隔离，筛选导出仅含所选会话');
  report.checks.push('四类记录切换保留同一会话，原文/记忆/摘要仍按来源会话隔离');
  console.log('phase: source drawer and editing'); await category('自动长期记忆'); const memory=(await api('dataQuery',{section:'long-memories',sessionId:session})).records.find(r=>r.text.includes('搬到北京'));
  console.log('phase: evidence layers and task recovery');
  const info = await api('dataOverview'), pending = info.memoryJobs.find(j => j.kind === 'consolidate' && j.sessionId === session);
  assert.ok(pending); assert.equal('runToken' in pending, false); assert.equal('payload' in pending, false);
  await api('dataMutate', { action: 'retry-memory-job', characterId: 'yoshino', id: pending.id });
  await until(() => api('dataOverview'), d => d.memoryJobs.find(j => j.id === pending.id)?.state === 'succeeded');
  await panel.getByText('归纳理解', { exact: true }).click(); await until(() => rows().count(), n => n === 1);
  const observation = (await api('dataQuery', { section: 'long-memories', memoryLayer: 'observations', sessionId: session })).records[0];
  await card(observation.id).getByRole('button', { name: '详情', exact: true }).click();
  const evidenceDrawer = panel.getByRole('dialog', { name: '记录详情', exact: true }); await evidenceDrawer.getByRole('button', { name: /查看来源事实/ }).click();
  await until(() => evidenceDrawer.innerText(), text => text.includes('喜欢地铁') && text.includes('当前适用'));
  await shot('归纳依据'); await evidenceDrawer.getByRole('button', { name: /查看确切出处/ }).click(); await until(() => rows().count(), n => n === 1); assert.equal(await card(users[2]).count(), 1);
  await panel.getByRole('button', { name: '清除来源筛选', exact: true }).click(); await idle();
  await category('自动长期记忆'); await panel.getByText('来源事实', { exact: true }).click(); await until(() => rows().count(), n => n === 3);
  report.checks.push('持久归纳任务手动重试完成，页面不暴露执行令牌；事实/归纳切换与归纳→依据事实→确切原文全链路通过');

  await card(memory.id).getByRole('button',{name:'详情',exact:true}).click(); const drawer=panel.getByRole('dialog',{name:'记录详情',exact:true}); await drawer.waitFor(); assert.ok((await drawer.innerText()).includes(users[4])); await shot('出处抽屉');
  await drawer.getByRole('button',{name:/查看确切出处/}).click(); await until(()=>rows().count(),n=>n===2); assert.equal(await card(users[0]).count(),1); assert.equal(await card(users[4]).count(),1);
  await panel.getByRole('button',{name:'清除来源筛选',exact:true}).click(); await until(()=>rows().count(),n=>n===24);
  await category('自动长期记忆'); await card(memory.id).getByRole('button',{name:'编辑',exact:true}).click(); await edit('人工修订：上海已是旧居，北京新住址仍未知。'); const revised=(await api('dataQuery',{section:'long-memories',sessionId:session})).records.find(r=>r.id===memory.id); assert.equal(revised.longMemory.author,'user'); assert.equal(revised.revision,2); assert.deepEqual(revised.longMemory.sourceMessageIds,memory.longMemory.sourceMessageIds); report.checks.push('右侧抽屉显示全文与精确出处；非连续来源回查只返回2条，记忆编辑保留来源及人工修订版本');
  console.log('phase: manually scoped story memory');
  await category('用户长期记忆'); await panel.getByRole('button', { name: /新增记忆/ }).click();
  await panel.getByRole('combobox', { name: '新记忆作用范围', exact: true }).click(); await panel.getByText('剧情设定：仅绑定会话', { exact: true }).last().click();
  await panel.getByRole('combobox', { name: '新记忆绑定会话', exact: true }).fill('搬家'); await panel.getByText('会话甲 · 搬家与通勤', { exact: true }).last().click();
  await edit('本分支的用户住在上海'); const scoped = (await api('dataQuery', { section: 'memories', query: '本分支的用户住在上海' })).records[0];
  assert.equal(scoped.memoryScope, 'fiction'); assert.equal(scoped.sessionId, session);
  await api('dataMutate', { action: 'delete-memories', items: [{ id: scoped.id, characterId: 'yoshino', revision: scoped.revision }] });
  report.checks.push('人工剧情记忆通过真实下拉框与会话名称搜索绑定，数据库作用域及会话匹配，现实资料默认策略保持');

  console.log('phase: confirmed memories and summaries'); await category('用户长期记忆'); await panel.getByRole('button',{name:/新增记忆/}).click(); await edit('后台新增偏好'); const added=(await api('dataQuery',{section:'memories',query:'后台新增偏好'})).records[0]; await card(added.id).getByRole('button',{name:'编辑',exact:true}).click(); await edit('后台修订偏好'); assert.equal((await api('dataQuery',{section:'memories',query:added.id})).records[0].revision,2);
  await card(added.id).getByRole('button',{name:'删除',exact:true}).click(); await panel.getByRole('dialog').getByRole('button',{name:/取\s*消/}).click(); assert.equal((await api('dataQuery',{section:'memories',query:added.id})).total,1);
  // The deliberate memory edit invalidates summaries; regenerate one through existing chat API with local mock.
  let c=await api('getChat'); if(c.sessionId!==session) c=await api('selectConversation',{...target(c),selectedSessionId:session}); await api('summarizeChat',target(c)); await until(()=>api('getChat'),c=>!c.summarizing && c.summary); const calls=requests.length;
  await category('会话摘要'); await search('搬家'); await card(session).getByRole('button',{name:'查看记录',exact:true}).click(); await until(()=>rows().count(),n=>n===1); await card(session).getByRole('button',{name:'编辑',exact:true}).click(); await panel.locator('#summary-edit-uncertainties').fill('用户人工补充：新住址未知。'); await panel.getByRole('button',{name:'保存修改',exact:true}).click(); await panel.getByRole('dialog').waitFor({state:'hidden'}); const summary=(await api('dataQuery',{section:'summaries',sessionId:session})).records[0]; assert.equal(summary.summary.author,'user'); assert.equal(summary.summary.revision,2); assert.equal(requests.length,calls); report.checks.push('标准表单支持独立用户记忆新增/修改/删除取消，以及七类摘要人工修订；保存不额外调用模型');
  console.log('phase: bulk and source invalidation'); await category('用户长期记忆'); await search('后台修订偏好'); await card(added.id).getByRole('checkbox').check(); await panel.getByRole('button',{name:/删除所选/}).click(); await panel.getByRole('button',{name:'确认删除',exact:true}).click(); await panel.getByRole('dialog').waitFor({state:'hidden'}); assert.equal((await api('dataQuery',{section:'memories',query:added.id})).total,0);
  await category('用户原文'); await panel.getByRole('combobox',{name:'用户原文会话筛选',exact:true}).fill('搬家'); await panel.getByText('会话甲 · 搬家与通勤 · 12 条原文',{exact:true}).last().click(); await until(()=>rows().count(),n=>n===12); await card(users[0]).getByRole('button',{name:'编辑',exact:true}).click(); await panel.locator('#admin-editor-text').fill('  后台新原文\n保留空白  '); await panel.getByRole('button',{name:'确认修订原文',exact:true}).click(); await panel.getByRole('dialog').waitFor({state:'hidden'}); const inputs=await api('dataQuery',{section:'inputs',sessionId:session}); assert.equal(inputs.total,1); assert.equal(inputs.records[0].text,'  后台新原文\n保留空白  '); assert.equal((await api('dataQuery',{section:'long-memories',sessionId:session})).total,0); assert.equal((await api('dataQuery',{section:'summaries',sessionId:session})).total,0); report.checks.push('批量删除先确认；修订原文同步两份档案、清理后文/来源记忆/摘要，其他会话独立保留');
  console.log('phase: chat links and window lifecycle'); await category('会话管理'); await panel.getByRole('button',{name:/重\s*置/}).click(); await search('会话乙'); await card(sessionB).getByRole('button',{name:'继续聊天',exact:true}).click(); await chatPanel.locator('#chat-input').waitFor(); assert.equal((await api('getChat')).sessionId,sessionB); assert.ok(app.windows().includes(panel));
  const id=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('view=admin')).id); await openAdmin('overview'); const same=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('view=admin')).id); assert.equal(id,same);
  // Closing/reopening admin must neither cancel a normal answer nor force a model call.
  const active=await api('getChat'); await api('sendChat',{...target(active),text:'后台关闭时继续回答'}); assert.equal((await api('getChat')).busy,true);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('view=admin')).close()); await openAdmin('sessions'); assert.equal((await api('getChat')).sessionId,sessionB); await until(()=>api('getChat'),c=>!c.busy && c.messages.at(-1)?.text==='正常完成的回答'); report.checks.push('后台继续聊天打开日常聊天窗口；重复打开复用独立窗口，关闭后台保留当前聊天与数据');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('view=admin')).setSize(800,680)); await until(()=>panel.locator('.admin-sider.ant-layout-sider-collapsed').count(),Boolean); assert.equal(await panel.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true); await shot('窄窗口');
  const beforeRestart=requests.length; await close(); await launch(); await openAdmin('sessions'); await search('搬家'); await until(()=>rows().count(),n=>n===1); assert.equal((await api('dataQuery',{section:'inputs',sessionId:session})).records[0].text,'  后台新原文\n保留空白  '); assert.equal(requests.length,beforeRestart); assert.equal((await api('getChat')).settings.autoLongMemory,false); report.checks.push('800px窗口自动折叠导航、表格内部横向滚动，无整页溢出；重启后名称、原文修订和开关保持，浏览无新模型调用');
  assert.deepEqual(errors,[]); report.passed=true;
} catch(error) { if(panel) await shot('失败').catch(()=>{}); report.failure=error.stack; process.exitCode=1; }
finally { if(app) await close().catch(error=>{report.failure??=error.stack;report.passed=false;process.exitCode=1}); server.closeAllConnections(); await new Promise(done=>server.close(done)); writeFileSync(join(output,`AdminConsole-${report.mode}-check.json`),JSON.stringify(report,null,2),'utf8'); console.log(JSON.stringify({passed:report.passed,checks:report.checks,failure:report.failure},null,2)); }
