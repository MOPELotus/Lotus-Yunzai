import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { PageGotoParams, Runtime, ScreenshotOptions } from "@pixel.js/shotium";
import { translateTemplate, translateTemplateStyles } from "../i18n-templates.ts";

interface TemplateCompiler {
  compile(source: string, options: { filename: string; cache?: boolean; loader?: (filename: string) => string }): (data: object) => string;
}

let legacyRuntime: Promise<Runtime> | undefined;

function loadLegacyRuntime(): Promise<Runtime> {
  return legacyRuntime ??= import("@pixel.js/shotium").then(({ Runtime }) => new Runtime()).catch((error: unknown) => {
    legacyRuntime = undefined;
    throw error;
  });
}

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

export async function verifyStaticRenderer(): Promise<void> {
  const runtime = await loadLegacyRuntime();
  runtime.start({ cacheDir: null });
  await runtime.stop();
}

export async function stopStaticRenderer(): Promise<void> {
  const runtime = await legacyRuntime?.catch(() => undefined);
  if (runtime?.running) await runtime.stop();
}

export async function renderTemplate(data: TemplateData): Promise<Buffer[] | false> {
  if (!data.tplFile) return false;

  const file = resolve(data.tplFile);
  const temporary = await mkdtemp(join(tmpdir(), "lotus-shotium-"));
  try {
    const template = require("art-template") as TemplateCompiler;
    const compiled = template.compile(translateTemplate(await readFile(file, "utf8"), file), {
      filename: file,
      cache: false,
      loader: filename => translateTemplate(readFileSync(filename, "utf8"), filename),
    })({
      resPath: "./resources/",
      ...data,
    });
    const html = await translateTemplateStyles(compiled, file);
    const expanded = join(temporary, "index.html");
    await writeFile(expanded, baseFor(html, dirname(file)), { mode: 0o600 });
    const runtime = await loadLegacyRuntime();
    if (!runtime.running) {
      runtime.start({ cacheDir: null });
      console.log($t("lib.renderer.shotium.text_82d0bc0811"));
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
    console.warn($t("lib.renderer.shotium.text_d1d8f438f2"));
    return false;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
