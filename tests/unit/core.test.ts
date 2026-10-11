import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { clampBounds, bottomRight, petSize, dragExceeded } from '../../src/shared/geometry';
import { safeResource, within } from '../../src/main/platform/paths';
import { loadDefault } from '../../src/main/characters/loadDefault';
import { patchSchema, PreferenceStore } from '../../src/main/settings/preferences';
import { StartupProbe } from '../../src/main/storage/startupProbe';

const temporaryRoot = resolve('data/tests/unit');
mkdirSync(temporaryRoot, { recursive: true });
const created: string[] = [];
function fixture() { const dir = mkdtempSync(join(temporaryRoot, 'case-')); created.push(dir); return dir; }
afterEach(() => { for (const dir of created.splice(0)) {
  if (!within(temporaryRoot, resolve(dir)) || resolve(dir) === temporaryRoot) throw new Error('Refuse unsafe test cleanup');
  rmSync(dir, { recursive: true, force: true });
} });

describe('desktop geometry', () => {
  it('keeps a window within a negative-coordinate monitor work area', () => {
    const area = { x: -1920, y: -100, width: 1920, height: 1040 };
    expect(clampBounds({ x: -2100, y: 1500, width: 400, height: 520 }, area)).toEqual({ x: -1920, y: 420, width: 400, height: 520 });
  });
  it('fits tall characters into a small work area and leaves a taskbar margin', () => {
    const area = { x: 0, y: 0, width: 800, height: 600 };
    const size = petSize(680, 2 / 3, area);
    expect(size.height).toBeLessThanOrEqual(600);
    const position = bottomRight(size, area);
    expect(position.y + position.height).toBeLessThanOrEqual(600);
  });
  it('distinguishes a click from a drag', () => {
    expect(dragExceeded({ x: 10, y: 10 }, { x: 13, y: 12 })).toBe(false);
    expect(dragExceeded({ x: 10, y: 10 }, { x: 16, y: 10 })).toBe(true);
  });
});
describe('resource boundaries', () => {
  it('rejects traversal, absolute paths, backslashes and directories', () => {
    const root = fixture(); writeFileSync(join(root, 'good.png'), 'fixture'); mkdirSync(join(root, 'folder'));
    expect(safeResource(root, 'good.png')).toBe(join(root, 'good.png'));
    for (const bad of ['../good.png', '/good.png', 'C:/good.png', 'folder\\a.png', 'folder', './good.png']) expect(() => safeResource(root, bad)).toThrow();
  });
  it('rejects a junction escaping the role root', () => {
    const parent = fixture(); const role = join(parent, 'role'); const outside = join(parent, 'outside');
    mkdirSync(role); mkdirSync(outside); writeFileSync(join(outside, 'secret.png'), 'fixture');
    symlinkSync(outside, join(role, 'linked'), 'junction');
    expect(() => safeResource(role, 'linked/secret.png')).toThrow();
  });
  it('loads the actual default role using the registry, without hardcoded image names', () => {
    const loaded = loadDefault(resolve('characters'));
    expect(loaded.view.id).toBe('yoshino');
    expect(Object.keys(loaded.view.expressions)).toEqual(['normal', 'happy', 'shy']);
    expect(loaded.assets.size).toBe(12);
    expect(loaded.view.actions.greet.kind).toBe('rig');
    expect(loaded.view.actions.smallgreet.kind).toBe('mesh');
  });
});
describe('preferences and SQLite', () => {
  it('rejects unsupported fields and unsafe values on the communication boundary', () => {
    expect(patchSchema.safeParse({ height: Infinity }).success).toBe(false);
    expect(patchSchema.safeParse({ height: 460, shell: 'anything' }).success).toBe(false);
    expect(patchSchema.safeParse({ height: 0 }).success).toBe(false);
    expect(patchSchema.safeParse({ interaction: 'unknown' }).success).toBe(false);
  });
  it('saves and reloads preferences with Chinese and space paths', () => {
    const root = fixture(); const dir = join(root, '中文 数据'); mkdirSync(dir);
    const prefs = new PreferenceStore(dir); prefs.value.height = 520; prefs.value.position = { x: -500, y: 100 }; prefs.save();
    expect(new PreferenceStore(dir).value).toEqual(prefs.value);
  });
  it('persists SQLite rows across closing and reopening the database', () => {
    const root = fixture(); const first = new StartupProbe(root);
    expect(first.result).toEqual({ previousLaunches: 0, currentLaunches: 1 }); first.close(); first.close();
    const second = new StartupProbe(root);
    expect(second.result).toEqual({ previousLaunches: 1, currentLaunches: 2 }); second.close();
  });
});
