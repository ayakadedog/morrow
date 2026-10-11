import { loadRegistry, loadPack, type ImageInspector } from './PackLoader';
export function loadDefault(root: string, inspector?: ImageInspector) {
  return loadPack(root, loadRegistry(root).defaultCharacterId, inspector);
}
