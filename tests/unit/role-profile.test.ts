import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { roleProfileSchema, roleProfileContext } from '../../src/shared/roleProfile';
import { loadPack } from '../../src/main/characters/PackLoader';
import { CompanionDirector } from '../../src/main/companion/CompanionDirector';
import { CompanionLedger } from '../../src/main/companion/CompanionLedger';
import { PreferenceStore } from '../../src/main/settings/preferences';
import { temporary, remove, roleFixture, registry } from './fixtures';
const profile = roleProfileSchema.parse(JSON.parse(readFileSync(resolve('characters/yoshino/profile/role.json'), 'utf8')));
describe('self-contained role profiles and companion model policy', () => {
  it('loads structured identity while leaving dialogue examples to provider message preparation', () => {
    const pack = loadPack(resolve('characters'), 'yoshino'); expect(pack.roleProfile?.revision).toBe(profile.revision);
    const text = roleProfileContext(profile, '四糸奈 休息', true); expect(text).toContain('手偶'); expect(text).not.toContain(JSON.stringify(profile.examples)); expect(text).toContain('proactiveStyle'); expect(text.length).toBeLessThan(9000);
  });
  it('rejects unproven canon claims, duplicate knowledge while accepting large core', () => {
    const copy = structuredClone(profile); delete copy.knowledge[0].source; expect(roleProfileSchema.safeParse(copy).success).toBe(false);
    copy.knowledge[0].source = profile.knowledge[0].source; copy.knowledge.push(copy.knowledge[0]); expect(roleProfileSchema.safeParse(copy).success).toBe(false);
    const huge = structuredClone(profile); huge.boundaries = Array(12).fill('x'.repeat(240)); huge.speech.rules = Array(12).fill('y'.repeat(240)); expect(roleProfileSchema.safeParse(huge).success).toBe(true);
  });
  it('rejects wrong profile identity or unknown example speaker, while accepting old packs', () => {
    const root = temporary(); try {
      roleFixture(root, 'role-a'); registry(root, ['role-a']); expect(loadPack(root, 'role-a').roleProfile).toBeUndefined();
      const file = join(root, 'role-a/manifest.json'), manifest = JSON.parse(readFileSync(file, 'utf8')); manifest.roleConfig = 'profile/role.json'; writeFileSync(file, JSON.stringify(manifest));
      expect(() => loadPack(root, 'role-a')).toThrow('角色设定');
      const copy = structuredClone(profile); copy.characterId = 'role-a'; copy.examples[0].speaker = 'unknown-speaker'; writeFileSync(join(root, 'role-a/profile/role.json'), JSON.stringify(copy)); expect(() => loadPack(root, 'role-a')).toThrow('说话者');
    } finally { remove(root); }
  });
  it('only calls the remote proactive hook through shared quiet and ledger limits', () => {
    const root = temporary(); const pack = loadPack(resolve('characters'), 'yoshino'), prefs = new PreferenceStore(root), ledger = new CompanionLedger(root);
    let now = new Date('2026-10-04T02:00:00Z').getTime(), calls = 0;
    prefs.value.greetings = false; prefs.value.animations = 'off';
    const director = new CompanionDirector(pack, () => prefs.value, ledger, () => {}, () => now, () => 0, () => { calls++; return true; });
    try {
      director.stageReady(1); director.setEnvironment({ idleSeconds: 10 }); now += 120001;
      prefs.value.quietUntil = now + 1000; director.tick(); expect(calls).toBe(0);
      prefs.value.quietUntil = 0; director.setEnvironment({ fullscreen: true }); director.tick(); expect(calls).toBe(0);
      director.setEnvironment({ fullscreen: false }); director.tick(); expect(calls).toBe(1); expect(director.state.bubble).toBeUndefined(); expect(ledger.value.automaticTimes.length).toBe(1);
      now += 60000; director.tick(); expect(calls).toBe(1); director.visibility(false); now += 3600001; director.tick(); expect(calls).toBe(1);
    } finally { director.dispose(); remove(root); }
  });
});
