import { randomUUID } from 'node:crypto';
import { loadPack, loadRegistry, listCharacters, type LoadedPack, type ImageInspector } from './PackLoader';
export class CharacterService {
  current: LoadedPack; epoch = 1;
  private pending?: { token: string; expires: number; pack: LoadedPack };
  private entries: { id: string; name: string }[];
  constructor(private root: string, private inspect?: ImageInspector, preferred?: string, private now = Date.now) {
    const registry = loadRegistry(root);
    this.entries = listCharacters(root);
    try { this.current = loadPack(root, preferred ?? registry.defaultCharacterId, inspect); }
    catch (error) {
      if (!preferred || preferred === registry.defaultCharacterId) throw error;
      this.current = loadPack(root, registry.defaultCharacterId, inspect);
      this.current.view.warnings.push('上次选择的角色不可用，已恢复默认角色。');
    }
  }
  list() {
    return this.entries;
  }
  prepare(id: string) {
    this.pending = undefined;
    const pack = loadPack(this.root, id, this.inspect);
    this.pending = { token: randomUUID(), expires: this.now() + 30000, pack };
    return { token: this.pending.token, character: pack.view };
  }
  validatePrepared(token: string) {
    if (!this.pending || this.pending.token !== token || this.now() > this.pending.expires) throw new Error('角色准备已失效，请重新选择');
  }
  commit(token: string) {
    this.validatePrepared(token);
    this.current = this.pending!.pack; this.pending = undefined; this.epoch++;
    return this.current;
  }
  resource(url: string) { return this.current.assets.get(url) ?? this.pending?.pack.assets.get(url); }
  invalidate() { this.pending = undefined; }
}
