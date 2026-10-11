import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
if (process.platform !== 'win32') {
  console.log('Windows full-screen observer skipped; use manual quiet mode on this platform.');
  process.exit(0);
}
await mkdir(join(root, 'native'), { recursive: true });
const compiler = join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const result = await promisify(execFile)(compiler, ['/nologo', '/target:exe', '/optimize+', '/platform:x64',
  `/out:${join(root, 'native/foreground-observer.exe')}`, join(root, 'src/main/platform/foreground-observer.cs')], { windowsHide: true });
if (result.stdout) console.log(result.stdout.trim());
console.log('Windows full-screen observer compiled.');
