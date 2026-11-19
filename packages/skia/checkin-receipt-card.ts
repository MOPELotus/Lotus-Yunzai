import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Canvas, FontLibrary, loadImage, type CanvasRenderingContext2D as Context } from "skia-canvas";
import { renderPng, type PngRender } from "./index.ts";

export interface CheckinReceiptCardModel {
  readonly displayName: string;
  readonly profileId: number;
  readonly rows: readonly {
    readonly label: string;
    readonly game: string;
    readonly community: string;
  }[];
  readonly detail?: {
    readonly title: "米游币" | "失败" | "云原神";
    readonly message: string;
  };
  readonly generatedAt?: string;
}

export interface CheckinReceiptCardOptions {
  readonly mode?: "auto" | "gpu" | "cpu";
  readonly scale?: number;
  readonly resourceDirectory?: string;
}

const width = 600;
const panelLeft = 10;
const panelWidth = 575;
const columnWidths = [160, 207.5, 207.5] as const;
const gold = "#d3bc8e";
const white = "#fff";
const defaultResources = fileURLToPath(new URL("../../data/passport/resources", import.meta.url));

async function loadTheme(directory: string) {
  const key = createHash("sha256").update(directory).digest("hex").slice(0, 12);
  const miao = `CheckinReceiptMiao${key}`;
  const title = `CheckinReceiptTitle${key}`;
  const miSans = `CheckinReceiptMiSans${key}`;
  for (const [font, file] of [
    [miao, "miao-theme/fonts/HYWH-65W.ttf"],
    [title, "source-templates/miao-stat/fonts/NZBZ.ttf"],
    [miSans, "fonts/MiSans-VF.ttf"],
  ] as const) {
    const filename = join(directory, file);
    if (!await Bun.file(filename).exists()) throw new Error(`签到回执原字体不可用：${file}`);
    FontLibrary.use(font, [filename]);
  }
  const background = await loadImage(join(directory, "miao-theme/bg/bg-hydro.webp"));
  const textFont = `"${miao}", "${miSans}", sans-serif`;
  return { background, textFont, titleFont: `"${title}", ${textFont}` };
}

const themes = new Map<string, ReturnType<typeof loadTheme>>();

function themeAt(directory: string) {
  let theme = themes.get(directory);
  if (!theme) {
    theme = loadTheme(directory).catch((error: unknown) => {
      themes.delete(directory);
      throw error;
    });
    themes.set(directory, theme);
  }
  return theme;
}

function wrapText(ctx: Context, value: string, available: number) {
  const text = value.replace(/\\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
  return text.split(/\r?\n/u).flatMap((paragraph) => {
    const lines: string[] = [];
    let line = "";
    function append(token: string) {
      if (line && ctx.measureText(line + token).width > available) {
        lines.push(line);
        line = "";
      }
      line += token;
    }
    for (const token of paragraph.match(/[-+]?\d+(?:\.\d+)?%?|[A-Za-z][A-Za-z0-9.-]*|./gu) ?? []) {
      if (ctx.measureText(token).width <= available) append(token);
      else for (const character of token) append(character);
    }
    lines.push(line);
    return lines;
  });
}

function text(ctx: Context, lines: readonly string[], x: number, y: number, font: string, leading: number,
  color: string, { center = false, shadow = false } = {}) {
  ctx.save();
  ctx.font = font;
  ctx.textBaseline = "top";
  ctx.textAlign = center ? "center" : "left";
  ctx.fillStyle = color;
  if (shadow) {
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 2;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
  }
  for (const [index, line] of lines.entries()) ctx.fillText(line, x, y + index * leading);
  ctx.restore();
}

function fill(ctx: Context, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 0);
  ctx.fill();
}

function clipPanel(ctx: Context, top: number, height: number) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(panelLeft, top, panelWidth, height, 10);
  ctx.clip();
}

export async function renderCheckinReceiptCard(model: CheckinReceiptCardModel,
  { mode = "auto", scale = 4, resourceDirectory = defaultResources }: CheckinReceiptCardOptions = {}): Promise<PngRender> {
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError("签到回执缩放比例须在 1 至 4 之间。");

  const { background, textFont, titleFont } = await themeAt(await realpath(resourceDirectory));
  const large = `36px ${titleFont}`;
  const medium = `20px ${textFont}`;
  const subtitleFont = `16px ${textFont}`;
  const body = `14px ${textFont}`;
  const small = `12px ${textFont}`;
  const metrics = new Canvas(1, 1).getContext("2d");
  metrics.font = subtitleFont;
  const subtitle = [model.displayName, `profile ${model.profileId}`].filter(Boolean).join(" · ");
  const subtitleLines = wrapText(metrics, subtitle, width - 70);
  const tableTop = 30 + 42 + subtitleLines.length * 24 + 6 + 14;
  let nextRow = tableTop;
  metrics.font = body;
  const values = [
    ["游戏 / 社区", "游戏签到", "社区签到"],
    ...model.rows.map(row => [row.label, row.game || "未执行", row.community || "未执行"]),
  ] as const;
  const rows = values.map(([name, game, community]) => {
    const cells = [
      wrapText(metrics, name ?? "", columnWidths[0] - 12),
      wrapText(metrics, game ?? "", columnWidths[1] - 12),
      wrapText(metrics, community ?? "", columnWidths[2] - 12),
    ];
    const height = Math.max(36, ...cells.map(lines => lines.length * 21 + 14));
    const top = nextRow;
    nextRow += height;
    return { cells, height, top };
  });
  const tableHeight = nextRow - tableTop;
  const detailTop = nextRow + 14;
  const message = model.detail?.message.trim() ? wrapText(metrics, model.detail.message, panelWidth - 65) : undefined;
  const detailHeader = 44;
  const detailHeight = message ? detailHeader + message.length * 22 + 8 + 20 : 0;
  const footerTop = detailTop + (message ? detailHeight + 10 : 0);
  metrics.font = small;
  const footer = wrapText(metrics, `荷花插件${model.generatedAt ? ` · ${model.generatedAt}` : ""}`, width - 30);
  const height = Math.max(240, footerTop + 50 + (footer.length - 1) * 18);
  const zoom = (720 / width) * scale;
  const pixelWidth = Math.round(width * zoom);
  const pixelHeight = Math.ceil(height * zoom);

  return renderPng(pixelWidth, pixelHeight, ctx => {
    ctx.scale(zoom, zoom);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    fill(ctx, 0, 0, width, Math.ceil(pixelHeight / zoom), "#243344");
    ctx.drawImage(background, 0, 0, width, height);
    text(ctx, ["签到结果"], 35, 30, large, 42, white, { shadow: true });
    text(ctx, subtitleLines, 35, 75, subtitleFont, 24, white, { shadow: true });

    clipPanel(ctx, tableTop, tableHeight);
    for (const [index, row] of rows.entries()) {
      const head = index === 0;
      fill(ctx, panelLeft, row.top, panelWidth, row.height, head ? "rgba(0,0,0,.5)" : index % 2 ? "#f0f0f0" : white);
      let x = panelLeft;
      for (const [column, w] of columnWidths.entries()) {
        text(ctx, row.cells[column] ?? [], x + 6, row.top + 7, body, 21, head ? gold : "#333");
        fill(ctx, x, row.top, w, 1, "rgba(100,100,100,.3)");
        fill(ctx, x, row.top, 1, row.height, "rgba(100,100,100,.3)");
        x += w;
      }
    }
    ctx.restore();

    if (model.detail && message) {
      clipPanel(ctx, detailTop, detailHeight);
      fill(ctx, panelLeft, detailTop, panelWidth, detailHeight, "rgba(0,0,0,.50)");
      fill(ctx, panelLeft, detailTop, panelWidth, detailHeader, "rgba(0,0,0,.40)");
      text(ctx, [model.detail.title], 30, detailTop + 10, medium, 28, gold);
      text(ctx, ["•"], 30, detailTop + detailHeader + 10, body, 21, white);
      text(ctx, message, 50, detailTop + detailHeader + 10, body, 22, white);
      ctx.restore();
    }
    text(ctx, footer, width / 2, footerTop + 15, small, 18, white, { center: true, shadow: true });
  }, mode);
}
