import type { CanvasRenderingContext2D as Context } from "skia-canvas";

/** The old banner casts a shadow outside its translucent statistics band. */
export function gachaBannerShadow(ctx: Context, left: number, width: number) {
  const top = 41, height = 58, radius = 29;
  ctx.save();
  ctx.beginPath();
  ctx.rect(left - 10, top - 10, width + 20, height + 20);
  ctx.roundRect(left, top, width, height, radius);
  ctx.clip("evenodd");
  ctx.beginPath();
  ctx.roundRect(left, top, width, height, radius);
  ctx.shadowColor = "rgba(0, 0, 0, .4)";
  ctx.shadowBlur = 5 * ctx.getTransform().a;
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.restore();
}
