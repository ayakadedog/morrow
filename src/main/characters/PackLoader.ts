import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { safeResource } from '../platform/paths';
import { loadInteraction } from './PackInteraction';
import { roleProfileSchema, type RoleProfile } from '../../shared/roleProfile';
import type { CharacterView, CharacterAction, CharacterRig, HitMask, InteractionEvent, InteractionLine } from '../../shared/contracts';

export const stableId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const resource = z.string().min(1).max(240);
const canvas = z.object({ width: z.number().int().min(64).max(8192), height: z.number().int().min(64).max(8192) });
const anchor = z.object({ x: z.literal(0.5), y: z.literal(1) });
const registrySchema = z.object({ schemaVersion: z.literal(1), defaultCharacterId: stableId,
  characters: z.array(z.object({ id: stableId, manifest: resource })).min(1).max(100) });
const manifestSchema = z.object({
  schemaVersion: z.literal(1), id: stableId, displayName: z.string().min(1).max(80),
  shortName: z.string().min(1).max(40).optional(), work: z.string().max(80).optional(), description: z.string().max(160).optional(),
  persona: resource, prompt: resource, memoryCompatibilityVersion: z.string().trim().min(1).max(80).optional(), roleConfig: resource.optional(), interactionConfig: resource.optional(),
  catalogConfig: resource.optional(), behaviorConfig: resource.optional(), bubbleConfig: resource.optional(),
  speakers: z.record(stableId, z.object({ displayName: z.string().min(1).max(40) })).optional(),
  visual: z.object({ format: z.literal('full-body-png'), canvas, anchor,
    mirrorAllowed: z.literal(false).optional(), defaultExpression: stableId, fallbackExpression: stableId,
    expressions: z.record(stableId, resource), animationConfig: resource, frameAnimationConfig: resource.optional(), motionConfig: resource.optional(), rigConfig: resource.optional() })
});
const normalizedPoint = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict();
const polygon = z.array(normalizedPoint).min(3).max(48);
export const rigConfigSchema = z.object({ schemaVersion: z.literal(1),
  fixedBelow: z.number().min(.5).max(1),
  assets: z.record(stableId, resource).refine(assets => Object.keys(assets).length > 0 && Object.keys(assets).length <= 8),
  patch: z.object({ texture: stableId, polygon }).strict(),
  bones: z.array(z.object({ id: stableId, parent: stableId.optional(), pivot: normalizedPoint,
    texture: z.union([z.literal('current'), stableId]), sourcePivot: normalizedPoint, scale: z.number().min(.2).max(2),
    sourceRect: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict().optional(), polygon: polygon.optional()
  }).strict()).min(1).max(8),
  actions: z.record(stableId, z.object({ durationMs: z.number().int().min(500).max(5000),
    keyframes: z.array(z.object({ offset: z.number().min(0).max(1), blend: z.number().min(0).max(1), rotations: z.record(stableId, z.number().min(-140).max(140)) }).strict()).min(3).max(24)
  }).strict()).refine(actions => Object.keys(actions).length > 0 && Object.keys(actions).length <= 16)
}).superRefine((rig, context) => {
  const available = new Set<string>();
  for (const bone of rig.bones) {
    if (available.has(bone.id) || bone.parent && !available.has(bone.parent)) context.addIssue({ code: 'custom', message: '骨骼重复、循环或父骨骼不在前面' });
    available.add(bone.id);
    if (bone.texture !== 'current' && !Object.hasOwn(rig.assets, bone.texture) || bone.sourceRect && (bone.sourceRect.x + bone.sourceRect.width > 1 || bone.sourceRect.y + bone.sourceRect.height > 1)) context.addIssue({ code: 'custom', message: '分层素材或取样范围错误' });
  }
  if (!Object.hasOwn(rig.assets, rig.patch.texture)) context.addIssue({ code: 'custom', message: '缺少遮挡补全素材' });
  for (const action of Object.values(rig.actions)) {
    const first = action.keyframes[0], last = action.keyframes.at(-1)!;
    if (first.offset !== 0 || last.offset !== 1 || first.blend !== 0 || last.blend !== 0 ||
      Object.values(first.rotations).some(value => value !== 0) || Object.values(last.rotations).some(value => value !== 0) ||
      action.keyframes.some((frame, i) => i > 0 && frame.offset <= action.keyframes[i - 1].offset)) context.addIssue({ code: 'custom', message: '分层动作须首尾归零且时序严格递增' });
    for (const frame of action.keyframes) if (Object.keys(frame.rotations).length !== available.size || [...available].some(id => !Object.hasOwn(frame.rotations, id))) context.addIssue({ code: 'custom', message: '分层动作须声明全部骨骼' });
  }
});
const meshConfigSchema = z.object({ schemaVersion: z.literal(1), actions: z.record(stableId,
  z.object({ durationMs: z.number().int().min(500).max(5000), regions: z.array(z.object({
    center: normalizedPoint, pivot: normalizedPoint, radius: z.object({ x: z.number().min(.02).max(.5), y: z.number().min(.02).max(.5) }).strict(),
    keyframes: z.array(z.object({ offset: z.number().min(0).max(1), x: z.number().min(-.03).max(.03), y: z.number().min(-.03).max(.03), rotate: z.number().min(-8).max(8) }).strict()).min(3).max(16)
  }).superRefine((region, context) => {
    const first = region.keyframes[0], last = region.keyframes.at(-1)!;
    if (first.offset !== 0 || last.offset !== 1 || first.x || first.y || first.rotate || last.x || last.y || last.rotate || region.keyframes.some((frame, i) => i > 0 && frame.offset <= region.keyframes[i - 1].offset))
      context.addIssue({ code: 'custom', message: '连续动作须首尾归零且时序严格递增' });
  })).min(1).max(4) }).strict()).refine(actions => Object.keys(actions).length <= 16) });
export const transformConfigSchema = z.object({ schemaVersion: z.literal(1),
  actions: z.record(stableId, z.object({ durationMs: z.number().int().min(100).max(30000), loop: z.boolean(),
    keyframes: z.array(z.object({ offset: z.number().min(0).max(1), translateY: z.number().min(-0.08).max(0.08), rotate: z.number().min(-10).max(10) }).strict()).min(2).max(32)
  }).superRefine((action, context) => {
    if (action.keyframes[0].offset !== 0 || action.keyframes.at(-1)!.offset !== 1 ||
      action.keyframes.some((frame, i) => i > 0 && frame.offset <= action.keyframes[i - 1].offset)) context.addIssue({ code: 'custom', message: '关键帧须从 0 到 1 严格递增' });
  })).refine(actions => Object.keys(actions).length <= 32)
});
export const frameSequenceSchema = z.object({ schemaVersion: z.literal(1), characterId: stableId, canvas, anchor,
  frames: z.record(stableId, resource).refine(frames => Object.keys(frames).length <= 64),
  expressionTransitionMs: z.number().int().min(0).max(500),
  actions: z.record(stableId, z.object({ transitionMs: z.number().int().min(0).max(250), returnTo: stableId,
    overlayRegions: z.array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1),
      radiusX: z.number().min(0.001).max(0.25), radiusY: z.number().min(0.001).max(0.25) }).strict()).min(1).max(4).optional(),
    frames: z.array(z.object({ frame: stableId, holdMs: z.number().int().min(10).max(3000) }).strict()).min(2).max(48)
  }).superRefine((action, context) => {
    const duration = action.frames.reduce((sum, frame) => sum + frame.holdMs + action.transitionMs, 0);
    if (duration > 15000 || action.frames.at(-1)!.frame !== action.returnTo) context.addIssue({ code: 'custom', message: '动作过长或没有回到原姿态' });
  })).refine(actions => Object.keys(actions).length <= 32)
}).superRefine((config, context) => {
  for (const action of Object.values(config.actions)) for (const frame of action.frames) {
    if (!Object.hasOwn(config.frames, frame.frame)) context.addIssue({ code: 'custom', message: '动作引用未知帧' });
  }
});

function text(root: string, path: string, max = 65536): string {
  const file = safeResource(root, path);
  if (statSync(file).size > max) throw new Error('角色配置文件过大');
  return readFileSync(file, 'utf8');
}
function json(root: string, path: string) { return JSON.parse(text(root, path, 1024 * 1024)); }
export function loadRegistry(root: string) {
  const registry = registrySchema.parse(json(root, 'registry.json'));
  if (new Set(registry.characters.map(c => c.id)).size !== registry.characters.length) throw new Error('角色 ID 重复');
  for (const entry of registry.characters) if (entry.manifest !== `${entry.id}/manifest.json`) throw new Error('角色登记路径与 ID 不一致');
  if (!registry.characters.some(c => c.id === registry.defaultCharacterId)) throw new Error('默认角色没有登记');
  return registry;
}
export function listCharacters(root: string) {
  return loadRegistry(root).characters.map(entry => {
    try { const manifest = manifestSchema.parse(json(root, entry.manifest)); return { id: entry.id, name: manifest.displayName }; }
    catch { return { id: entry.id, name: `${entry.id}（配置待检查）` }; }
  });
}
export interface LoadedPack {
  memoryCompatibilityVersion?: string;
  roleProfile?: RoleProfile;
  view: CharacterView; assets: Map<string, string>; persona: string; prompt: string;
  lines: Record<InteractionEvent, InteractionLine[]>;
}
export type ImageInspector = (path: string) => { width: number; height: number; mask: HitMask };
export function loadPack(root: string, characterId: string, inspector?: ImageInspector): LoadedPack {
  const registry = loadRegistry(root), entry = registry.characters.find(c => c.id === characterId);
  if (!entry) throw new Error('角色未登记');
  const characterRoot = join(root, entry.id);
  const manifest = manifestSchema.parse(json(root, entry.manifest));
  if (manifest.id !== entry.id) throw new Error('角色 ID 与登记不一致');
  const persona = text(characterRoot, manifest.persona, Infinity), prompt = text(characterRoot, manifest.prompt, Infinity);
  const transforms = transformConfigSchema.parse(json(characterRoot, manifest.visual.animationConfig));
  const assets = new Map<string, string>(), hitMasks: Record<string, HitMask> = {}, warnings: string[] = [];
  const imageCache = new Map<string, ReturnType<ImageInspector> | undefined>();
  let decodedPixels = 0;
  function image(name: string, path: string): string {
    const file = safeResource(characterRoot, path), url = `pet-asset://character/${entry!.id}/${name}`;
    if (assets.has(url)) { if (assets.get(url) !== file) throw new Error('表情与动作帧命名冲突'); return url; }
    if (!file.toLowerCase().endsWith('.png') || statSync(file).size > 32 * 1024 * 1024) throw new Error('素材必须是合理大小的 PNG');
    const bytes = readFileSync(file);
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.readUInt32BE(16) !== manifest.visual.canvas.width || bytes.readUInt32BE(20) !== manifest.visual.canvas.height) throw new Error('图片画布不一致或 PNG 已损坏');
    if (!imageCache.has(file)) {
      decodedPixels += manifest.visual.canvas.width * manifest.visual.canvas.height;
      if (decodedPixels > 48 * 1024 * 1024) throw new Error('角色图片总尺寸过大');
      imageCache.set(file, inspector?.(file));
    }
    const inspected = imageCache.get(file);
    if (inspected && (inspected.width !== manifest.visual.canvas.width || inspected.height !== manifest.visual.canvas.height)) throw new Error('图片解码失败或尺寸不一致');
    if (inspected) hitMasks[name] = inspected.mask;
    assets.set(url, file); return url;
  }
  const expressions: Record<string, string> = {}, frames: Record<string, string> = {};
  for (const name of [manifest.visual.defaultExpression, manifest.visual.fallbackExpression]) {
    const file = manifest.visual.expressions[name]; if (!file) throw new Error('缺少默认或回退表情');
    expressions[name] = image(name, file);
  }
  for (const [name, path] of Object.entries(manifest.visual.expressions)) {
    if (expressions[name]) continue;
    try { expressions[name] = image(name, path); }
    catch { expressions[name] = expressions[manifest.visual.fallbackExpression]; warnings.push(`表情 ${name} 无法读取，使用默认表情。`); }
  }
  Object.assign(frames, expressions);
  const actions: Record<string, CharacterAction> = {};
  for (const [name, action] of Object.entries(transforms.actions)) actions[name] = { kind: 'transform', ...action };
  let expressionTransitionMs = 180;
  if (manifest.visual.frameAnimationConfig) {
    const sequence = frameSequenceSchema.parse(json(characterRoot, manifest.visual.frameAnimationConfig));
    if (sequence.characterId !== entry.id || sequence.canvas.width !== manifest.visual.canvas.width || sequence.canvas.height !== manifest.visual.canvas.height ||
      sequence.anchor.x !== manifest.visual.anchor.x || sequence.anchor.y !== manifest.visual.anchor.y) throw new Error('动作配置与人物不一致');
    expressionTransitionMs = sequence.expressionTransitionMs;
    for (const [name, path] of Object.entries(sequence.frames)) frames[name] = image(name, path);
    for (const [name, action] of Object.entries(sequence.actions)) actions[name] = { kind: 'frames', loop: false,
      transitionMs: action.transitionMs, frames: action.frames, overlayRegions: action.overlayRegions,
      durationMs: action.frames.reduce((sum, frame) => sum + frame.holdMs + action.transitionMs, 0) };
  }
  const speakers = manifest.speakers ?? { [manifest.id]: { displayName: manifest.displayName } };
  if (manifest.visual.motionConfig) {
    const motion = meshConfigSchema.parse(json(characterRoot, manifest.visual.motionConfig));
    for (const [name, action] of Object.entries(motion.actions)) actions[name] = { kind: 'mesh', loop: false, ...action };
  }
  let rig: CharacterRig | undefined;
  if (manifest.visual.rigConfig) {
    const config = rigConfigSchema.parse(json(characterRoot, manifest.visual.rigConfig));
    const textures = Object.fromEntries(Object.entries(config.assets).map(([name, path]) => [name, image(`rig-${name}`, path)]));
    rig = { assets: textures, fixedBelow: config.fixedBelow, patch: config.patch, bones: config.bones };
    for (const [name, action] of Object.entries(config.actions)) actions[name] = { kind: 'rig', loop: false, ...action };
  }
  if (!Object.keys(speakers).length) throw new Error('角色缺少说话者');
  const roleProfile = manifest.roleConfig ? roleProfileSchema.parse(JSON.parse(text(characterRoot, manifest.roleConfig, Infinity))) : undefined;
  if (roleProfile && (roleProfile.characterId !== manifest.id || roleProfile.examples.some(e => e.speaker && !Object.hasOwn(speakers, e.speaker)))) throw new Error('角色设定与角色 ID 或说话者不一致');
  const { lines, catalog, behavior, bubble } = loadInteraction(path => json(characterRoot, path), manifest, actions, expressions, speakers, manifest.visual.defaultExpression);
  return { persona, prompt, roleProfile, memoryCompatibilityVersion: manifest.memoryCompatibilityVersion, assets, lines, view: { id: manifest.id, name: manifest.displayName,
    shortName: manifest.shortName ?? manifest.displayName, work: manifest.work ?? '', description: manifest.description ?? '温和的桌面陪伴。',
    canvas: manifest.visual.canvas, anchor: manifest.visual.anchor, expressions, frames, actions, rig, hitMasks, speakers,
    defaultExpression: manifest.visual.defaultExpression, fallbackExpression: manifest.visual.fallbackExpression, expressionTransitionMs, warnings, catalog, behavior, bubble } };
}
