import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function electronExecutable(root, packaged = false) {
  const platform = process.platform;
  let file;
  if (packaged && process.env.MORROW_EXECUTABLE_PATH) {
    file = resolve(process.env.MORROW_EXECUTABLE_PATH);
  } else if (platform === 'darwin') {
    const folder = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
    file = packaged ? join(root, 'release', folder, 'Morrow.app/Contents/MacOS/Morrow') :
      join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  } else if (platform === 'win32') {
    file = packaged ? join(root, 'release/win-unpacked/Morrow.exe') : join(root, 'node_modules/electron/dist/electron.exe');
  } else {
    throw new Error('Desktop verification currently supports Windows and macOS.');
  }
  if (!existsSync(file)) throw new Error(`Electron executable missing: ${file}. Build the app first.`);
  return file;
}
