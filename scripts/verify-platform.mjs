import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { electronExecutable } from './electron-runtime.mjs';

const root = resolve(import.meta.dirname, '..');
const packaged = process.argv.includes('--packaged');
const mode = packaged ? 'packaged' : 'source';
const parent = join(root, 'data/tests/platform');
mkdirSync(parent, { recursive: true });
const data = mkdtempSync(join(parent, `${mode}-中文-`));
const env = { ...process.env, PET_DATA_DIR: data };
delete env.PET_CHARACTER_DIR;
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const errors = [];
const report = { platform: process.platform, arch: process.arch, mode, passed: false, checks: [], errors,
  manualPending: ['真实底层鼠标穿透与拖动手感', '多屏、Spaces 和全屏切换', '首次下载后的系统验证', 'API Key 钥匙串许可与升级读取'] };
let app;
async function pageFor(predicate) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const page = app.windows().find(predicate);
    if (page) return page;
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error('Expected application window did not open.');
}
async function launch() {
  app = await electron.launch({ executablePath: electronExecutable(root, packaged), args: packaged ? [] : [root], cwd: root, env, timeout: 30000 });
  app.on('window', page => page.on('pageerror', error => errors.push(error.message)));
  await app.firstWindow();
  const page = await pageFor(page => page.url().startsWith('pet-app:') && !page.url().includes('view='));
  assert.ok(page, 'pet window must exist');
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.petAPI), undefined, { timeout: 20000 });
  await page.waitForSelector('.portrait[data-active=true]', { state: 'attached' });
  await page.waitForFunction(() => document.querySelector('.portrait[data-active=true]')?.naturalWidth > 0);
  return page;
}
async function api(page, method, value) {
  const reply = await page.evaluate(async ([method, value]) => window.petAPI[method](value), [method, value]);
  assert.equal(reply.ok, true, reply.error?.message);
  return reply.value;
}
try {
  const page = await launch();
  const initial = await api(page, 'getState');
  assert.equal(initial.character.id, 'yoshino');
  assert.deepEqual(initial.characters.map(character => character.id).sort(), ['gojo', 'yoshino']);
  await api(page, 'setPreferences', { proactive: false, greetings: false, animations: 'off' });
  report.checks.push('isolated startup and registered characters');
  const details = await app.evaluate(({ app, BrowserWindow, Menu }) => {
    const pet = BrowserWindow.getAllWindows().find(win => win.getTitle().includes('Morrow'));
    return { packaged: app.isPackaged, data: app.getPath('userData'), preferences: pet.webContents.getLastWebPreferences(),
      spaces: pet.isVisibleOnAllWorkspaces(), menus: Menu.getApplicationMenu()?.items.map(item => item.label) };
  });
  assert.equal(details.packaged, packaged);
  assert.equal(resolve(details.data), resolve(data));
  assert.equal(details.preferences.contextIsolation, true);
  assert.equal(details.preferences.sandbox, true);
  assert.equal(details.preferences.nodeIntegration, false);
  if (process.platform === 'darwin') {
    assert.equal(details.spaces, true);
    assert.ok(details.menus.includes('Morrow'));
    await page.waitForFunction(async () => (await window.petAPI.getState()).value.companion.fullscreenObserver === 'unavailable');
    report.checks.push('Mac application menu, desktop Spaces and fullscreen observer fallback');
  }
  report.checks.push('packaged resource paths and renderer isolation');
  for (const id of ['gojo', 'yoshino']) {
    const prepared = await api(page, 'prepareCharacter', id);
    await page.evaluate(async urls => {
      for (const url of urls) { const image = new Image(); image.src = url; await image.decode(); }
    }, Object.values(prepared.character.expressions));
    assert.equal((await api(page, 'commitCharacter', prepared.token)).character.id, id);
  }
  report.checks.push('both character packs decode and switch');
  assert.equal((await api(page, 'setPreferences', { interaction: 'passthrough' })).mouseIgnored, true);
  assert.equal((await api(page, 'setPreferences', { interaction: 'interactive' })).mouseIgnored, false);
  const quietUntil = Date.now() + 30 * 60000;
  const quiet = await api(page, 'setPreferences', { quietUntil, alwaysOnTop: false });
  assert.equal(quiet.companion.quietReason, 'manual');
  report.checks.push('mouse pass-through API and manual quiet mode');
  await api(page, 'openChat');
  await app.firstWindow();
  const panel = await pageFor(page => page.url().includes('tab=chat'));
  assert.ok(panel);
  await panel.waitForSelector('#chat-input');
  await api(panel, 'configureModel', { baseUrl: 'http://127.0.0.1:11434/v1', model: 'platform-fixture', proactive: false, memoryEnabled: true });
  const chat = await api(panel, 'getChat');
  const target = { characterId: chat.characterId, epoch: chat.epoch, sessionId: chat.sessionId, historyRevision: chat.historyRevision };
  await api(panel, 'addMemory', { ...target, text: '平台验收：用户喜欢在晚上阅读。' });
  assert.equal((await api(panel, 'getChat')).memories.length, 1);
  await api(panel, 'openDataAdmin', 'overview');
  const admin = await pageFor(page => page.url().includes('view=admin'));
  assert.ok(admin);
  await admin.getByRole('navigation', { name: '后台导航' }).waitFor();
  report.checks.push('chat, local model configuration, SQLite memory and admin window');
  await app.close(); app = undefined;
  const restoredPage = await launch();
  const restored = await api(restoredPage, 'getState');
  assert.equal(restored.database.previousLaunches, initial.database.currentLaunches);
  assert.equal(restored.preferences.quietUntil, quietUntil);
  assert.equal(restored.preferences.alwaysOnTop, false);
  await api(restoredPage, 'openChat');
  const restoredPanel = await pageFor(page => page.url().includes('tab=chat'));
  assert.ok(restoredPanel);
  await restoredPanel.waitForSelector('#chat-input');
  assert.equal((await api(restoredPanel, 'getChat')).memories.length, 1);
  report.checks.push('restart retains preferences and memory');
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  const output = join(root, 'artifacts/reports');
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, `platform-${process.platform}-${process.arch}-${mode}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
