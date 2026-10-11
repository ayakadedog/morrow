import { readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { roleProfileSchema } from '../src/shared/roleProfile.ts';
import { safeResource } from '../src/main/platform/paths.ts';

// Character packages are the only authoring source. Validation never writes to them.
const packs = resolve(import.meta.dirname, '../characters');
const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const registry = z.object({ schemaVersion: z.literal(1), defaultCharacterId: id,
  characters: z.array(z.object({ id, manifest: z.string().min(1) }).strict()).min(1).max(100)
}).strict().parse(JSON.parse(readFileSync(safeResource(packs, 'registry.json'), 'utf8')));
if (new Set(registry.characters.map(p => p.id)).size !== registry.characters.length
  || !registry.characters.some(p => p.id === registry.defaultCharacterId)) throw new Error('角色登记重复或默认角色不存在');
let profiles = 0;
for (const entry of registry.characters) {
  if (entry.manifest !== `${entry.id}/manifest.json`) throw new Error('角色登记必须指向对应角色目录');
  const manifest = JSON.parse(readFileSync(safeResource(packs, entry.manifest), 'utf8'));
  if (manifest.id !== entry.id) throw new Error('角色包 ID 不符');
  const root = join(packs, entry.id);
  for (const path of [manifest.persona, manifest.prompt]) {
    readFileSync(safeResource(root, path), 'utf8'); // No arbitrary persona/prompt length cap.
  }
  if (!manifest.roleConfig) continue; // Legacy packages use their own persona/prompt.
  const profilePath = safeResource(root, manifest.roleConfig);
  const profile = roleProfileSchema.parse(JSON.parse(readFileSync(profilePath, 'utf8')));
  const speakers = manifest.speakers ?? { [entry.id]: {} };
  if (profile.characterId !== entry.id || profile.examples.some(e => e.speaker && !Object.hasOwn(speakers, e.speaker))) throw new Error('设定 ID 或示例说话者不符');
  profiles++;
}
console.log(`Validated ${registry.characters.length} character pack(s), ${profiles} structured role profile(s). No files overwritten.`);
