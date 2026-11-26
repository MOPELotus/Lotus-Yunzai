import type { CanvasRenderingContext2D } from "skia-canvas";
import { brandTextColor } from "./brand-color.ts";
import { builtinFontFallback } from "./builtin-fonts.ts";

export interface ImageFooterConfig {
  text: string;
  fontSize: number;
  lineHeight: number;
  padding: number;
  color: string;
  align: "left" | "center" | "right";
  bold: boolean;
}

type FooterLayout = { height: number; lines: string[] };

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

function setFont(ctx: CanvasRenderingContext2D, config: ImageFooterConfig): void {
  ctx.font = `${config.bold ? "bold" : "normal"} ${config.fontSize}px ${builtinFontFallback}`;
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
    for (let i = 0; i < Math.min(layout.lines.length, 2000); i++) {
      const y = top + padding + i * config.lineHeight;
      ctx.fillStyle = config.color === "auto" ? brandTextColor(ctx, layout.lines[i]!, x, y, available) : config.color;
      ctx.fillText(layout.lines[i]!, x, y, available);
    }
  } finally {
    ctx.restore();
  }
}
