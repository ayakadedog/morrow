import { z } from 'zod';
import type { CharacterAction, CharacterBehavior, CharacterBubble, CharacterCatalog, InteractionLine } from '../../shared/contracts';

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const hostEvents = ['startup', 'hover', 'click', 'drag-end', 'proactive', 'welcome'] as const;
const label = z.string().min(1).max(40);
const line = z.object({ id, speaker: id, text: z.string().min(1).max(160), expression: id, action: id.optional() }).strict();
const responses = z.record(id, z.array(line).min(1).max(20)).refine(value => Object.keys(value).length <= 64);
export const dialogueSchema = z.union([
  z.object({ schemaVersion: z.literal(2), responses }).strict(),
  z.object({ schemaVersion: z.literal(1), events: responses }).strict(),
]);
export const catalogSchema = z.object({ schemaVersion: z.literal(1),
  actions: z.record(id, z.object({ label, allowInSubtle: z.boolean().default(false) }).strict()),
  expressions: z.record(id, z.object({ label }).strict()),
}).strict();
const timingSchema = z.object({
  startupDelayMs: z.number().int().min(200).max(10000).default(1600),
  hoverDelayMs: z.number().int().min(100).max(5000).default(400),
  hoverTextDelayMs: z.number().int().min(100).max(5000).default(850),
  leaveDelayMs: z.number().int().min(100).max(3000).default(500),
  hoverCooldownMs: z.number().int().min(1000).max(60000).default(8000),
  clickCooldownMs: z.number().int().min(200).max(10000).default(1200),
}).strict();
export const behaviorSchema = z.object({ schemaVersion: z.literal(1),
  events: z.object({ startup: id, hover: id, click: id, 'drag-end': id, proactive: id, welcome: id }).partial().strict(),
  commands: z.record(id, z.object({ label, response: id, cooldownMs: z.number().int().min(0).max(60000).default(0) }).strict())
    .refine(value => Object.keys(value).length <= 16),
  states: z.object({ hovering: id.optional(), dragging: id.optional() }).strict().default({}),
  idleAction: id.optional(),
  ambient: z.object({ action: id, firstDelayMs: z.number().int().min(1000).max(60000),
    minIntervalMs: z.number().int().min(1000).max(60000), maxIntervalMs: z.number().int().min(1000).max(60000) }).strict()
    .refine(value => value.maxIntervalMs >= value.minIntervalMs).optional(),
  timing: timingSchema.default(() => timingSchema.parse({})),
}).strict();
const color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
export const bubbleSchema = z.object({ schemaVersion: z.literal(1),
  choices: z.array(id).max(3).refine(value => new Set(value).size === value.length),
  choiceHint: z.string().max(80), passiveHint: z.string().max(80),
  theme: z.object({ background: color, backgroundEnd: color, text: color, accent: color, border: color, buttonBackground: color,
    radius: z.number().int().min(0).max(28) }).strict(),
}).strict();

export function loadInteraction(read: (path: string) => unknown, paths: { interactionConfig?: string; catalogConfig?: string; behaviorConfig?: string; bubbleConfig?: string },
  actions: Record<string, CharacterAction>, expressions: Record<string, string>, speakers: Record<string, { displayName: string }>, defaultExpression: string) {
  let lines: Record<string, InteractionLine[]> = {};
  if (paths.interactionConfig) {
    const content = dialogueSchema.parse(read(paths.interactionConfig));
    lines = content.schemaVersion === 2 ? content.responses : content.events;
  }
  // Older packs keep their declared responses, without borrowing another character's behavior.
  const catalog: CharacterCatalog = paths.catalogConfig ? catalogSchema.parse(read(paths.catalogConfig)) : {
    actions: Object.fromEntries(Object.keys(actions).map(key => [key, { label: key, allowInSubtle: false }])),
    expressions: Object.fromEntries(Object.keys(expressions).map(key => [key, { label: key }])),
  };
  const behavior: CharacterBehavior = paths.behaviorConfig ? behaviorSchema.parse(read(paths.behaviorConfig)) : {
    events: Object.fromEntries(hostEvents.filter(event => Object.hasOwn(lines, event)).map(event => [event, event])),
    commands: Object.fromEntries(Object.keys(lines).filter(key => !(hostEvents as readonly string[]).includes(key)).map(key => [key, { label: key, response: key, cooldownMs: 0 }])),
    states: {}, timing: timingSchema.parse({}),
  };
  const bubble: CharacterBubble = paths.bubbleConfig ? bubbleSchema.parse(read(paths.bubbleConfig)) : {
    choices: [], choiceHint: '', passiveHint: '',
    theme: { background: '#ffffff', backgroundEnd: '#f6f7f8', text: '#333333', accent: '#666666', border: '#dddddd', buttonBackground: '#eeeeee', radius: 20 },
  };
  for (const values of Object.values(lines)) {
    if (new Set(values.map(value => value.id)).size !== values.length) throw new Error('互动台词 ID 重复');
    for (const value of values) if (!Object.hasOwn(speakers, value.speaker) || !Object.hasOwn(expressions, value.expression) || value.action && !Object.hasOwn(actions, value.action))
      throw new Error('互动台词引用未知说话者、表情或动作');
  }
  for (const [key, command] of Object.entries(behavior.commands)) {
    if ((hostEvents as readonly string[]).includes(key)) throw new Error('角色指令与宿主事件重名');
    if (!Object.hasOwn(lines, command.response)) throw new Error('角色指令引用未知回应');
  }
  for (const response of Object.values(behavior.events)) if (!Object.hasOwn(lines, response)) throw new Error('角色事件引用未知回应');
  for (const key of Object.values(behavior.states)) if (!Object.hasOwn(expressions, key)) throw new Error('互动状态引用未知表情');
  for (const key of bubble.choices) if (!Object.hasOwn(behavior.commands, key)) throw new Error('气泡按钮引用未知指令');
  const sameKeys = (a: object, b: object) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key));
  if (!sameKeys(catalog.actions, actions) || !sameKeys(catalog.expressions, expressions)) throw new Error('角色清单与实际动作或表情不一致');
  if (behavior.idleAction) {
    const action = actions[behavior.idleAction];
    if (!action || action.kind !== 'transform' || !action.loop) throw new Error('待机须引用循环整体动作');
    const first = action.keyframes[0], last = action.keyframes.at(-1)!;
    if (first.translateY !== last.translateY || first.rotate !== last.rotate) throw new Error('待机动作首尾须衔接');
  }
  if (behavior.ambient && !Object.hasOwn(actions, behavior.ambient.action)) throw new Error('周期动作不存在');
  if (!Object.hasOwn(expressions, defaultExpression)) throw new Error('默认表情不存在');
  return { lines, catalog, behavior, bubble };
}
