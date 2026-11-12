type Frame = { width: number; height: number; bytes: Uint8Array };
let frame: Frame | null = null;
let calls = 0;
let resizes: Array<{ width: number; height: number }> = [];
type Rect = { x: number; y: number; width: number; height: number };
let rects: Rect[] = [];

export function setFakeCapture(value: Frame): void { frame = { ...value, bytes: value.bytes.slice() }; }
export function resetFakeCapture(): void { frame = null; calls = 0; resizes = []; rects = []; zoomFactor = 1; }
export function fakeCaptureCalls(): number { return calls; }
export function fakeCaptureResizes(): Array<{ width: number; height: number }> { return resizes.map(size => ({ ...size })); }
export function fakeCaptureRects(): Rect[] { return rects.map(rect => ({ ...rect })); }

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
let zoomFactor = 1;
/** Współczynnik zoomu okna (plugin przelicza prostokąt CSS px -> DIP). */
export function setFakeZoomFactor(value: number): void { zoomFactor = value; }
export const remote = { getCurrentWebContents: () => ({
  getZoomFactor: () => zoomFactor,
  async capturePage(rect: Rect) {
    calls++;
    rects.push({ ...rect });
    if (!frame) throw new Error('Fake capture unavailable');
    return nativeImage(frame);
  },
}) };
