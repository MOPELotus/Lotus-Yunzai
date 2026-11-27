import { expect, test } from 'bun:test';
import { Path2D, type CanvasRenderingContext2D } from 'skia-canvas';
import { captureFooterDrawing } from './footer-drawing.ts';

function fixture() {
  let transform = { a: 0.5, b: 0, c: 0, d: 0.5, e: 7, f: 11 };
  const fills: unknown[][] = [];
  const rects: unknown[][] = [];
  const images: { args: unknown[]; clipped: boolean; alpha: number; composite: string }[] = [];
  const clips: Path2D[] = [];
  let clipped = false;
  const stack: boolean[] = [];
  const mock = {
    globalAlpha: 0.02,
    globalCompositeOperation: 'multiply',
    getTransform: () => transform,
    measureText: () => ({ actualBoundingBoxDescent: 2 }),
    fillRect(...args: unknown[]) { fills.push(args); },
    rect(...args: unknown[]) { rects.push(args); },
    drawImage(...args: unknown[]) {
      images.push({ args, clipped, alpha: mock.globalAlpha, composite: mock.globalCompositeOperation });
    },
    fillText() {},
    save() { stack.push(clipped); },
    restore() { clipped = stack.pop() ?? false; },
    clip(path: Path2D) { clips.push(path); clipped = true; },
  };
  const ctx = mock as unknown as CanvasRenderingContext2D;
  return {
    ctx, mock, fills, rects, images, clips,
    setTransform(value: typeof transform) { transform = value; },
  };
}

const image = {} as Parameters<CanvasRenderingContext2D['drawImage']>[0];

test('extends full backgrounds and clips, normalizes scale and translation, and restores wrappers', () => {
  const f = fixture();
  const { ctx } = f;
  const original = { rect: ctx.rect, fillRect: ctx.fillRect, drawImage: ctx.drawImage, fillText: ctx.fillText };
  const capture = captureFooterDrawing(ctx, 1200, 400, 160);
  f.setTransform({ a: 2, b: 0, c: 0, d: 2, e: 7, f: 11 });
  ctx.rect(0, 0, 300, 100);
  ctx.rect(-10, -20, 320, 140);
  ctx.rect(10, 10, 30, 20);
  ctx.fillRect(0, 0, 300, 100);
  ctx.fillRect(10, 10, 30, 20);
  ctx.drawImage(image, 0, 0, 300, 100);
  ctx.drawImage(image, 0, 0, 100, 100, 0, 0, 300, 100);
  ctx.fillText('Lotus-Yunzai', 150, 92);
  expect(f.rects).toEqual([[0, 0, 300, 140], [-10, -20, 320, 180], [10, 10, 30, 20]]);
  expect(f.fills).toEqual([[0, 0, 300, 140], [10, 10, 30, 20]]);
  expect(f.images.map(draw => draw.args.slice(1))).toEqual([
    [0, 0, 300, 100], [0, 0, 300, 140],
    [0, 0, 100, 100, 0, 0, 300, 100],
    [0, 0, 100, 100, 0, 0, 300, 140],
  ]);
  expect(f.images.map(draw => draw.clipped)).toEqual([false, true, false, true]);
  expect(f.clips[0]?.bounds).toEqual(new Path2D('M0 100h300v40H0z').bounds);
  expect(capture.brandBottom()).toBe(376);
  capture.restore();
  expect(ctx.rect).toBe(original.rect);
  expect(ctx.fillRect).toBe(original.fillRect);
  expect(ctx.drawImage).toBe(original.drawImage);
  expect(ctx.fillText).toBe(original.fillText);
});

test('negative-origin cover images preserve original pixels and drawing state', () => {
  const f = fixture();
  captureFooterDrawing(f.ctx, 1200, 400, 160);
  f.ctx.drawImage(image, -100, -50, 1400, 500);
  expect(f.images.map(draw => draw.args.slice(1))).toEqual([
    [-100, -50, 1400, 500], [-100, -50, 1400, 660],
  ]);
  expect(f.images.map(draw => draw.clipped)).toEqual([false, true]);
  expect(f.images.every(draw => draw.alpha === 0.02 && draw.composite === 'multiply')).toBe(true);
  expect(f.clips[0]?.bounds).toEqual(new Path2D('M0 450h1200v110H0z').bounds);
  f.ctx.drawImage(image, 10, 10, 20, 20);
  expect(f.images[2]?.clipped).toBe(false);
});

test('three-argument images use natural dimensions and fall back to width and height', () => {
  const f = fixture();
  captureFooterDrawing(f.ctx, 1200, 400, 160);
  const natural = { naturalWidth: 1400, naturalHeight: 500, width: 10, height: 10 } as unknown as typeof image;
  const sized = { width: 1200, height: 400 } as unknown as typeof image;
  f.ctx.drawImage(natural, -100, -50);
  f.ctx.drawImage(sized, 0, 0);
  f.ctx.drawImage(image, 0, 0);
  expect(f.images.map(draw => draw.args)).toEqual([
    [natural, -100, -50], [natural, -100, -50, 1400, 660],
    [sized, 0, 0], [sized, 0, 0, 1200, 560],
    [image, 0, 0],
  ]);
});

test('partial geometry and unsupported transforms remain unchanged', () => {
  const f = fixture();
  captureFooterDrawing(f.ctx, 1200, 400, 160);
  for (const [x, y, w, h] of [[0, 0, 600, 400], [-100, -50, 1200, 400], [10, 0, 1200, 400]] as const) {
    f.ctx.rect(x, y, w, h);
    f.ctx.drawImage(image, x, y, w, h);
  }
  expect(f.rects).toEqual([[0, 0, 600, 400], [-100, -50, 1200, 400], [10, 0, 1200, 400]]);
  expect(f.images.map(draw => draw.args.slice(1))).toEqual(f.rects);
  f.setTransform({ a: 0.5, b: 1, c: 0, d: 0.5, e: 7, f: 11 });
  f.ctx.rect(0, 0, 1200, 400);
  f.ctx.drawImage(image, 0, 0, 1200, 400);
  expect(f.rects[3]).toEqual([0, 0, 1200, 400]);
  expect(f.images[3]?.args.slice(1)).toEqual([0, 0, 1200, 400]);
  expect(f.clips).toHaveLength(0);
});

test('cover overscan already reaching footer is not composited a second time', () => {
  const f = fixture();
  captureFooterDrawing(f.ctx, 1200, 400, 160);
  f.ctx.drawImage(image, -100, -50, 1400, 900);
  expect(f.images).toHaveLength(1);
  expect(f.clips).toHaveLength(0);
});
