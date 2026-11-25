import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("skia", messageCatalog.messages);
import { brandTextColor } from "./brand-color.ts";
import { prepareBuiltinFonts, builtinFontFallback } from "./builtin-fonts.ts";
import { builtinResourceDirectory } from "../../lib/builtin-resources.ts";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Canvas, FontLibrary, loadImage, type CanvasRenderingContext2D as Context } from "skia-canvas";
import { renderPng, type PngRender } from "./index.ts";

export interface InfoCardOptions {
  readonly mode?: "auto" | "gpu" | "cpu";
  readonly scale?: number;
  readonly themeDirectory?: string;
  readonly backgroundPath?: string;
  readonly bodyFontPath?: string;
  readonly titleFontPath?: string;
  readonly allowHalfScale?: boolean;
  readonly typography?: { readonly body: string; readonly title: string };
}

export interface InfoCardHeader {
  readonly title: string;
  readonly eyebrow?: string;
  readonly metadata?: string;
  readonly icon?: Uint8Array;
  readonly width?: number;
}

export interface InfoCardBodyLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly measure: Context;
  readonly bottomPadding: number;
}

export interface InfoCardBody {
  readonly height: number;
  draw(ctx: Context, visible: { readonly top: number; readonly bottom: number }): void | Promise<void>;
}

interface InfoTextOptions {
  readonly size: number;
  readonly leading?: number;
  readonly color?: string;
  readonly align?: Context["textAlign"];
  readonly title?: boolean;
}

// The Bilibili video card's typography, panel, and footer.
export const infoCardColors = {
  background: "#243344",
  frame: "rgba(15,20,31,.78)",
  text: "#fff",
  gold: "#d3bc8e",
  muted: "#c2c5cb",
  rule: "rgba(211,188,142,.35)",
  tile: "rgba(255,255,255,.08)",
} as const;
const font = `"LotusInfoText", "LotusInfoMiSans", ${builtinFontFallback}`;
const textStyles = new WeakMap<Context, NonNullable<InfoCardOptions["typography"]>>();
const cachedTheme = fileURLToPath(new URL("../../data/atlas/theme", import.meta.url));
const defaultTheme = existsSync(join(cachedTheme, "bg/bg-hydro.webp")) ? cachedTheme : builtinResourceDirectory("templates/atlas");
const themes = new Map<string, ReturnType<typeof loadTheme>>();

async function loadTheme(directory: string) {
  for (const [family, file] of [
    ["LotusInfoText", "HYWH-65W.ttf"], ["LotusInfoMiSans", "MiSans-VF.ttf"],
  ] as const) {
    const direct = join(directory, "fonts", file);
    const candidates = file === "MiSans-VF.ttf" ? [direct, join(dirname(directory), "fonts", file)] : [direct];
    for (const filename of candidates) {
      if (!await Bun.file(filename).exists()) continue;
      FontLibrary.use(family, [filename]);
      break;
    }
  }
  return loadImage(join(directory, "bg", "bg-hydro.webp")).catch(() => undefined);
}

function themeImage(directory: string) {
  let image = themes.get(directory);
  if (!image) {
    image = loadTheme(directory);
    themes.set(directory, image);
  }
  return image;
}

function selectFont(ctx: Context, size: number, title: boolean) {
  const custom = textStyles.get(ctx);
  ctx.font = `${size}px ${(title ? custom?.title : custom?.body) ?? font}`;
}

export function measureInfoText(ctx: Context, value: string, maxWidth: number, size: number, title = false) {
  selectFont(ctx, size, title);
  return value.split(/\r?\n/u).flatMap((text) => {
    const rows: string[] = [];
    let row = "";
    function add(token: string) {
      if (row && ctx.measureText(row + token).width > maxWidth) {
        rows.push(row);
        row = "";
      }
      row += token;
    }
    for (const token of text.match(/[-+]?\d+(?:\.\d+)?%?|[A-Za-z][A-Za-z0-9.-]*|./gu) ?? []) {
      if (ctx.measureText(token).width > maxWidth) Array.from(token).forEach(add);
      else add(token);
    }
    rows.push(row);
    return rows;
  });
}

export function drawInfoText(ctx: Context, rows: readonly string[], x: number, y: number,
  { size, leading = size * 1.5, color = infoCardColors.text, align = "left", title = false }: InfoTextOptions) {
  selectFont(ctx, size, title);
  ctx.textBaseline = "top";
  ctx.textAlign = align;
  ctx.fillStyle = color;
  for (const [index, row] of rows.entries()) {
    ctx.fillStyle = row.includes("Lotus-Yunzai") ? brandTextColor(ctx, row, x, y + index * leading) : color;
    ctx.fillText(row, x, y + index * leading);
  }
}

async function prepareInfoCard({ title, eyebrow, metadata, icon, width = 900 }: InfoCardHeader,
  buildBody: (layout: InfoCardBodyLayout) => InfoCardBody,
  { themeDirectory = Bun.env.LOTUS_ATLAS_THEME_DIR?.trim() || defaultTheme, backgroundPath, bodyFontPath, titleFontPath, typography }: InfoCardOptions) {
  prepareBuiltinFonts();
  if (typography) typography = { body: `${typography.body}, ${builtinFontFallback}`, title: `${typography.title}, ${builtinFontFallback}` };
  if (!Number.isFinite(width) || width < 300) throw new RangeError($t("info-card.text_28bf43cf12"));
  const [background, badge] = await Promise.all([
    backgroundPath ? loadImage(backgroundPath) : themeImage(themeDirectory),
    icon ? loadImage(Buffer.from(icon.buffer, icon.byteOffset, icon.byteLength)).catch(() => undefined) : undefined,
  ]);
  if (bodyFontPath || titleFontPath) {
    const use = (path: string | undefined, fallback: string) => {
      if (!path) return fallback;
      const family = "LotusInfoCustom" + createHash("sha256").update(path).digest("hex").slice(0, 16);
      FontLibrary.use(family, [path]);
      return `"${family}", ${builtinFontFallback}`;
    };
    typography = { body: use(bodyFontPath, typography?.body ?? font), title: use(titleFontPath, typography?.title ?? font) };
  }
  const metrics = new Canvas(1, 1);
  metrics.gpu = false;
  const measure = metrics.getContext("2d");
  if (typography) textStyles.set(measure, typography);
  const x = 30;
  const contentWidth = width - 2 * x;
  const eyebrowX = badge ? 143 : 35;
  const labels = eyebrow ? measureInfoText(measure, eyebrow, width - eyebrowX - 35, 30) : [];
  const heading = measureInfoText(measure, title, contentWidth, 44, true);
  const meta = metadata ? measureInfoText(measure, metadata, contentWidth, 18) : [];
  const hasHeader = Boolean(eyebrow || badge);
  const titleTop = hasHeader ? Math.max(150, 56 + labels.length * 46) + 20 : 44;
  const metadataTop = titleTop + heading.length * 60 + (meta.length ? 8 : 0);
  const ruleTop = metadataTop + meta.length * 28 + 14;
  const bodyTop = ruleTop + 22;
  const bodyBottomPadding = 25;
  const footerHeight = 65;
  const body = buildBody({ x, y: bodyTop, width: contentWidth, measure, bottomPadding: bodyBottomPadding + footerHeight });
  const bottom = bodyTop + body.height + bodyBottomPadding;
  const height = Math.max(240, bottom + footerHeight);

  async function draw(ctx: Context, visible: { readonly top: number; readonly bottom: number }) {
    if (typography) textStyles.set(ctx, typography);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = infoCardColors.background;
    ctx.fillRect(0, 0, width, height);
    if (background) ctx.drawImage(background, 0, 0, width, height);
    ctx.fillStyle = infoCardColors.frame;
    ctx.beginPath();
    ctx.roundRect(15, 20, width - 30, bottom - 20, 15);
    ctx.fill();

    if (badge) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(35, 40, 90, 90, 45);
      ctx.clip();
      const cover = 90 / Math.min(badge.width, badge.height);
      const badgeWidth = badge.width * cover;
      const badgeHeight = badge.height * cover;
      ctx.drawImage(badge, 80 - badgeWidth / 2, 85 - badgeHeight / 2, badgeWidth, badgeHeight);
      ctx.restore();
    }
    drawInfoText(ctx, labels, eyebrowX, 56, { size: 30, leading: 46, color: infoCardColors.gold });
    if (hasHeader) {
      ctx.fillStyle = infoCardColors.rule;
      ctx.fillRect(x, titleTop - 5, contentWidth, 1);
    }
    drawInfoText(ctx, heading, x, titleTop, { size: 44, leading: 60, title: true });
    drawInfoText(ctx, meta, x, metadataTop, { size: 18, leading: 28, color: infoCardColors.gold });
    ctx.fillStyle = infoCardColors.rule;
    ctx.fillRect(x, ruleTop, contentWidth, 1);
    await body.draw(ctx, visible);

    ctx.shadowColor = "#000";
    ctx.shadowBlur = 2;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    drawInfoText(ctx, [$t("info-card.text_3867834e77")], width / 2, bottom + 30, { size: 12, align: "center" });
  }
  return { width, height, draw };
}

export async function renderInfoCardPages(header: InfoCardHeader, buildBody: (layout: InfoCardBodyLayout) => InfoCardBody,
  { pageHeight, mode = "auto", scale = 4, allowHalfScale = scale === 4, ...options }: InfoCardOptions & { readonly pageHeight?: number } = {}):
  Promise<readonly PngRender[]> {
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError($t("info-card.text_9a5c3b0f9a"));
  if (pageHeight !== undefined && (!Number.isFinite(pageHeight) || pageHeight < 1)) {
    throw new RangeError($t("info-card.text_65a627fa1f"));
  }
  const { width, height, draw } = await prepareInfoCard(header, buildBody, options);
  const pages = pageHeight === undefined ? 1 : Math.ceil(height / pageHeight);
  const renders: PngRender[] = [];
  for (let index = 0; index < pages; index++) {
    const top = Math.floor(height * index / pages);
    const bottom = index + 1 === pages ? height : Math.floor(height * (index + 1) / pages);
    renders.push(await renderPng(Math.round(width * scale), Math.ceil((bottom - top) * scale), async ctx => {
      ctx.scale(scale, scale);
      ctx.translate(0, -top);
      await draw(ctx, { top, bottom });
    }, mode, { renderScale: scale, allowHalfScale: scale === 4 && allowHalfScale && pages === 1 }));
  }
  return renders;
}

export async function renderInfoCard(header: InfoCardHeader, buildBody: (layout: InfoCardBodyLayout) => InfoCardBody,
  options?: InfoCardOptions): Promise<PngRender> {
  const [rendered] = await renderInfoCardPages(header, buildBody, options);
  return rendered!;
}
