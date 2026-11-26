import type { CanvasRenderingContext2D } from "skia-canvas";

type Transform = ReturnType<CanvasRenderingContext2D["getTransform"]>;

function validTransform(t: Transform): boolean {
  return [t.a, t.b, t.c, t.d, t.e, t.f].every(Number.isFinite)
    && t.a > 0 && t.d > 0 && t.b === 0 && t.c === 0;
}

export function captureFooterDrawing(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  extraHeight: number,
): { restore(): void; brandBottom(): number | undefined } {
  const originalFillRect = ctx.fillRect;
  const originalDrawImage = ctx.drawImage;
  const originalFillText = ctx.fillText;
  const initial = ctx.getTransform();
  const initialA = initial.a;
  const initialD = initial.d;
  const enabled = validTransform(initial)
    && Number.isFinite(width) && width > 0
    && Number.isFinite(height) && height > 0
    && Number.isFinite(width * initialA)
    && Number.isFinite(height * initialD);
  let lowest: number | undefined;

  function extendedHeight(
    receiver: CanvasRenderingContext2D,
    args: readonly unknown[],
    index: number,
    cover = false,
  ): number | undefined {
    if (!enabled || !Number.isFinite(extraHeight) || extraHeight <= 0) return;
    const x = args[index];
    const y = args[index + 1];
    const w = args[index + 2];
    const h = args[index + 3];
    if (typeof x !== "number" || typeof y !== "number"
      || typeof w !== "number" || typeof h !== "number"
      || ![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return;
    const t = receiver.getTransform();
    if (!validTransform(t)) return;
    const edges = [
      t.a * x + t.e,
      t.d * y + t.f,
      t.a * (x + w) + t.e - width * initialA,
      t.d * (y + h) + t.f - height * initialD,
    ];
    if (!edges.every(Number.isFinite) || Math.abs(edges[0]!) > 2 || Math.abs(edges[1]!) > 2 ||
        (cover ? edges[2]! < -2 || edges[3]! < -2 : Math.abs(edges[2]!) > 2 || Math.abs(edges[3]!) > 2)) return;
    const extended = h + extraHeight * initialD / t.d;
    if (Number.isFinite(extended) && extended > 0) return extended;
  }

  ctx.fillRect = function (
    this: CanvasRenderingContext2D,
    ...args: unknown[]
  ) {
    const extended = extendedHeight(this, args, 0);
    if (extended !== undefined) args[3] = extended;
    return Reflect.apply(originalFillRect, this, args);
  } as typeof originalFillRect;

  ctx.drawImage = function (
    this: CanvasRenderingContext2D,
    ...args: unknown[]
  ) {
    const index = args.length === 5 ? 1 : args.length === 9 ? 5 : undefined;
    if (index !== undefined) {
      const extended = extendedHeight(this, args, index, true);
      if (extended !== undefined) args[index + 3] = extended;
    }
    return Reflect.apply(originalDrawImage, this, args);
  } as typeof originalDrawImage;

  ctx.fillText = function (
    this: CanvasRenderingContext2D,
    ...args: unknown[]
  ) {
    const result: unknown = Reflect.apply(originalFillText, this, args);
    const text = args[0];
    const x = args[1];
    const y = args[2];
    if (enabled && typeof text === "string" && /Lotus[- ]Yunzai/.test(text)
      && typeof x === "number" && Number.isFinite(x)
      && typeof y === "number" && Number.isFinite(y)) {
      const t = this.getTransform();
      if (validTransform(t)) {
        const baseline = (t.d * y + t.f) / initialD;
        if (baseline >= height * 0.65 && baseline <= height) {
          const descent = this.measureText(text).actualBoundingBoxDescent;
          const bottom = (t.d * (y + descent) + t.f) / initialD;
          if (Number.isFinite(bottom)) {
            lowest = lowest === undefined ? bottom : Math.max(lowest, bottom);
          }
        }
      }
    }
    return result;
  } as typeof originalFillText;

  return {
    restore(): void {
      ctx.fillRect = originalFillRect;
      ctx.drawImage = originalDrawImage;
      ctx.fillText = originalFillText;
    },
    brandBottom(): number | undefined {
      return lowest;
    },
  };
}
