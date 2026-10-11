import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, cpSync, readdirSync, linkSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { electronExecutable } from './electron-runtime.mjs';
const source = resolve(import.meta.dirname, '..'), project = source, packaged = process.argv.includes('--packaged');
const parent = join(project, 'data/tests/chat'); mkdirSync(parent, { recursive: true });
const run = mkdtempSync(join(parent, packaged ? 'packaged-' : 'source-')), data = join(run, 'runtime'), packs = join(run, 'packs'); mkdirSync(data); mkdirSync(packs);
const output = join(project, 'artifacts/reports'); mkdirSync(output, { recursive: true });
const shots = join(project, 'artifacts/screenshots'); mkdirSync(shots, { recursive: true });
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
const requests = [], requestPaths = [], errors = []; let app, panel, pet, mode = 'normal', closedRequests = 0;
function archivedInput(messageId) {
  const db = new DatabaseSync(join(data, 'chat.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT * FROM user_inputs WHERE message_id=?').get(messageId); }
  finally { db.close(); }
}
const server = createServer((req, res) => {
  if (!['/v1/chat/completions', '/v1/responses'].includes(req.url)) { res.writeHead(404).end(); return; }
  let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
    const value = JSON.parse(body); requests.push(value); requestPaths.push(req.url); const currentMode = mode;
    if (req.url === '/v1/responses') {
      const response = { id: 'resp_fixture', object: 'response', created_at: 1, status: 'completed', model: 'fixture-chat',
        output: [{ type: 'reasoning', id: 'rs_fixture', summary: [{ type: 'summary_text', text: 'Responses 公开摘要测试。' }] },
          { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"text":"这是 Responses 最终台词。","expression":"happy"}', annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, output_tokens_details: { reasoning_tokens: 15 } } };
      if (!value.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response)); return; }
      const sse = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse('response.created', { response: { id: response.id, model: response.model } }));
      res.write(sse('response.reasoning_summary_text.delta', { item_id: 'rs_fixture', output_index: 0, summary_index: 0, delta: 'Responses 公开摘要测试。' }));
      const finish = setTimeout(() => res.end(sse('response.output_text.delta', { item_id: 'msg_fixture', output_index: 1, content_index: 0, delta: response.output[1].content[0].text }) + sse('response.completed', { response })), 600);
      res.on('close', () => clearTimeout(finish)); return;
    }
    if (currentMode === 'transient-first') { mode = 'normal'; res.writeHead(503, { 'content-type': 'application/json', 'retry-after-ms': '1' }).end('{"error":"temporary fixture"}'); return; }
    if (currentMode === 'unauthorized') { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"private fixture-only-key"}'); return; }
    const text = currentMode === 'slow' ? '这条迟到回复不应完成。' : currentMode === 'broken' ? '损坏结构' : value.messages[0].content.includes('角色契约 B') ? '角色 B 的明亮回应。' : '你好，小林。喜欢蓝色的你，今天也可以慢慢来。';
    const b = value.messages[0].content.includes('角色契约 B');
    const isSummary = value.messages[0].content.startsWith('你是会话档案整理器');
    const reply = currentMode === 'broken' ? '{"text":"unfinished' : isSummary ? JSON.stringify({ events: ['用户谈到过去上海的生活。'], userStatements: ['用户说现在已搬到北京，住址与工作地点未知。'], fictionalState: ['故事中的上海住址与现实分开。'], uncertainties: ['下个月可能搬家，尚未决定。'], commitments: ['若下雨则取消散步，未兑现。'], openQuestions: ['新城市通勤条件未知。'], keyQuotes: ['用户：“我喜欢地铁。”'] }) : JSON.stringify({ text, speaker: b ? 'role-b' : 'yoshinon', expression: b ? 'bright' : 'happy', action: b ? 'nod' : 'comfort' });
    const reasoning = currentMode === 'reasoning' ? '{"text":"推理分离测试","action":"greet"}' : undefined;
    if (value.stream === false) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: reply, reasoning_content: reasoning }, finish_reason: 'stop' }] })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (reasoning) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: null, reasoning_content: reasoning }, finish_reason: null }] })}\n\n`);
    const answerAt = Date.now() + (reasoning ? 600 : 0);
    let index = 0;
    const interval = setInterval(() => {
      if (Date.now() < answerAt) return;
      if (currentMode === 'slow' && index >= 15) return;
      if (index >= reply.length) { clearInterval(interval); res.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":6,"completion_tokens":4,"total_tokens":10}}\n\ndata: [DONE]\n\n'); return; }
      const chunk = reply.slice(index, index + 3); index += 3;
      const bytes = Buffer.from(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\r\n\r\n`);
      const split = Math.floor(bytes.length / 2); res.write(bytes.subarray(0, split)); res.write(bytes.subarray(split));
    }, 18);
    const force = setTimeout(() => { clearInterval(interval); if (!res.writableEnded) res.end('data: [DONE]\n\n'); }, 12000);
    res.on('close', () => { clearInterval(interval); clearTimeout(force); if (currentMode === 'slow') closedRequests++; });
  });
});
await new Promise(done => server.listen(0, '127.0.0.1', done)); const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
function fixture(id) {
  const original = join(project, 'characters/yoshino'), target = join(packs, id);
  cpSync(original, target, { recursive: true, filter: file => !file.includes('references') && !file.includes('voice') && !file.endsWith('.png') });
  function pngs(dir) { for (const item of readdirSync(dir, { withFileTypes: true })) { if (['references', 'voice'].includes(item.name)) continue; const file = join(dir, item.name); if (item.isDirectory()) pngs(file); else if (file.endsWith('.png')) { const dest = join(target, relative(original, file)); mkdirSync(dirname(dest), { recursive: true }); try { linkSync(file, dest); } catch (error) { if (!['UNKNOWN', 'EMLINK', 'EXDEV', 'EPERM'].includes(error.code)) throw error; copyFileSync(file, dest); } } } }
  pngs(original); if (id === 'yoshino') return;
  const manifest = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')); manifest.id = id; manifest.displayName = manifest.shortName = '角色契约 B'; manifest.speakers = { [id]: { displayName: '角色 B' } };
  const profile = JSON.parse(readFileSync(join(target, manifest.roleConfig), 'utf8')); profile.characterId = id; profile.identity = { name: '角色契约 B', work: '测试', summary: '角色契约 B，明快地回应。', traits: ['开朗'] }; profile.relationships.others = []; profile.knowledge = []; profile.examples = []; write(join(target, manifest.roleConfig), profile);
  manifest.visual.expressions = { calm: manifest.visual.expressions.normal, bright: manifest.visual.expressions.happy }; manifest.visual.defaultExpression = manifest.visual.fallbackExpression = 'calm';
  delete manifest.visual.frameAnimationConfig; delete manifest.visual.motionConfig; delete manifest.visual.rigConfig;
  write(join(target, 'manifest.json'), manifest); writeFileSync(join(target, manifest.persona), '角色契约 B，明快地回应。', 'utf8'); writeFileSync(join(target, manifest.prompt), '简短自然地聊天。', 'utf8');
  const action = { durationMs: 900, loop: false, keyframes: [{ offset: 0, translateY: 0, rotate: 0 }, { offset: .5, translateY: -.005, rotate: 2 }, { offset: 1, translateY: 0, rotate: 0 }] };
  write(join(target, manifest.visual.animationConfig), { schemaVersion: 1, actions: { rest: { ...action, durationMs: 4000, loop: true }, nod: action } });
  write(join(target, manifest.catalogConfig), { schemaVersion: 1, actions: { rest: { label: '浮动' }, nod: { label: '点头' } }, expressions: { calm: { label: '平静' }, bright: { label: '明亮' } } });
  write(join(target, manifest.interactionConfig), { schemaVersion: 2, responses: { touch: [{ id: 'touch', speaker: id, text: '角色 B 点击回应', expression: 'calm' }] } });
  write(join(target, manifest.behaviorConfig), { schemaVersion: 1, events: { click: 'touch' }, commands: {}, states: {}, idleAction: 'rest' });
  write(join(target, manifest.bubbleConfig), { schemaVersion: 1, choices: [], choiceHint: '', passiveHint: '角色 B', theme: { background: '#ffffff', backgroundEnd: '#eef4ff', text: '#203050', accent: '#3355aa', border: '#7799cc', buttonBackground: '#dde8ff', radius: 8 } });
}
fixture('yoshino'); fixture('role-b'); write(join(packs, 'registry.json'), { schemaVersion: 1, defaultCharacterId: 'yoshino', characters: ['yoshino', 'role-b'].map(id => ({ id, manifest: `${id}/manifest.json` })) });
const env = { ...process.env, PET_DATA_DIR: data, PET_CHARACTER_DIR: packs }; delete env.ELECTRON_RUN_AS_NODE;
const report = { version: '', mode: packaged ? 'packaged' : 'source', passed: false, checks: [], errors, data: run, screenshots: [], realProviderVerified: false };
async function state(page) { const reply = await page.evaluate(() => window.petAPI.getState()); assert.equal(reply.ok, true); return reply.value; }
async function chat() { const reply = await panel.evaluate(() => window.petAPI.getChat()); assert.equal(reply.ok, true); return reply.value; }
async function until(get, predicate, timeout = 12000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await get(); if (predicate(value)) return value; await new Promise(done => setTimeout(done, 40)); } throw new Error(`Timed out: ${predicate}`); }
async function launch() {
  const executablePath = electronExecutable(source, packaged);
  app = await electron.launch({ executablePath, args: packaged ? [] : [source], cwd: project, env });
  app.on('window', page => { page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message)); });
  await app.firstWindow(); await until(async () => app.windows().find(p => p.url().startsWith('pet-app:') && !p.url().includes('view=')), p => Boolean(p));
  pet = app.windows().find(p => p.url().startsWith('pet-app:') && !p.url().includes('view=')); await pet.waitForSelector('.portrait[data-active=true]', { state: 'attached' });
  await pet.evaluate(() => window.petAPI.setPreferences({ proactive: false, greetings: false, animations: 'full', interaction: 'interactive' }));
  await pet.evaluate(() => window.petAPI.openChat()); await until(async () => app.windows().find(p => p.url().includes('tab=chat')), p => Boolean(p));
  panel = app.windows().find(p => p.url().includes('tab=chat')); await panel.locator('#chat-input').waitFor(); return app;
}
async function send(text) { await panel.locator('#chat-input').fill(text); await panel.getByRole('button', { name: '发送', exact: true }).click(); }
async function inspector() { if (await panel.locator('.chat-inspector').getAttribute('open') === null) await panel.locator('.chat-inspector > summary').click(); }
async function closeApp() {
  const closing = app; if (!closing) return; const child = closing.process();
  let timer;
  try { await Promise.race([closing.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Electron quit exceeded 10 seconds')), 10000); })]); }
  finally { clearTimeout(timer); if (!child.killed && child.exitCode === null) child.kill(); app = undefined; }
}
try {
  console.log('phase: launch');
  await launch(); report.version = (await state(pet)).version;
  console.log('phase: configure');
  const denied = await pet.evaluate(() => window.petAPI.configureModel({ baseUrl: 'http://localhost/v1', model: 'no', proactive: false, memoryEnabled: false })); assert.equal(denied.ok, false);
  await panel.getByRole('button', { name: '模型连接', exact: true }).click(); await panel.locator('#model-url').fill(baseUrl); await panel.locator('#model-name').fill('fixture-chat'); await panel.locator('#model-key').fill('fixture-only-key');
  await panel.locator('#model-auto-summary').uncheck(); await panel.locator('#model-auto-long-memory').uncheck();
  await panel.getByRole('button', { name: '保存连接设置', exact: true }).click(); await until(chat, c => c.settings.hasKey); assert.equal(requests.length, 0); assert.equal(await panel.locator('#model-key').inputValue(), '');
  assert.equal(readFileSync(join(data, 'chat-model.json'), 'utf8').includes('fixture-only-key'), false); assert.equal(JSON.stringify(await chat()).includes('fixture-only-key'), false);
  report.checks.push('连接保存不调用模型；系统加密密钥，不回显；桌宠窗口不能修改聊天配置');
  await panel.getByRole('button', { name: '对话', exact: true }).click();
  const welcomeShot = join(shots, `聊天新版-空白-${report.mode}.png`); await panel.screenshot({ path: welcomeShot }); report.screenshots.push(welcomeShot);
  console.log('phase: first turn'); mode = 'transient-first';
  await panel.getByRole('button', { name: '对话', exact: true }).click(); await send('我叫小林，喜欢蓝色。');
  await until(chat, c => c.busy && c.draft.includes('你好')); assert.equal(await panel.locator('.chat-message.assistant').innerText().then(t => t.includes('"text"')), false);
  const complete = await until(chat, c => !c.busy && c.messages.at(-1)?.status === 'complete'); assert.equal(complete.messages.at(-1).speaker, 'yoshinon');
  await until(() => state(pet), s => s.expression === 'happy' && s.companion.presentation?.action === 'comfort' && s.companion.bubble?.speaker === '四糸奈');
  assert.equal(complete.messages.length, 2); assert.equal(complete.lastRequest.attempts, 2); assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].messages, requests[1].messages); assert.equal(archivedInput(complete.messages[0].id).text, '我叫小林，喜欢蓝色。');
  report.checks.push('首次请求503由SDK重试成功，HTTP尝试两次，仅保存一条用户原文与一条回答，不重复输出');
  const firstSession = complete.sessionId; await panel.getByRole('button', { name: '记住这句话', exact: true }).click(); await until(chat, c => c.memories.length === 1);
  await send('你还记得我喜欢什么吗？'); await until(chat, c => !c.busy && c.messages.length === 4); assert.equal(JSON.stringify(requests.at(-1).messages).includes('我叫小林，喜欢蓝色。'), true);
  const shot = join(shots, `聊天面板-M2-${report.mode}.png`); await panel.screenshot({ path: shot, fullPage: true }); report.screenshots.push(shot);
  const layout = await panel.evaluate(() => ({ height: innerHeight, width: innerWidth, pageWidth: document.documentElement.scrollWidth, logHeight: document.querySelector('.chat-log').getBoundingClientRect().height, composeBottom: document.querySelector('.chat-compose').getBoundingClientRect().bottom }));
  assert.ok(layout.logHeight > 220); assert.ok(layout.composeBottom <= layout.height); assert.ok(layout.pageWidth <= layout.width);
  await panel.getByLabel('搜索会话名称').fill('不会存在的会话'); await panel.getByText('没有找到相关会话', { exact: true }).waitFor();
  await panel.getByLabel('搜索会话名称').fill('喜欢蓝色'); await panel.locator(`[data-session-id="${firstSession}"]`).waitFor(); await panel.getByLabel('搜索会话名称').fill('');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=settings')).setSize(440, 680));
  await until(() => panel.evaluate(() => innerWidth), width => width < 650);
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const narrowInput = await panel.locator('.chat-compose').boundingBox(); assert.ok(narrowInput.y + narrowInput.height <= await panel.evaluate(() => innerHeight));
  await panel.locator('#chat-input').fill('键盘换行'); await panel.locator('#chat-input').press('Shift+Enter'); assert.equal(await panel.locator('#chat-input').inputValue(), '键盘换行\n'); await panel.locator('#chat-input').fill('');
  const narrowShot = join(shots, `聊天新版-窄窗口-${report.mode}.png`); await panel.screenshot({ path: narrowShot }); report.screenshots.push(narrowShot);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=settings')).setSize(1040, 820)); await until(() => panel.evaluate(() => innerWidth), width => width > 900);
  report.checks.push('新版会话侧栏名称搜索和空结果可用；宽窄窗口无横向溢出，输入与发送保持可见，Shift+Enter只换行');
  report.checks.push('真实 Electron + 本地 HTTP SSE：中文流式显示、无 JSON 闪现、四糸奈署名、表情和动作联动；已确认记忆进入请求');
  console.log('phase: cancel');
  await panel.getByRole('button', { name: '新对话', exact: true }).click(); await until(chat, c => c.sessionId !== firstSession && c.messages.length === 0);
  await panel.locator(`[data-session-id="${firstSession}"]`).click(); await until(chat, c => c.messages.length === 4);
  mode = 'slow'; await send('慢慢回答'); await until(chat, c => c.busy && c.draft.length > 0); await panel.getByRole('button', { name: '停止回复', exact: true }).click(); await until(chat, c => !c.busy && c.messages.at(-1)?.status === 'cancelled');
  await until(async () => closedRequests, c => c >= 1); report.checks.push('新对话与历史选择可用；停止回复会中止 HTTP 请求并保留取消状态');
  if (!packaged) {
    console.log('phase: switch');
    await send('角色切换前的慢回复'); await until(chat, c => c.busy && c.draft.length > 0);
    await panel.getByRole('button', { name: '角色与动作', exact: true }).click(); await panel.locator('#character').selectOption('role-b'); await until(() => state(pet), s => s.character.id === 'role-b');
    await panel.getByRole('button', { name: '聊天', exact: true }).click(); await until(chat, c => c.characterId === 'role-b' && !c.busy && !c.messages.length && !c.memories.length);
    mode = 'normal'; await send('你好 B'); await until(chat, c => !c.busy && c.messages.at(-1)?.status === 'complete'); await until(() => state(pet), s => s.expression === 'bright' && s.companion.presentation?.action === 'nod');
    assert.equal(JSON.stringify(requests.at(-1).messages).includes('我叫小林'), false); assert.equal(requests.at(-1).messages[0].content.includes('"bright"'), true);
    await panel.getByRole('button', { name: '角色与动作', exact: true }).click(); await panel.locator('#character').selectOption('yoshino'); await until(() => state(pet), s => s.character.id === 'yoshino');
    await panel.getByRole('button', { name: '聊天', exact: true }).click(); await until(chat, c => c.characterId === 'yoshino' && c.memories.length === 1); await panel.locator(`[data-session-id="${firstSession}"]`).click(); await until(chat, c => c.messages.length >= 6);
    assert.equal((await chat()).messages.at(-1).status, 'cancelled'); report.checks.push('A→B→A：旧流取消、消息和记忆隔离；B 使用自己的 bright/nod 与人设，无 A 用户资料');
  }
  console.log('phase: errors');
  const rawInput = '  检查错误\n用户输入原文保留。  ';
  mode = 'unauthorized'; await send(rawInput); await until(chat, c => !c.busy && c.messages.at(-1)?.status === 'failed'); await panel.getByRole('alert').filter({ hasText: '认证失败' }).waitFor(); assert.equal((await panel.locator('body').innerText()).includes('fixture-only-key'), false);
  const diagnosticText = readFileSync(join(data, 'chat-diagnostics.jsonl'), 'utf8');
  const diagnostic = JSON.parse(diagnosticText.trim().split('\n').at(-1));
  assert.equal(diagnostic.outcome, 'failed'); assert.equal(diagnostic.errorCode, 'HTTP_401'); assert.equal(diagnostic.httpStatus, 401); assert.equal(diagnostic.attempts, 1);
  for (const secret of ['fixture-only-key', rawInput, 'private']) assert.equal(diagnosticText.includes(secret), false);
  await inspector(); assert.equal((await panel.locator('.chat-request-diagnostic summary').innerText()).includes('失败'), true);
  report.checks.push('失败原因分类和HTTP尝试次数持久化，界面可查看；诊断文件不含密钥、用户原文或原始错误响应');
  const sourceInput = (await chat()).messages.find(m => m.role === 'user' && m.text === rawInput); assert.ok(sourceInput);
  const archivedSource = archivedInput(sourceInput.id);
  assert.equal(archivedSource.text, rawInput); assert.equal(archivedSource.character_id, 'yoshino');
  assert.equal(archivedSource.created_at, sourceInput.createdAt);
  assert.equal(requests.at(-1).messages.at(-1).content, rawInput);
  await panel.locator('.chat-message.user').filter({ hasText: '用户输入原文保留。' }).getByRole('button', { name: '记住这句话', exact: true }).click(); await until(chat, c => c.memories.length === 2);
  assert.equal((await chat()).memories.find(m => m.sourceMessageId === sourceInput.id).text, rawInput);
  await panel.getByRole('button', { name: '记忆', exact: true }).click(); await panel.locator('.memory-list article').filter({ hasText: '用户输入原文保留。' }).getByRole('button').click(); await until(chat, c => c.memories.length === 1);
  await panel.getByRole('button', { name: '对话', exact: true }).click();
  mode = 'broken'; await send('检查坏结构'); await until(chat, c => !c.busy && c.messages.at(-1)?.status === 'failed'); assert.equal((await chat()).messages.at(-1).text, ''); report.checks.push('401 错误分类可见且不泄漏响应内容；损坏 JSON 不作为成功台词或记忆');
  await panel.getByRole('button', { name: '记忆', exact: true }).click(); const memoryId = (await chat()).memories[0].id;
  console.log('phase: memory and restart');
  await panel.getByRole('button', { name: '忘记：我叫小林，喜欢蓝色。', exact: true }).click(); await until(chat, c => c.memories.length === 0);
  await panel.locator('#memory-input').fill('我喜欢散步'); await panel.getByRole('button', { name: '保存记忆', exact: true }).click(); await until(chat, c => c.memories.length === 1); assert.notEqual((await chat()).memories[0].id, memoryId);
  await closeApp(); console.log('phase: restart launch'); await launch(); assert.equal((await chat()).settings.hasKey, true); assert.equal((await chat()).memories[0].text, '我喜欢散步'); assert.equal((await chat()).messages.length > 0, true);
  assert.equal((await chat()).messages.find(m => m.id === sourceInput.id)?.text, rawInput);
  assert.deepEqual(archivedInput(sourceInput.id), archivedSource);
  report.checks.push('用户输入实体档案与完整聊天双份保存：原文、角色、消息ID和时间对应；失败及重启保留同一档案');
  report.checks.push('用户输入经真实界面/IPC 原样入库并发送：首尾空格与换行保留，模型失败后和重启后仍可按消息 ID 回查');
  report.checks.push('重启后聊天、记忆和加密连接配置持久化，未完成轮次不会伪装成功');
  console.log('phase: clear');
  mode = 'slow'; await send('删除前慢回复'); await until(chat, c => c.busy && c.draft.length > 0); await inspector(); await panel.getByRole('button', { name: '删除此角色聊天记录', exact: true }).click(); await panel.getByRole('button', { name: '确认删除', exact: true }).click(); await until(chat, c => !c.busy && c.messages.length === 0);
  assert.equal((await chat()).memories.length, 1); mode = 'normal'; await send('新的对话'); await until(chat, c => !c.busy && c.messages.at(-1)?.status === 'complete');
  assert.equal(archivedInput(sourceInput.id), undefined);
  assert.equal(requests.at(-1).messages.some(m => m.role !== 'system' && m.content.includes('小林')), false); report.checks.push('清空角色全部历史会取消旧请求，不恢复被删记录；明确保留独立记忆');
  await panel.getByRole('button', { name: '模型连接', exact: true }).click(); await panel.locator('#model-streaming').uncheck(); await panel.getByRole('button', { name: '保存连接设置', exact: true }).click(); await until(chat, c => c.settings.streaming === false);
  const modelShot = join(shots, `模型连接-LangChain-${report.mode}.png`); await panel.screenshot({ path: modelShot, fullPage: true }); report.screenshots.push(modelShot);
  const nonstreamCalls = requests.length; await panel.getByRole('button', { name: '对话', exact: true }).click(); await send('验证完整回复模式'); await until(chat, c => !c.busy && c.messages.at(-1)?.status === 'complete');
  assert.equal(requests.length, nonstreamCalls + 1); assert.equal(requests.at(-1).stream, false); assert.equal((await chat()).settings.hasKey, true); report.checks.push('关闭逐字显示后使用 SDK 非流式调用，一次请求完整回复并保留加密密钥');
  console.log('phase: reasoning and answer channels');
  await panel.getByRole('button', { name: '模型连接', exact: true }).click(); await panel.locator('#model-streaming').check(); await panel.getByRole('button', { name: '保存连接设置', exact: true }).click(); await until(chat, c => c.settings.streaming);
  mode = 'reasoning'; await panel.getByRole('button', { name: '对话', exact: true }).click(); await send('先思考再回复');
  await until(chat, c => c.busy && c.generationPhase === 'thinking' && c.reasoningDraft?.includes('推理分离测试'));
  assert.equal((await chat()).draft, ''); assert.equal(await panel.locator('.chat-message.assistant').last().locator('p').first().innerText(), '正在思考…');
  await until(chat, c => !c.busy && c.messages.at(-1)?.status === 'complete'); const thought = (await chat()).messages.at(-1);
  assert.equal(thought.reasoning, '{"text":"推理分离测试","action":"greet"}'); assert.equal(thought.text.includes('推理分离测试'), false);
  await panel.locator('.chat-message .chat-reasoning summary').last().click(); const reasoningShot = join(shots, `推理与回答-${report.mode}.png`); await panel.screenshot({ path: reasoningShot, fullPage: true }); report.screenshots.push(reasoningShot);
  mode = 'normal'; await send('再聊一句'); await until(chat, c => !c.busy && c.messages.at(-1)?.status === 'complete'); assert.equal(JSON.stringify(requests.at(-1).messages).includes('推理分离测试'), false);
  await closeApp(); await launch(); assert.equal((await chat()).messages.some(m => m.reasoning?.includes('推理分离测试')), true);
  report.checks.push('思考中状态、独立折叠推理、最终台词分离；推理重启后保留，不进入后续模型上下文');
  console.log('phase: Responses settings and summaries');
  await panel.getByRole('button', { name: '模型连接', exact: true }).click(); await panel.locator('#model-protocol').selectOption('responses'); await panel.locator('#model-reasoning-effort').selectOption('high'); await panel.locator('#model-output-budget').fill('8192'); await panel.locator('#model-timeout').fill('300');
  await panel.getByRole('button', { name: '保存连接设置', exact: true }).click(); await until(chat, c => c.settings.protocol === 'responses' && c.settings.timeoutSeconds === 300);
  await panel.getByRole('button', { name: '对话', exact: true }).click(); await send('验证 Responses 思考摘要'); await until(chat, c => c.busy && c.generationPhase === 'thinking'); await until(chat, c => !c.busy && c.messages.at(-1)?.status === 'complete');
  assert.equal((await chat()).messages.at(-1).text, '这是 Responses 最终台词。'); assert.equal((await chat()).messages.at(-1).reasoning, 'Responses 公开摘要测试。');
  assert.equal(requestPaths.at(-1), '/v1/responses'); assert.equal(requests.at(-1).store, false); assert.equal(requests.at(-1).max_output_tokens, 8192); assert.deepEqual(requests.at(-1).reasoning, { effort: 'high', summary: 'auto' });
  await panel.getByRole('button', { name: '模型连接', exact: true }).click(); await panel.locator('#model-streaming').uncheck(); await panel.getByRole('button', { name: '保存连接设置', exact: true }).click(); await until(chat, c => !c.settings.streaming);
  await panel.getByRole('button', { name: '对话', exact: true }).click(); await send('验证 Responses 完整回复'); await until(chat, c => !c.busy && c.messages.at(-1)?.status === 'complete'); assert.equal(requests.at(-1).stream, false); assert.equal((await chat()).messages.at(-1).reasoning, 'Responses 公开摘要测试。');
  report.checks.push('Responses 流式与非流式：摘要独立、无重复；可配置思考强度、8192 输出预算、300 秒等待；SDK 选择正确端点');
  console.log('phase: context pagination and persistent summary');
  await panel.getByRole('button', { name: '模型连接', exact: true }).click(); await panel.locator('#model-protocol').selectOption('chat-completions'); await panel.locator('#model-reasoning-effort').selectOption('default'); await panel.locator('#model-output-budget').fill('4096'); await panel.locator('#model-streaming').check();
  await panel.getByRole('button', { name: '保存连接设置', exact: true }).click(); await until(chat, c => c.settings.protocol === 'chat-completions');
  console.log('phase: edit regenerate retract through UI');
  const beforeEditSession = (await chat()).sessionId;
  await panel.getByRole('button', { name: '对话', exact: true }).click();
  await panel.getByRole('button', { name: '新对话', exact: true }).click(); await until(chat, c => c.sessionId !== beforeEditSession);
  mode = 'normal'; await send('编辑前：我住上海。'); await until(chat, c => !c.busy && c.messages.length === 2);
  const originalUser = (await chat()).messages[0];
  await panel.locator(`[data-message-id="${originalUser.id}"]`).getByRole('button', { name: '记住这句话', exact: true }).click();
  await until(chat, c => c.memories.some(m => m.sourceMessageId === originalUser.id));
  await send('接着聊旧城市'); await until(chat, c => !c.busy && c.messages.length === 4);
  const staleHistory = await chat(), mutationTarget = { characterId: staleHistory.characterId, epoch: staleHistory.epoch, sessionId: staleHistory.sessionId, historyRevision: staleHistory.historyRevision };
  const editedRaw = '  更正：我一直住北京。\n保留这些空格。  ';
  await panel.locator(`[data-message-id="${originalUser.id}"]`).getByRole('button', { name: '编辑并重发', exact: true }).click();
  assert.equal(await panel.locator('#edit-chat-message').inputValue(), originalUser.text);
  await panel.locator('#edit-chat-message').fill(editedRaw); await panel.getByRole('button', { name: '保存并重新发送', exact: true }).click();
  const editedState = await until(chat, c => !c.busy && c.historyRevision === 1 && c.messages.length === 2);
  const editedUser = editedState.messages[0]; assert.equal(editedUser.text, editedRaw); assert.notEqual(editedUser.id, originalUser.id);
  assert.equal(archivedInput(originalUser.id), undefined); assert.equal(archivedInput(editedUser.id).text, editedRaw);
  assert.equal(editedState.memories.some(m => m.sourceMessageId === originalUser.id), false);
  await until(async () => panel.locator('.chat-message').count(), n => n === 2);
  assert.equal(requests.at(-1).messages.some(m => m.content.includes('接着聊旧城市') || m.content.includes('编辑前：')), false);
  const oldAnswer = editedState.messages[1], beforeRegeneration = requests.length;
  await panel.locator(`[data-message-id="${oldAnswer.id}"]`).getByRole('button', { name: '重新生成', exact: true }).click();
  await panel.getByRole('button', { name: '确认重新生成', exact: true }).click();
  const regenerated = await until(chat, c => !c.busy && c.historyRevision === 2 && c.messages.at(-1)?.status === 'complete');
  assert.equal(regenerated.messages.length, 2); assert.equal(regenerated.messages[0].id, editedUser.id); assert.notEqual(regenerated.messages[1].id, oldAnswer.id);
  assert.equal(archivedInput(editedUser.id).text, editedRaw); assert.equal(requests.length, beforeRegeneration + 1);
  for (const action of ['retractMessage', 'editMessage', 'regenerateReply']) {
    const rejected = await pet.evaluate(({ action, target, messageId }) => window.petAPI[action]({ ...target, messageId, ...(action === 'editMessage' ? { text: '禁止改写' } : {}) }), { action, target: { ...mutationTarget, historyRevision: 2 }, messageId: editedUser.id }); assert.equal(rejected.ok, false);
  }
  const stalePage = await panel.evaluate(({ target, beforeId }) => window.petAPI.chatHistory({ ...target, kind: 'messages', beforeId }), { target: mutationTarget, beforeId: originalUser.id }); assert.equal(stalePage.ok, false);
  const staleEdit = await panel.evaluate(target => window.petAPI.editMessage({ ...target, text: '旧操作不应恢复' }), { ...mutationTarget, messageId: editedUser.id }); assert.equal(staleEdit.ok, false);
  report.checks.push('实际界面编辑旧用户消息并重发：后续对话、原文副本和来源记忆同步删除，空格换行保留；重新生成保留原问题且不重复存用户原文；旧历史操作与桌宠窗口改写被拒绝');
  mode = 'slow'; await send('编辑时停止迟到回复'); await until(chat, c => c.busy && c.draft.length > 0);
  const inflightUser = (await chat()).messages.at(-2);
  await panel.locator(`[data-message-id="${inflightUser.id}"]`).getByRole('button', { name: '编辑并重发', exact: true }).click();
  await panel.locator('#edit-chat-message').fill('改写后的当前问题'); mode = 'normal';
  await panel.getByRole('button', { name: '保存并重新发送', exact: true }).click();
  await until(chat, c => !c.busy && c.historyRevision === 3 && c.messages.at(-1)?.status === 'complete');
  assert.equal(archivedInput(inflightUser.id), undefined); assert.equal((await chat()).messages.some(m => m.text.includes('迟到回复')), false);
  const retractState = await chat(), retractCalls = requests.length;
  await panel.locator(`[data-message-id="${editedUser.id}"]`).getByRole('button', { name: '撤回', exact: true }).click();
  await panel.getByRole('button', { name: '取消修改', exact: true }).click(); assert.equal((await chat()).messages.length, 4);
  await panel.locator(`[data-message-id="${editedUser.id}"]`).getByRole('button', { name: '撤回', exact: true }).click();
  const mutationShot = join(shots, `聊天历史修改-${report.mode}.png`); await panel.screenshot({ path: mutationShot, fullPage: true }); report.screenshots.push(mutationShot);
  await panel.getByRole('button', { name: '确认撤回', exact: true }).click();
  await until(chat, c => c.historyRevision === 4 && c.messages.length === 0); await until(async () => panel.locator('.chat-message').count(), n => n === 0);
  for (const m of retractState.messages.filter(m => m.role === 'user')) assert.equal(archivedInput(m.id), undefined);
  assert.equal(requests.length, retractCalls); await closeApp(); await launch(); assert.equal((await chat()).historyRevision, 4); assert.equal((await chat()).messages.length, 0);
  report.checks.push('实际界面生成中编辑会中止旧请求；撤回确认可取消，确认后清理选中及后续两份记录，无 API 调用；清理结果与历史版本重启后保持');
  const targetState = await chat(), stale = { characterId: targetState.characterId, epoch: targetState.epoch, sessionId: targetState.sessionId, historyRevision: targetState.historyRevision };
  await closeApp();
  const seed = new DatabaseSync(join(data, 'chat.sqlite')); seed.exec('PRAGMA foreign_keys=ON; BEGIN');
  for (let i = 0; i < 110; i++) for (const role of ['user', 'assistant']) seed.prepare('INSERT INTO messages(id,session_id,role,text,status,created_at,proactive) VALUES(?,?,?,?,?,?,0)').run(randomUUID(), stale.sessionId, role, `${role === 'user' ? '分页原文' : '分页回应'} ${i}`, 'complete', Date.now());
  for (let i = 0; i < 56; i++) seed.prepare('INSERT INTO sessions(id,character_id,created_at,title) VALUES(?,?,?,?)').run(randomUUID(), stale.characterId, Date.now(), `历史会话 ${i}`);
  const expectedMessages = seed.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id=?').get(stale.sessionId).n;
  const expectedSessions = seed.prepare('SELECT COUNT(*) AS n FROM sessions WHERE character_id=?').get(stale.characterId).n;
  seed.exec('COMMIT'); seed.close(); await launch();
  let paged = await chat(); assert.equal(paged.sessionId, stale.sessionId); assert.equal(paged.messages.length, 100); assert.equal(paged.hasOlderMessages, true);
  assert.equal(paged.sessions.some(s => s.title === '历史会话 0'), false);
  await panel.getByLabel('搜索会话名称').fill('历史会话 0'); await panel.getByRole('button', { name: '历史会话 0', exact: false }).waitFor(); await panel.getByLabel('搜索会话名称').fill('');
  report.checks.push('会话名称搜索查询完整SQLite档案，找到未加载进最近50条列表的旧会话');
  await panel.getByRole('button', { name: '更早的聊天记录', exact: true }).click(); await until(async () => panel.locator('.chat-message').count(), n => n === 200);
  await panel.getByRole('button', { name: '更早的聊天记录', exact: true }).click(); await until(async () => panel.locator('.chat-message').count(), n => n === expectedMessages);
  await panel.getByRole('button', { name: '更早的聊天记录', exact: true }).waitFor({ state: 'detached' });
  assert.equal(await panel.locator('.chat-message.user p').filter({ hasText: /^分页原文 0$/ }).count(), 1);
  await panel.getByRole('button', { name: '更多历史会话', exact: true }).click(); await panel.getByRole('button', { name: '更多历史会话', exact: true }).waitFor({ state: 'detached' });
  assert.equal(await panel.getByLabel('选择会话').locator('option').count(), expectedSessions);
  await panel.locator('.chat-inspector > summary').click(); await panel.locator('.chat-summary').filter({ has: panel.locator('summary', { hasText: '会话摘要' }) }).locator('summary').click();
  const summariesBefore = requests.length; await panel.getByRole('button', { name: '整理一批历史（调用模型）', exact: true }).click(); await until(chat, c => !c.summarizing && c.summary?.revision === 1);
  const compressed = await chat(); assert.ok(compressed.summary.sourceCount > 0); assert.equal(requests.length, summariesBefore + 1); assert.equal(compressed.settings.autoSummary, false);
  const summaryShot = join(shots, `会话摘要与分页-${report.mode}.png`); await panel.screenshot({ path: summaryShot, fullPage: true }); report.screenshots.push(summaryShot);
  await closeApp(); await launch(); assert.deepEqual((await chat()).summary, compressed.summary);
  await send('更正：我一直住北京，过去上海只是旅行。'); await until(chat, c => !c.busy && c.messages.at(-1)?.status === 'complete');
  const promptNow = requests.at(-1).messages; assert.equal(promptNow.some(m => m.role === 'user' && m.content.includes('本会话历史摘要')), false); assert.ok(promptNow.some(m => m.role === 'user' && m.content === '分页原文 0')); assert.equal((await chat()).contextStats.summarizedMessages, 0); assert.equal(promptNow.at(-1).content, '更正：我一直住北京，过去上海只是旅行。');
  assert.ok((await chat()).contextStats.estimatedTokens <= (await chat()).contextStats.inputBudget);
  await panel.getByRole('button', { name: '新对话', exact: true }).click(); await until(chat, c => c.sessionId !== stale.sessionId); const newSession = (await chat()).sessionId;
  for (const action of ['clearChatHistory', 'cancelChat', 'newConversation', 'sendChat']) { const result = await panel.evaluate(({ action, stale }) => window.petAPI[action](action === 'sendChat' ? { ...stale, text: '旧会话迟到输入' } : stale), { action, stale: { ...stale, epoch: (await chat()).epoch } }); assert.equal(result.ok, false); }
  assert.equal((await chat()).sessionId, newSession); assert.equal((await chat()).summary, undefined);
  report.checks.push('超过100条原文与50个会话可从实际界面分页查看；游标稳定无重复');
  report.checks.push('LangChain SDK 生成结构化会话摘要，来源与角色版本持久化；重启恢复；预算充足时全部原文和当前纠正进入上下文，已有摘要不提前替代能放下的原文（本地模拟，非摘要语义质量评测）');
  report.checks.push('旧会话的清空、停止、新建和发送 IPC 被拒绝，不影响当前会话；用户显式关闭自动摘要');
  console.log('phase: image composer and preview');
  const imageSettings = (await chat()).settings; const { hasKey, ...connectionSettings } = imageSettings;
  assert.equal((await panel.evaluate(settings => window.petAPI.configureModel(settings), { ...connectionSettings, imageInput: 'enabled' })).ok, true);
  await app.evaluate(({ dialog }, imagePath) => { globalThis.chatOriginalPicker = dialog.showOpenDialog; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [imagePath] }); }, join(source, 'characters/yoshino/assets/portraits/v2/normal.png'));
  try { await panel.getByRole('button', { name: '添加图片', exact: true }).click(); await panel.locator('.chat-images-draft figure').waitFor(); }
  finally { await app.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.chatOriginalPicker; delete globalThis.chatOriginalPicker; }); }
  await send('分享一张参考图片'); await until(chat, c => !c.busy && c.messages.at(-1)?.status === 'complete');
  assert.equal((await chat()).messages.find(m => m.text === '分享一张参考图片').images.length, 1);
  assert.ok(requests.at(-1).messages.at(-1).content.some(block => block.type === 'image_url'));
  const imageShot = join(shots, `聊天新版-图片-${report.mode}.png`); await panel.screenshot({ path: imageShot }); report.screenshots.push(imageShot);
  await panel.locator('.chat-message .chat-image-thumb').last().click(); await panel.getByRole('dialog', { name: '图片预览' }).waitFor(); await panel.getByRole('button', { name: '关闭图片预览', exact: true }).click();
  report.checks.push('实际图片选择、输入附件、发送、消息缩略图及大图预览可用；图片仅发送本地模拟服务');
  const calls = requests.length; await app.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen')); await panel.waitForTimeout(300); assert.equal(requests.length, calls); report.checks.push('锁屏不发起模型请求；主动模型默认关闭，测试未产生外部 API 费用');
  assert.deepEqual(errors, []); report.passed = true;
} catch (error) { if (panel) await panel.screenshot({ path: join(shots, `聊天失败-${report.mode}.png`) }).catch(() => {}); report.failure = error.stack; report.lastChat = await chat().catch(() => undefined); process.exitCode = 1; }
finally {
  console.log('phase: teardown', report.failure ?? 'passed');
  if (app) await closeApp().catch(error => { report.failure ??= error.stack; report.passed = false; process.exitCode = 1; }); server.closeAllConnections(); await new Promise(done => server.close(done));
  write(join(output, `M2-chat-${report.mode}-check.json`), report); write(join(run, '验收结果.json'), report);
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, failure: report.failure }, null, 2));
}
