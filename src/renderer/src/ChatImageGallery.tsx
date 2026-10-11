import './chat-images.css';
import { useRef, useState } from 'react';
import type { ChatImage } from '../../shared/contracts';

export function ChatImageGallery({ images, onRemove, disabled }: { images?: ChatImage[]; onRemove?: (id: string) => void; disabled?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null), [selected, setSelected] = useState<ChatImage>();
  if (!images?.length) return null;
  const open = (image: ChatImage) => { setSelected(image); dialog.current?.showModal(); };
  return <div className={`chat-images ${onRemove ? 'chat-images-draft' : ''}`}>
    {images.map(image => <figure key={image.id}>
      <button type="button" className="chat-image-thumb" aria-label={`查看图片：${image.name}`} onClick={() => open(image)}><img src={image.url} alt={image.name} loading="lazy" /><span>{image.name}</span></button>
      {onRemove && <button type="button" className="chat-image-remove" disabled={disabled} aria-label={`移除图片：${image.name}`} onClick={() => onRemove(image.id)}>×</button>}
    </figure>)}
    <dialog ref={dialog} className="chat-image-dialog" aria-label="图片预览" onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      {selected && <><div className="chat-image-heading"><span>{selected.name} · {selected.width} × {selected.height}</span><button type="button" aria-label="关闭图片预览" onClick={() => dialog.current?.close()}>关闭</button></div><img src={selected.url} alt={selected.name} /><small>保存在本机的图片 · {Math.ceil(selected.byteLength / 1024)} KB</small></>}
    </dialog>
  </div>;
}
