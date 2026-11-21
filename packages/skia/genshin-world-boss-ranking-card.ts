import { Canvas, loadImage, type CanvasRenderingContext2D as Context } from "skia-canvas";
import { renderPng, type PngRender } from "./index.ts";

export interface GenshinWorldBossRankingCardModel {
  readonly rows: readonly {
    readonly name: string;
    readonly count: number;
    readonly uid: string;
    readonly image?: Uint8Array;
  }[];
}

export interface GenshinWorldBossRankingCardOptions {
  readonly mode?: "auto" | "gpu" | "cpu";
  readonly scale?: number;
}

// 原版渲染器以 800px 视口截图 body，左右各有 8px 浏览器默认外边距。
const width = 784;
const inset = 20;
const tableWidth = width - inset * 2;
const tableTop = 109;
const textInset = 11;
const lineHeight = 24;
const imageSize = 50;
const missingIconWidth = 16;
const imageAlt = "BOSS1头像";
const headers = ["BOSS头像", "BOSS名称", "UID", "击杀次数"] as const;
const fontFamily = 'Arial, "Liberation Sans", "Noto Sans CJK SC", sans-serif';
const textFont = `16px ${fontFamily}`;
const headerFont = `bold ${textFont}`;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function decodeIcon(source: Uint8Array | undefined) {
  if (!source) return;
  const bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  const png = bytes.subarray(0, 8).equals(pngSignature);
  const webp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (png || webp) return loadImage(bytes).catch(() => undefined);
}

function nameLines(ctx: Context, name: string, available: number) {
  const lines: string[] = [];
  let line = "";
  for (const char of name) {
    if (line && ctx.measureText(line + char).width > available) {
      lines.push(line);
      line = "";
    }
    line += char;
  }
  lines.push(line);
  return lines;
}

export async function renderGenshinWorldBossRankingCard(model: GenshinWorldBossRankingCardModel,
  { mode = "auto", scale = 4 }: GenshinWorldBossRankingCardOptions = {}): Promise<PngRender> {
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError("世界 BOSS 榜单缩放比例须在 1 至 4 之间。");

  const metrics = new Canvas(1, 1).getContext("2d");
  metrics.font = headerFont;
  let iconWidth = metrics.measureText(headers[0]).width;
  let nameWidth = metrics.measureText(headers[1]).width;
  let uidWidth = metrics.measureText(headers[2]).width;
  let countWidth = metrics.measureText(headers[3]).width;
  metrics.font = textFont;
  const missingWidth = missingIconWidth + metrics.measureText(imageAlt).width;
  const icons = new Map<Uint8Array, ReturnType<typeof decodeIcon>>();
  const rows = [];
  for (const row of model.rows) {
    let image;
    if (row.image) {
      let pending = icons.get(row.image);
      if (!pending) {
        pending = decodeIcon(row.image);
        icons.set(row.image, pending);
      }
      image = await pending;
    }
    const count = String(row.count);
    iconWidth = Math.max(iconWidth, image ? imageSize : missingWidth);
    nameWidth = Math.max(nameWidth, metrics.measureText(row.name).width);
    uidWidth = Math.max(uidWidth, metrics.measureText(row.uid).width);
    countWidth = Math.max(countWidth, metrics.measureText(count).width);
    rows.push({ name: row.name, uid: row.uid, count, image });
  }

  const available = tableWidth - 1;
  const cellGutter = textInset * 2 - 1;
  const total = iconWidth + nameWidth + uidWidth + countWidth + headers.length * cellGutter;
  const scaleColumns = Math.max(1, available / total);
  const iconColumn = inset;
  const nameColumn = iconColumn + (iconWidth + cellGutter) * scaleColumns;
  const uidColumn = nameColumn + (nameWidth + cellGutter) * scaleColumns - Math.max(total - available, 0);
  const countColumn = uidColumn + (uidWidth + cellGutter) * scaleColumns;
  const columns = [iconColumn, nameColumn, uidColumn, countColumn, inset + available];
  const cellLeft = (x: number) => Math.round(x) + textInset;
  let nextRow = tableTop + 45;
  const layout = rows.map(row => {
    const names = nameLines(metrics, row.name, uidColumn - nameColumn - cellGutter);
    const height = cellGutter + Math.max(row.image ? 54 : lineHeight, names.length * lineHeight);
    const top = nextRow;
    nextRow += height;
    return { ...row, names, top, height };
  });
  const height = nextRow + 1 + inset;

  return renderPng(Math.ceil(width * scale), Math.ceil(height * scale), ctx => {
    ctx.fillStyle = "#121212";
    ctx.fillRect(0, 0, Math.ceil(width * scale), Math.ceil(height * scale));
    ctx.scale(scale, scale);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    ctx.fillStyle = "#1e1e1e";
    ctx.fillRect(inset, tableTop, tableWidth, 45);
    ctx.fillStyle = "#2a2a2a";
    for (const [index, row] of layout.entries()) {
      if (index % 2 === 1) ctx.fillRect(inset, row.top, tableWidth, row.height);
    }

    ctx.fillStyle = "#444";
    for (const y of [tableTop, ...layout.map(row => row.top), nextRow]) ctx.fillRect(inset, y, tableWidth, 1);
    for (const x of columns) ctx.fillRect(Math.round(x), tableTop, 1, nextRow - tableTop + 1);

    ctx.fillStyle = "#fff";
    ctx.font = `bold 32px ${fontFamily}`;
    ctx.textAlign = "center";
    ctx.fillText("BOSS击杀排行榜", width / 2, 78);
    ctx.textAlign = "left";
    ctx.font = headerFont;
    for (const [index, x] of [iconColumn, nameColumn, uidColumn, countColumn].entries()) {
      const text = headers[index];
      if (text) ctx.fillText(text, cellLeft(x), tableTop + (index === 2 ? 28 : 30));
    }

    ctx.font = textFont;
    for (const row of layout) {
      const middle = row.top + row.height / 2;
      const iconLeft = cellLeft(iconColumn);
      if (row.image) {
        const imageTop = middle - 27;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(iconLeft, imageTop, imageSize, imageSize, 5);
        ctx.clip();
        ctx.drawImage(row.image, iconLeft, imageTop, imageSize, imageSize);
        ctx.restore();
      } else {
        ctx.fillText(imageAlt, iconLeft + missingIconWidth, middle + 7);
      }
      const firstBaseline = middle - (row.names.length - 1) * lineHeight / 2 + 7;
      row.names.forEach((text, index) => ctx.fillText(text, cellLeft(nameColumn), firstBaseline + index * lineHeight));
      ctx.fillText(row.uid, cellLeft(uidColumn), middle + 5);
      ctx.fillText(row.count, cellLeft(countColumn), middle + 5);
    }
  }, mode, { allowHalfScale: scale === 4 });
}
