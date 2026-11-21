import { Canvas, loadImage, type CanvasRenderingContext2D as Context } from "skia-canvas";
import { renderPng, type PngRender } from "./index.ts";

export interface GenshinWorldBossCardModel {
  readonly groups: readonly {
    readonly name: string;
    readonly bosses: readonly {
      readonly name: string;
      readonly killCount: number;
      readonly image?: Uint8Array;
    }[];
  }[];
}

export interface GenshinWorldBossCardOptions {
  readonly mode?: "auto" | "gpu" | "cpu";
  readonly scale?: number;
}

// Original 原神BOSS击杀数.html dimensions, including the browser's body margin.
const contentLeft = 28;
const contentWidth = 1260;
const width = contentWidth + contentLeft * 2;
const headingMargin = 21.4375;
const headingLineHeight = 46;
const columns = 3;
const columnStep = 419.953125;
const cardMargin = 10;
const cardWidth = columnStep - cardMargin * 2;
const cardPadding = 10;
const imageSize = 50;
const textGap = 10;
const lineHeight = 24;
const fontFamily = 'Arial, "Liberation Sans", "Noto Sans CJK SC", sans-serif';
const headingFont = `bold 32px ${fontFamily}`;
const bodyFont = `16px ${fontFamily}`;
const footer = "功能作者: Tloml-Starry | QQ: 1947425850";
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function textLines(ctx: Context, text: string, available: number) {
  const lines: string[] = [];
  let line = "";
  for (const char of text) {
    if (line && ctx.measureText(line + char).width > available) {
      lines.push(line);
      line = "";
    }
    line += char;
  }
  lines.push(line);
  return lines;
}

async function drawIcon(ctx: Context, source: Uint8Array | undefined, x: number, y: number) {
  let image;
  if (source) {
    const bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    const png = bytes.subarray(0, 8).equals(pngSignature);
    const webp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    if (png || webp) image = await loadImage(bytes).catch(() => undefined);
  }

  ctx.save();
  ctx.beginPath();
  ctx.arc(x + imageSize / 2, y + imageSize / 2, imageSize / 2, 0, Math.PI * 2);
  ctx.clip();
  if (image) {
    ctx.drawImage(image, x, y, imageSize, imageSize);
  } else {
    ctx.fillStyle = "#fff";
    ctx.font = bodyFont;
    ctx.fillText("BOSS", x, y + 30);
    ctx.fillText("头像", x, y + 50);
  }
  ctx.restore();
}

export async function renderGenshinWorldBossCard(model: GenshinWorldBossCardModel,
  { mode = "auto", scale = 4 }: GenshinWorldBossCardOptions = {}): Promise<PngRender> {
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError("世界 BOSS 卡缩放比例须在 1 至 4 之间。");

  const metrics = new Canvas(1, 1).getContext("2d");
  let top = contentLeft;
  const groups = model.groups.map(group => {
    metrics.font = headingFont;
    const titles = textLines(metrics, group.name, contentWidth);
    const titleTop = top + headingMargin;
    const underline = titleTop + titles.length * headingLineHeight + 10;
    const gridTop = underline + 2 + headingMargin;
    top = gridTop;

    metrics.font = bodyFont;
    const rows = [];
    for (let start = 0; start < group.bosses.length; start += columns) {
      const bosses = group.bosses.slice(start, start + columns).map(boss => {
        const count = `- 击杀数: ${boss.killCount}`;
        const nameWidth = cardWidth - cardPadding * 2 - imageSize - 2 * textGap - metrics.measureText(count).width;
        const names = textLines(metrics, boss.name, nameWidth);
        const countOffset = Math.max(...names.map(name => metrics.measureText(name).width)) + textGap;
        return { names, count, countOffset, image: boss.image };
      });
      const y = top + cardMargin;
      const height = Math.max(imageSize, ...bosses.map(boss => boss.names.length * lineHeight)) + cardPadding * 2;
      rows.push({ y, height, bosses });
      top += height + cardMargin * 2;
    }
    return { titles, titleTop, underline, rows };
  });
  const footerTop = top + 30;
  const height = footerTop + 88 + contentLeft;

  return renderPng(Math.ceil(width * scale), Math.ceil(height * scale), async ctx => {
    ctx.fillStyle = "#2c2c2c";
    ctx.fillRect(0, 0, Math.ceil(width * scale), Math.ceil(height * scale));
    ctx.scale(scale, scale);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    for (const { titles, titleTop, underline, rows } of groups) {
      ctx.fillStyle = "#ffcc00";
      ctx.font = headingFont;
      titles.forEach((title, index) => ctx.fillText(title, contentLeft, titleTop + 37 + index * headingLineHeight));
      ctx.fillRect(contentLeft, Math.floor(underline), contentWidth, 2);

      for (const { y, height, bosses } of rows) {
        for (const [column, boss] of bosses.entries()) {
          const x = contentLeft + cardMargin + column * columnStep;
          const middle = y + height / 2;
          ctx.fillStyle = "#3c3c3c";
          ctx.beginPath();
          ctx.roundRect(x, y, cardWidth, height, 5);
          ctx.fill();
          await drawIcon(ctx, boss.image, x + cardPadding, middle - imageSize / 2);

          ctx.fillStyle = "#fff";
          ctx.font = bodyFont;
          const textX = x + cardPadding + imageSize + textGap;
          const textTop = middle - boss.names.length * lineHeight / 2;
          boss.names.forEach((name, index) => ctx.fillText(name, textX, textTop + 19 + index * lineHeight));
          ctx.fillText(boss.count, textX + boss.countOffset, middle + 7);
        }
      }
    }

    ctx.fillStyle = "#888";
    ctx.font = `14px ${fontFamily}`;
    ctx.textAlign = "center";
    ctx.fillText(footer, width / 2, footerTop + 51);
  }, mode, { allowHalfScale: scale === 4 });
}
