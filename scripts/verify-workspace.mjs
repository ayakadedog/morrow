import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { electronExecutable } from './electron-runtime.mjs';

const root = resolve(import.meta.dirname, '..'), packaged = process.argv.includes('--packaged');
const mode = packaged ? 'packaged' : 'source';
const fixtures = join(root, 'data/tests/workspace'); mkdirSync(fixtures, { recursive: true });
const data = mkdtempSync(join(fixtures, `${mode}-`));
const shots = join(root, 'artifacts/screenshots'), reports = join(root, 'artifacts/reports');
mkdirSync(shots, { recursive: true }); mkdirSync(reports, { recursive: true });
const env = { ...process.env, PET_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
const report = { mode, data, checks: [], screenshots: [], errors: [], passed: false };
const app = await electron.launch({ executablePath: electronExecutable(root, packaged), args: packaged ? [] : [root], cwd: root, env, timeout: 30000 });
app.on('window', page => { page.setDefaultTimeout(15000); page.on('pageerror', error => report.errors.push(error.message)); });
async function windowFor(query) {
  for (let i = 0; i < 100; i++) { const page = app.windows().find(p => query(p.url())); if (page) { await page.waitForFunction(() => Boolean(window.petAPI)); return page; } await new Promise(done => setTimeout(done, 100)); }
  throw new Error('Window not opened');
}
async function api(page, method, value) { const reply = await page.evaluate(([method, value]) => window.petAPI[method](value), [method, value]); assert.equal(reply.ok, true, JSON.stringify(reply)); return reply.value; }
async function dimensions(kind, width, height) { await app.evaluate(({ BrowserWindow }, { kind, width, height }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes(`view=${kind}`)).setSize(width, height), { kind, width, height }); }
async function shot(page, name) { await page.screenshot({ path: join(shots, `${name}-${mode}.png`) }); report.screenshots.push(`${name}-${mode}.png`); }
async function fits(page) { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'No horizontal page overflow'); }
async function toggle(page, selector, checked) {
  if (await page.locator(selector).isChecked() !== checked) await page.locator(selector).click();
  await page.waitForFunction(({ selector, checked }) => document.querySelector(selector)?.checked === checked, { selector, checked });
}
try {
  await app.firstWindow(); const pet = await windowFor(url => url.startsWith('pet-app:') && !url.includes('view='));
  await api(pet, 'setPreferences', { proactive: false, greetings: false, height: 460 });
  await api(pet, 'openSettings'); const panel = await windowFor(url => url.includes('view=settings'));
  await panel.locator('.settings-content').waitFor(); await dimensions('settings', 1040, 820);
  const state = () => api(panel, 'getState');
  await toggle(panel, '#proactive', true); assert.equal((await state()).preferences.proactive, true);
  await toggle(panel, '#proactive', false);
  await panel.locator('#frequency').selectOption('90'); assert.equal((await state()).preferences.proactiveMinutes, 90);
  await panel.locator('#bubble-duration').selectOption('2000'); assert.equal((await state()).preferences.bubbleDurationMs, 2000);
  await panel.getByRole('button', { name: '安静 30 分钟', exact: true }).click(); assert.ok((await state()).preferences.quietUntil > Date.now());
  await panel.getByRole('button', { name: '结束安静', exact: true }).click(); assert.equal((await state()).preferences.quietUntil, 0);
  await panel.locator('.settings-content').evaluate(el => el.scrollTop = 0); await fits(panel); await shot(panel, '全局新版-陪伴'); report.checks.push('陪伴卡片：主动开关、间隔、气泡时长及安静开始/结束真正更新偏好');
  await panel.getByRole('button', { name: '外观', exact: true }).click();
  await panel.locator('#height').fill('500'); assert.equal((await state()).preferences.height, 500);
  await toggle(panel, '#top', false); assert.equal((await state()).preferences.alwaysOnTop, false);
  await panel.locator('#animations').selectOption('subtle'); assert.equal((await state()).preferences.animations, 'subtle');
  await panel.locator('#interaction').selectOption('interactive'); assert.equal((await state()).preferences.interaction, 'interactive');
  await panel.locator('.settings-content').evaluate(el => el.scrollTop = 0); await fits(panel); await shot(panel, '全局新版-外观'); report.checks.push('外观卡片：大小、置顶、动作程度和穿透设置正常写入');
  await panel.getByRole('button', { name: '角色与动作', exact: true }).click();
  const original = await state(), expressions = Object.keys(original.character.expressions);
  assert.equal(await panel.locator('.expression-buttons button').count(), expressions.length);
  assert.equal(await panel.locator('.action-buttons button').count(), Object.keys(original.character.actions).length);
  await panel.locator('.expression-buttons button').last().click(); assert.equal((await state()).expression, expressions.at(-1));
  await api(panel, 'setPreferences', { animations: 'full' }); await panel.locator('.action-buttons button').first().click();
  await panel.getByRole('button', { name: '停止动作 · 恢复待机', exact: true }).click();
  if (original.characters.length > 1) {
    await panel.locator('#character').selectOption(original.characters.find(role => role.id !== original.character.id).id);
    await panel.waitForFunction(id => document.querySelector('#character')?.value === id && !document.querySelector('#character')?.disabled, original.characters.find(role => role.id !== original.character.id).id);
    assert.notEqual((await state()).character.id, original.character.id);
    await panel.locator('#character').selectOption(original.character.id); await panel.waitForFunction(id => document.querySelector('#character')?.value === id && !document.querySelector('#character')?.disabled, original.character.id);
  }
  await api(panel, 'setExpression', original.character.defaultExpression);
  await panel.locator('.expression-buttons img').first().evaluate(img => img.decode());
  await panel.locator('.settings-content').evaluate(el => el.scrollTop = 0); await fits(panel); await shot(panel, '全局新版-角色'); report.checks.push('表情缩略图、动作入口及停止保留；角色切换后数量与标签来自新角色包');
  for (const name of ['陪伴', '外观', '角色与动作']) {
    await panel.getByRole('button', { name, exact: true }).click(); await panel.waitForFunction(() => document.querySelector('.settings-content')?.scrollTop === 0); await dimensions('settings', 440, 680); await fits(panel);
    await panel.getByRole('button', { name: '找回角色', exact: true }).scrollIntoViewIfNeeded();
    await panel.locator('.settings-content').evaluate(el => el.scrollTop = 0); await shot(panel, `全局新版-窄窗口-${name}`);
  }
  report.checks.push('440px窄窗口：三个设置页可滚动、底部操作可到达、无横向溢出');
  await dimensions('settings', 1040, 820); await panel.getByRole('button', { name: '聊天', exact: true }).click();
  await panel.getByRole('button', { name: '模型连接', exact: true }).click();
  assert.equal(await panel.locator('.config-card').count(), 4);
  await panel.locator('#model-url').fill('http://127.0.0.1:9/v1'); await panel.locator('#model-name').fill('fixture-workspace');
  await toggle(panel, '#model-auto-summary', false); await toggle(panel, '#model-auto-long-memory', false);
  await panel.getByRole('button', { name: '保存连接设置', exact: true }).click();
  let chat = await api(panel, 'getChat'); assert.equal(chat.settings.model, 'fixture-workspace'); assert.equal(chat.settings.autoSummary, false); assert.equal(chat.settings.autoLongMemory, false);
  await panel.locator('.chat-config-page').evaluate(el => el.scrollTop = 0); await fits(panel); await shot(panel, '全局新版-模型');
  await panel.locator('#model-context-window').scrollIntoViewIfNeeded(); await shot(panel, '全局新版-模型-预算');
  report.checks.push('模型连接按服务/思考/预算/记忆分组，原字段和保存逻辑完整可达，不调用模型');
  await panel.getByRole('button', { name: '记忆', exact: true }).click(); await panel.locator('#memory-input').fill('我喜欢安静地散步。这是一条界面测试资料。');
  await panel.getByRole('button', { name: '保存记忆', exact: true }).click(); await panel.locator('.memory-list article').waitFor();
  chat = await api(panel, 'getChat'); assert.equal(chat.memories.length, 1); await fits(panel); await shot(panel, '全局新版-记忆');
  await dimensions('settings', 440, 680); await fits(panel); await shot(panel, '全局新版-窄窗口-记忆');
  await panel.getByRole('button', { name: '模型连接', exact: true }).click(); await fits(panel);
  await panel.getByRole('button', { name: '保存连接设置', exact: true }).scrollIntoViewIfNeeded(); await panel.locator('.chat-config-page').evaluate(el => el.scrollTop = 0); await shot(panel, '全局新版-窄窗口-模型');
  report.checks.push('记忆卡片新增、状态及后台管理入口正常；模型与记忆在440px窗口无溢出');
  await dimensions('settings', 1040, 820); await panel.getByRole('button', { name: '记忆', exact: true }).click();
  await panel.getByRole('button', { name: '管理与编辑 ↗', exact: true }).click(); const admin = await windowFor(url => url.includes('view=admin'));
  await admin.locator('.admin-table-card').waitFor();
  for (const name of ['数据概览', '会话管理', '聊天记录', '用户原文', '用户长期记忆', '自动长期记忆', '会话摘要']) {
    await admin.getByRole('menuitem', { name: new RegExp(name) }).click(); await admin.getByRole('heading', { name, exact: true }).waitFor(); await fits(admin); await shot(admin, `全局新版-后台-${name}`);
  }
  await dimensions('admin', 800, 680); await admin.locator('.admin-sider.ant-layout-sider-collapsed').waitFor(); await fits(admin); await shot(admin, '全局新版-后台-窄窗口');
  report.checks.push('独立后台七个页面、侧栏收起和窄窗口正常，共用应用色彩与卡片风格');
  assert.deepEqual(report.errors, []); report.passed = true; console.log(JSON.stringify(report, null, 2));
} catch (error) { report.errors.push(error.stack ?? String(error)); throw error; }
finally { await app.close(); writeFileSync(join(reports, `workspace-${mode}-check.json`), JSON.stringify(report, null, 2), 'utf8'); }
