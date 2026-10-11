import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
export class FullscreenObserver {
  private child?: ChildProcess; private watchdog?: ReturnType<typeof setTimeout>; private closed = false;
  constructor(file: string, changed: (value: boolean) => void, status: (value: 'ready' | 'unavailable') => void) {
    if (process.platform !== 'win32' || !existsSync(file)) { status('unavailable'); return; }
    this.child = spawn(file, [String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let buffer = '', received = false;
    this.watchdog = setTimeout(() => { if (!received) { status('unavailable'); this.dispose(); } }, 8000);
    this.child.stdout?.on('data', bytes => {
      buffer += bytes.toString('utf8'); if (buffer.length > 4096) { buffer = ''; return; }
      const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const value = JSON.parse(line.trim()); if (typeof value.fullscreen !== 'boolean') continue;
          received = true; clearTimeout(this.watchdog); status('ready'); changed(value.fullscreen);
        } catch { /* Ignore incomplete native output without logging desktop data. */ }
      }
    });
    this.child.once('error', () => { if (!this.closed) status('unavailable'); });
    this.child.once('exit', () => { if (!this.closed) { status('unavailable'); changed(false); } });
  }
  dispose() { this.closed = true; clearTimeout(this.watchdog); this.child?.kill(); }
}
