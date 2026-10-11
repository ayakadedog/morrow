import { realpathSync, lstatSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';

export function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'));
}
export function safeResource(root: string, resource: string): string {
  if (!resource || resource.includes('\\') || /[:\x00]/.test(resource) || isAbsolute(resource) || resource.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new Error('角色资源必须是目录内的相对路径');
  }
  const realRoot = realpathSync(root);
  const candidate = resolve(realRoot, resource);
  if (!within(realRoot, candidate)) throw new Error('资源路径越界');
  let component = realRoot;
  for (const part of resource.split('/')) {
    component = join(component, part);
    if (lstatSync(component).isSymbolicLink()) throw new Error('资源路径不能使用链接');
  }
  const actual = realpathSync(candidate);
  if (!within(realRoot, actual) || !lstatSync(actual).isFile()) throw new Error('资源不可用或路径越界');
  return actual;
}
export function runtimePaths(appPath: string, packaged: boolean, resourcesPath: string, userDataPath: string) {
  const projectRoot = resolve(appPath);
  const data = packaged ? userDataPath : join(projectRoot, 'data', 'development');
  const dataRoot = process.env.PET_DATA_DIR ? resolve(process.env.PET_DATA_DIR) : data;
  mkdirSync(dataRoot, { recursive: true });
  return { projectRoot, dataRoot, characters: packaged ? join(resourcesPath, 'characters') : process.env.PET_CHARACTER_DIR ? resolve(process.env.PET_CHARACTER_DIR) : join(projectRoot, 'characters'),
    renderer: packaged ? join(appPath, 'out/renderer') : join(appPath, 'out/renderer') };
}
