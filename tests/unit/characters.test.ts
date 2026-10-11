import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CharacterService } from '../../src/main/characters/CharacterService';
import { loadPack, loadRegistry, frameSequenceSchema, transformConfigSchema, rigConfigSchema } from '../../src/main/characters/PackLoader';
import { temporary, remove, roleFixture, registry } from './fixtures';
const dirs: string[] = [];
function packs(ids = ['role-a', 'role-b']) { const root = temporary(); dirs.push(root); for (const id of ids) roleFixture(root, id); registry(root, ids); return root; }
afterEach(() => dirs.splice(0).forEach(remove));
describe('validated role switching', () => {
  it('keeps A active while preparing B, then changes epoch on A→B→A', () => {
    const root = packs(), service = new CharacterService(root);
    const b = service.prepare('role-b'); expect(service.current.view.id).toBe('role-a');
    service.commit(b.token); expect(service.current.view.id).toBe('role-b'); expect(service.epoch).toBe(2);
    service.commit(service.prepare('role-a').token); expect(service.epoch).toBe(3);
    expect(service.current.lines.click[0].text).toContain('role-a');
  });
  it('rejects stale tokens, repeated commit and expired preparations', () => {
    const root = packs(); let time = 100000; const service = new CharacterService(root, undefined, undefined, () => time);
    const old = service.prepare('role-b'), next = service.prepare('role-a');
    expect(() => service.commit(old.token)).toThrow(); service.commit(next.token);
    expect(() => service.commit(next.token)).toThrow(); const expiring = service.prepare('role-b'); time += 30001;
    expect(() => service.commit(expiring.token)).toThrow(); expect(service.current.view.id).toBe('role-a');
  });
  it('fails missing default pictures without losing the current character', () => {
    const root = packs(), service = new CharacterService(root);
    const file = join(root, 'role-b/manifest.json'), manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.visual.expressions.normal = 'assets/portraits/missing.png'; writeFileSync(file, JSON.stringify(manifest));
    expect(() => service.prepare('role-b')).toThrow(); expect(service.current.view.id).toBe('role-a');
  });
  it('falls back an optional missing expression while preserving valid frames', () => {
    const root = packs(['role-a']), file = join(root, 'role-a/manifest.json'), manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.visual.expressions.worried = 'assets/expressions/missing.png'; writeFileSync(file, JSON.stringify(manifest));
    const catalogFile = join(root, 'role-a', manifest.catalogConfig), catalog = JSON.parse(readFileSync(catalogFile, 'utf8'));
    catalog.expressions.worried = { label: '担心' }; writeFileSync(catalogFile, JSON.stringify(catalog));
    const pack = loadPack(root, 'role-a'); expect(pack.view.expressions.worried).toBe(pack.view.expressions.normal); expect(pack.view.warnings).toHaveLength(1);
  });
  it('rejects duplicate registry IDs and persona path escapes', () => {
    const root = packs(['role-a']); registry(root, ['role-a', 'role-a']); expect(() => loadRegistry(root)).toThrow();
    registry(root, ['role-a']); const file = join(root, 'role-a/manifest.json'), manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.persona = '../outside.md'; writeFileSync(file, JSON.stringify(manifest)); expect(() => loadPack(root, 'role-a')).toThrow();
  });
  it('rejects unknown frame references, overlong motion and unordered offsets', () => {
    const root = packs(['role-a']);
    const frames = JSON.parse(readFileSync(join(root, 'role-a/assets/animations/sequences-v2.json'), 'utf8'));
    frames.actions.greet.frames[1].frame = 'missing'; expect(frameSequenceSchema.safeParse(frames).success).toBe(false);
    const transforms = JSON.parse(readFileSync(join(root, 'role-a/assets/animations/actions.json'), 'utf8'));
    transforms.actions.greet.keyframes[1].offset = 0; expect(transformConfigSchema.safeParse(transforms).success).toBe(false);
    transforms.actions.greet.durationMs = Infinity; expect(transformConfigSchema.safeParse(transforms).success).toBe(false);
  });
  it('rejects continuous regions that exceed range or do not return to rest', () => {
    const root = packs(['role-a']), file = join(root,'role-a/assets/animations/motions-v3.json'), motion = JSON.parse(readFileSync(file,'utf8'));
    motion.actions.greet.regions[0].keyframes.at(-1).rotate = 2;
    writeFileSync(file,JSON.stringify(motion)); expect(() => loadPack(root,'role-a')).toThrow();
    motion.actions.greet.regions[0].keyframes.at(-1).rotate = 0; motion.actions.greet.regions[0].radius.x = 2;
    writeFileSync(file,JSON.stringify(motion)); expect(() => loadPack(root,'role-a')).toThrow();
  });
  it('rejects rig cycles, missing textures and overflowing texture crops', () => {
    const root = packs(['role-a']), rig = JSON.parse(readFileSync(join(root,'role-a/assets/animations/rig-v4.json'),'utf8'));
    const changed = structuredClone(rig); changed.bones[0].parent = 'forearm'; expect(rigConfigSchema.safeParse(changed).success).toBe(false);
    changed.bones[0].parent = undefined; changed.bones[1].texture = 'missing'; expect(rigConfigSchema.safeParse(changed).success).toBe(false);
    changed.bones[1].texture = rig.bones[1].texture; changed.bones[1].sourceRect.width = 1; expect(rigConfigSchema.safeParse(changed).success).toBe(false);
    expect(rigConfigSchema.safeParse(rig).success).toBe(true);
  });
  it('rejects rig motion without complete joints or a neutral transparent ending', () => {
    const root = packs(['role-a']), rig = JSON.parse(readFileSync(join(root,'role-a/assets/animations/rig-v4.json'),'utf8'));
    const changed = structuredClone(rig); changed.actions.greet.keyframes.at(-1).blend = .1; expect(rigConfigSchema.safeParse(changed).success).toBe(false);
    changed.actions.greet.keyframes.at(-1).blend = 0; delete changed.actions.greet.keyframes[2].rotations.forearm; expect(rigConfigSchema.safeParse(changed).success).toBe(false);
    changed.actions.greet.keyframes[2].rotations.forearm = -200; expect(rigConfigSchema.safeParse(changed).success).toBe(false);
  });
});
