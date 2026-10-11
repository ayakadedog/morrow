import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';

if (process.platform !== 'darwin') {
  console.error('Mac packages must be built on macOS. Copy the source to a Mac, or use the optional Build macOS workflow in GitHub Actions.');
  process.exit(1);
}
const root = resolve(import.meta.dirname, '..');
const flags = process.argv.slice(2);
const allowed = new Set(['--dir', '--arm64', '--x64']);
if (flags.some(flag => !allowed.has(flag)) || flags.includes('--arm64') && flags.includes('--x64')) {
  console.error('Usage: npm run dist:mac -- [--arm64 | --x64] (or npm run pack:mac for an unpacked app)');
  process.exit(1);
}
const arch = flags.includes('--arm64') ? 'arm64' : flags.includes('--x64') ? 'x64' : process.arch;
if (!['arm64', 'x64'].includes(arch) || arch !== process.arch) {
  console.error('Build on a Mac runner matching the target architecture: Apple Silicon for arm64, Intel for x64.');
  process.exit(1);
}
function run(file, args) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: root, stdio: 'inherit' });
    child.once('error', fail);
    child.once('exit', (code, signal) => code === 0 ? done() : fail(new Error(`Build failed (${signal ?? code}).`)));
  });
}
// Invoke npm through Node so we do not need a shell or depend on PATH for its executable.
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this script through npm run pack:mac or npm run dist:mac.');
await run(npm, ['run', 'build']);
await run(join(root, 'node_modules/electron-builder/cli.js'), ['--mac', `--${arch}`, '--publish', 'never', ...flags.filter(flag => flag === '--dir')]);
