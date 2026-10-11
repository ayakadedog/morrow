import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPack } from '../../src/main/characters/PackLoader';
import { CharacterService } from '../../src/main/characters/CharacterService';
import { CompanionDirector } from '../../src/main/companion/CompanionDirector';
import { CompanionLedger } from '../../src/main/companion/CompanionLedger';
import { PreferenceStore } from '../../src/main/settings/preferences';
import { differentRoleFixture, roleFixture, registry, temporary, remove } from './fixtures';
const dirs: string[] = [], directors: CompanionDirector[] = [];
function setup() {
  const root = temporary(); dirs.push(root); roleFixture(root, 'role-a'); differentRoleFixture(root, 'role-b'); registry(root, ['role-a', 'role-b']);
  const prefs = new PreferenceStore(root), service = new CharacterService(root), ledger = new CompanionLedger(root);
  prefs.value.greetings = false; prefs.value.proactive = false;
  const director = new CompanionDirector(service.current, () => prefs.value, ledger, () => {}, Date.now, () => 0);
  directors.push(director); director.stageReady(1);
  return { root, prefs, service, ledger, director };
}
function mutate(root: string, file: string, change: (value: any) => void) {
  const path = join(root, 'role-b', file), value = JSON.parse(readFileSync(path, 'utf8')); change(value); writeFileSync(path, JSON.stringify(value));
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T10:00:00Z')); });
afterEach(() => { directors.splice(0).forEach(d => d.dispose()); vi.useRealTimers(); dirs.splice(0).forEach(remove); });
describe('character-owned interaction contract', () => {
  it('switches all metadata and bindings with different IDs and rejects old commands and completions', () => {
    const { service, director } = setup(); director.interact('greet'); const old = director.state.presentation!;
    const prepared = service.prepare('role-b'); expect(Object.keys(prepared.character.actions)).toEqual(['rest', 'nod']);
    expect(prepared.character.catalog.actions.nod.label).toBe('蓝色点头'); expect(prepared.character.bubble.choices).toEqual(['cheer']);
    director.setPack(service.commit(prepared.token), service.epoch); director.stageReady(service.epoch);
    expect(() => director.interact('greet')).toThrow(); expect(() => director.playAction('puppet')).toThrow();
    director.interact('cheer'); expect(director.state.presentation?.action).toBe('nod'); expect(director.state.expression).toBe('bright');
    const next = director.state.presentation!.id; director.animationFinished(old.epoch, old.id); expect(director.state.presentation!.id).toBe(next);
    const bubbleId = director.state.bubble!.id; director.interact('cheer'); expect(director.state.bubble!.id).toBe(bubbleId);
    vi.advanceTimersByTime(9000); director.interact('cheer'); expect(director.state.bubble!.id).not.toBe(bubbleId);
    director.setPack(service.commit(service.prepare('role-a').token), service.epoch); director.stageReady(service.epoch);
    expect(() => director.interact('cheer')).toThrow(); director.interact('greet'); expect(director.state.presentation?.action).toBe('greet');
  });
  it('uses declared drag/hover expressions and restores without a missing drag-end response', () => {
    const { service, director } = setup(); director.setPack(service.commit(service.prepare('role-b').token), service.epoch); director.stageReady(service.epoch);
    director.hover(true); vi.advanceTimersByTime(400); expect(director.state.expression).toBe('bright');
    director.hover(false); vi.advanceTimersByTime(500); expect(director.state.expression).toBe('calm');
    director.dragStart(); expect(director.state.expression).toBe('calm'); director.dragEnd();
    expect(director.state.dragging).toBe(false); expect(director.state.bubble).toBeUndefined(); expect(director.state.expression).toBe('calm');
  });
  it('uses a custom periodic action in subtle mode and respects static and quiet rules', () => {
    const { service, director, prefs, ledger } = setup(); director.setPack(service.commit(service.prepare('role-b').token), service.epoch); director.stageReady(service.epoch);
    prefs.value.animations = 'subtle'; vi.advanceTimersByTime(1000); director.tick(); expect(director.state.presentation?.action).toBe('nod');
    expect(ledger.value.automaticTimes).toHaveLength(0); director.stop(); prefs.value.animations = 'off'; vi.advanceTimersByTime(3000); director.tick(); expect(director.state.presentation).toBeUndefined();
    prefs.value.animations = 'full'; director.setEnvironment({ locked: true }); director.tick(); expect(director.state.presentation).toBeUndefined();
    expect(() => director.interact('startup')).toThrow(); expect(() => director.interact('__proto__')).toThrow();
  });
  it('rejects invalid cross-file references and keeps the old pack usable', () => {
    const { root, service } = setup(); mutate(root, 'interaction/bubble.json', b => { b.choices = ['missing']; });
    expect(() => service.prepare('role-b')).toThrow(); expect(service.current.view.id).toBe('role-a');
    mutate(root, 'interaction/bubble.json', b => { b.choices = ['cheer']; }); mutate(root, 'interaction/behaviors.json', b => { b.ambient.action = 'blink'; });
    expect(() => service.prepare('role-b')).toThrow();
    mutate(root, 'interaction/behaviors.json', b => { b.ambient.action = 'nod'; b.events.click = 'missing'; }); expect(() => service.prepare('role-b')).toThrow();
  });
  it('rejects mismatched catalog, executable styling and reserved commands', () => {
    const { root } = setup(); mutate(root, 'interaction/actions.json', b => { b.actions.puppet = { label: '错误' }; }); expect(() => loadPack(root, 'role-b')).toThrow();
    mutate(root, 'interaction/actions.json', b => { delete b.actions.puppet; }); mutate(root, 'interaction/bubble.json', b => { b.theme.background = 'url(file:///x)'; }); expect(() => loadPack(root, 'role-b')).toThrow();
    mutate(root, 'interaction/bubble.json', b => { b.theme.background = '#ffffff'; }); mutate(root, 'interaction/behaviors.json', b => { b.commands.startup = { label: '越界', response: 'arrival' }; }); expect(() => loadPack(root, 'role-b')).toThrow();
  });
  it('loads a minimal legacy pack quietly without Yoshino labels, expressions or commands', () => {
    const { root } = setup(); mutate(root, 'manifest.json', b => { delete b.catalogConfig; delete b.behaviorConfig; delete b.bubbleConfig; delete b.interactionConfig; });
    const pack = loadPack(root, 'role-b'); expect(pack.lines).toEqual({}); expect(pack.view.behavior.events).toEqual({}); expect(pack.view.behavior.commands).toEqual({});
    expect(pack.view.behavior.states).toEqual({}); expect(pack.view.behavior.ambient).toBeUndefined(); expect(pack.view.bubble.choices).toEqual([]);
    expect(pack.view.catalog.actions.nod.label).toBe('nod');
  });
});
