import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { MessageEvent } from "../messages.ts";
import puppeteer from "../puppeteer/puppeteer.js";

type TemplateData = Record<string, unknown>;
type Screenshot = (name: string, data: TemplateData) => ReturnType<typeof puppeteer.screenshot>;

interface RenderOptions {
  readonly retType?: string;
  readonly beforeRender?: (input: { data: TemplateData }) => TemplateData | false | void;
}

async function inside(directory: string, file: string): Promise<string | undefined> {
  try {
    const physical = await realpath(file);
    const path = relative(directory, physical);
    if (path && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)) return physical;
  } catch { return; }
}

export function legacyTemplateRender(
  reply: MessageEvent["reply"], source: (plugin: string) => string | undefined,
  screenshot: Screenshot = puppeteer.screenshot,
) {
  return async (plugin: string, name: string, data: TemplateData = {}, options: RenderOptions = {}) => {
    const returnsImage = options.retType === "base64";
    const missing = !returnsImage;
    const directory = typeof plugin === "string" && source(plugin);
    if (!directory || typeof name !== "string" || /[\\\x00]/u.test(name)) return missing;

    const parts = name.replace(/\.html$/u, "").split("/").filter(Boolean);
    if (!parts.length || parts.some(part => part === "." || part === "..")) return missing;
    const path = parts.join("/");
    const resources = await inside(directory, join(directory, "resources"));
    if (!resources) return missing;

    const resourceUrl = pathToFileURL(resources + sep).href;
    const prepared = {
      sys: { scale: 1 }, copyright: "Created By Lotus-Yunzai", _res_path: resourceUrl,
      ...data,
      _plugin: plugin, _htmlPath: path, pluResPath: resourceUrl,
      tplFile: join(resources, `${path}.html`), saveId: data.saveId || data.save_id || parts.at(-1),
    };
    const renderData = options.beforeRender?.({ data: prepared }) || prepared;
    if (typeof renderData.tplFile !== "string") return missing;
    const file = await inside(resources, renderData.tplFile);
    if (!file || !(await stat(file).catch(() => undefined))?.isFile() || source(plugin) !== directory) return missing;

    const image = await screenshot(`${plugin}/${path}`, { ...renderData, tplFile: file });
    if (source(plugin) !== directory) return missing;
    if (returnsImage) return image;
    if (image) await reply(image);
    return true;
  };
}
