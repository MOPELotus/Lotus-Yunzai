import { readFile, writeFile } from "node:fs/promises";
import { templateTextEntries } from "../lib/i18n-templates.ts";

const scan = Bun.spawn(["rg", "--files", "resources", "plugins", "web", "--glob", "*.html", "--glob", "*.css"], { stdout: "pipe" });
const paths = (await new Response(scan.stdout).text()).trim().split("\n").filter(Boolean).sort();
if (await scan.exited !== 0) throw new Error("template-scan-failed");
const messages: Record<string, string> = {};
const sections: Record<string, { description: string; source: string }> = {};
for (const path of paths) {
  if (/(?:^|\/)(?:node_modules|test|tests|fixtures|dist)(?:\/|$)/u.test(path)) continue;
  for (const entry of templateTextEntries(await readFile(path, "utf8"), path)) {
    const section = entry.key.slice(0, entry.key.lastIndexOf("."));
    messages[entry.key] = entry.text;
    sections[section] = { description: path, source: path };
  }
}
const document = {
  language: "zh-CN", name: "简体中文", namespace: "legacy-templates",
  description: "兼容 HTML 模板、CSS 伪元素及米游社网页的静态文字。原模板与素材保持原样；渲染和网页交付时按来源替换纯展示文本，不改变命令、路径与模板表达式。sections.source 定位原模板，text/attribute/css 分别表示正文、辅助标签和伪元素文字。",
  sections, parameters: {}, messages,
};
await writeFile(new URL("../i18n/legacy-templates/zh-CN.json", import.meta.url), JSON.stringify(document, null, 2) + "\n");
console.info(JSON.stringify({ namespace: document.namespace, sections: Object.keys(sections).length, messages: Object.keys(messages).length }));
