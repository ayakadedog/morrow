import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, cpSync, readdirSync, linkSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { electronExecutable } from './electron-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), project = root;
const packaged = process.argv.includes('--packaged');
const testRoot = join(project, 'data/tests/companion'); mkdirSync(testRoot, { recursive: true });
const run = mkdtempSync(join(testRoot, packaged ? 'packaged-' : 'source-'));
const data = join(run, '中文运行数据'); mkdirSync(data);
const output = join(project, 'artifacts/reports'); mkdirSync(output, { recursive: true });
const screenshots = join(project, 'artifacts/screenshots'); mkdirSync(screenshots, { recursive: true });
const env = { ...process.env, PET_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
if (!packaged) {
  const packs = join(run, 'packs'); mkdirSync(packs); env.PET_CHARACTER_DIR = packs;
  const original = join(project, 'characters/yoshino');
  for (const id of ['yoshino', 'test-b', 'test-broken']) {
    const target = join(packs, id);
    cpSync(original, target, { recursive: true, filter: p => !p.includes('references') && !p.includes('voice') && !p.endsWith('.png') });
    function linkImages(dir) {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        if (['references', 'voice'].includes(item.name)) continue;
        const file = join(dir, item.name);
        if (item.isDirectory()) linkImages(file);
        else if (file.endsWith('.png')) { const dest = join(target, relative(original, file)); mkdirSync(dirname(dest), { recursive: true }); linkSync(file, dest); }
      }
    }
    linkImages(original);
    const manifest = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8'));
    manifest.id = id;
    if (id !== 'yoshino') delete manifest.roleConfig;
    if (id !== 'yoshino') { manifest.displayName = `验收角色 ${id}`; manifest.shortName = id; manifest.speakers.yoshino.displayName = id; }
    if (id === 'test-broken') manifest.visual.expressions.normal = 'assets/portraits/不存在.png';
    writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest));
    const framesPath = join(target, manifest.visual.frameAnimationConfig), frames = JSON.parse(readFileSync(framesPath, 'utf8'));
    frames.characterId = id; writeFileSync(framesPath, JSON.stringify(frames));
    if (id === 'test-b') {
      const path = join(target, manifest.interactionConfig), content = JSON.parse(readFileSync(path, 'utf8'));
      for (const lines of Object.values(content.responses ?? content.events)) for (const line of lines) line.text = `角色 B：${line.text}`;
      writeFileSync(path, JSON.stringify(content));
    }
  }
  writeFileSync(join(packs, 'registry.json'), JSON.stringify({ schemaVersion: 1, defaultCharacterId: 'yoshino', characters: ['yoshino', 'test-b', 'test-broken'].map(id => ({ id, manifest: `${id}/manifest.json` })) }));
}
const executablePath = electronExecutable(root, packaged);
const args = packaged ? [] : [root];
const report = { mode: packaged ? 'packaged' : 'source', data, checks: [], errors: [], screenshots: [], manualPending: ['真实桌面底层点击与拖动手感', '多屏插拔、不同 DPI、睡眠唤醒', '全屏检测与不同游戏兼容性'] };
let active;
async function state(page) { const result = await page.evaluate(() => window.petAPI.getState()); assert.equal(result.ok, true); return result.value; }
async function launch() {
  const start = performance.now();
  const app = await electron.launch({ executablePath, args, cwd: project, env, timeout: 30000 }); active = app;
  // UI automation does not reset the system's physical-input idle clock. Keep this scenario deterministic.
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 10; });
  app.on('window', p => p.on('pageerror', e => report.errors.push(e.message)));
  let page = await app.firstWindow();
  if (page.url().includes('view=')) page = app.windows().find(p => !p.url().includes('view=')) ?? page;
  page.on('pageerror', e => report.errors.push(e.message));
  await page.waitForSelector('.portrait[data-active="true"]');
  await page.waitForFunction(() => document.querySelector('.portrait[data-active="true"]')?.naturalWidth === 1024);
  await page.waitForFunction(async expected => (await window.petAPI.getState()).value?.companion.fullscreenObserver === expected,
    process.platform === 'win32' ? 'ready' : 'unavailable');
  await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.getTitle().includes('Morrow')), area = screen.getPrimaryDisplay().workArea;
    win.setPosition(area.x + 50, area.y + 60);
  });
  const bubble = app.windows().find(p => p.url().includes('view=bubble')); assert.ok(bubble);
  return { app, page, bubble, launchMs: Math.round(performance.now() - start) };
}
async function until(page, predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await state(page); if (predicate(value)) return value; await page.waitForTimeout(60); }
  const last = await state(page);
  throw new Error(`Timed out: ${predicate.toString()}\n${JSON.stringify({ role: last.character.id, companion: last.companion, preferences: last.preferences })}`);
}
async function checkFrames(page, action, expected) {
  await page.evaluate(action => window.petAPI.playAction(action), action);
  const seen = new Set(); const end = Date.now() + 2200;
  while (Date.now() < end) {
    seen.add(await page.locator('.portrait[data-active="true"]').getAttribute('data-frame'));
    if (!(await state(page)).companion.presentation) break;
    await page.waitForTimeout(25);
  }
  for (const frame of expected) assert.ok(seen.has(frame), `${action} missing ${frame}; saw ${[...seen]}`);
  await until(page, s => !s.companion.presentation);
  await page.waitForFunction(() => document.querySelector('.portrait[data-active="true"]')?.dataset.frame === 'normal');
}
async function checkMotion(page, action) {
  const selector = (await state(page)).character.actions[action].kind === 'rig' ? '.rig-canvas' : '.motion-canvas';
  await page.evaluate(action => window.petAPI.playAction(action), action);
  await page.waitForFunction(selector => Number(document.querySelector(selector)?.dataset.progress) > .05 && getComputedStyle(document.querySelector(selector)).opacity === '1', selector);
  const samples = new Set(); const end = Date.now() + 2300;
  const pixels = new Set(), feet = new Set(); let painted = false, captured = false;
  while (Date.now() < end && (await state(page)).companion.presentation) {
    samples.add(await page.locator(selector).getAttribute('data-progress'));
    const snapshot = await page.locator(selector).evaluate(canvas => {
      const rig = canvas.classList.contains('rig-canvas'), gl = rig ? null : canvas.getContext('webgl');
      const bytes = rig ? canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data : new Uint8Array(canvas.width * canvas.height * 4);
      if (gl) gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
      let all = 2166136261, lower = 2166136261, alpha = 0;
      for (let i = 0; i < bytes.length; i += 16) { all = Math.imul(all ^ bytes[i],16777619); if(rig ? i > bytes.length * .65 : i < bytes.length * .35) lower = Math.imul(lower ^ bytes[i],16777619); alpha += bytes[i+3] > 0 ? 1 : 0; }
      return { all, lower, alpha };
    });
    pixels.add(snapshot.all); feet.add(snapshot.lower); painted ||= snapshot.alpha > 100;
    if (!captured && samples.size >= 8) {
      const file = join(screenshots, `四糸乃连续动作-${action}-${report.mode}.png`);
      await page.screenshot({ path: file, omitBackground: true }); report.screenshots.push(file); captured = true;
    }
    await page.waitForTimeout(35);
  }
  assert.ok(samples.size > 15, `${action} did not produce continuous updates: ${samples.size}`);
  assert.ok(painted && pixels.size > 8, `${action} continuous pixels did not render`);
  assert.equal(feet.size, 1, `${action} must keep lower body fixed`);
  (report.motionSamples ??= []).push({ action, progressUpdates: samples.size, pixelVariants: pixels.size, lowerBodyVariants: feet.size, painted });
  await until(page, s => !s.companion.presentation);
  assert.equal(await page.locator(selector).evaluate(canvas => getComputedStyle(canvas).opacity), '0');
}
try {
  const { app, page, bubble, launchMs } = await launch(); report.launchMs = launchMs;
  await until(page, s => s.companion.bubble?.source === 'startup');
  assert.equal((await state(page)).character.id, 'yoshino');
  assert.equal(Object.keys((await state(page)).character.frames).length, 9);
  await bubble.waitForSelector('.speech-text');
  assert.ok((await bubble.locator('.speech-text').innerText()).length > 0);
  report.checks.push('启动问候、9 张 v2 图片解码、独立气泡、全屏辅助程序就绪');
  report.initialMetrics = await app.evaluate(({ app }) => app.getAppMetrics().map(p => ({ type: p.type, workingSetKB: p.memory.workingSetSize, cpu: p.cpu.percentCPUUsage })));
  report.initialMemoryMiB = Math.round(report.initialMetrics.reduce((sum, p) => sum + p.workingSetKB, 0) / 1024);
  await page.evaluate(() => window.petAPI.stopAction());
  const security = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ title: w.getTitle(), focusable: w.isFocusable(), preferences: w.webContents.getLastWebPreferences() })));
  for (const win of security) { assert.equal(win.preferences.sandbox, true); assert.equal(win.preferences.contextIsolation, true); assert.equal(win.preferences.nodeIntegration, false); assert.equal(win.focusable, false); }
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal((await page.evaluate(() => window.petAPI.setPreferences({ height: 0, command: 'invalid' }))).ok, false);
  assert.equal((await bubble.evaluate(() => window.petAPI.dragStart({ x: 10, y: 10 }))).ok, false);
  assert.equal(await app.evaluate(async ({ net }) => (await net.fetch('pet-asset://character/yoshino/unknown')).status), 404);
  report.checks.push('窗口不抢焦点、沙箱隔离、参数校验、跨窗口拖动调用与未知资源拒绝');

  await page.evaluate(() => window.petAPI.setPreferences({ proactive: false, greetings: false, animations: 'full', height: 460, interaction: 'interactive' }));
  for (const action of ['greet','smallgreet','shy','comfort','lookaround','puppet']) await checkMotion(page, action);
  await checkFrames(page, 'blink', ['blink-half', 'blink-closed']);
  for (let i = 0; i < 8; i++) { await page.evaluate(() => window.petAPI.playAction('greet')); await page.waitForTimeout(40); await page.evaluate(() => window.petAPI.stopAction()); }
  await page.waitForFunction(() => document.querySelector('.portrait[data-active="true"]')?.dataset.frame === 'normal');
  assert.equal((await state(page)).companion.presentation, undefined);
  report.checks.push('大幅分层挥手与五种连续动作真实像素更新、下部固定、局部眨眼，8 次快速打断后恢复正常姿态');

  await page.mouse.move(5, 5); await page.evaluate(() => window.petAPI.setHover(false)); await page.evaluate(() => window.petAPI.stopAction()); await page.waitForTimeout(8500);
  await page.mouse.move(175, 245); await page.waitForTimeout(160); await page.mouse.move(5, 5); await page.waitForTimeout(550);
  assert.equal((await state(page)).companion.bubble, undefined);
  await page.mouse.move(175, 245);
  await until(page, s => s.companion.bubble?.source === 'hover');
  await page.mouse.move(5, 5); await until(page, s => !s.companion.bubble);
  report.checks.push('真实 pointer 事件：快速掠过不搭话，稳定悬停回应，移开后收起');

  await page.mouse.click(175, 245);
  await until(page, s => s.companion.bubble?.source === 'click');
  await bubble.getByRole('button', { name: '安慰一下', exact: true }).click();
  await until(page, s => s.companion.bubble?.source === 'comfort');
  const bubbleFile = join(screenshots, `四糸乃互动气泡-M1-${report.mode}.png`); await bubble.screenshot({ path: bubbleFile, omitBackground: true }); report.screenshots.push(bubbleFile);
  await bubble.getByRole('button', { name: '关闭气泡' }).click(); await until(page, s => !s.companion.bubble);
  await page.mouse.move(175, 245); await page.mouse.down(); await page.mouse.move(135, 215, { steps: 6 }); await page.mouse.up();
  await until(page, s => !s.companion.dragging && s.companion.bubble?.source === 'drag-end');
  assert.equal(app.windows().length, 2);
  report.checks.push('点击回应、气泡快速选择与关闭、实际拖动放下反馈、拖动不打开设置');
  await page.evaluate(() => window.petAPI.stopAction());
  await page.mouse.move(5, 5); await page.evaluate(() => window.petAPI.setPreferences({ interaction: 'auto' }));
  await until(page, s => s.mouseIgnored);
  await page.mouse.move(175, 245); await until(page, s => !s.mouseIgnored);
  await page.mouse.move(35, 40); await until(page, s => s.mouseIgnored);
  await page.evaluate(() => window.petAPI.setPreferences({ interaction: 'passthrough' }));
  assert.equal((await page.evaluate(() => window.petAPI.dragStart({ x: 100, y: 100 }))).ok, false);
  await page.evaluate(() => window.petAPI.resetPosition());
  report.checks.push('人物 alpha 区域命中、透明空洞退出交互、完全穿透与托盘恢复接口');

  const panelPromise = app.waitForEvent('window'); await page.evaluate(() => window.petAPI.openSettings()); const panel = await panelPromise;
  await panel.waitForSelector('#proactive'); assert.equal((await state(page)).companion.quietReason, 'settings');
  await panel.getByRole('button', { name: '角色与动作', exact: true }).click();
  await panel.getByRole('button', { name: '开心', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.portrait[data-active="true"]')?.dataset.frame === 'happy');
  await checkMotion(page, 'greet');
  const roleFile = join(screenshots, `四糸乃角色动作设置-M1-${report.mode}.png`); await panel.screenshot({ path: roleFile }); report.screenshots.push(roleFile);
  if (!packaged) {
    await panel.locator('#character').selectOption('test-b'); await until(page, s => s.character.id === 'test-b' && s.companion.epoch === 2);
    await page.waitForFunction(() => document.querySelector('.portrait[data-active="true"]')?.src.includes('/test-b/')); await page.waitForTimeout(150);
    await page.evaluate(() => window.petAPI.interact('company')); await until(page, s => s.companion.bubble?.text.startsWith('角色 B：'));
    await panel.locator('#character').selectOption('test-broken'); await panel.waitForSelector('[role="alert"]');
    assert.equal((await state(page)).character.id, 'test-b');
    await panel.locator('#character').selectOption('yoshino'); await until(page, s => s.character.id === 'yoshino' && s.companion.epoch === 3);
    await page.waitForFunction(() => document.querySelector('.portrait[data-active="true"]')?.src.includes('/yoshino/')); await page.waitForTimeout(150);
    await page.evaluate(() => window.petAPI.interact('company')); await until(page, s => s.companion.bubble && !s.companion.bubble.text.startsWith('角色 B：'));
    report.checks.push('设置界面 A→B→A 切换：图片、台词、说话者一起切换；坏包保留当前角色');
  } else assert.equal(await panel.locator('#character').isDisabled(), true);
  await panel.getByRole('button', { name: '外观', exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => window.petAPI.interact('greet')); await until(page, s => !s.companion.presentation && s.companion.bubble?.source === 'greet');
  assert.equal(await page.locator('.character-motion').getAttribute('data-idle'), 'false');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await panel.locator('#animations').selectOption('off'); await page.evaluate(() => window.petAPI.interact('greet'));
  assert.equal((await state(page)).companion.presentation, undefined); assert.equal((await state(page)).companion.bubble.source, 'greet');
  await panel.evaluate(() => window.petAPI.setPreferences({ height: 520, alwaysOnTop: false, interaction: 'auto', animations: 'full', quietUntil: Date.now() + 1800000 }));
  const resized = await state(page); assert.equal(resized.window.height, 584);
  const appearanceFile = join(screenshots, `四糸乃外观设置-M1-${report.mode}.png`); await panel.screenshot({ path: appearanceFile }); report.screenshots.push(appearanceFile);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle().includes('桌宠设置')).close());
  await until(page, s => s.companion.quietReason === 'manual');
  await page.evaluate(() => window.petAPI.interact('company')); await until(page, s => s.companion.bubble?.source === 'company');
  await page.evaluate(() => window.petAPI.dragStart({ x: 100, y: 100 }));
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen')); await until(page, s => s.companion.quietReason === 'locked' && !s.companion.bubble && !s.companion.dragging);
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('unlock-screen')); await until(page, s => s.companion.quietReason === 'manual');
  await page.evaluate(() => window.petAPI.hide()); assert.equal((await state(page)).companion.visible, false);
  await page.evaluate(() => window.petAPI.resetPosition()); assert.equal((await state(page)).companion.visible, true);
  assert.equal((await state(page)).companion.bubble, undefined);
  report.checks.push('设置暂停自动演出、手动预览有效、减少动态与静态保留文字、安静模式手动回应、拖动中锁屏取消、隐藏恢复不补播');
  await page.evaluate(() => window.petAPI.setPreferences({ quietUntil: 0 }));
  if (process.platform === 'win32') {
  const externalPath = join(run, 'fullscreen-test.cjs');
  writeFileSync(externalPath, `const {app,BrowserWindow}=require('electron'); app.setPath('userData',${JSON.stringify(join(run, '全屏测试数据'))}); app.whenReady().then(()=>{const w=new BrowserWindow({fullscreen:true,autoHideMenuBar:true,backgroundColor:'#eef3eb'}); w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<h1 style="font:24px sans-serif;padding:40px">桌宠全屏安静检测 · 自动验收</h1>'));}); app.on('window-all-closed',()=>app.quit());`);
  const external = await electron.launch({ executablePath: electronExecutable(root), args: [externalPath], env: { ...env, PET_DATA_DIR: join(run, '全屏测试数据') }, cwd: project });
  try {
    const fullscreenPage = await external.firstWindow(); await fullscreenPage.waitForLoadState('domcontentloaded');
    await external.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setAlwaysOnTop(true); win.show(); win.setFullScreen(true); win.moveTop(); win.focus(); });
    await fullscreenPage.waitForTimeout(300);
    report.fullscreenFixture = await external.evaluate(({ BrowserWindow, screen }) => { const win = BrowserWindow.getAllWindows()[0]; return { focused:win.isFocused(), visible:win.isVisible(), fullscreen:win.isFullScreen(), bounds:win.getBounds(), monitor:screen.getDisplayMatching(win.getBounds()).bounds }; });
    await until(page, s => s.companion.quietReason === 'fullscreen', 12000);
  }
  finally { await external.close(); }
  await until(page, s => s.companion.quietReason === undefined, 12000);
  assert.equal((await state(page)).companion.bubble, undefined);
  report.checks.push('真实独立全屏窗口：原生检测进入安静，关闭全屏后恢复且不补播旧气泡');
  } else {
    report.checks.push('非 Windows 自动全屏检测降级，使用手动安静模式');
  }
  await page.evaluate(() => window.petAPI.setPreferences({ quietUntil: Date.now() + 1800000 }));
  const panel2Promise = app.waitForEvent('window'); await page.evaluate(() => window.petAPI.openSettings()); const panel2 = await panel2Promise;
  await panel2.waitForSelector('#proactive'); const settingsFile = join(screenshots, `四糸乃陪伴设置-M1-${report.mode}.png`); await panel2.screenshot({ path: settingsFile }); report.screenshots.push(settingsFile);
  await page.evaluate(() => window.petAPI.stopAction());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle().includes('桌宠设置')).close());
  await page.waitForTimeout(2500);
  report.settledMetrics = await app.evaluate(({ app }) => app.getAppMetrics().map(p => ({ type: p.type, workingSetKB: p.memory.workingSetSize, cpu: p.cpu.percentCPUUsage })));
  report.settledMemoryMiB = Math.round(report.settledMetrics.reduce((sum, p) => sum + p.workingSetKB, 0) / 1024);
  const reopenedPromise = app.waitForEvent('window'); await page.evaluate(() => window.petAPI.openSettings()); await reopenedPromise;
  const petFile = join(screenshots, `四糸乃桌面窗口-M1-${report.mode}.png`); await page.screenshot({ path: petFile, omitBackground: true }); report.screenshots.push(petFile);
  const duplicate = spawn(executablePath, args, { cwd: project, env, windowsHide: true, stdio: 'ignore' });
  await new Promise((done, fail) => { const timer = setTimeout(() => { duplicate.kill(); fail(new Error('duplicate did not exit')); }, 10000); duplicate.once('error', fail); duplicate.once('exit', code => { clearTimeout(timer); code === 0 ? done() : fail(new Error(`duplicate exit ${code}`)); }); });
  assert.equal(app.windows().length, 3); report.checks.push('重复启动仅恢复已有实例');
  report.metrics = await app.evaluate(({ app }) => app.getAppMetrics().map(p => ({ type: p.type, workingSetKB: p.memory.workingSetSize, cpu: p.cpu.percentCPUUsage })));
  report.memoryMiB = Math.round(report.metrics.reduce((sum, p) => sum + p.workingSetKB, 0) / 1024);
  report.metricsNote = '调试连接、角色和气泡、设置共三个窗口；工作集可能重复统计共享内存。';
  const launches = (await state(page)).database.currentLaunches;
  await app.close(); active = undefined;
  const second = await launch();
  const restored = await state(second.page); assert.equal(restored.database.previousLaunches, launches); assert.equal(restored.preferences.height, 520); assert.equal(restored.preferences.alwaysOnTop, false); assert.equal(restored.preferences.quietUntil > Date.now(), true);
  await second.page.waitForTimeout(1900); assert.equal((await state(second.page)).companion.bubble, undefined);
  assert.equal(JSON.parse(readFileSync(join(data, 'companion-ledger.json'), 'utf8')).automaticTimes.length, 1);
  report.checks.push('中文目录启动、SQLite、偏好和主动频率账本退出重开持久化，不重复问候');
  report.runtime = await second.app.evaluate(() => process.versions);
  const exited = new Promise(done => second.app.process().once('exit', done)); await second.page.evaluate(() => window.petAPI.quit()); await exited; active = undefined;
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.passed = false; report.failure = error.stack; process.exitCode = 1; }
finally {
  if (active) await active.close().catch(() => {});
  writeFileSync(join(output, `M1-${report.mode}-check.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(run, '验收结果.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, launchMs: report.launchMs, checks: report.checks, memoryMiB: report.memoryMiB, failure: report.failure }, null, 2));
}
