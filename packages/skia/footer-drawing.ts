import { Path2D, type CanvasRenderingContext2D } from "skia-canvas";

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
  const originalRect = ctx.rect;
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
      t.a * x + t.e - initial.e,
      t.d * y + t.f - initial.f,
      t.a * (x + w) + t.e - initial.e - width * initialA,
      t.d * (y + h) + t.f - initial.f - height * initialD,
    ];
    if (!edges.every(Number.isFinite)) return;
    if (cover
      ? edges[0]! > 2 || edges[1]! > 2 || edges[2]! < -2 || edges[3]! < -2
      : edges.some(edge => Math.abs(edge) > 2)) return;
    const extended = h + extraHeight * initialD / t.d;
    if (Number.isFinite(extended) && extended > 0) return extended;
  }

  ctx.rect = function (
    this: CanvasRenderingContext2D,
    ...args: unknown[]
  ) {
    const extended = extendedHeight(this, args, 0, true);
    if (extended !== undefined) args[3] = extended;
    return Reflect.apply(originalRect, this, args);
  } as typeof originalRect;

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
    const result: unknown = Reflect.apply(originalDrawImage, this, args);
    let continuation = args.slice();
    let index = args.length === 5 ? 1 : args.length === 9 ? 5 : undefined;
    if (args.length === 3) {
      const image = args[0];
      if (typeof image === "object" && image !== null) {
        const dimensions = image as {
          naturalWidth?: unknown;
          naturalHeight?: unknown;
          width?: unknown;
          height?: unknown;
        };
        const w = dimensions.naturalWidth ?? dimensions.width;
        const h = dimensions.naturalHeight ?? dimensions.height;
        continuation = [image, args[1], args[2], w, h];
        index = 1;
      }
    }
    if (index === undefined) return result;
    const extended = extendedHeight(this, continuation, index, true);
    if (extended === undefined) return result;
    const t = this.getTransform();
    const originalBottom =
      t.d *
        (Number(continuation[index + 1]) +
          Number(continuation[index + 3])) +
      t.f;
    const bandStart = Math.max(
      initial.f + height * initialD,
      originalBottom,
    );
    const bandEnd = initial.f + (height + extraHeight) * initialD;
    if (bandStart >= bandEnd) return result;
    continuation[index + 3] = extended;
    const band = new Path2D();
    band.rect(
      (initial.e - t.e) / t.a,
      (bandStart - t.f) / t.d,
      width * initialA / t.a,
      (bandEnd - bandStart) / t.d,
    );
    this.save();
    try {
      this.clip(band);
      Reflect.apply(originalDrawImage, this, continuation);
    } finally {
      this.restore();
    }
    return result;
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
        const baseline = (t.d * y + t.f - initial.f) / initialD;
        if (baseline >= height * 0.65 && baseline <= height) {
          const descent = this.measureText(text).actualBoundingBoxDescent;
          const bottom = (t.d * (y + descent) + t.f - initial.f) / initialD;
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
      ctx.rect = originalRect;
      ctx.fillRect = originalFillRect;
      ctx.drawImage = originalDrawImage;
      ctx.fillText = originalFillText;
    },
    brandBottom(): number | undefined {
      return lowest;
    },
  };
}
