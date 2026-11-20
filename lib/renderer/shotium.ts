import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Runtime, type PageGotoParams, type ScreenshotOptions } from "@pixel.js/shotium";

const template = require("art-template") as {
  compile(source: string, options: { filename: string }): (data: object) => string;
};
const runtime = new Runtime();

interface LegacyPageGotoParams {
  readonly waitUntil?: string | readonly string[];
  readonly timeout?: number | string;
}

interface TemplateData extends Record<string, unknown> {
  tplFile?: string;
  imgType?: "png" | "jpeg" | "webp";
  quality?: number;
  omitBackground?: boolean;
  viewport?: ScreenshotOptions["viewport"];
  scale?: number;
  pageGotoParams?: LegacyPageGotoParams;
  multiPage?: boolean;
  multiPageHeight?: number;
}

export function staticPageGotoParams(input: LegacyPageGotoParams | undefined): PageGotoParams | undefined {
  if (!input) return;
  const waits = Array.isArray(input.waitUntil) ? input.waitUntil : [input.waitUntil];
  const networkIdle = waits.some(wait => wait === "networkidle" || wait === "networkidle0" || wait === "networkidle2");
  const timeout = typeof input.timeout === "number" || typeof input.timeout === "string" ? Number(input.timeout) : 0;
  return {
    waitUntil: networkIdle ? "networkidle" : "load",
    timeout: Number.isSafeInteger(timeout) && timeout > 0 ? timeout : undefined,
  };
}

function baseFor(html: string, directory: string): string {
  if (/<base\s/iu.test(html)) return html;

  const href = pathToFileURL(directory + sep).href.replaceAll("&", "&amp;");
  const base = `<base href="${href}">`;
  if (/<head\b[^>]*>/iu.test(html)) return html.replace(/<head\b[^>]*>/iu, (head) => head + base);
  if (/<html\b[^>]*>/iu.test(html)) return html.replace(/<html\b[^>]*>/iu, (head) => head + `<head>${base}</head>`);
  return html.replace(/^(\s*<!doctype[^>]*>)?/iu, (doctype) => doctype + base);
}

export function verifyStaticRenderer(): Promise<void> {
  runtime.start({ cacheDir: null });
  return runtime.stop();
}

export function stopStaticRenderer(): Promise<void> {
  return runtime.running ? runtime.stop() : Promise.resolve();
}

export async function renderTemplate(data: TemplateData): Promise<Buffer[] | false> {
  if (!data.tplFile) return false;

  const file = resolve(data.tplFile);
  const temporary = await mkdtemp(join(tmpdir(), "lotus-shotium-"));
  try {
    const html = template.compile(await readFile(file, "utf8"), { filename: file })({
      resPath: "./resources/",
      ...data,
    });
    const expanded = join(temporary, "index.html");
    await writeFile(expanded, baseFor(html, dirname(file)), { mode: 0o600 });
    if (!runtime.running) {
      runtime.start({ cacheDir: null });
      console.log("[渲染] Shotium 静态 HTML CPU 后端已启动。");
    }

    const options: ScreenshotOptions = {
      file: pathToFileURL(expanded).href,
      type: data.imgType ?? (data.multiPage ? "jpeg" : "png"),
      viewport: data.viewport,
      quality: data.quality,
      scale: data.scale,
      pageGotoParams: staticPageGotoParams(data.pageGotoParams),
      cache: "no-store",
      allowFileAccess: true,
    };
    options.omitBackground = options.type !== "jpeg" && data.omitBackground === true;

    for (const selector of ["#container", "body"]) {
      try {
        if (data.multiPage) {
          const result = await runtime.screenshotTiles({
            ...options, selector, tile: { height: data.multiPageHeight ?? 1600 },
          });
          const images = result.tiles.map((tile) => tile.image);
          return images.length && images.every((image) => image !== null) ? images : false;
        }
        const result = await runtime.screenshot({ ...options, selector });
        return result.image ? [result.image] : false;
      } catch (error) {
        if (selector === "body" || !(error instanceof Error) ||
            !error.message.includes("no element matches the selector")) throw error;
      }
    }
    return false;
  } catch {
    console.warn("[渲染] Shotium 模板截图失败。");
    return false;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
