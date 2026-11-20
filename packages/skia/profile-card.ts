import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Canvas, FontLibrary, loadImage, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";
import { renderPng, type PngRender } from "./index.ts";

interface ProfileCardField {
  readonly label: string;
  /** 已整理的展示值，例如保存状态与脱敏标识。 */
  readonly value: string | number;
}

export interface ProfileCardRole {
  readonly uid?: string | number;
  readonly name?: string;
  readonly level?: string | number;
  readonly active?: boolean;
  readonly image?: Uint8Array;
  readonly banner?: Uint8Array;
}

export interface ProfileCardModel {
  readonly title?: string;
  readonly subtitle?: string;
  readonly summary?: string;
  readonly generatedAt?: string;
  readonly roleGroups?: readonly { readonly label: string; readonly rows?: readonly ProfileCardRole[] }[];
  readonly roles?: readonly ProfileCardField[];
  readonly account?: readonly ProfileCardField[];
  readonly settings?: readonly ProfileCardField[];
  readonly warnings?: readonly string[];
}

export interface ProfileCardOptions {
  readonly mode?: "auto" | "gpu" | "cpu";
  readonly scale?: number;
  readonly resourceDirectory?: string;
}

// Lotus-ReFactor profile-card, drawn from the original Genshin UID-list template.
const width = 450;
const panelWidth = width - 25;
const gold = "#d3bc8e";
const white = "#fff";
const ink = "#414e64";
const defaultResources = fileURLToPath(new URL("../../data/passport/resources", import.meta.url));

async function loadTheme(directory: string) {
  const key = createHash("sha256").update(directory).digest("hex").slice(0, 12);
  const body = `PassportProfileBody${key}`;
  const title = `PassportProfileTitle${key}`;
  const number = `PassportProfileNumber${key}`;
  const miSans = `PassportProfileMiSans${key}`;
  for (const [name, file] of [
    [body, "miao-theme/fonts/HYWH-65W.ttf"],
    [title, "source-templates/miao-stat/fonts/NZBZ.ttf"],
    [number, "source-templates/miao-stat/fonts/tttgbnumber.ttf"],
    [miSans, "fonts/MiSans-VF.ttf"],
  ] as const) {
    const fontPath = join(directory, file);
    if (!await Bun.file(fontPath).exists()) throw new Error(`账号资料卡原字体不可用：${file}`);
    FontLibrary.use(name, [fontPath]);
  }
  const background = await loadImage(join(directory, "miao-theme/bg/bg-hydro.webp"));
  const text = `"${body}", "${miSans}", sans-serif`;
  return { background, text, number: `"${number}", ${text}`, title: `"${title}", ${text}` };
}

const themes = new Map<string, ReturnType<typeof loadTheme>>();
type Theme = Awaited<ReturnType<typeof loadTheme>>;

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

function lines(ctx: Context, value: string | number | undefined, available: number, size: number, font: string) {
  ctx.font = `${size}px ${font}`;
  const text = String(value ?? "").replace(/\\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
  return text.split(/\r?\n/u).flatMap((paragraph) => {
    const rows: string[] = [];
    let line = "";
    function append(token: string) {
      if (line && ctx.measureText(line + token).width > available) {
        rows.push(line);
        line = "";
      }
      line += token;
    }
    for (const token of paragraph.match(/[-+]?\d+(?:\.\d+)?%?|[A-Za-z][A-Za-z0-9.-]*|./gu) ?? []) {
      if (ctx.measureText(token).width <= available) append(token);
      else for (const character of token) append(character);
    }
    rows.push(line);
    return rows;
  });
}

function rectPath(ctx: Context, x: number, y: number, w: number, h: number, radius: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
}

function fillRect(ctx: Context, x: number, y: number, w: number, h: number, fill: string, radius: number) {
  rectPath(ctx, x, y, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();
}

function cover(ctx: Context, image: Image, x: number, y: number, w: number, h: number, radius: number) {
  const scale = Math.max(w / image.width, h / image.height);
  const dw = image.width * scale;
  const dh = image.height * scale;
  ctx.save();
  rectPath(ctx, x, y, w, h, radius);
  ctx.clip();
  ctx.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

class ProfileLayout {
  readonly commands: ((ctx: Context) => void)[] = [];
  readonly #measure = new Canvas(1, 1).getContext("2d");
  y = 20;

  constructor(private readonly theme: Theme) {}

  rect(x: number, y: number, w: number, h: number, fill: string, radius = 0) {
    this.commands.push((ctx) => fillRect(ctx, x, y, w, h, fill, radius));
  }

  clip(x: number, y: number, w: number, h: number, radius = 10) {
    this.commands.push((ctx) => {
      ctx.save();
      rectPath(ctx, x, y, w, h, radius);
      ctx.clip();
    });
  }

  restore() {
    this.commands.push((ctx) => ctx.restore());
  }

  image(image: Image | undefined, x: number, y: number, w: number, h: number, radius: number) {
    if (image) this.commands.push((ctx) => cover(ctx, image, x, y, w, h, radius));
  }

  text(value: string | number | undefined, x: number, y: number, w: number, size: number, color: string,
    { font = this.theme.text, leading = size * 1.5, center = false, shadow = false } = {}) {
    const rows = lines(this.#measure, value, w, size, font);
    this.commands.push((ctx) => {
      ctx.save();
      ctx.font = `${size}px ${font}`;
      ctx.textBaseline = "top";
      ctx.textAlign = center ? "center" : "left";
      ctx.fillStyle = color;
      if (shadow) {
        ctx.shadowColor = "#000";
        ctx.shadowBlur = 2;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
      }
      for (const [index, row] of rows.entries()) ctx.fillText(row, x + (center ? w / 2 : 0), y + index * leading);
      ctx.restore();
    });
    return rows.length * leading;
  }

  heading(title: string, subtitle?: string) {
    this.y += 10;
    this.y += this.text(title, 35, this.y, width - 70, 36, white,
      { font: this.theme.title, leading: 42, shadow: true });
    if (subtitle) this.y += this.text(subtitle, 35, this.y + 3, width - 70, 16, white, { shadow: true }) + 6;
    this.y += 14;
  }

  log(title: string, contents: readonly string[]) {
    const top = this.y;
    const textFont = this.theme.text;
    const titleHeight = lines(this.#measure, title, panelWidth - 40, 20, textFont).length * 28 + 16;
    const entries = contents.filter(Boolean);
    const heights = entries.map((entry) => lines(this.#measure, entry, panelWidth - 65, 14, textFont).length * 22 + 8);
    const panelHeight = titleHeight + heights.reduce((sum, height) => sum + height, 0) + 20;
    this.clip(10, top, panelWidth, panelHeight);
    this.rect(10, top, panelWidth, panelHeight, "rgba(0,0,0,.50)");
    this.rect(10, top, panelWidth, titleHeight, "rgba(0,0,0,.40)");
    this.text(title, 30, top + 10, panelWidth - 40, 20, gold, { leading: 28 });
    let y = top + titleHeight + 10;
    for (const [index, entry] of entries.entries()) {
      this.text("•", 30, y, 15, 14, white, { leading: 22 });
      this.text(entry, 50, y, panelWidth - 65, 14, white, { leading: 22 });
      y += heights[index]!;
    }
    this.restore();
    this.y += panelHeight + 10;
  }
}

function fieldTexts(fields: readonly ProfileCardField[] | undefined): string[] {
  return (fields ?? []).map(({ label, value }) => `${label}：${value}`);
}

export async function renderProfileCard(model: ProfileCardModel,
  { mode = "auto", scale = 4, resourceDirectory = defaultResources }: ProfileCardOptions = {}): Promise<PngRender> {
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError("资料卡缩放比例须在 1 至 4 之间。");
  const theme = await themeAt(await realpath(resourceDirectory));
  const layout = new ProfileLayout(theme);
  const groups: NonNullable<ProfileCardModel["roleGroups"]> = model.roleGroups?.length ? model.roleGroups : (model.roles ?? [])
    .map(({ label, value }) => ({ label, rows: [{ name: String(value) }] }));
  const images = new Map<Uint8Array, Promise<Image | undefined>>();
  for (const { rows } of groups) {
    for (const row of rows ?? []) {
      for (const asset of [row.image, row.banner]) {
        if (asset && !images.has(asset)) images.set(asset, loadImage(Buffer.from(asset)).catch(() => undefined));
      }
    }
  }

  layout.heading(model.title || "账号资料卡", model.subtitle);
  for (const group of groups) {
    const top = layout.y;
    const rows = group.rows?.length ? group.rows : [{ name: "未同步游戏角色" }];
    const height = 42 + rows.length * 76;
    layout.clip(10, top, panelWidth, height);
    layout.rect(10, top, panelWidth, height, "rgba(255,255,255,.65)");
    layout.rect(10, top, panelWidth, 34, "rgba(255,255,255,.8)");
    layout.text(group.label, 25, top + 8, panelWidth - 30, 16, "#333");
    for (const [index, row] of rows.entries()) {
      const y = top + 42 + index * 76;
      layout.rect(19, y + 20, 18, 22, row.active ? gold : white, 6);
      layout.text(index + 1, 19, y + 23, 18, 14, "#3a2702", { center: true });
      layout.rect(42, y, panelWidth - 43, 64, "#f0ece4", 33);
      if (row.banner) layout.image(await images.get(row.banner), 42, y, panelWidth - 43, 64, 33);
      const avatar = row.image ? await images.get(row.image) : undefined;
      if (avatar) {
        layout.rect(46, y + 4, 56, 56, white, 30);
        layout.image(avatar, 48, y + 6, 52, 52, 30);
      }
      const indent = avatar ? 104 : 48;
      layout.text(row.uid || row.name, 10 + indent, y + 9, panelWidth - indent - 22, row.uid ? 24 : 16, ink,
        { font: row.uid ? theme.number : theme.text, leading: 21 });
      if (row.uid) {
        const caption = [row.name, row.level ? `Lv.${row.level}` : "", row.active ? "当前 UID" : ""].filter(Boolean).join(" · ");
        layout.text(caption, 10 + indent, y + 38, panelWidth - indent - 22, 12, ink);
      }
    }
    layout.restore();
    layout.y += height + 10;
  }
  layout.log("账号状态", [model.summary ?? "", ...fieldTexts(model.account)]);
  layout.log("签到设置", fieldTexts(model.settings));
  if (model.warnings?.length) layout.log("提示", model.warnings);
  layout.text(`Lotus-Yunzai${model.generatedAt ? ` · ${model.generatedAt}` : ""}`, 15, layout.y + 15, width - 30, 12, white,
    { center: true, shadow: true, leading: 18 });

  const height = Math.max(240, layout.y + 50);
  const zoom = 720 / width * scale;
  return renderPng(Math.round(width * zoom), Math.ceil(height * zoom), (ctx) => {
    ctx.scale(zoom, zoom);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    fillRect(ctx, 0, 0, width, 100000, "#243344", 0);
    ctx.drawImage(theme.background, 0, 0, width, height);
    for (const draw of layout.commands) draw(ctx);
  }, mode);
}
