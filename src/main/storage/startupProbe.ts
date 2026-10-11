import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export class StartupProbe {
  private db: DatabaseSync;
  private closed = false;
  readonly result: { previousLaunches: number; currentLaunches: number };
  constructor(dataRoot: string) {
    this.db = new DatabaseSync(join(dataRoot, 'desktop.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS startup_probe (id INTEGER PRIMARY KEY, started_at TEXT NOT NULL)');
    const previous = (this.db.prepare('SELECT COUNT(*) AS count FROM startup_probe').get() as { count: number }).count;
    this.db.prepare('INSERT INTO startup_probe(started_at) VALUES (?)').run(new Date().toISOString());
    this.result = { previousLaunches: previous, currentLaunches: previous + 1 };
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
