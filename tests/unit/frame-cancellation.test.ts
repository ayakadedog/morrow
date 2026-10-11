import { describe, expect, it } from 'vitest';
import { FramePlayer } from '../../src/renderer/src/FramePlayer';
import type { CharacterView } from '../../src/shared/contracts';

function image() {
  return { src: '', style: {}, dataset: {}, offsetWidth: 1, decode: () => Promise.resolve() } as unknown as HTMLImageElement;
}
const character = { defaultExpression: 'normal', fallbackExpression: 'normal', expressions: { normal: 'normal.png' }, frames: { happy: 'happy.png', shy: 'shy.png' }, hitMasks: {} } as unknown as CharacterView;
describe('FramePlayer image cancellation', () => {
  it('ignores a decode failure belonging to a cancelled frame while the next expression completes', async () => {
    const visible = image(), hidden = image();
    let rejectOld!: (reason: Error) => void;
    let decodes = 0;
    hidden.decode = () => ++decodes === 1 ? new Promise((_, reject) => { rejectOld = reject; }) : Promise.resolve();
    const player = new FramePlayer(visible, hidden, image(), { style: {} } as HTMLCanvasElement, { style: {} } as HTMLCanvasElement, {} as HTMLElement, character);
    const old = player.run(signal => player.show('happy', 0, signal));
    const latest = player.run(signal => player.show('shy', 0, signal));
    rejectOld(new DOMException('The source image changed', 'EncodingError'));
    await expect(old).resolves.toBeUndefined(); await expect(latest).resolves.toBeUndefined();
    expect(hidden.dataset.frame).toBe('shy'); expect(hidden.dataset.active).toBe('true');
  });
  it('still reports a genuine failure for the current frame', async () => {
    const hidden = image(), failure = new DOMException('Invalid image', 'EncodingError');
    hidden.decode = () => Promise.reject(failure);
    const player = new FramePlayer(image(), hidden, image(), { style: {} } as HTMLCanvasElement, { style: {} } as HTMLCanvasElement, {} as HTMLElement, character);
    await expect(player.run(signal => player.show('happy', 0, signal))).rejects.toBe(failure);
  });
});
