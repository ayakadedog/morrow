// Capture the real window using only a verified synthetic chat fixture. No model calls.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { electronExecutable } from './electron-runtime.mjs';
const root = resolve(import.meta.dirname, '..'), fixtureRoot = join(root, 'data/tests/chat');
const fixture = JSON.parse(readFileSync(join(root, 'artifacts/reports/M2-chat-source-check.json'), 'utf8'));
assert.equal(fixture.passed, true);
const run = resolve(fixture.data); assert.ok(run.startsWith(fixtureRoot + sep));
const env = { ...process.env, PET_DATA_DIR: join(run, 'runtime'), PET_CHARACTER_DIR: join(run, 'packs') }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: electronExecutable(root), args: [root], cwd: root, env });
try {
  await app.firstWindow(); let pet;
  for (let i = 0; i < 100; i++) { pet = app.windows().find(page => page.url().startsWith('pet-app:') && !page.url().includes('view=')); if (pet) break; await new Promise(done => setTimeout(done, 50)); }
  assert.ok(pet); await pet.waitForFunction(() => Boolean(window.petAPI));
  await pet.evaluate(() => window.petAPI.openChat());
  let panel;
  for (let i = 0; i < 100; i++) { panel = app.windows().find(page => page.url().includes('view=settings')); if (panel) break; await new Promise(done => setTimeout(done, 50)); }
  assert.ok(panel); await panel.locator('.chat-message .chat-image-thumb').waitFor();
  const settings = await panel.evaluate(() => window.petAPI.getChat());
  assert.equal(settings.ok, true); assert.equal(settings.value.settings.autoLongMemory, false); assert.equal(settings.value.settings.autoSummary, false); assert.equal(settings.value.settings.proactive, false);
  assert.equal(await panel.locator('.chat-message .chat-image-thumb').last().evaluate(el => getComputedStyle(el).display), 'block');
  await panel.screenshot({ path: join(root, 'artifacts/screenshots/聊天新版-图片-source.png') });
  await panel.locator('.chat-message .chat-image-thumb').last().click(); await panel.getByRole('dialog', { name: '图片预览' }).waitFor();
  await panel.screenshot({ path: join(root, 'artifacts/screenshots/聊天新版-图片预览-source.png') });
  console.log('Final thumbnail caption and image preview verified with synthetic data.');
} finally { await app.close(); }
