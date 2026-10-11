import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, linkSync, copyFileSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { within } from '../../src/main/platform/paths';
export const fixtureRoot = resolve('data/tests/unit');
mkdirSync(fixtureRoot, { recursive: true });
export function temporary() { return mkdtempSync(join(fixtureRoot, 'companion-')); }
export function remove(dir: string) {
  if (!within(fixtureRoot, resolve(dir)) || resolve(dir) === fixtureRoot) throw new Error('Refuse unsafe test cleanup');
  rmSync(dir, { recursive: true, force: true });
}
export function roleFixture(root: string, id: string, name = id) {
  const original = resolve('characters/yoshino'), target = join(root, id);
  cpSync(original, target, { recursive: true, filter: path => !path.includes('references') && !path.includes('voice') && !path.endsWith('.png') });
  function images(dir: string) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (['references', 'voice'].includes(item.name)) continue;
      const file = join(dir, item.name);
      if (item.isDirectory()) images(file);
      else if (file.endsWith('.png')) { const dest = join(target, relative(original, file)); mkdirSync(dirname(dest), { recursive: true }); try { linkSync(file, dest); } catch (error) { if (!['UNKNOWN', 'EMLINK', 'EXDEV', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; copyFileSync(file, dest); } }
    }
  }
  images(original);
  const manifest = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8'));
  manifest.id = id; manifest.displayName = name; manifest.shortName = name;
  delete manifest.roleConfig; // Legacy fixture tests its own persona; no copied structured identity.
  manifest.speakers.yoshino.displayName = name; manifest.memory.namespace = id;
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest));
  const frames = JSON.parse(readFileSync(join(target, manifest.visual.frameAnimationConfig), 'utf8')); frames.characterId = id;
  writeFileSync(join(target, manifest.visual.frameAnimationConfig), JSON.stringify(frames));
  const interaction = JSON.parse(readFileSync(join(target, manifest.interactionConfig), 'utf8'));
  for (const lines of Object.values(interaction.responses ?? interaction.events) as { text: string }[][]) for (const line of lines) line.text = `${name}：${line.text}`;
  writeFileSync(join(target, manifest.interactionConfig), JSON.stringify(interaction));
  return target;
}
export function registry(root: string, ids: string[]) {
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ schemaVersion: 1, defaultCharacterId: ids[0], characters: ids.map(id => ({ id, manifest: `${id}/manifest.json` })) }));
}
// Distinct action/expression/command IDs exercise the host contract, using existing art only as a test fixture.
export function differentRoleFixture(root: string, id: string) {
  const target = roleFixture(root, id);
  const write = (name: string, value: unknown) => writeFileSync(join(target, name), JSON.stringify(value));
  const manifest = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8'));
  manifest.visual.expressions = { calm: manifest.visual.expressions.normal, bright: manifest.visual.expressions.happy };
  manifest.visual.defaultExpression = manifest.visual.fallbackExpression = 'calm';
  delete manifest.visual.frameAnimationConfig; delete manifest.visual.motionConfig; delete manifest.visual.rigConfig;
  write('manifest.json', manifest);
  const action = { durationMs: 600, loop: false, keyframes: [{ offset: 0, translateY: 0, rotate: 0 }, { offset: .5, translateY: -.005, rotate: 2 }, { offset: 1, translateY: 0, rotate: 0 }] };
  write(manifest.visual.animationConfig, { schemaVersion: 1, actions: { rest: { ...action, loop: true, durationMs: 4000 }, nod: action } });
  write(manifest.catalogConfig, { schemaVersion: 1, actions: { rest: { label: '缓缓浮动' }, nod: { label: '蓝色点头', allowInSubtle: true } }, expressions: { calm: { label: '沉静' }, bright: { label: '明亮' } } });
  write(manifest.interactionConfig, { schemaVersion: 2, responses: {
    arrival: [{ id: 'arrive', speaker: 'yoshino', text: '角色 B 的问候', expression: 'bright', action: 'nod' }],
    touch: [{ id: 'touch', speaker: 'yoshino', text: '角色 B 的点击', expression: 'calm' }],
    approve: [{ id: 'approve', speaker: 'yoshino', text: '角色 B 的击掌', expression: 'bright', action: 'nod' }],
  } });
  write(manifest.behaviorConfig, { schemaVersion: 1, events: { startup: 'arrival', click: 'touch' },
    commands: { cheer: { label: '击掌一下', response: 'approve', cooldownMs: 9000 } }, states: { hovering: 'bright', dragging: 'calm' }, idleAction: 'rest',
    ambient: { action: 'nod', firstDelayMs: 1000, minIntervalMs: 2000, maxIntervalMs: 2000 }, timing: { startupDelayMs: 2000 } });
  write(manifest.bubbleConfig, { schemaVersion: 1, choices: ['cheer'], choiceHint: '这是角色 B 的按钮', passiveHint: '蓝色陪伴',
    theme: { background: '#eef4ff', backgroundEnd: '#ffffff', text: '#203050', accent: '#3355aa', border: '#7799cc', buttonBackground: '#dde8ff', radius: 8 } });
  return target;
}
