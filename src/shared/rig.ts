import type { CharacterRig, Point, RigAction } from './contracts';

export interface Matrix { a: number; b: number; c: number; d: number; e: number; f: number }
const identity = (): Matrix => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
export function multiply(left: Matrix, right: Matrix): Matrix {
  return { a: left.a * right.a + left.c * right.b, b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d, d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e, f: left.b * right.e + left.d * right.f + left.f };
}
export function rigPose(action: RigAction, progress: number) {
  const time = Math.min(1, Math.max(0, progress));
  const end = action.keyframes.findIndex(frame => frame.offset >= time);
  const right = action.keyframes[Math.max(0, end)], left = action.keyframes[Math.max(0, end - 1)];
  const raw = right.offset === left.offset ? 0 : (time - left.offset) / (right.offset - left.offset);
  const eased = (1 - Math.cos(Math.PI * raw)) / 2;
  return { blend: left.blend + (right.blend - left.blend) * eased,
    rotations: Object.fromEntries(Object.keys(left.rotations).map(id => [id, left.rotations[id] + (right.rotations[id] - left.rotations[id]) * eased])) };
}
export function boneMatrices(rig: CharacterRig, rotations: Record<string, number>, width: number, height: number) {
  const result = new Map<string, Matrix>();
  for (const bone of rig.bones) {
    const x = bone.pivot.x * width, y = bone.pivot.y * height, angle = rotations[bone.id] * Math.PI / 180;
    const a = Math.cos(angle), b = Math.sin(angle);
    const around = { a, b, c: -b, d: a, e: x - a * x + b * y, f: y - b * x - a * y };
    result.set(bone.id, multiply(bone.parent ? result.get(bone.parent)! : identity(), around));
  }
  return result;
}
function inside(point: Point, polygon: Point[]) {
  let result = false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
    const a=polygon[i], b=polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x) result = !result;
  }
  return result;
}
export function rigHit(rig: CharacterRig, matrices: Map<string, Matrix>, blend: number, point: Point, width: number, height: number,
  sourceHit: (texture: string, x: number, y: number) => boolean) {
  if(point.x < 0 || point.x >= 1 || point.y < 0 || point.y >= 1) return false;
  const patched = inside(point,rig.patch.polygon);
  if((!patched || blend < .875) && sourceHit('current',point.x,point.y)) return true;
  if(blend <= .125 || point.y >= rig.fixedBelow) return false;
  if(patched && sourceHit(rig.patch.texture,point.x,point.y)) return true;
  for(const bone of rig.bones) {
    const m=matrices.get(bone.id)!, determinant=m.a*m.d-m.b*m.c, x=point.x*width-m.e, y=point.y*height-m.f;
    const source={ x:((m.d*x-m.c*y)/determinant-bone.pivot.x*width)/bone.scale/width+bone.sourcePivot.x,
      y:((-m.b*x+m.a*y)/determinant-bone.pivot.y*height)/bone.scale/height+bone.sourcePivot.y };
    const r=bone.sourceRect;
    if(r && (source.x < r.x || source.y < r.y || source.x >= r.x+r.width || source.y >= r.y+r.height) || bone.polygon && !inside(source,bone.polygon)) continue;
    if(sourceHit(bone.texture,source.x,source.y)) return true;
  }
  return false;
}
