import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { getLanguage, registerLanguage, setLanguage } from "../packages/i18n/index.ts";
import { injectMiyousheLanguage, templateTextEntries, templateTextKey, translateTemplate, translateTemplateStyles } from "../lib/i18n-templates.ts";

const web = "web/miyoushe/index.html";
const css = "resources/builtin/games/miao/character/artis-mark.css";
const locale = "en-XA";
const textKey = (text: string) => templateTextKey(web, "text", text);

test("中文原模板保留完整字节，目录仅登记纯展示节点与CSS伪元素", async () => {
  const source = await readFile(new URL("../web/miyoushe/index.html", import.meta.url), "utf8");
  expect(translateTemplate(source, web)).toBe(source);
  const entries = templateTextEntries(source, web);
  expect(entries.some(entry => entry.text === "重试")).toBe(true);
  expect(entries.some(entry => entry.text.startsWith("#"))).toBe(false);
  expect(templateTextEntries('<script>const x="中文代码";</script><input value="协议值" data-value="角色键" placeholder="输入文字">', web))
    .toMatchObject([{ kind: "attribute", text: "输入文字" }]);
  expect(templateTextEntries('p::before {content: "分"}', css)).toMatchObject([{ kind: "css", text: "分" }]);
});

test("翻译保留原模板表达式、命令及脚本，文案不能注入HTML或模板代码", () => {
  const previous = getLanguage();
  const translated = '<b>Retry</b>{{throw "injected"}}';
  registerLanguage(locale, { "legacy-templates": { [textKey("重试")]: translated } });
  try {
    setLanguage(locale);
    const source = '<button>重试{{name}}</button><code>#米游社功能</code><script>const label="重试";</script>';
    const output = translateTemplate(source, web);
    expect(output).toContain("&lt;b&gt;Retry&lt;/b&gt;&#123;&#123;throw &quot;injected&quot;&#125;&#125;{{name}}");
    expect(output).toContain('<code>#米游社功能</code>');
    expect(output).toContain('<script>const label="重试";</script>');
    const compiler = createRequire(import.meta.url)("art-template");
    expect(compiler.compile(output, { minimize: false })({ name: "original" })).toContain("original</button>");
  } finally { setLanguage(previous); }
});

test("实际原CSS只在翻译时转为内联并保留资源相对路径含义", async () => {
  const previous = getLanguage();
  registerLanguage(locale, { "legacy-templates": { [templateTextKey(css, "css", "分")]: "points" } });
  const path = fileURLToPath(new URL("../" + css, import.meta.url));
  const source = `<link rel="stylesheet" href="${pathToFileURL(path).href}">`;
  try {
    setLanguage("zh-CN");
    expect(await translateTemplateStyles(source, fileURLToPath(new URL("../web/miyoushe/index.html", import.meta.url)))).toBe(source);
    setLanguage(locale);
    const result = await translateTemplateStyles(source, path);
    expect(result).toContain('<style>');
    expect(result).toContain('content: "points"');
    expect(result).not.toContain('<link');
  } finally { setLanguage(previous); }
});

test("米游社语言引导只传网页文案，JSON不得逃出数据元素", () => {
  const previous = getLanguage();
  registerLanguage(locale, { core: {
    "web.miyoushe.app.fixture": '</script><script>alert("bad")</script>',
    "lib.account.privateFixture": "not-for-web",
  } });
  try {
    setLanguage(locale);
    const output = injectMiyousheLanguage('<html lang="zh-CN"><head></head><body></body></html>');
    expect(output).toContain('lang="en-XA"');
    expect(output.match(/<script/gu)).toHaveLength(1);
    expect(output).not.toContain("not-for-web");
    const payload = JSON.parse(output.match(/type="application\/json">(.*?)<\/script>/u)![1]!);
    expect(payload.language).toBe(locale);
    expect(payload.messages.core["web.miyoushe.app.fixture"]).toBe('</script><script>alert("bad")</script>');
  } finally { setLanguage(previous); }
});
