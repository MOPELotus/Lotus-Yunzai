import { Canvas, loadImage, type CanvasRenderingContext2D as Context } from "skia-canvas";
import { renderPng, type PngRender } from "./index.ts";

export interface GenshinBackpackCardModel {
  readonly categories: readonly {
    readonly name: string;
    readonly items: readonly {
      readonly name: string;
      readonly count: number;
      readonly exact: boolean;
      readonly image?: Uint8Array;
    }[];
  }[];
}

export interface GenshinBackpackCardOptions {
  readonly mode?: "auto" | "gpu" | "cpu";
  readonly scale?: number;
}

const width = 2650;
const columns = 20;
const padding = 10;
const gap = 10;
const cardWidth = 122;
const cardHeight = 142;
const artSize = 100;
const badgeInset = 6;
const labelWidth = cardWidth - badgeInset * 2;
const labelLineHeight = 17;
const categoryLineHeight = 26;
const headingLead = 20;
const headingTail = 20;
const fontFamily = '"Microsoft YaHei", Arial, "Liberation Sans", "Noto Sans CJK SC", sans-serif';
const labelFont = `12px ${fontFamily}`;
const categoryFont = `bold 18px ${fontFamily}`;
const footer = "数据来自米游社养成计算器，≥ 表示至少拥有该数量。　原功能作者 Tloml-Starry";
const graphemes = new Intl.Segmenter("zh");
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function textLines(ctx: Context, value: string, available: number) {
  const lines: string[] = [];
  let line = "";
  for (const { segment } of graphemes.segment(value)) {
    if (line && ctx.measureText(line + segment).width > available) {
      lines.push(line);
      line = "";
    }
    line += segment;
  }
  lines.push(line);
  return lines;
}

function rounded(ctx: Context, x: number, y: number, w: number, h: number, radius: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
}

async function decodeIcon(source: Uint8Array) {
  const bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  const png = bytes.subarray(0, 8).equals(pngSignature);
  const webp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (png || webp) return loadImage(bytes).catch(() => undefined);
}

export async function renderGenshinBackpackCard(model: GenshinBackpackCardModel,
  { mode = "auto", scale = 4 }: GenshinBackpackCardOptions = {}): Promise<PngRender> {
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError("原神背包卡缩放比例须在 1 至 4 之间。");

  const metrics = new Canvas(1, 1).getContext("2d");
  let nextTitle = padding + headingLead;
  const categories = model.categories.map(category => {
    metrics.font = categoryFont;
    const titles = textLines(metrics, category.name, width - padding * 2);
    const titleTop = nextTitle;
    const gridTop = titleTop + titles.length * categoryLineHeight + headingTail;
    let rowTop = gridTop;
    metrics.font = labelFont;
    const rows = [];
    for (let start = 0; start < category.items.length; start += columns) {
      const cards = category.items.slice(start, start + columns).map(item => {
        const names = textLines(metrics, item.name, labelWidth - 6);
        const labelHeight = names.length * labelLineHeight + 6;
        const count = `${item.exact ? "x" : "≥"}${item.count}`;
        const countWidth = metrics.measureText(count).width;
        const badgeWidth = Math.min(labelWidth, countWidth + 12);
        const countFont = countWidth + 12 <= labelWidth ? labelFont :
          `${Math.floor(12 * (labelWidth - 13) / countWidth)}px ${fontFamily}`;
        return { names, labelHeight, count, badgeWidth, countFont, image: item.image };
      });
      // Long labels may cover the bottom of the artwork, as in the original.
      // Leave the upper artwork and quantity badge visible when a row grows.
      const height = Math.max(cardHeight, ...cards.map(card => card.labelHeight + 76));
      rows.push({ cards, top: rowTop, height });
      rowTop += height + gap;
    }
    nextTitle = rowTop + headingLead;
    return { titles, titleTop, rows };
  });
  const footerTop = categories.length ? nextTitle : padding + 30;
  const height = footerTop + 88 + padding;

  const icons = new Map<Uint8Array, ReturnType<typeof decodeIcon>>();
  return renderPng(Math.ceil(width * scale), Math.ceil(height * scale), async ctx => {
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, Math.ceil(width * scale), Math.ceil(height * scale));
    ctx.scale(scale, scale);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    for (const { titles, titleTop, rows } of categories) {
      ctx.textAlign = "left";
      ctx.fillStyle = "#ffcc00";
      ctx.font = categoryFont;
      titles.forEach((title, index) => ctx.fillText(title, padding, titleTop + 20 + index * categoryLineHeight));
      ctx.textAlign = "center";
      for (const { cards, top, height } of rows) {
        for (const [column, card] of cards.entries()) {
          const left = padding + column * (cardWidth + gap);
          const center = left + cardWidth / 2;
          ctx.fillStyle = "#444";
          rounded(ctx, left, top, cardWidth, height, 8);
          ctx.fill();
          ctx.fillStyle = "#2a2a2a";
          rounded(ctx, left + 1, top + 1, cardWidth - 2, height - 2, 7);
          ctx.fill();

          let image;
          if (card.image) {
            let pending = icons.get(card.image);
            if (!pending) {
              pending = decodeIcon(card.image);
              icons.set(card.image, pending);
            }
            image = await pending;
          }
          if (image) {
            const fit = Math.min(1, artSize / image.width, artSize / image.height);
            const artWidth = image.width * fit;
            const artHeight = image.height * fit;
            const x = center - artWidth / 2;
            const y = top + padding + 1;
            ctx.save();
            rounded(ctx, x, y, artWidth, artHeight, 4);
            ctx.clip();
            ctx.drawImage(image, x, y, artWidth, artHeight);
            ctx.restore();
          } else {
            ctx.fillStyle = "#e0e0e0";
            ctx.font = `16px ${fontFamily}`;
            ctx.fillText("icon", center + 8, top + 25);
          }

          const nameY = top + height - badgeInset - card.labelHeight;
          const badgeLeft = left + cardWidth - badgeInset - card.badgeWidth;
          const badgeTop = top + badgeInset;
          ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
          rounded(ctx, left + badgeInset, nameY, labelWidth, card.labelHeight, 4);
          ctx.fill();
          rounded(ctx, badgeLeft, badgeTop, card.badgeWidth, 20, 4);
          ctx.fill();
          ctx.font = labelFont;
          ctx.fillStyle = "#fff";
          card.names.forEach((name, index) => ctx.fillText(name, center, nameY + 16 + index * labelLineHeight));
          ctx.font = card.countFont;
          ctx.fillText(card.count, badgeLeft + card.badgeWidth / 2, badgeTop + 14);
        }
      }
    }

    ctx.textAlign = "center";
    ctx.fillStyle = "#888";
    ctx.font = `14px ${fontFamily}`;
    ctx.fillText(footer, width / 2, footerTop + 51);
  }, mode, { allowHalfScale: scale === 4 });
}
