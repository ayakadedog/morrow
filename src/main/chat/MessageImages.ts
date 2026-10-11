import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { ChatImage, ChatMessage } from '../../shared/contracts';
import type { ModelMessage } from './ModelClient';

export interface StoredImage extends Omit<ChatImage, 'url'> { data: Buffer }
export function migrateImages(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS message_images(
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    name TEXT NOT NULL, mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg')),
    width INTEGER NOT NULL, height INTEGER NOT NULL, byte_length INTEGER NOT NULL,
    sha256 TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS message_images_message ON message_images(message_id);`);
}
export function imageURL(id: string) { return `pet-image://image/${id}`; }
export function listImages(db: DatabaseSync, messageId: string): ChatImage[] {
  const rows = db.prepare('SELECT id,name,mime,width,height,byte_length AS byteLength,sha256 FROM message_images WHERE message_id=? ORDER BY rowid').all(messageId) as unknown as Omit<ChatImage, 'url'>[];
  return rows.map(row => ({ ...row, url: imageURL(row.id) }));
}
export function withImages(db: DatabaseSync, message: ChatMessage): ChatMessage {
  const images = listImages(db, message.id); return images.length ? { ...message, images } : message;
}
export function withImagesBatch(db: DatabaseSync, messages: ChatMessage[]): ChatMessage[] {
  if (!messages.length) return [];
  const rows = db.prepare('SELECT message_id,id,name,mime,width,height,byte_length AS byteLength,sha256 FROM message_images WHERE message_id IN(SELECT value FROM json_each(?)) ORDER BY rowid').all(JSON.stringify(messages.map(m => m.id))) as unknown as (Omit<ChatImage, 'url'> & { message_id: string })[];
  const images = new Map<string, ChatImage[]>();
  for (const { message_id, ...image } of rows) { const list = images.get(message_id) ?? []; list.push({ ...image, url: imageURL(image.id) }); images.set(message_id, list); }
  return messages.map(m => images.has(m.id) ? { ...m, images: images.get(m.id) } : m);
}
export function insertImages(db: DatabaseSync, messageId: string, images: StoredImage[]) {
  for (const image of images) db.prepare('INSERT INTO message_images VALUES(?,?,?,?,?,?,?,?,?,?)').run(image.id, messageId, image.name, image.mime, image.width, image.height, image.byteLength, image.sha256, image.data, Date.now());
}
export function readImage(db: DatabaseSync, id: string): StoredImage | undefined {
  const row = db.prepare('SELECT id,name,mime,width,height,byte_length AS byteLength,sha256,data FROM message_images WHERE id=?').get(id) as unknown as StoredImage | undefined;
  return row ? { ...row, data: Buffer.from(row.data) } : undefined;
}
export function copyImages(db: DatabaseSync, messageId: string): StoredImage[] {
  return listImages(db, messageId).map(m => ({ ...readImage(db, m.id)!, id: randomUUID() }));
}
export function imageSourceStamp(message: ChatMessage): unknown[] {
  return message.images?.length ? [message.images.map(m => [m.id, m.sha256])] : [];
}
// Metadata is placed next to its source ID. Pixels remain image blocks, not base64 text.
export function archiveImages(messages: ChatMessage[]): Pick<ModelMessage, 'images'> {
  const images = messages.filter(m => m.status === 'complete' && m.role === 'user').flatMap(m => m.images ?? []).map(m => ({ url: m.url, byteLength: m.byteLength }));
  return images.length ? { images } : {};
}
