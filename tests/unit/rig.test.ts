import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { boneMatrices, rigPose, rigHit } from '../../src/shared/rig';
import type { CharacterRig, RigAction } from '../../src/shared/contracts';
const config = JSON.parse(readFileSync(resolve('characters/yoshino/assets/animations/rig-v4.json'),'utf8'));
const rig: CharacterRig = config, action: RigAction = { kind: 'rig', loop: false, ...config.actions.greet };
describe('articulated animation geometry', () => {
  it('clamps time and returns exactly to neutral without retaining replacement textures', () => {
    for (const time of [-1,0,1,2]) expect(rigPose(action,time)).toEqual({ blend: 0, rotations: { upper: 0, forearm: 0 } });
    expect(rigPose(action,.28)).toEqual({ blend: 1, rotations: { upper: 45, forearm: -85 } });
  });
  it('keeps the elbow attached to its moving parent throughout the complete wave', () => {
    const elbow = rig.bones[1].pivot, x = elbow.x * 1024, y = elbow.y * 1536;
    for(let i=0;i<=100;i++) {
      const matrices = boneMatrices(rig,rigPose(action,i/100).rotations,1024,1536), upper=matrices.get('upper')!, forearm=matrices.get('forearm')!;
      expect(forearm.a*x+forearm.c*y+forearm.e).toBeCloseTo(upper.a*x+upper.c*y+upper.e,8);
      expect(forearm.b*x+forearm.d*y+forearm.f).toBeCloseTo(upper.b*x+upper.d*y+upper.f,8);
    }
  });
  it('interpolates continuously through the wave turning points', () => {
    for(const key of action.keyframes.slice(1,-1)) {
      const left=rigPose(action,key.offset-.0001), right=rigPose(action,key.offset+.0001);
      expect(Math.abs(left.rotations.forearm-right.rotations.forearm)).toBeLessThan(.001);
      expect(Math.abs(left.blend-right.blend)).toBeLessThan(.001);
    }
  });
  it('moves alpha hit testing with the palm and does not retain its old hit area', () => {
    const matrices=boneMatrices(rig,{upper:45,forearm:-85},1024,1536), m=matrices.get('forearm')!, bone=rig.bones[1];
    const x=bone.pivot.x*1024+(550-bone.sourcePivot.x*1024)*bone.scale, y=bone.pivot.y*1536+(450-bone.sourcePivot.y*1536)*bone.scale;
    const moved={x:(m.a*x+m.c*y+m.e)/1024,y:(m.b*x+m.d*y+m.f)/1536};
    const sourceHit=(texture:string,u:number,v:number)=>texture==='forearm-open'&&Math.abs(u*1024-550)<15&&Math.abs(v*1536-450)<15;
    expect(rigHit(rig,matrices,1,moved,1024,1536,sourceHit)).toBe(true);
    expect(rigHit(rig,matrices,1,{x:x/1024,y:y/1536},1024,1536,sourceHit)).toBe(false);
    expect(rigHit(rig,matrices,1,{x:-.1,y:.2},1024,1536,sourceHit)).toBe(false);
  });
});
