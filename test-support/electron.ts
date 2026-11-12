type Frame = { width: number; height: number; bytes: Uint8Array };
let frame: Frame | null = null;
let calls = 0;
let resizes: Array<{ width: number; height: number }> = [];

export function setFakeCapture(value: Frame): void { frame = { ...value, bytes: value.bytes.slice() }; }
export function resetFakeCapture(): void { frame = null; calls = 0; resizes = []; }
export function fakeCaptureCalls(): number { return calls; }
export function fakeCaptureResizes(): Array<{ width: number; height: number }> { return resizes.map(size => ({ ...size })); }

function nativeImage(value: Frame) {
  return {
    getSize: () => ({ width: value.width, height: value.height }),
    resize: (size: { width: number; height: number }) => {
      resizes.push({ ...size });
      return nativeImage({ ...value, ...size });
    },
    toJPEG: (_quality: number) => value.bytes.slice(),
  };
}
export const remote = { getCurrentWebContents: () => ({
  async capturePage() {
    calls++;
    if (!frame) throw new Error('Fake capture unavailable');
    return nativeImage(frame);
  },
}) };
