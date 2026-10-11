import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadPack } from '../../src/main/characters/PackLoader';
import { CompanionDirector } from '../../src/main/companion/CompanionDirector';
import { CompanionLedger } from '../../src/main/companion/CompanionLedger';
import { PreferenceStore } from '../../src/main/settings/preferences';
import { bubbleBounds, maskHit } from '../../src/shared/geometry';
import { temporary, remove } from './fixtures';
const dirs: string[] = [], directors: CompanionDirector[] = [];
function setup() {
  const root = temporary(); dirs.push(root); const prefs = new PreferenceStore(root), ledger = new CompanionLedger(root);
  const director = new CompanionDirector(loadPack(resolve('characters'), 'yoshino'), () => prefs.value, ledger, () => {}, Date.now, () => 0);
  directors.push(director); director.stageReady(1); return { director, prefs, ledger, root };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T04:00:00Z')); });
afterEach(() => { directors.splice(0).forEach(d => d.dispose()); vi.useRealTimers(); dirs.splice(0).forEach(remove); });
describe('companion behavior and quiet rules', () => {
  it('greets once, restores after expiration and survives restart without greeting spam', () => {
    const { director, ledger, root } = setup(); vi.advanceTimersByTime(1600); expect(director.state.bubble?.source).toBe('startup');
    director.stageReady(1); vi.advanceTimersByTime(5500); expect(director.state.bubble).toBeUndefined(); expect(director.state.expression).toBe('normal');
    expect(new CompanionLedger(root).allows(Date.now(), true)).toBe(false); expect(ledger.value.automaticTimes).toHaveLength(1);
  });
  it('ignores a quick hover but responds once on a stable visit and restores on leave', () => {
    const { director } = setup(); director.hover(true); vi.advanceTimersByTime(100); director.hover(false);
    vi.advanceTimersByTime(500); expect(director.state.bubble).toBeUndefined();
    director.hover(true); vi.advanceTimersByTime(1250); expect(director.state.bubble?.source).toBe('hover');
    const id = director.state.bubble?.id; director.hover(true); expect(director.state.bubble?.id).toBe(id);
    director.hover(false); vi.advanceTimersByTime(500); expect(director.state.bubble).toBeUndefined();
  });
  it('keeps manual clicks responsive during quiet time and limits rapid repeats', () => {
    const { director, prefs } = setup(); prefs.value.quietUntil = Date.now() + 3600000; director.preferencesChanged();
    vi.advanceTimersByTime(1600); expect(director.state.bubble).toBeUndefined();
    director.interact('click'); expect(director.state.bubble?.source).toBe('click');
    const id = director.state.bubble!.id; director.interact('click'); expect(director.state.bubble!.id).toBe(id);
  });
  it('dragging interrupts the greeting and placing gives only one response', () => {
    const { director } = setup(); vi.advanceTimersByTime(1600); director.dragStart();
    expect(director.state.bubble).toBeUndefined(); expect(director.state.dragging).toBe(true);
    director.interact('click'); expect(director.state.bubble).toBeUndefined();
    director.dragEnd(); expect(director.state.bubble?.source).toBe('drag-end');
    const id = director.state.bubble!.id; director.dragEnd(); expect(director.state.bubble!.id).toBe(id);
  });
  it('hiding cancels all feedback and does not replay accumulated greetings', () => {
    const { director } = setup(); director.interact('greet'); director.visibility(false); vi.advanceTimersByTime(3600000);
    expect(director.state.bubble).toBeUndefined(); expect(director.state.presentation).toBeUndefined();
    director.visibility(true); vi.advanceTimersByTime(1600); expect(director.state.bubble).toBeUndefined();
  });
  it('does not let an old completion change a newer action or character epoch', () => {
    const { director } = setup(); director.interact('greet'); const old = director.state.presentation!;
    director.interact('comfort'); const next = director.state.presentation!;
    director.animationFinished(old.epoch, old.id); expect(director.state.presentation?.id).toBe(next.id);
    director.setPack(loadPack(resolve('characters'), 'yoshino'), 2); director.stageReady(2); director.interact('greet');
    const latest = director.state.presentation!.id; director.animationFinished(1, latest); expect(director.state.presentation!.id).toBe(latest);
  });
  it('suppresses automatic speech in full-screen/settings/locked states', () => {
    const { director } = setup(); director.setEnvironment({ fullscreen: true }); vi.advanceTimersByTime(1600);
    expect(director.state.quietReason).toBe('fullscreen'); expect(director.state.bubble).toBeUndefined();
    director.interact('greet'); expect(director.state.bubble?.source).toBe('greet');
    director.setEnvironment({ locked: true }); expect(director.state.bubble).toBeUndefined();
    director.interact('click'); expect(director.state.bubble).toBeUndefined();
  });
  it('uses persisted hourly/day caps for low-frequency proactive speech', () => {
    const { director, ledger } = setup(); vi.advanceTimersByTime(1600); vi.advanceTimersByTime(3600001);
    director.setEnvironment({ idleSeconds: 10 }); director.tick(); expect(director.state.bubble?.source).toBe('proactive');
    expect(ledger.value.automaticTimes).toHaveLength(2); vi.advanceTimersByTime(5500); director.tick(); expect(director.state.bubble).toBeUndefined();
    ledger.value.automaticTimes = Array.from({ length: 6 }, (_, i) => Date.now() - (i + 2) * 3600000);
    expect(ledger.allows(Date.now())).toBe(false);
  });
  it('only welcomes after genuine long system inactivity, not simply leaving the portrait', () => {
    const { director } = setup(); director.setEnvironment({ idleSeconds: 901 }); vi.advanceTimersByTime(2000);
    director.setEnvironment({ idleSeconds: 0 }); director.interact('click'); expect(director.state.bubble?.source).toBe('welcome');
  });
  it('static mode leaves manual expressions and speech without an action', () => {
    const { director, prefs } = setup(); prefs.value.animations = 'off'; director.preferencesChanged(); director.interact('greet');
    expect(director.state.bubble?.source).toBe('greet'); expect(director.state.presentation).toBeUndefined();
  });
  it('manual idle preview plays one cycle and stops without leaving a loop behind', () => {
    const { director, prefs } = setup(); prefs.value.greetings = false; director.playAction('idle'); expect(director.state.presentation?.action).toBe('idle');
    director.stop(); vi.advanceTimersByTime(4000); expect(director.state.presentation).toBeUndefined();
  });
  it('leaving the pointer cannot cancel a manually previewed wave', () => {
    const { director } = setup(); director.playAction('greet'); director.hover(true); director.hover(false);
    vi.advanceTimersByTime(650); expect(director.state.presentation?.action).toBe('greet');
  });
  it('fits a spoken wave into a short bubble while manual previews keep the full duration', () => {
    const { director, prefs } = setup(); prefs.value.bubbleDurationMs = 1500; director.interact('greet');
    expect(director.state.presentation!.durationMs).toBeLessThanOrEqual(1200);
    director.playAction('greet'); expect(director.state.presentation!.durationMs).toBe(2550);
  });
  it('does not bypass automatic limits after clock rollback or a corrupted ledger', () => {
    const { ledger, root } = setup(); ledger.record(Date.now(), true); vi.setSystemTime(Date.now() - 3600000);
    expect(new CompanionLedger(root).allows(Date.now(), true)).toBe(false);
    writeFileSync(resolve(root, 'companion-ledger.json'), '{broken');
    const damaged = new CompanionLedger(root); expect(damaged.warning).toBeTruthy(); expect(damaged.allows(Date.now())).toBe(false);
  });
  it('keeps manual interaction usable when automatic ledger cannot be saved', () => {
    const { director, ledger, root } = setup(); mkdirSync(resolve(root, 'companion-ledger.json.tmp'));
    vi.advanceTimersByTime(1600); expect(ledger.warning).toBeTruthy(); expect(director.state.bubble).toBeUndefined();
    director.interact('company'); expect(director.state.bubble?.source).toBe('company');
  });
  it('expires speech at the configured short duration and cancels its presentation', () => {
    const { director, prefs } = setup(); prefs.value.greetings = false; prefs.value.bubbleDurationMs = 1500;
    director.interact('greet'); expect(director.state.bubble!.expiresAt - Date.now()).toBe(1500);
    vi.advanceTimersByTime(1499); expect(director.state.bubble).toBeTruthy();
    vi.advanceTimersByTime(1); expect(director.state.bubble).toBeUndefined(); expect(director.state.presentation).toBeUndefined(); expect(director.state.expression).toBe('normal');
  });
  it('hover does not replace or restart an explicitly playing continuous action', () => {
    const { director, prefs } = setup(); prefs.value.greetings = false; director.playAction('greet');
    const action = director.state.presentation!.id; director.hover(true); vi.advanceTimersByTime(1250);
    expect(director.state.presentation!.id).toBe(action); expect(director.state.expression).toBe('normal'); expect(director.state.bubble).toBeUndefined();
  });
});
describe('hit testing and bubble placement', () => {
  it('distinguishes transparent holes and ignores coordinates outside the sprite', () => {
    const bits = new Uint8Array([0b00001001]);
    expect(maskHit(bits, 2, 2, 0.1, 0.1)).toBe(true); expect(maskHit(bits, 2, 2, 0.9, 0.1)).toBe(false);
    expect(maskHit(bits, 2, 2, 1, 1)).toBe(false); expect(maskHit(bits, 2, 2, -0.01, 0.2)).toBe(false);
  });
  it('puts a bubble beside the pet and clamps it on negative-coordinate or small screens', () => {
    const area = { x: -1920, y: -100, width: 1920, height: 1040 }, pet = { x: -360, y: 350, width: 320, height: 524 };
    const bubble = bubbleBounds(pet, area); expect(bubble.x + bubble.width).toBeLessThan(pet.x);
    const small = bubbleBounds({ x: 0, y: 0, width: 280, height: 480 }, { x: 0, y: 0, width: 300, height: 180 });
    expect(small).toEqual({ x: 0, y: 0, width: 300, height: 180 });
  });
});
