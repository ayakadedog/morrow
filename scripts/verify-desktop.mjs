import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { electronExecutable } from './electron-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = root;
const packaged = process.argv.includes('--packaged');
const output = join(project, 'artifacts/reports');
const dataParent = join(project, 'data/tests/desktop'); await mkdir(dataParent, { recursive: true });
const data = await mkdtemp(join(dataParent, packaged ? 'packaged 中文 数据-' : 'source 中文 数据-'));
const screenshot = join(project, 'artifacts/screenshots');
await mkdir(output, { recursive: true }); await mkdir(data, { recursive: true }); await mkdir(screenshot, { recursive: true });
const env = { ...process.env, PET_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = electronExecutable(root, packaged);
const args = packaged ? [] : [root];
const errors = [];
const report = { mode: packaged ? 'packaged' : 'source-build', checks: [], screenshots: [], errors,
  manualPending: ['实际底层桌面点击穿透', '人工拖动手感与焦点切换', '多屏插拔与不同 DPI', '中文输入法（M0 无聊天输入框）'] };
async function launch() {
  const launchedAt = performance.now();
  const application = await electron.launch({ executablePath, args, cwd: project, env, timeout: 30000 });
  application.on('window', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    await application.firstWindow(); let page;
    for (let i = 0; i < 100; i++) { page = application.windows().find(p => p.url().startsWith('pet-app:') && !p.url().includes('view=')); if (page) break; await new Promise(done => setTimeout(done, 100)); }
    assert.ok(page, 'Character window must open'); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('.portrait', { state: 'attached', timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('.portrait')?.complete && document.querySelector('.portrait')?.naturalWidth > 0);
    return { application, page, launchMs: Math.round(performance.now() - launchedAt) };
  } catch (error) { await application.close().catch(() => {}); throw error; }
}
async function getState(page) {
  const result = await page.evaluate(() => window.petAPI.getState());
  assert.equal(result.ok, true); return result.value;
}
let first, second;
try {
  first = await launch();
  const { application, page } = first;
  report.launchMs = first.launchMs;
  const initial = await getState(page);
  assert.equal(initial.character.id, 'yoshino');
  await page.evaluate(() => window.petAPI.setPreferences({ height: 460, alwaysOnTop: true, interaction: 'auto' }));
  const windowOptions = await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.getTitle().includes('Morrow'));
    return { preferences: win.webContents.getLastWebPreferences(), alwaysOnTop: win.isAlwaysOnTop(), bounds: win.getBounds() };
  });
  assert.equal(windowOptions.preferences.sandbox, true);
  assert.equal(windowOptions.preferences.contextIsolation, true);
  assert.equal(windowOptions.preferences.nodeIntegration, false);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const invalid = await page.evaluate(() => window.petAPI.setPreferences({ height: 0, command: 'ignored' }));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'INVALID_INPUT');
  assert.equal((await page.evaluate(() => window.petAPI.setExpression('../normal'))).ok, false);
  const traversal = await application.evaluate(async ({ net }) => (await net.fetch('pet-asset://character/yoshino/unknown')).status);
  assert.equal(traversal, 404);
  report.checks.push('画像加载、沙箱隔离、IPC 参数校验、未知资源拒绝');

  await page.waitForTimeout(2000);
  const metrics = [];
  for (let i = 0; i < 3; i++) {
    metrics.push(await application.evaluate(({ app }) => app.getAppMetrics().map(p => ({ pid: p.pid, type: p.type, workingSetKB: p.memory.workingSetSize, cpuPercent: p.cpu.percentCPUUsage }))));
    await page.waitForTimeout(1500);
  }
  report.metrics = metrics;
  report.memoryMiB = metrics.map(sample => Number((sample.reduce((sum, p) => sum + p.workingSetKB, 0) / 1024).toFixed(1)));
  report.cpuPercent = metrics.map(sample => Number(sample.reduce((sum, p) => sum + p.cpuPercent, 0).toFixed(2)));
  report.metricsNote = '构建版，仅角色窗口，Playwright 调试连接存在；各进程工作集之和可能包含共享页。';

  const hoverFalse = await page.evaluate(() => window.petAPI.setHover(false)); assert.equal(hoverFalse.ok, true);
  assert.equal((await getState(page)).mouseIgnored, true);
  await page.evaluate(() => window.petAPI.setHover(true));
  assert.equal((await getState(page)).mouseIgnored, false);
  await page.evaluate(() => window.petAPI.setPreferences({ interaction: 'passthrough' }));
  assert.equal((await getState(page)).mouseIgnored, true);
  await page.evaluate(() => window.petAPI.resetPosition());
  assert.equal((await getState(page)).preferences.interaction, 'auto');
  report.checks.push('自动穿透状态、完全穿透状态、交互恢复（API 层）');

  await page.evaluate(() => window.petAPI.setPreferences({ interaction: 'interactive' }));
  const previous = (await getState(page)).window;
  await page.evaluate(async () => {
    await window.petAPI.dragStart({ x: 900, y: 700 });
    await window.petAPI.dragMove({ x: 850, y: 670 });
    await window.petAPI.dragEnd();
  });
  const moved = (await getState(page)).window;
  assert.equal(moved.x, previous.x - 50); assert.equal(moved.y, previous.y - 30);
  const stage = await page.locator('.portrait').first().boundingBox();
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.down(); await page.mouse.move(stage.x + stage.width / 2 - 40, stage.y + stage.height / 2 - 30, { steps: 5 }); await page.mouse.up();
  await page.waitForTimeout(250);
  assert.equal(application.windows().filter(window => window.url().includes('view=settings')).length, 0, 'drag must not open settings');
  report.checks.push('拖动接口和实际渲染事件，拖动不误触发设置');
  const portraitFile = join(screenshot, packaged ? '四糸乃桌面窗口-M0.png' : '四糸乃桌面窗口-开发构建.png');
  await page.screenshot({ path: portraitFile, omitBackground: true }); report.screenshots.push(portraitFile);

  // Keep the always-on-top character from intercepting native clicks over the settings window.
  await page.evaluate(() => window.petAPI.setPreferences({ alwaysOnTop: false }));
  const panelPromise = application.waitForEvent('window');
  await page.evaluate(() => window.petAPI.openSettings());
  const panel = await panelPromise;
  assert.ok(panel); await panel.getByRole('button', { name: '角色与动作', exact: true }).click();
  await panel.waitForSelector('.expression-buttons');
  await page.waitForFunction(async () => (await window.petAPI.getState()).value.companion.quietReason === 'settings');
  await panel.getByRole('button', { name: '开心', exact: true }).dispatchEvent('click');
  await page.waitForFunction(async () => (await window.petAPI.getState()).value.expression === 'happy');
  await page.waitForFunction(() => [...document.querySelectorAll('.portrait')].some(img => img.dataset.active === 'true' && img.dataset.frame === 'happy'));
  await panel.getByRole('button', { name: '害羞', exact: true }).dispatchEvent('click');
  await page.waitForFunction(async () => (await window.petAPI.getState()).value.expression === 'shy');
  await page.waitForFunction(() => [...document.querySelectorAll('.portrait')].some(img => img.dataset.active === 'true' && img.dataset.frame === 'shy'));
  await panel.getByRole('button', { name: '平常', exact: true }).dispatchEvent('click');
  await panel.getByRole('button', { name: '外观', exact: true }).click(); await panel.waitForSelector('#height');
  await panel.evaluate(() => window.petAPI.setPreferences({ height: 520, alwaysOnTop: false, interaction: 'auto' }));
  const resized = await getState(page); assert.equal(resized.preferences.height, 520);
  assert.equal(resized.window.height, 584);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle().includes('Morrow')).isAlwaysOnTop()), false);
  const panelFile = join(screenshot, packaged ? '四糸乃桌宠设置-M0.png' : '四糸乃桌宠设置-开发构建.png');
  await panel.screenshot({ path: panelFile }); report.screenshots.push(panelFile);
  report.checks.push('设置页按钮事件、实际渲染三表情、尺寸调整、置顶切换（表情使用DOM事件，避免置顶窗口拦截）');

  const duplicate = spawn(executablePath, args, { cwd: project, env, windowsHide: true, stdio: 'ignore' });
  await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => { duplicate.kill(); reject(new Error('second instance did not exit')); }, 10000);
    duplicate.once('error', error => { clearTimeout(timer); reject(error); });
    duplicate.once('exit', code => { clearTimeout(timer); assert.equal(code, 0); resolveExit(); });
  });
  assert.equal(application.windows().filter(window => window.url().includes('view=settings')).length, 1);
  assert.equal(application.windows().filter(window => window.url().startsWith('pet-app:') && !window.url().includes('view=')).length, 1);
  report.checks.push('单实例：重复启动退出且没有重复角色窗口');

  const databaseBefore = (await getState(page)).database.currentLaunches;
  await application.close(); first = null;
  second = await launch();
  const restored = await getState(second.page);
  assert.equal(restored.database.previousLaunches, databaseBefore);
  assert.equal(restored.preferences.height, 520);
  assert.equal(restored.preferences.alwaysOnTop, false);
  report.checks.push('SQLite 退出重开读写、偏好持久化、非源码工作目录启动');
  report.runtime = await second.application.evaluate(() => process.versions);
  const exitPromise = new Promise(resolveExit => second.application.process().once('exit', resolveExit));
  await second.page.evaluate(() => window.petAPI.quit());
  await Promise.race([exitPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('quit timed out')), 10000))]);
  second = null;
  report.checks.push('应用退出入口正常结束主进程');
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  if (first) report.stageFailure = await first.page.evaluate(async () => ({ state: (await window.petAPI.getState()).value.expression, frames: [...document.querySelectorAll('.portrait')].map(img => ({ frame: img.dataset.frame, active: img.dataset.active, source: img.src, opacity: getComputedStyle(img).opacity })) })).catch(() => undefined);
  report.passed = false; report.failure = error.stack; throw error;
} finally {
  if (first) await first.application.close().catch(() => {});
  if (second) await second.application.close().catch(() => {});
  await writeFile(join(output, packaged ? 'M0-packaged-check.json' : 'M0-source-check.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, memoryMiB: report.memoryMiB, launchMs: report.launchMs, failure: report.failure }, null, 2));
}
