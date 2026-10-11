import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatRequestDiagnostic } from '../../shared/contracts';

// Metadata only. Never persist request/response bodies, credentials, headers or raw errors.
export class ChatDiagnostics {
  private file: string;
  constructor(root: string) { this.file = join(root, 'chat-diagnostics.jsonl'); }
  record(value: ChatRequestDiagnostic) {
    try {
      const previous = existsSync(this.file) ? readFileSync(this.file, 'utf8').split('\n').filter(Boolean).slice(-99) : [];
      writeFileSync(this.file + '.tmp', [...previous, JSON.stringify(value)].join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
      renameSync(this.file + '.tmp', this.file);
    } catch { /* Diagnostics failure must never fail or retry a successful answer. */ }
  }
}
