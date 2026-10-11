/** Local names need no model call; a manual title always takes precedence. */
export function automaticSessionTitle(text: string | undefined, createdAt: number) {
  const topic = text?.replace(/\s+/g, ' ').trim();
  if (topic) return [...topic].slice(0, 40).join('') + ([...topic].length > 40 ? '…' : '');
  const date = new Date(createdAt), pad = (n: number) => String(n).padStart(2, '0');
  return `新对话 · ${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
