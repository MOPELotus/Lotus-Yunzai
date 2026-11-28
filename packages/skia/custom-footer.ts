import type { CanvasRenderingContext2D } from "skia-canvas";
import { brandTextColor } from "./brand-color.ts";
import { builtinFooterFontFallback } from "./builtin-fonts.ts";
import { footerMarkup, type FooterRun, type FooterStyle } from "./footer-markup.ts";

export interface ImageFooterConfig {
  text: string;
  fontSize: number;
  lineHeight: number;
  padding: number;
  color: string;
  align: "left" | "center" | "right";
  bold: boolean;
}

type FooterRow = { runs: FooterRun[]; width: number; height: number };
type FooterLayout = { height: number; lines: string[]; rows?: FooterRow[] };

const defaults: Readonly<ImageFooterConfig> = Object.freeze({
  text: "",
  fontSize: 14,
  lineHeight: 22,
  padding: 12,
  color: "auto",
  align: "center",
  bold: false,
});
const keys = new Set([...Object.keys(defaults), "background"]);
const hex = /^#(?:[a-f\d]{3}|[a-f\d]{6})$/i;
let current: ImageFooterConfig = { ...defaults };

export function parseImageFooter(value: unknown): ImageFooterConfig | undefined {
  if (value == null) return { ...defaults };
  try {
    if (typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !keys.has(key))) {
      return undefined;
    }
    const { background: legacyBackground, ...fields } = value as Record<string, unknown>;
    if (legacyBackground !== undefined && (typeof legacyBackground !== "string" || !hex.test(legacyBackground))) return undefined;
    const config = { ...defaults, ...fields } as ImageFooterConfig;
    if (typeof config.text !== "string" || config.text.length > 4000) return undefined;
    config.text = config.text.replace(/\r\n/g, "\n");
    if (config.text.length > 2000 || config.text.split("\n").length > 20) return undefined;
    if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(config.text)) return undefined;
    if (!Number.isInteger(config.fontSize) || config.fontSize < 8 || config.fontSize > 32) {
      return undefined;
    }
    if (!Number.isInteger(config.lineHeight) || config.lineHeight < config.fontSize ||
        config.lineHeight > 64) return undefined;
    if (!Number.isInteger(config.padding) || config.padding < 0 || config.padding > 32) {
      return undefined;
    }
    if (typeof config.color !== "string" || (config.color !== "auto" && !hex.test(config.color))) return undefined;
    if (config.align !== "left" && config.align !== "center" && config.align !== "right") {
      return undefined;
    }
    if (typeof config.bold !== "boolean") return undefined;
    return config;
  } catch {
    return undefined;
  }
}

export function setImageFooter(value: unknown): void {
  current = parseImageFooter(value) ?? { ...defaults };
}

export function getImageFooter(): ImageFooterConfig {
  return { ...current };
}

function safeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(0, width) : 0;
}

function setFont(ctx: CanvasRenderingContext2D, config: Pick<FooterStyle, "bold" | "fontSize">): void {
  ctx.font = `${config.bold ? "bold" : "normal"} ${config.fontSize}px ${builtinFooterFontFallback}`;
}

export function layoutImageFooter(
  ctx: CanvasRenderingContext2D,
  width: number,
  config: ImageFooterConfig,
): FooterLayout {
  config = parseImageFooter(config) ?? { ...defaults };
  if (config.text === "") return { height: 0, lines: [] };
  const w = safeWidth(width);
  const padding = Math.min(config.padding, w / 4);
  const available = w - 2 * padding;
  const lines: string[] = [];
  ctx.save();
  try {
    const rich = footerMarkup(config.text, config);
    if (rich) {
      const rows: FooterRow[] = [];
      let row: FooterRow = { runs: [], width: 0, height: config.lineHeight };
      const finish = () => { rows.push(row); row = { runs: [], width: 0, height: config.lineHeight }; };
      for (const run of rich) {
        setFont(ctx, run);
        for (const character of run.text) {
          if (character === '\n') { finish(); continue; }
          const last = row.runs.at(-1);
          const same = last && last.fontSize === run.fontSize && last.bold === run.bold && last.color === run.color;
          const priorWidth = same ? ctx.measureText(last.text).width : 0;
          const nextWidth = ctx.measureText(same ? last.text + character : character).width;
          const added = nextWidth - priorWidth;
          if (row.runs.length && row.width + added > available) finish();
          const tail = row.runs.at(-1);
          if (tail && tail.fontSize === run.fontSize && tail.bold === run.bold && tail.color === run.color) {
            const previous = ctx.measureText(tail.text).width;
            tail.text += character;
            row.width += ctx.measureText(tail.text).width - previous;
          } else {
            row.runs.push({ ...run, text: character });
            row.width += ctx.measureText(character).width;
          }
          row.height = Math.max(row.height, run.fontSize * config.lineHeight / config.fontSize);
        }
      }
      finish();
      return { height: 2 * padding + rows.reduce((sum, entry) => sum + entry.height, 0),
        lines: rows.map(entry => entry.runs.map(run => run.text).join('')), rows };
    }
    setFont(ctx, config);
    // At most 2000 measurements, each on at most 2000 UTF-16 units.
    for (const paragraph of config.text.split("\n")) {
      let line = "";
      for (const character of paragraph) {
        const candidate = line + character;
        const measured = ctx.measureText(candidate).width;
        if (line !== "" && (!Number.isFinite(measured) || measured > available)) {
          lines.push(line);
          line = character;
        } else {
          line = candidate;
        }
      }
      lines.push(line);
    }
    return {
      height: 2 * padding + lines.length * config.lineHeight,
      lines,
    };
  } finally {
    ctx.restore();
  }
}

export function paintImageFooter(
  ctx: CanvasRenderingContext2D,
  width: number,
  top: number,
  layout: FooterLayout,
  config: ImageFooterConfig,
): void {
  config = parseImageFooter(config) ?? { ...defaults };
  if (config.text === "" || !Number.isFinite(top) ||
      !Number.isFinite(layout.height) || layout.height <= 0) return;
  const w = safeWidth(width);
  const padding = Math.min(config.padding, w / 4);
  const available = w - 2 * padding;
  const x = config.align === "left" ? padding
    : config.align === "right" ? w - padding : w / 2;
  ctx.save();
  try {
    setFont(ctx, config);
    ctx.textBaseline = "top";
    ctx.textAlign = config.align;
    ctx.fillStyle = config.color === "auto" ? "#fff" : config.color;
    if (available <= 0) return;
    // The original Miao copyright uses a 1px offset / 1px blur text shadow.
    // Canvas shadow distances use device pixels, unlike the transformed glyphs.
    const transform = ctx.getTransform();
    const scale = Math.hypot(transform.a, transform.b) || 1;
    ctx.shadowOffsetX = scale;
    ctx.shadowOffsetY = scale;
    ctx.shadowBlur = scale;
    const shadow = (color: string) => {
      ctx.shadowColor = color === '#000' || color === '#000000' ? '#fff' : '#000';
    };
    if (layout.rows) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      let y = top + padding;
      for (const row of layout.rows) {
        let left = config.align === 'left' ? padding : config.align === 'right' ? w - padding - row.width : (w - row.width) / 2;
        // Sample all run backgrounds before drawing any glyphs or shadows.
        const colors = row.runs.map(run => {
          setFont(ctx, run);
          const color = run.color === 'auto' ? brandTextColor(ctx, run.text, left, y + row.height / 2) : run.color;
          left += ctx.measureText(run.text).width;
          return color;
        });
        left = config.align === 'left' ? padding : config.align === 'right' ? w - padding - row.width : (w - row.width) / 2;
        row.runs.forEach((run, index) => {
          setFont(ctx, run);
          ctx.fillStyle = colors[index]!;
          shadow(colors[index]!);
          ctx.fillText(run.text, left, y + row.height / 2);
          left += ctx.measureText(run.text).width;
        });
        y += row.height;
      }
      return;
    }
    for (let i = 0; i < Math.min(layout.lines.length, 2000); i++) {
      const y = top + padding + i * config.lineHeight;
      ctx.fillStyle = config.color === "auto" ? brandTextColor(ctx, layout.lines[i]!, x, y, available) : config.color;
      shadow(String(ctx.fillStyle));
      ctx.fillText(layout.lines[i]!, x, y, available);
    }
  } finally {
    ctx.restore();
  }
}
