import type { DataMutation, DataOverview, DataQuery } from '../../shared/contracts';
import { dataMutationSchema, dataQuerySchema, dataExportSchema } from '../../shared/dataAdmin';
import type { ChatStore } from './ChatStore';
import type { ModelConfig } from './ModelConfig';
export class DataAdminService {
  constructor(private store: ChatStore, private config: ModelConfig, private runtime: () => { dataRoot: string; databaseSizeBytes: number; launches: number; characters: { id: string; name: string }[] }, private beforeChange: () => void, private afterChange: () => void) {}
  overview(): DataOverview {
    const runtime = this.runtime(), installed = new Map(runtime.characters.map(row => [row.id, row.name]));
    const ids = [...new Set([...installed.keys(), ...this.store.dataRoleIds()])];
    return { memoryJobs: this.store.memory.list().map(({ id, kind, characterId, sessionId, state, attempts, notBefore, errorCode, updatedAt }) => ({ id, kind, characterId, sessionId, state, attempts, notBefore, errorCode, updatedAt, sessionTitle: this.store.sessionEntry(sessionId).title })), observationCount: (this.store.memory.db.prepare('SELECT COUNT(*) AS n FROM memory_observations').get() as { n: number }).n, dataRoot: runtime.dataRoot, schemaVersion: this.store.schemaVersion, databaseSizeBytes: runtime.databaseSizeBytes, launches: runtime.launches, counts: this.store.dataCounts(), roles: ids.map(id => ({ id, name: installed.get(id) ?? id, installed: installed.has(id), counts: this.store.dataCounts(id) })), memoryEnabled: this.config.public().memoryEnabled, autoSummary: this.config.public().autoSummary, autoLongMemory: this.config.public().autoLongMemory };
  }
  query(raw: DataQuery) { return this.store.dataPage(dataQuerySchema.parse(raw)); }
  mutate(raw: DataMutation) {
    const input = dataMutationSchema.parse(raw);
    if (input.action === 'add-memory' && !this.overview().roles.some(role => role.id === input.characterId)) throw new Error('角色不存在，请选择已有角色');
    this.store.assertDataMutation(input); if (input.action !== 'rename-session') this.beforeChange(); this.store.mutateData(input); this.afterChange(); return null;
  }
  export(raw: Omit<DataQuery, 'before' | 'offset'>) {
    const scope = dataExportSchema.parse(raw), total = this.store.dataPage(scope, 1).total;
    if (total > 20000) throw new Error('筛选结果超过20000条，请缩小角色、会话或关键词范围后导出');
    const records = this.store.dataPage(scope, 20000).records;
    return { schemaVersion: 1, exportedAt: new Date().toISOString(), scope, count: records.length, records };
  }
}
