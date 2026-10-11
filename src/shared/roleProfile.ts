import { z } from 'zod';
const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const short = z.string().trim().min(1), rules = z.array(short);
export const roleProfileSchema = z.object({
  schemaVersion: z.literal(1), characterId: id, revision: z.string().min(1).max(40),
  identity: z.object({ name: short, work: z.string(), summary: z.string().min(1), traits: rules }).strict(),
  speech: z.object({ tone: short, rules, avoid: rules }).strict(),
  relationships: z.object({ userDefault: short, others: z.array(z.object({ name: short, description: short }).strict()) }).strict(),
  boundaries: rules, proactiveStyle: short,
  knowledge: z.array(z.object({ id, text: short, keywords: z.array(z.string().min(1).max(30)).max(8),
    kind: z.enum(['canon', 'project-design']), source: z.string().url().max(400).refine(s => s.startsWith('https://')).optional()
  }).strict()),
  examples: z.array(z.object({ user: short, assistant: z.string().min(1), speaker: id.optional(), situation: short }).strict())
}).strict().superRefine((value, ctx) => {
  if (new Set(value.knowledge.map(k => k.id)).size !== value.knowledge.length) ctx.addIssue({ code: 'custom', message: '角色背景知识 ID 重复' });
  if (value.knowledge.some(k => k.kind === 'canon' && !k.source)) ctx.addIssue({ code: 'custom', message: '原作事实必须带来源链接' });
});
export type RoleProfile = z.infer<typeof roleProfileSchema>;
export function roleProfileContext(profile: RoleProfile, query: string, proactive: boolean) {
  const ranked = profile.knowledge.map((item, index) => ({ item, index, score: item.keywords.filter(k => query.includes(k)).length }))
    .sort((a, b) => b.score - a.score || a.index - b.index).map(({ item }) => ({ text: item.text, kind: item.kind }));
  // A profile is authoring data, never a source of executable permissions.
  const core = { identity: profile.identity, speech: profile.speech, relationships: profile.relationships, boundaries: profile.boundaries,
    ...(proactive ? { proactiveStyle: profile.proactiveStyle } : {}) };
  return `角色身份、语言与相处规则：${JSON.stringify(core)}\n完整背景资料（canon 是原作资料，project-design 是本项目创作；不代表用户经历）：${JSON.stringify(ranked)}`;
}
