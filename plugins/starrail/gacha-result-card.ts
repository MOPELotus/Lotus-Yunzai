import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPng, type PngRender } from "@lotus-yunzai/skia";
import { Canvas, FontLibrary, loadImage, type CanvasRenderingContext2D as Context } from "skia-canvas";
import type { createStarRailGachaSync } from "./gacha-sync.ts";

type GachaSyncResult = Awaited<ReturnType<ReturnType<typeof createStarRailGachaSync>["sync"]>>;
type GachaCardResult = Pick<GachaSyncResult, "pools"> & {
  readonly log: Pick<GachaSyncResult["log"], "qq" | "uid" | "profileId" | "updatedAt">;
};

interface GachaCardOptions {
  readonly mode?: "auto" | "gpu" | "cpu";
  readonly scale?: number;
  readonly themeDirectory?: string;
}

// Miao help/version-info, as drawn by Lotus-ReFactor's Skia status template.
const width = 600;
const panelWidth = 575;
const title = "星铁抽卡记录";
const font = '"LotusGachaMiao", "LotusGachaMiSans", sans-serif';
const defaultTheme = fileURLToPath(new URL("../../data/atlas/theme", import.meta.url));
const defaultMessage = "已通过官方小程序接口更新五星和抽数；重复更新会按记录 ID 合并，不会叠加。";
const failureMessages = {
  "rate-limited": "访问过于频繁，请稍后再试。",
  "profile-changed": "更新星铁抽卡历史时档案已变更，请重新发起请求。",
  "request-failed": "星铁抽卡记录更新失败。",
} as const;

interface GachaCardFailure {
  readonly qq: string;
  readonly profileId: number;
  readonly reason?: keyof typeof failureMessages;
  readonly at?: Date;
}

async function loadTheme(directory: string) {
  for (const [family, file] of [
    ["LotusGachaMiao", "HYWH-65W.ttf"], ["LotusGachaMiSans", "MiSans-VF.ttf"],
  ] as const) {
    const filename = join(directory, "fonts", file);
    if (await Bun.file(filename).exists()) FontLibrary.use(family, [filename]);
  }
  return loadImage(join(directory, "bg", "bg-hydro.webp")).catch(() => undefined);
}

const themes = new Map<string, ReturnType<typeof loadTheme>>();

function themeImage(directory: string) {
  let image = themes.get(directory);
  if (!image) {
    image = loadTheme(directory);
    themes.set(directory, image);
  }
  return image;
}

function lines(ctx: Context, value: string, maxWidth: number, size: number) {
  ctx.font = `${size}px ${font}`;
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

function paintText(ctx: Context, rows: readonly string[], x: number, y: number,
  size: number, leading: number, color: string) {
  ctx.font = `${size}px ${font}`;
  ctx.textBaseline = "top";
  ctx.fillStyle = color;
  for (const [index, row] of rows.entries()) ctx.fillText(row, x, y + index * leading);
}

function localTime(date: Date) {
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function renderStatus(lead: string, contents: readonly string[], at: Date,
  { mode = "auto", scale = 4, themeDirectory = defaultTheme }: GachaCardOptions): Promise<PngRender> {
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError("抽卡卡片缩放比例须在 1 至 4 之间。");
  const background = await themeImage(themeDirectory);
  const metrics = new Canvas(1, 1);
  metrics.gpu = false;
  const measure = metrics.getContext("2d");
  const heading = lines(measure, title, panelWidth - 40, 20);
  const headingHeight = heading.length * 28 + 16;
  const rows = [lead, ...contents].map((value) => lines(measure, value, panelWidth - 65, 14));
  const panelHeight = headingHeight + rows.reduce((sum, row) => sum + row.length * 22 + 8, 0) + 20;
  const height = Math.max(240, 20 + panelHeight + 10 + 50);
  const zoom = (720 / width) * scale;
  const pixelWidth = Math.round(width * zoom);
  const pixelHeight = Math.ceil(height * zoom);
  return renderPng(pixelWidth, pixelHeight, (ctx) => {
    ctx.fillStyle = "#243344";
    ctx.fillRect(0, 0, pixelWidth, pixelHeight);
    ctx.scale(zoom, zoom);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (background) ctx.drawImage(background, 0, 0, width, height);

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(10, 20, panelWidth, panelHeight, 10);
    ctx.clip();
    ctx.fillStyle = "rgba(0,0,0,.50)";
    ctx.fillRect(10, 20, panelWidth, panelHeight);
    ctx.fillStyle = "rgba(0,0,0,.40)";
    ctx.fillRect(10, 20, panelWidth, headingHeight);
    paintText(ctx, heading, 30, 30, 20, 28, "#d3bc8e");
    let y = 20 + headingHeight + 10;
    for (const row of rows) {
      paintText(ctx, ["•"], 30, y, 14, 21, "#fff");
      paintText(ctx, row, 50, y, 14, 22, "#fff");
      y += row.length * 22 + 8;
    }
    ctx.restore();

    ctx.textAlign = "center";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 2;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    paintText(ctx, [`荷花插件 · ${localTime(at)}`], 300, 20 + panelHeight + 25, 12, 18, "#fff");
  }, mode);
}

export function renderStarRailGachaResult({ log, pools }: GachaCardResult, options: GachaCardOptions = {}) {
  const lead = `QQ ${log.qq} · Profile ${log.profileId} · UID ${log.uid}\n${defaultMessage}`;
  const visiblePools = pools.filter(({ total, totalDraws }) => total || totalDraws);
  const contents = visiblePools.length ? visiblePools.map(({ name, total, added, totalDraws, pity }) =>
    `${name}：五星 ${total}（新增 ${added}）· 已抽 ${totalDraws} · 当前垫 ${pity}`) : ["记录：当前没有可用抽卡数据"];
  return renderStatus(lead, contents, new Date(log.updatedAt), options);
}

export function renderStarRailGachaFailure(
  { qq, profileId, reason = "request-failed", at = new Date() }: GachaCardFailure, options: GachaCardOptions = {},
) {
  const lead = `QQ ${qq} · Profile ${profileId}\n${failureMessages[reason]}`;
  return renderStatus(lead, [
    "阶段：profile Cookie / 星铁官方活动接口",
    "建议：检查 profile 登录状态与星铁 UID；无需 authkey。",
  ], at, options);
}
