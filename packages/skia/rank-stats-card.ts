// Ark's graph layout is based on e81b5ef9111294c17b2b489aee9a94e4ebc0c9c6. See lib/rank-statistics.LICENSE.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadImage } from "skia-canvas";
import { rankPercentiles, type DamageRankStats } from "../../lib/rank-statistics.ts";
import { renderPng } from "./index.ts";

type Context = Parameters<Parameters<typeof renderPng>[2]>[0];
type RenderMode = Parameters<typeof renderPng>[3];
const font = '"Noto Sans CJK SC", sans-serif';
const cyan = "#67e8f9";
const format = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" });

function label(ctx: Context, value: string, x: number, y: number, size: number, color: string, max = 1080) {
  ctx.fillStyle = color;
  ctx.font = `600 ${size}px ${font}`;
  const width = ctx.measureText(value).width;
  if (width > max) ctx.font = `600 ${Math.floor(size * max / width)}px ${font}`;
  ctx.fillText(value, x, y);
}

function block(ctx: Context, x: number, y: number, width: number, height: number, radius: number, fill: string) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}

const imageLimit = 12 * 1024 * 1024;
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const gameBackgrounds = { gs: "bg-hydro.webp", sr: "bg-sr.webp" } as const;
type Game = keyof typeof gameBackgrounds;

async function readBackground(game: Game, themeDirectory: string) {
  try {
    const path = join(themeDirectory, "common", "bg", gameBackgrounds[game]);
    const info = await stat(path);
    if (!info.isFile() || info.size > imageLimit) return;
    const data = await readFile(path);
    if (data.length > imageLimit || !(data.subarray(0, 8).equals(pngHeader) ||
        (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") ||
        (data[0] === 255 && data[1] === 216))) return;
    return await loadImage(data);
  } catch {
    return;
  }
}

export async function renderDamageRankStatsCard(game: Game, name: string, stats: DamageRankStats, {
  mode = "auto", now = new Date(), themeDirectories = [], footer = "Lotus-Yunzai",
}: { readonly mode?: RenderMode; readonly now?: Date; readonly themeDirectories?: readonly string[]; readonly footer?: string } = {}) {
  let background: Awaited<ReturnType<typeof readBackground>>;
  for (const directory of new Set(themeDirectories)) {
    background = await readBackground(game, directory);
    if (background) break;
  }
  const width = 1200;
  const height = 793;
  const scale = 4;
  const chart = { left: 119, right: 1135, top: 204, bottom: 560 };
  const maximum = Math.max(1, Math.ceil(Math.max(...stats.scores) * 1.15));
  const points = rankPercentiles.map((percent, index) => ({
    x: chart.left + (chart.right - chart.left) * percent / 100,
    y: chart.bottom - (chart.bottom - chart.top) * stats.scores[index]! / maximum,
  }));

  return renderPng(Math.round(width * scale), Math.round(height * scale), ctx => {
    ctx.scale(scale, scale);
    const backdrop = ctx.createLinearGradient(0, 0, width, height);
    backdrop.addColorStop(0, "#101027");
    backdrop.addColorStop(0.54, "#232346");
    backdrop.addColorStop(1, "#111532");
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, 0, width, height);
    if (background) {
      const ratio = Math.max(width / background.width, height / background.height);
      const w = background.width * ratio, h = background.height * ratio;
      ctx.drawImage(background, (width - w) / 2, (height - h) / 2, w, h);
      ctx.fillStyle = "#10112450";
      ctx.fillRect(0, 0, width, height);
    }

    ctx.textAlign = "center";
    label(ctx, name, 600, 66, 40, "#ffffff");
    label(ctx, `排名趋势 · ${stats.title}`, 600, 99, 19, "#efd6a0");
    block(ctx, 390, 115, 420, 34, 17, "#263e6a9b");
    label(ctx, `统计样本 ${format.format(stats.total)} 个 UID  ·  生成时间 ${date.format(now)}`, 600, 137, 14, "#e9f1fd", 392);
    block(ctx, 34, 166, 1132, 485, 16, "#0d132aa8");
    label(ctx, "伤害", 92, 197, 13, "#b4c4e3");
    label(ctx, "排名百分比", 600, 619, 14, "#c5d2e6");
    for (let tick = 0; tick <= 6; tick++) {
      const value = maximum * tick / 6;
      const y = chart.bottom - (chart.bottom - chart.top) * tick / 6;
      ctx.strokeStyle = "#d3e6fb26";
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.moveTo(chart.left, y);
      ctx.lineTo(chart.right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.textAlign = "right";
      label(ctx, value >= 10_000 ? `${(value / 10_000).toFixed(1)}万` : format.format(value), chart.left - 12, y + 5, 12, "#aebdda", 76);
    }

    const gradient = ctx.createLinearGradient(chart.left, chart.top, chart.right, chart.top);
    gradient.addColorStop(0, cyan);
    gradient.addColorStop(0.52, "#4895ef");
    gradient.addColorStop(1, "#a96bf1");
    for (const { x, y } of points) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "#ced7f525";
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, chart.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.beginPath();
    points.forEach(({ x, y }, index) => {
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    const fill = ctx.createLinearGradient(chart.left, chart.top, chart.left, chart.bottom);
    fill.addColorStop(0, "#4895ef5b");
    fill.addColorStop(1, "#4895ef10");
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 3.4;
    ctx.stroke();
    ctx.lineTo(points.at(-1)!.x, chart.bottom);
    ctx.lineTo(points[0]!.x, chart.bottom);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.textAlign = "center";
    points.forEach(({ x, y }, index) => {
      ctx.beginPath();
      ctx.arc(x, y, 4.3, 0, Math.PI * 2);
      ctx.fillStyle = cyan;
      ctx.fill();
      ctx.strokeStyle = "#f3faff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      label(ctx, `${rankPercentiles[index]}%`, x, chart.bottom + 23, 11, "#c2cde0", 35);
    });

    for (const [index, value] of stats.scores.entries()) {
      const x = 34 + index * 114;
      block(ctx, x, 669, 104, 68, 9, index < 3 ? "#2c7d9d65" : "#393a626d");
      label(ctx, `TOP ${rankPercentiles[index]}%`, x + 52, 694, 12, "#c9d6e9", 93);
      label(ctx, format.format(value), x + 52, 723, 17, index < 3 ? cyan : "#ffffff", 99);
    }
    label(ctx, footer, 600, 772, 12, "#c0cbe0");
  }, mode, { allowHalfScale: scale === 4 });
}
