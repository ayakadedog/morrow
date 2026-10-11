import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { ChatStore } from '../../src/main/chat/ChatStore';
import { ChatService } from '../../src/main/chat/ChatService';
import { ModelConfig } from '../../src/main/chat/ModelConfig';
import { loadPack } from '../../src/main/characters/PackLoader';
import { temporary, remove } from './fixtures';
const roots: string[] = [];
const connections: { close(): void }[] = [];
const services: ChatService[] = [];
function fixture() {
  const root = temporary(); roots.push(root);
  const store = new ChatStore(root); connections.push(store);
  const db = new DatabaseSync(join(root, 'chat.sqlite')); connections.push(db);
  db.exec('PRAGMA foreign_keys=ON'); return { root, store, db };
}
function close(connection: { close(): void }) { connection.close(); connections.splice(connections.indexOf(connection), 1); }
afterEach(() => { services.splice(0).forEach(s => s.dispose()); connections.splice(0).reverse().forEach(c => c.close()); roots.splice(0).forEach(remove); });
describe('separate user source archive and complete chat log', () => {
  it('stores two real copies with linked identity, preserves raw text and excludes all assistant messages', () => {
    const { store, db } = fixture(), session = store.session('yoshino');
    const raw = '  下个月可能搬家。\n现在还没决定。  ';
    const id = store.append(session, 'user', raw);
    store.append(session, 'user', raw); store.append(session, 'assistant', '这是回复。');
    store.append(session, 'assistant', '', false, 'pending'); store.append(session, 'assistant', '主动关心。', true);
    const archive = db.prepare('SELECT * FROM user_inputs ORDER BY sequence').all();
    expect(archive).toHaveLength(2);
    expect(archive[0]).toMatchObject({ message_id: id, session_id: session, character_id: 'yoshino', text: raw, origin: 'live' });
    expect(archive[0].created_at).toBe(store.messages(session)[0].createdAt);
    expect(archive[1].message_id).not.toBe(id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n).toBe(5);
    expect(db.prepare("SELECT type FROM sqlite_master WHERE name='user_inputs'").get()?.type).toBe('table');
  });
  it('backfills old history beyond the display window once and keeps new input live after migration', () => {
    const { root, store, db } = fixture(), session = store.session('yoshino');
    for (let i = 0; i < 112; i++) store.append(session, 'user', `旧输入 ${i}`);
    store.append(session, 'assistant', '旧模型回复。');
    db.exec('DROP TRIGGER archive_user_input; DROP TABLE user_inputs; PRAGMA user_version=0;');
    close(db); close(store);
    const upgraded = new ChatStore(root); connections.push(upgraded);
    const check = new DatabaseSync(join(root, 'chat.sqlite')); connections.push(check);
    expect(check.prepare('SELECT COUNT(*) AS n FROM user_inputs').get()?.n).toBe(112);
    expect(check.prepare("SELECT COUNT(*) AS n FROM user_inputs WHERE origin='backfill'").get()?.n).toBe(112);
    const first = check.prepare('SELECT message_id,text,created_at,sequence FROM user_inputs ORDER BY sequence LIMIT 1').get();
    check.exec('PRAGMA user_version=0'); // Simulate retrying the migration with existing archives.
    close(upgraded); const restarted = new ChatStore(root); connections.push(restarted);
    expect(check.prepare('SELECT COUNT(*) AS n FROM user_inputs').get()?.n).toBe(112);
    expect(check.prepare('SELECT message_id,text,created_at,sequence FROM user_inputs ORDER BY sequence LIMIT 1').get()).toEqual(first);
    restarted.append(session, 'user', '新输入');
    expect(check.prepare("SELECT COUNT(*) AS n FROM user_inputs WHERE origin='live'").get()?.n).toBe(1);
  });
  it('rolls back the complete chat insert if its user source cannot be saved', () => {
    const { store, db } = fixture(), session = store.session('yoshino');
    db.exec("CREATE TRIGGER fail_source BEFORE INSERT ON user_inputs BEGIN SELECT RAISE(ABORT,'fixture input failure'); END;");
    expect(() => store.append(session, 'user', '不能只保存一份')).toThrow('fixture input failure');
    expect(store.messages(session)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_inputs').get()?.n).toBe(0);
    db.exec('DROP TRIGGER fail_source'); store.append(session, 'user', '恢复正常');
    expect(store.messages(session)).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_inputs').get()?.n).toBe(1);
  });
  it('rolls back failed backfill without advancing its version and can retry after recovery', () => {
    const { root, store, db } = fixture(), session = store.session('yoshino');
    const first = store.append(session, 'user', '旧消息一');
    const second = store.append(session, 'user', '坏旧消息');
    store.append(session, 'assistant', '原聊天回复');
    db.exec(`DELETE FROM user_inputs; PRAGMA user_version=0;
      CREATE TRIGGER fail_backfill BEFORE INSERT ON user_inputs WHEN NEW.text='坏旧消息'
      BEGIN SELECT RAISE(ABORT,'fixture backfill failure'); END;`);
    close(store); expect(() => new ChatStore(root)).toThrow('fixture backfill failure');
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_inputs').get()?.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n).toBe(3);
    expect(db.prepare("SELECT id FROM messages WHERE role='user' ORDER BY rowid").all().map(m => m.id)).toEqual([first, second]);
    db.exec('DROP TRIGGER fail_backfill');
    const recovered = new ChatStore(root); connections.push(recovered);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(12);
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_inputs').get()?.n).toBe(2);
    expect(recovered.messages(session)).toHaveLength(3);
  });
  it('does not call the model when either copy of the accepted user input cannot be written', () => {
    const { root, store, db } = fixture();
    const codec = { encrypt: (s: string) => Buffer.from(s).toString('base64'), decrypt: (s: string) => Buffer.from(s, 'base64').toString() };
    const config = new ModelConfig(root, codec); config.save({ baseUrl: 'http://localhost:8000/v1', model: 'fixture', proactive: false, memoryEnabled: true });
    const pack = loadPack(resolve('characters'), 'yoshino'); let calls = 0;
    const service = new ChatService(store, config, () => ({ pack, epoch: 1 }), () => {}, () => {}, () => false,
      async () => { calls++; return '{"text":"测试回复"}'; });
    connections.splice(connections.indexOf(store), 1); services.push(service);
    db.exec("CREATE TRIGGER fail_source BEFORE INSERT ON user_inputs BEGIN SELECT RAISE(ABORT,'fixture input failure'); END;");
    expect(() => service.send({ characterId: 'yoshino', epoch: 1, sessionId: service.state().sessionId, historyRevision: 0, text: '故障输入' })).toThrow('fixture input failure');
    expect(calls).toBe(0); expect(service.state().busy).toBe(false); expect(service.state().messages).toEqual([]);
  });
  it('preserves archives across new sessions and restarts while deletion clears both copies only for the selected character', () => {
    const { root, store, db } = fixture(), a = store.session('yoshino'), b = store.session('role-b');
    store.append(a, 'user', 'A的原文'); store.append(b, 'user', 'B的原文'); store.remember('yoshino', '原有记忆');
    store.newSession('yoshino'); close(store);
    const restarted = new ChatStore(root); connections.push(restarted);
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_inputs').get()?.n).toBe(2);
    restarted.clearHistory('yoshino');
    expect(db.prepare("SELECT COUNT(*) AS n FROM user_inputs WHERE character_id='yoshino'").get()?.n).toBe(0);
    expect(db.prepare("SELECT text FROM user_inputs WHERE character_id='role-b'").get()?.text).toBe('B的原文');
    expect(restarted.messages(a)).toEqual([]); expect(restarted.messages(b)[0].text).toBe('B的原文');
    expect(restarted.memories('yoshino')[0].text).toBe('原有记忆');
  });
});
