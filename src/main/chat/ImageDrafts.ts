import { nativeImage } from 'electron';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ChatImage, ChatTarget } from '../../shared/contracts';
import { IMAGE_LIMIT } from '../../shared/imageInput';
import { imageURL, type StoredImage } from './MessageImages';

const MAX_SOURCE = 10 * 1024 * 1024, MAX_STORED = 4 * 1024 * 1024;
function dimensions(data: Buffer): { width: number; height: number; mime: StoredImage['mime'] } {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && data.toString('ascii', 12, 16) === 'IHDR') return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), mime: 'image/png' };
  if (data[0] === 255 && data[1] === 216) {
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 255) break;
      while (data[offset] === 255) offset++;
      const marker = data[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) return { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3), mime: 'image/jpeg' };
      offset += length;
    }
  }
  throw new Error('图片格式无效，目前支持 PNG、JPEG');
}
export function normalizeImage(path: string): StoredImage {
  const stat = statSync(path); if (!stat.isFile() || stat.size > MAX_SOURCE) throw new Error('每张原图不能超过 10 MB');
  const source = readFileSync(path); if (source.length > MAX_SOURCE) throw new Error('每张原图不能超过 10 MB');
  const header = dimensions(source);
  if (!header.width || !header.height || header.width > 8192 || header.height > 8192 || header.width * header.height > 20_000_000) throw new Error('图片过大，最长边须不超过 8192 像素，总像素不超过 2000 万');
  let decoded = nativeImage.createFromBuffer(source); if (decoded.isEmpty()) throw new Error('图片无法解码，请更换文件');
  let size = decoded.getSize(); const ratio = Math.min(1, 2048 / Math.max(size.width, size.height));
  if (ratio < 1) decoded = decoded.resize({ width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)), quality: 'best' });
  let data = header.mime === 'image/png' ? decoded.toPNG() : decoded.toJPEG(90);
  while (data.length > MAX_STORED) {
    size = decoded.getSize(); if (Math.min(size.width, size.height) <= 128) throw new Error('图片处理后仍过大，请换一张图片');
    decoded = decoded.resize({ width: Math.round(size.width * .75), height: Math.round(size.height * .75), quality: 'best' });
    data = header.mime === 'image/png' ? decoded.toPNG() : decoded.toJPEG(85);
  }
  size = decoded.getSize();
  return { id: randomUUID(), name: basename(path).slice(0, 160), mime: header.mime, ...size, byteLength: data.length, sha256: createHash('sha256').update(data).digest('hex'), data };
}
function sameTarget(a: ChatTarget, b: ChatTarget) { return a.characterId === b.characterId && a.epoch === b.epoch && a.sessionId === b.sessionId && a.historyRevision === b.historyRevision; }
export class ImageDrafts {
  private drafts = new Map<string, { image: StoredImage; target: ChatTarget; at: number }>();
  private sweep() { for (const [id, draft] of this.drafts) if (Date.now() - draft.at > 10 * 60_000) this.drafts.delete(id); }
  stage(target: ChatTarget, paths: string[]): ChatImage[] {
    this.sweep(); if (!paths.length) return [];
    if (paths.length > IMAGE_LIMIT || this.drafts.size + paths.length > 12) throw new Error('每条消息最多 4 张图片，请先移除多余附件');
    const images = paths.map(normalizeImage); // Decode all before mutating the draft pool.
    for (const image of images) this.drafts.set(image.id, { image, target: { ...target }, at: Date.now() });
    return images.map(({ data: _data, ...image }) => ({ ...image, url: imageURL(image.id) }));
  }
  resolve(target: ChatTarget, ids: string[]): StoredImage[] {
    this.sweep(); return ids.map(id => { const draft = this.drafts.get(id); if (!draft || !sameTarget(target, draft.target)) throw new Error('图片草稿已过期或会话已改变，请重新添加'); return draft.image; });
  }
  read(id: string) { this.sweep(); return this.drafts.get(id)?.image; }
  discard(ids: string[]) { for (const id of ids) this.drafts.delete(id); }
  clear() { this.drafts.clear(); }
}
