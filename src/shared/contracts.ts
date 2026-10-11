export interface Point { x: number; y: number }
export interface Bounds extends Point { width: number; height: number }
export type InteractionMode = 'auto' | 'interactive' | 'passthrough';
export type AnimationLevel = 'full' | 'subtle' | 'off';
export interface Preferences {
  height: number; alwaysOnTop: boolean; interaction: InteractionMode; position?: Point;
  proactive: boolean; greetings: boolean; animations: AnimationLevel; proactiveMinutes: number;
  quietUntil: number; selectedCharacterId?: string;
  bubbleDurationMs: number;
}
export type PreferencePatch = Partial<Omit<Preferences, 'position' | 'selectedCharacterId'>>;
export interface FrameAction {
  overlayRegions?: { x: number; y: number; radiusX: number; radiusY: number }[];
  kind: 'frames'; transitionMs: number; durationMs: number; loop: false;
  frames: { frame: string; holdMs: number }[];
}
export interface TransformAction {
  kind: 'transform'; durationMs: number; loop: boolean;
  keyframes: { offset: number; translateY: number; rotate: number }[];
}
export interface MeshAction {
  kind: 'mesh'; durationMs: number; loop: false;
  regions: { center: Point; radius: Point; pivot: Point;
    keyframes: { offset: number; x: number; y: number; rotate: number }[] }[];
}
export interface RigAction {
  kind: 'rig'; durationMs: number; loop: false;
  keyframes: { offset: number; blend: number; rotations: Record<string, number> }[];
}
export interface CharacterRig {
  assets: Record<string, string>;
  fixedBelow: number;
  patch: { texture: string; polygon: Point[] };
  bones: { id: string; parent?: string; pivot: Point; texture: string; sourcePivot: Point; scale: number;
    sourceRect?: { x: number; y: number; width: number; height: number }; polygon?: Point[] }[];
}
export type CharacterAction = FrameAction | TransformAction | MeshAction | RigAction;
export interface HitMask { width: number; height: number; bits: string }
export type HostEvent = 'startup' | 'hover' | 'click' | 'drag-end' | 'proactive' | 'welcome';
export type InteractionEvent = string;
export interface InteractionLine { id: string; speaker: string; text: string; expression: string; action?: string }
export interface CharacterCatalog {
  actions: Record<string, { label: string; allowInSubtle: boolean }>;
  expressions: Record<string, { label: string }>;
}
export interface CharacterBehavior {
  events: Partial<Record<HostEvent, string>>;
  commands: Record<string, { label: string; response: string; cooldownMs: number }>;
  states: { hovering?: string; dragging?: string };
  idleAction?: string;
  ambient?: { action: string; firstDelayMs: number; minIntervalMs: number; maxIntervalMs: number };
  timing: { startupDelayMs: number; hoverDelayMs: number; hoverTextDelayMs: number; leaveDelayMs: number; hoverCooldownMs: number; clickCooldownMs: number };
}
export interface CharacterBubble {
  choices: string[]; choiceHint: string; passiveHint: string;
  theme: { background: string; backgroundEnd: string; text: string; accent: string; border: string; buttonBackground: string; radius: number };
}
export interface CharacterView {
  id: string; name: string; shortName: string; work: string; description: string;
  canvas: { width: number; height: number }; anchor: Point;
  expressions: Record<string, string>; frames: Record<string, string>; actions: Record<string, CharacterAction>;
  rig?: CharacterRig;
  hitMasks: Record<string, HitMask>; speakers: Record<string, { displayName: string }>;
  defaultExpression: string; fallbackExpression: string; expressionTransitionMs: number;
  warnings: string[];
  catalog: CharacterCatalog; behavior: CharacterBehavior; bubble: CharacterBubble;
}
export interface Bubble {
  id: number; speaker: string; text: string; source: InteractionEvent; choices: boolean; expiresAt: number;
}
export interface Presentation { id: number; epoch: number; action: string; expression: string; durationMs: number }
export interface CompanionState {
  epoch: number; presentation?: Presentation; bubble?: Bubble; expression: string;
  dragging: boolean; visible: boolean; quietReason?: 'manual' | 'fullscreen' | 'locked' | 'settings';
  fullscreenObserver: 'starting' | 'ready' | 'unavailable';
}
export interface DesktopState {
  character: CharacterView; characters: { id: string; name: string }[]; preferences: Preferences;
  expression: string; companion: CompanionState; window: Bounds; mouseIgnored: boolean;
  database: { previousLaunches: number; currentLaunches: number }; version: string; warnings: string[];
}
export interface PreparedCharacter { token: string; character: CharacterView }
export interface ChatImage { id: string; name: string; mime: 'image/png' | 'image/jpeg'; width: number; height: number; byteLength: number; sha256: string; url: string }
export interface ModelOptions { imageInput?: 'auto' | 'enabled' | 'disabled'; provider: 'openai-compatible' | 'deepseek'; protocol: 'chat-completions' | 'responses'; thinking: 'default' | 'enabled' | 'disabled'; reasoningEffort: 'default' | 'none' | 'low' | 'medium' | 'high' | 'max'; reasoningSummary: boolean; maxOutputTokens: number; timeoutSeconds: number }
export interface ContextOptions { contextWindowTokens: number; autoSummary: boolean; autoLongMemory?: boolean }
export interface ModelSettings extends ModelOptions, ContextOptions { baseUrl: string; model: string; hasKey: boolean; proactive: boolean; memoryEnabled: boolean; streaming: boolean }
export interface ModelSettingsInput extends Partial<ModelOptions>, Partial<ContextOptions> { baseUrl: string; model: string; apiKey?: string; clearKey?: boolean; proactive: boolean; memoryEnabled: boolean; streaming?: boolean }
export interface ChatMessage { images?: ChatImage[]; revision?: number; turnId?: string; id: string; role: 'user' | 'assistant'; text: string; reasoning?: string; speaker?: string; status: 'complete' | 'pending' | 'cancelled' | 'failed'; createdAt: number; proactive: boolean }
export type MemoryEffectiveStatus = 'current' | 'historical' | 'retracted' | 'needs_review' | 'future' | 'expired' | 'condition_failed' | 'unknown';
export interface MemoryApplicability { status: MemoryEffectiveStatus; reason?: string; evaluatedAt: number }
export type EvidenceClass = 'user_asserted' | 'user_confirmed' | 'fiction_event' | 'character_belief' | 'hypothesis' | 'quoted' | 'model_inferred';
export interface MemoryMetadata { evidenceClass: EvidenceClass; assertedAt?: number; validityBasis?: 'explicit' | 'as_of_assertion' | 'unknown' }
export interface MemoryLifecycle { status: 'active' | 'historical' | 'retracted' | 'needs_review'; reason?: string; factKey?: string; changeType?: 'fact_change' | 'correction' | 'temporary' | 'plan' | 'history' | 'fiction'; eventTime?: string; validFrom?: string; validTo?: string; conditions?: string[]; dependsOn?: string[]; dependencies?: { id: string; revision: number }[] }
export interface MemoryItem { scope?: LongMemoryScope; sessionId?: string; lifecycle?: MemoryLifecycle; updateSourceMessageIds?: string[]; id: string; text: string; sourceMessageId?: string; createdAt: number; revision?: number; updatedAt?: number }
export type LongMemoryKind = 'user_statement' | 'preference' | 'experience' | 'belief' | 'plan' | 'commitment' | 'uncertainty';
export type LongMemoryScope = 'real' | 'fiction' | 'unknown';
export interface LongMemoryItem { metadata?: MemoryMetadata; applicability?: MemoryApplicability; lifecycle?: MemoryLifecycle; updateSourceMessageIds?: string[]; id: string; text: string; kind: LongMemoryKind; scope: LongMemoryScope; subject: 'user' | 'character' | 'interaction'; characterId: string; sessionId: string; batchId: string; roleRevision: string; sourceMessageIds: string[]; fromMessageId: string; throughMessageId: string; sourceHash: string; asOf: number; createdAt: number; updatedAt: number; revision: number; author: 'model' | 'user' }
export interface MemoryObservation { id: string; characterId: string; sessionId: string; roleRevision: string; scope: LongMemoryScope; topicKey: string; text: string; revision: number; status: 'active' | 'needs_review'; author: 'model' | 'user'; sources: { type: 'fact' | 'confirmed'; id: string; revision: number }[]; createdAt: number; updatedAt: number }
export interface SummaryEntry { id: string; revision: number; category: keyof SummaryData; text: string; scope: LongMemoryScope; modality: 'asserted' | 'possible' | 'negated' | 'conditional'; status: 'active' | 'resolved'; sourceMessageIds: string[]; sourceGranularity: 'exact' | 'batch'; author: 'model' | 'user' }
export interface MemoryJobView { sessionTitle?: string; id: string; kind: 'extract' | 'consolidate' | 'summary'; characterId: string; sessionId: string; state: 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'superseded' | 'blocked'; attempts: number; notBefore: number; errorCode?: string; updatedAt: number }
export interface ChatTarget { characterId: string; epoch: number; sessionId: string; historyRevision: number }
export interface SessionEntry { id: string; createdAt: number; title: string; titleRevision: number }
export interface HistoryPage { target: ChatTarget; messages: ChatMessage[]; sessions: SessionEntry[]; hasMore: boolean }
export interface ConversationSummary { entries?: SummaryEntry[]; revision: number; roleRevision: string; throughMessageId: string; sourceCount: number; sourceHash: string; asOf: number; createdAt: number; data: SummaryData; author?: 'model' | 'user' }
export interface SummaryData { events: string[]; userStatements: string[]; fictionalState: string[]; uncertainties: string[]; commitments: string[]; openQuestions: string[]; keyQuotes: string[] }
export interface ContextMemoryTrace { observations?: { id: string; revision: number }[]; enabled: boolean; confirmed: { id: string; text: string; revision: number; updatedAt: number }[]; automatic: { id: string; text: string; revision: number }[]; omittedConfirmed: number; omittedAutomatic: number }
export interface ChatRequestDiagnostic { promptRevision?: string; memoryVersions?: { id: string; revision: number; type: 'confirmed' | 'fact' | 'observation' }[]; roleRevision?: string; summaryRevision?: number; at: number; sessionId: string; assistantId: string; model: string; outcome: 'completed' | 'failed' | 'cancelled'; attempts?: number; errorCode?: string; httpStatus?: number; transportCode?: string; elapsedMs: number; confirmedMemoryIds: string[]; automaticMemoryIds: string[] }
export interface ContextStats { includedImages?: number; omittedImages?: number; estimatedTokens: number; inputBudget: number; includedMessages: number; omittedMessages: number; summarizedMessages: number; memoryTrace?: ContextMemoryTrace }
export interface ChatState extends ChatTarget { characterId: string; epoch: number; sessionId: string; sessions: SessionEntry[]; messages: ChatMessage[]; hasOlderMessages: boolean; hasOlderSessions: boolean; memories: MemoryItem[]; settings: ModelSettings; contextStats?: ContextStats; lastRequest?: ChatRequestDiagnostic; summary?: ConversationSummary; summarizing: boolean; summaryWarning?: string; longMemoryRunning?: boolean; longMemoryCount?: number; longMemoryWarning?: string; busy: boolean; draft: string; reasoningDraft?: string; generationPhase?: 'waiting' | 'thinking' | 'answering'; error?: string }
export type DataSection = 'memories' | 'long-memories' | 'messages' | 'inputs' | 'summaries' | 'sessions';
export interface DataQuery { memoryLayer?: 'facts' | 'observations'; memoryStatus?: MemoryLifecycle['status']; section: DataSection; characterId?: string; sessionId?: string; query?: string; before?: number; offset?: number; sourceMemoryId?: string; createdFrom?: number; createdBefore?: number; sessionContent?: 'with-messages' | 'empty' }
export interface DataRecord { memoryScope?: LongMemoryScope; observation?: MemoryObservation; applicability?: MemoryApplicability; lifecycle?: MemoryLifecycle; updateSourceMessageIds?: string[]; images?: ChatImage[]; id: string; section: DataSection; sequence: number; characterId: string; sessionId?: string; text: string; createdAt: number; revision: number; stamp?: string; updatedAt?: number; sourceMessageId?: string; sourceSessionId?: string; role?: ChatMessage['role']; status?: ChatMessage['status']; proactive?: boolean; speaker?: string; reasoning?: string; origin?: 'live' | 'backfill'; summary?: ConversationSummary; longMemory?: LongMemoryItem; summaryError?: string; messageCount?: number; isActive?: boolean; sessionTitle?: string; lastMessageAt?: number; inputCount?: number; longMemoryCount?: number; hasSummary?: boolean; titleRevision?: number; titleSource?: 'auto' | 'manual' }
export interface DataPage { records: DataRecord[]; total: number; hasMore: boolean; nextBefore?: number }
export interface DataOverview { memoryJobs?: MemoryJobView[]; observationCount?: number; dataRoot: string; schemaVersion: number; databaseSizeBytes: number; launches: number; counts: Record<DataSection, number>; roles: { id: string; name: string; installed: boolean; counts: Record<DataSection, number> }[]; memoryEnabled: boolean; autoSummary: boolean; autoLongMemory?: boolean }
export type DataMutation = { action: 'retry-memory-job'; characterId: string; id: string } | { action: 'edit-observation'; characterId: string; id: string; revision: number; text: string } | { action: 'delete-observations'; items: { characterId: string; id: string; revision: number }[] } | { action: 'rename-session'; characterId: string; id: string; titleRevision: number; title: string } | { action: 'add-memory'; characterId: string; text: string; scope?: LongMemoryScope; sessionId?: string } | { action: 'edit-memory'; characterId: string; id: string; revision: number; text: string } | { action: 'delete-memories'; items: { characterId: string; id: string; revision: number }[] } | { action: 'delete-sessions'; items: { characterId: string; id: string; revision: number }[] } | { action: 'edit-input'; characterId: string; sessionId: string; id: string; revision: number; text: string } | { action: 'retract-message'; characterId: string; sessionId: string; id: string; revision: number } | { action: 'edit-summary'; characterId: string; sessionId: string; revision: number; stamp: string; data: SummaryData } | { action: 'discard-summary'; characterId: string; sessionId: string; revision: number; stamp: string } | { action: 'edit-long-memory'; characterId: string; id: string; revision: number; text: string } | { action: 'delete-long-memories'; items: { characterId: string; id: string; revision: number }[] };
export interface DataExportResult { cancelled: boolean; path?: string; count?: number }
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
export interface PetAPI {
  openDataAdmin(section?: DataSection | 'overview'): Promise<ApiResult<null>>;
  onAdminNavigate(callback: (section: string) => void): () => void;
  dataOverview(): Promise<ApiResult<DataOverview>>;
  dataQuery(value: DataQuery): Promise<ApiResult<DataPage>>;
  dataMutate(value: DataMutation): Promise<ApiResult<null>>;
  dataExport(value: Omit<DataQuery, 'before' | 'offset'>): Promise<ApiResult<DataExportResult>>;
  retractMessage(value: ChatTarget & { messageId: string }): Promise<ApiResult<ChatState>>;
  editMessage(value: ChatTarget & { messageId: string; text: string }): Promise<ApiResult<ChatState>>;
  regenerateReply(value: ChatTarget & { messageId: string }): Promise<ApiResult<ChatState>>;
  getChat(): Promise<ApiResult<ChatState>>;
  configureModel(value: ModelSettingsInput): Promise<ApiResult<ChatState>>;
  pickChatImages(value: ChatTarget & { remaining: number }): Promise<ApiResult<ChatImage[]>>;
  discardChatImages(value: { ids: string[] }): Promise<ApiResult<null>>;
  sendChat(value: ChatTarget & { text: string; imageIds?: string[] }): Promise<ApiResult<ChatState>>;
  cancelChat(value: ChatTarget): Promise<ApiResult<ChatState>>;
  newConversation(value: ChatTarget): Promise<ApiResult<ChatState>>;
  selectConversation(value: ChatTarget & { selectedSessionId: string }): Promise<ApiResult<ChatState>>;
  clearChatHistory(value: ChatTarget): Promise<ApiResult<ChatState>>;
  addMemory(value: ChatTarget & { text: string; sourceMessageId?: string; scope?: LongMemoryScope }): Promise<ApiResult<ChatState>>;
  deleteMemory(value: ChatTarget & { id: string }): Promise<ApiResult<ChatState>>;
  chatHistory(value: ChatTarget & { kind: 'messages' | 'sessions'; beforeId: string }): Promise<ApiResult<HistoryPage>>;
  extractLongMemory(value: ChatTarget): Promise<ApiResult<ChatState>>;
  summarizeChat(value: ChatTarget): Promise<ApiResult<ChatState>>;
  discardSummary(value: ChatTarget): Promise<ApiResult<ChatState>>;
  openChat(): Promise<ApiResult<null>>;
  onChat(callback: (state: ChatState) => void): () => void;
  getState(): Promise<ApiResult<DesktopState>>;
  setPreferences(patch: PreferencePatch): Promise<ApiResult<DesktopState>>;
  setExpression(expression: string): Promise<ApiResult<DesktopState>>;
  interact(event: string): Promise<ApiResult<null>>;
  playAction(action: string): Promise<ApiResult<null>>;
  stopAction(): Promise<ApiResult<null>>;
  dismissBubble(): Promise<ApiResult<null>>;
  stageReady(epoch: number): Promise<ApiResult<null>>;
  animationFinished(value: { epoch: number; id: number }): Promise<ApiResult<null>>;
  prepareCharacter(id: string): Promise<ApiResult<PreparedCharacter>>;
  commitCharacter(token: string): Promise<ApiResult<DesktopState>>;
  setHover(inside: boolean): Promise<ApiResult<null>>;
  setBubbleHover(inside: boolean): Promise<ApiResult<null>>;
  dragStart(point: Point): Promise<ApiResult<null>>;
  dragMove(point: Point): Promise<ApiResult<null>>;
  dragEnd(): Promise<ApiResult<null>>;
  dragCancel(): Promise<ApiResult<null>>;
  openSettings(): Promise<ApiResult<null>>;
  openMenu(): Promise<ApiResult<null>>;
  hide(): Promise<ApiResult<null>>;
  resetPosition(): Promise<ApiResult<DesktopState>>;
  quit(): Promise<ApiResult<null>>;
  onState(callback: (state: DesktopState) => void): () => void;
}
export const channels = {
  openDataAdmin: 'data:open', adminNavigate: 'data:navigate',
  dataOverview: 'data:overview', dataQuery: 'data:query', dataMutate: 'data:mutate', dataExport: 'data:export',
  pickChatImages: 'chat:images-pick', discardChatImages: 'chat:images-discard', getChat: 'chat:state', configureModel: 'chat:config', sendChat: 'chat:send', cancelChat: 'chat:cancel', newConversation: 'chat:new', selectConversation: 'chat:select',
  clearChatHistory: 'chat:clear', addMemory: 'chat:remember', deleteMemory: 'chat:forget', openChat: 'chat:open', chatChanged: 'chat:changed',
  extractLongMemory: 'chat:long-memory', chatHistory: 'chat:history', summarizeChat: 'chat:summarize', discardSummary: 'chat:summary-discard',
  retractMessage: 'chat:retract', editMessage: 'chat:edit', regenerateReply: 'chat:regenerate',
  getState: 'pet:state', setPreferences: 'pet:preferences', setExpression: 'pet:expression',
  interact: 'pet:interact', playAction: 'pet:action', stopAction: 'pet:stop', dismissBubble: 'pet:dismiss',
  stageReady: 'pet:ready', animationFinished: 'pet:finished', prepareCharacter: 'pet:prepare', commitCharacter: 'pet:commit',
  setHover: 'pet:hover', setBubbleHover: 'pet:bubble-hover', dragStart: 'pet:drag-start', dragMove: 'pet:drag-move',
  dragEnd: 'pet:drag-end', dragCancel: 'pet:drag-cancel', openSettings: 'pet:settings', openMenu: 'pet:menu', hide: 'pet:hide',
  resetPosition: 'pet:reset', quit: 'pet:quit', changed: 'pet:changed'
} as const;
