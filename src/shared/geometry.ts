import type { Bounds, Point } from './contracts';
export const MARGIN_X = 24;
export const MARGIN_Y = 32;
export function petSize(height: number, ratio: number, area: Bounds): { width: number; height: number } {
  const actual = Math.max(100, Math.min(height, area.height - MARGIN_Y * 2, (area.width - MARGIN_X * 2) / ratio));
  return { width: Math.round(actual * ratio) + MARGIN_X * 2, height: Math.round(actual) + MARGIN_Y * 2 };
}
export function clampBounds(bounds: Bounds, area: Bounds): Bounds {
  return { ...bounds,
    x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + Math.max(0, area.width - bounds.width)))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + Math.max(0, area.height - bounds.height))))
  };
}
export function bottomRight(size: Pick<Bounds, 'width' | 'height'>, area: Bounds): Bounds {
  return clampBounds({ ...size, x: area.x + area.width - size.width - 28, y: area.y + area.height - size.height - 16 }, area);
}
export function dragExceeded(from: Point, to: Point): boolean { return Math.hypot(from.x - to.x, from.y - to.y) >= 6; }

export function bubbleBounds(pet: Bounds, area: Bounds): Bounds {
  const width = Math.min(340, area.width), height = Math.min(240, area.height);
  const left = pet.x - width - 8, right = pet.x + pet.width + 8;
  const x = left >= area.x ? left : right + width <= area.x + area.width ? right : area.x;
  const y = left >= area.x || right + width <= area.x + area.width ? pet.y + Math.round(pet.height * 0.14) : pet.y - height - 8;
  return clampBounds({ x, y, width, height }, area);
}

export function maskHit(bits: Uint8Array, width: number, height: number, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= 1 || y >= 1) return false;
  const index = Math.floor(y * height) * width + Math.floor(x * width);
  return Boolean(bits[index >> 3] & (1 << (index & 7)));
}
