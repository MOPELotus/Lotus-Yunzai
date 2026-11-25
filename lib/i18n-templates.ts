import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTranslator, getCatalog, getLanguage } from "../packages/i18n/index.ts";
import catalog from "../i18n/legacy-templates/zh-CN.json";

const $t = createTranslator("legacy-templates", catalog.messages);
const root = fileURLToPath(new URL("../", import.meta.url));
const visible = /\p{Script=Han}/u;
const placeholders = /(\{\{[\s\S]*?\}\}|<%[\s\S]*?%>)/gu;
const tag = /<!--[\s\S]*?-->|<script\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/script\s*>|<style\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/style\s*>|\{\{[\s\S]*?\}\}|<%[\s\S]*?%>|<(?:!doctype|\/?[a-z])(?:[^>"']|"[^"]*"|'[^']*')*>/giu;

export interface TemplateTextEntry {
  readonly key: string;
  readonly source: string;
  readonly kind: "text" | "attribute" | "css";
  readonly text: string;
}

function sourcePath(filename: string) {
  return (isAbsolute(filename) ? relative(root, filename) : filename).replaceAll("\\", "/");
}

export function templateTextKey(filename: string, kind: TemplateTextEntry["kind"], text: string) {
  const source = sourcePath(filename);
  const section = source.replace(/\.[^.]+$/u, "").replace(/[^A-Za-z0-9]+/gu, ".").replace(/^\.|\.$/gu, "").slice(0, 160);
  return `${section}.${kind}_${createHash("sha256").update(source + "\0" + kind + "\0" + text).digest("hex").slice(0, 12)}`;
}

function htmlEscape(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("{", "&#123;").replaceAll("}", "&#125;");
}
function cssEscape(text: string, quote: string) {
  return text.replaceAll("\\", "\\\\").replaceAll(quote, "\\" + quote).replace(/[\r\n\f]/gu, " ")
    .replaceAll("<", "\\3c ").replaceAll(">", "\\3e ");
}

type Visitor = (entry: TemplateTextEntry) => string;
function walkText(input: string, filename: string, kind: "text" | "attribute", visit: Visitor): string {
  return input.split(placeholders).map(piece => {
    if (!piece || piece.startsWith("{{") || piece.startsWith("<%")) return piece;
    const value = piece.trim();
    if (!value || !visible.test(value) || /^#[\p{L}\p{N}_-]+$/u.test(value)) return piece;
    const entry = { key: templateTextKey(filename, kind, value), source: sourcePath(filename), kind, text: value } as const;
    const translated = visit(entry);
    return translated === value ? piece : piece.slice(0, piece.indexOf(value)) + htmlEscape(translated) + piece.slice(piece.indexOf(value) + value.length);
  }).join("");
}

function walkCss(source: string, filename: string, visit: Visitor): string {
  return source.replace(/(\bcontent\s*:\s*)(["'])((?:\\.|[^\\])*?)\2/giu, (original, prefix: string, quote: string, text: string) => {
    if (!visible.test(text) || /\{\{|<%/u.test(text)) return original;
    const entry = { key: templateTextKey(filename, "css", text), source: sourcePath(filename), kind: "css", text } as const;
    const translated = visit(entry);
    return translated === text ? original : prefix + quote + cssEscape(translated, quote) + quote;
  });
}

function walkHtml(source: string, filename: string, visit: Visitor): string {
  let offset = 0, output = "";
  for (const match of source.matchAll(tag)) {
    output += walkText(source.slice(offset, match.index), filename, "text", visit);
    const token = match[0];
    if (/^<script\b|^<!--|^\{\{|^<%/iu.test(token)) output += token;
    else if (/^<style\b/iu.test(token)) {
      const start = token.indexOf(">") + 1, end = token.toLowerCase().lastIndexOf("</style");
      output += token.slice(0, start) + walkCss(token.slice(start, end), filename, visit) + token.slice(end);
    } else {
      output += token.replace(/(\b(?:title|alt|placeholder|aria-label|aria-description|aria-valuetext)\s*=\s*)(["'])([\s\S]*?)\2/giu,
        (_match, prefix: string, quote: string, value: string) => prefix + quote + walkText(value, filename, "attribute", visit) + quote);
    }
    offset = match.index + token.length;
  }
  return output + walkText(source.slice(offset), filename, "text", visit);
}

export function templateTextEntries(source: string, filename: string): readonly TemplateTextEntry[] {
  const entries = new Map<string, TemplateTextEntry>();
  const visit: Visitor = entry => { entries.set(entry.key, entry); return entry.text; };
  if (/\.css$/iu.test(filename)) walkCss(source, filename, visit);
  else walkHtml(source, filename, visit);
  return [...entries.values()];
}

function translate(entry: TemplateTextEntry) {
  return Object.hasOwn(catalog.messages, entry.key) ? $t(entry.key) : entry.text;
}

/** Only display text changes. Original templates, data values and expression syntax remain intact. */
export function translateTemplate(source: string, filename: string): string {
  return /\.css$/iu.test(filename) ? walkCss(source, filename, translate) : walkHtml(source, filename, translate);
}

function cssReferences(source: string, filename: string) {
  const base = pathToFileURL(filename).href;
  return source.replace(/(url\(\s*)(["']?)([^"')\r\n]+)\2(\s*\))/giu, (raw, prefix: string, quote: string, target: string, end: string) => {
    if (!target.trim() || /^(?:[a-z][a-z0-9+.-]*:|#|\/)/iu.test(target)) return raw;
    try { return prefix + quote + new URL(target.trim(), base).href + quote + end; } catch { return raw; }
  }).replace(/(@import\s+)(["'])([^"'\r\n]+)\2/giu, (raw, prefix: string, quote: string, target: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/iu.test(target)) return raw;
    try { return prefix + quote + new URL(target, base).href + quote; } catch { return raw; }
  });
}

/** Inline a translated local stylesheet only when its display strings actually change. */
export async function translateTemplateStyles(source: string, filename: string): Promise<string> {
  const links = [...source.matchAll(/<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/giu)];
  let result = source;
  for (const match of links.reverse()) {
    const link = match[0];
    if (!/\brel\s*=\s*(["'])stylesheet\1/iu.test(link)) continue;
    const href = /\bhref\s*=\s*(["'])(.*?)\1/iu.exec(link)?.[2];
    if (!href || /\{\{|<%/u.test(href) || /^(?!file:)[a-z][a-z0-9+.-]*:/iu.test(href) || href.startsWith("//")) continue;
    let path: string;
    try { path = href.startsWith("file:") ? fileURLToPath(href) : resolve(dirname(filename), href); } catch { continue; }
    if (!/\.css$/iu.test(path)) continue;
    try {
      const original = await readFile(path, "utf8");
      const translated = translateTemplate(original, path);
      if (translated === original) continue;
      const media = /\bmedia\s*=\s*(["'])(.*?)\1/iu.exec(link)?.[2];
      const style = `<style${media ? ` media="${htmlEscape(media)}"` : ""}>${cssReferences(translated, path).replaceAll("</style", "<\\/style")}</style>`;
      result = result.slice(0, match.index) + style + result.slice(match.index + link.length);
    } catch { /* A missing stylesheet keeps the renderer's original loading behavior. */ }
  }
  return result;
}

/** Public browser data contains display strings only, never account or session data. */
export function injectMiyousheLanguage(source: string) {
  const language = getLanguage();
  const core = getCatalog(language, "core").core ?? {};
  const messages = Object.fromEntries(Object.entries(core).filter(([key]) => key.startsWith("web.miyoushe.")));
  const payload = JSON.stringify({ language, messages: { core: messages } }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
  const data = `<script id="lotus-language" type="application/json">${payload}</script>`;
  const page = source.replace(/<html\b([^>]*?)\blang\s*=\s*(["']).*?\2/iu, (_raw, prefix: string) => `<html${prefix}lang="${htmlEscape(language)}"`);
  return page.includes("</head>") ? page.replace("</head>", data + "</head>") : data + page;
}
