import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { panelApi } from "../lib/panel.ts";
import { createMiyousheWeb } from "../lib/miyoushe-web.ts";
import { readLotusGlobalConfig } from "../lib/lotus-global-config.ts";
import { stageLegacyGlobalConfig } from "../lib/migration-global-config.ts";
import { panelWebLogin } from "../lib/panel-web-login.ts";
import type { WebLoginSnapshot } from "../lib/panel-web-login-schema.ts";

const path = "/panel/api/settings/web/login";
const origin = "http://127.0.0.1:4500";
const auth = { Authorization: "Bearer web-login-fixture" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lotus-web-login-settings-"));
  await mkdir(join(root, "config"), { recursive: true });
  const url = pathToFileURL(root + "/");
  const file = join(root, "config/global.yaml");
  const route = panelWebLogin(url, "/hook/messages");
  const api = panelApi("web-login-fixture", [], candidate => candidate === path ? route : undefined);
  const request = (method = "GET", data?: unknown, headers: Record<string, string> = auth) =>
    api(new Request(origin + path, {
      method, headers: data === undefined ? headers : { ...headers, "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    }));
  const state = async () => (await (await request())?.json()) as WebLoginSnapshot;
  const save = (revision: string, patch: unknown) => request("PUT", { revision, patch });
  return { root, url, file, request, state, save, close: () => rm(root, { recursive: true, force: true }) };
}

test("网页登录按字段保存，保留继承的旧网站配置、挂载前缀与管理时长", async () => {
  const { root, file, request, state, save, close } = await fixture();
  try {
    const inherited = join(root, "plugins/Lotus-ReFactor/config");
    await mkdir(inherited, { recursive: true });
    const old = "coin_shop:\n  enable: true\n  path: /players\n  public_url: https://old.example.invalid/players\n  ticket_minutes: 13\n  panel_session_hours: 2\n  legacy_flag: preserve\n";
    const original = "scheduler: {mode: fixed} # other section\r\n";
    await writeFile(join(inherited, "global.yaml"), old);
    await writeFile(file, original);
    expect((await request("GET", undefined, {}))?.status).toBe(401);
    const first = await state();
    expect(first.settings).toEqual({
      enable: true, path: "/players", public_url: "https://old.example.invalid/players", icp_number: "", ticket_minutes: 13,
      session_hours: 8, panel_ticket_minutes: 10, panel_session_hours: 2,
    });
    expect((await request("PUT", { revision: first.revision, patch: { enable: false } }, {}))?.status).toBe(401);
    for (const patch of [
      {}, { legacy_flag: false }, { path: "/panel/private" }, { path: "/unsafe//route" }, { ticket_minutes: 1.5 },
      { panel_ticket_minutes: 0 }, { session_hours: -1 }, { panel_session_hours: 0.0001 },
      { public_url: "http://external.invalid/player" }, { public_url: "https://user:secret@bad.invalid/players" },
      { public_url: "https://bad.invalid/player#credential" }, { public_url: "https://bad.invalid/panel/blocked" },
    ]) expect((await save(first.revision, patch))?.status).toBe(400);
    expect((await save(first.revision, { path: "/hook" }))?.status).toBe(422);
    expect(await readFile(file, "utf8")).toBe(original);

    const yes = await save(first.revision, { panel_ticket_minutes: 16, session_hours: 0.5, path: "/custom/" });
    expect(yes?.status).toBe(200);
    const second = await state();
    expect(await yes?.json()).toEqual(second);
    expect(second.settings).toMatchObject({ path: "/custom", session_hours: 0.5, panel_ticket_minutes: 16, panel_session_hours: 2 });
    const written = await readFile(file, "utf8");
    expect(written).toStartWith(original);
    expect(Bun.YAML.parse(written)).toMatchObject({ scheduler: { mode: "fixed" },
      coin_shop: { legacy_flag: "preserve", ticket_minutes: 13, public_url: "https://old.example.invalid/players" } });
    expect(await readFile(join(inherited, "global.yaml"), "utf8")).toBe(old);
    expect((await save(first.revision, { ticket_minutes: 4 }))?.status).toBe(409);
    expect((await save(second.revision, { path: "/custom/" }))?.status).toBe(200);
    expect(await readFile(file, "utf8")).toBe(written);
    expect((await save(second.revision, { public_url: "", path: "", enable: false }))?.status).toBe(200);
    expect((await state()).settings).toMatchObject({ enable: false, public_url: "", path: "" });
  } finally { await close(); }
});

test("网页登录遇到 YAML 别名只覆盖选中的字段，隐藏不安全的旧地址", async () => {
  const { file, state, save, close } = await fixture();
  try {
    const original = "defaults: &shared\n  ticket_minutes: 31\n  public_url: https://example:legacy-secret@old.invalid/\ncoin_shop: *shared\n";
    await writeFile(file, original);
    const before = await state();
    expect(before.settings.public_url).toBe("");
    expect(JSON.stringify(before)).not.toContain("legacy-secret");
    expect((await save(before.revision, { ticket_minutes: 32 }))?.status).toBe(200);
    const contents = await readFile(file, "utf8");
    expect(contents).toContain("<<: *shared");
    expect(Bun.YAML.parse(contents)).toMatchObject({
      defaults: { ticket_minutes: 31 }, coin_shop: { ticket_minutes: 32, public_url: "https://example:legacy-secret@old.invalid/" },
    });
  } finally { await close(); }
});

test("备案号沿用旧配置并经既有鉴权修改，用户站只将它作为固定链接的文本渲染", async () => {
  const { root, url, file, request, state, save, close } = await fixture();
  const site = createMiyousheWeb({
    publicBase: () => new URL(origin), databasePath: join(root, "user-site.sqlite"), assetDirectory: "web/miyoushe",
    signal: new AbortController().signal, loginIdentity: async () => { throw new Error("Static footer has no login read"); },
    async overview() { throw new Error("Static footer has no user-specific data"); },
    readLoginConfig: async () => (await readLotusGlobalConfig(url)).coin_shop,
  });
  const page = () => site.handle(new Request(origin + "/miyoushe/"));
  try {
    const inherited = join(root, "plugins/Lotus-ReFactor/config");
    await mkdir(inherited, { recursive: true });
    const inheritedFile = join(inherited, "global.yaml");
    const sample = "coin_shop: {icp_number: '示例备案号', ticket_minutes: 13, private_fixture: fixture-kept}\n";
    await writeFile(inheritedFile, sample);
    expect((await state()).settings.icp_number).toBe("示例备案号");
    const firstPage = (await page())!;
    expect(firstPage.headers.get("Cache-Control")).toBe("no-store");
    expect(await firstPage.text()).toContain('<footer class="site-footer"><a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">示例备案号</a></footer>');
    const staged = join(root, "stage");
    await stageLegacyGlobalConfig(root, staged);
    expect(Bun.YAML.parse(await readFile(join(staged, "config/global.yaml"), "utf8"))).toEqual({
      coin_shop: { icp_number: "示例备案号", ticket_minutes: 13 },
    });
    const before = await state();
    expect((await request("PUT", { revision: before.revision, patch: { icp_number: "fixture" } }, {}))?.status).toBe(401);
    for (const icp_number of [null, 1234, "a\nb", "a\u0000b", "a\u2028b", "a".repeat(257)]) {
      expect((await save(before.revision, { icp_number }))?.status).toBe(400);
    }
    const plain = `样本 $& <img src="test" alt='tag'>`;
    expect((await save(before.revision, { icp_number: ` ${plain} ` }))?.status).toBe(200);
    expect((await save(before.revision, { icp_number: "another" }))?.status).toBe(409);
    const current = await state();
    expect(current.settings.icp_number).toBe(plain);
    expect(current.settings.ticket_minutes).toBe(13);
    const html = await (await page())!.text();
    expect(html).toContain("样本 $&amp; &lt;img src=&quot;test&quot; alt=&#39;tag&#39;&gt;");
    expect(html).not.toContain('<img src="test"');
    expect(html).not.toContain("fixture-kept");
    expect((await site.handle(new Request(origin + "/miyoushe/", { method: "HEAD" })))?.body).toBeNull();
    expect(await readFile(inheritedFile, "utf8")).toBe(sample);
    expect(Bun.YAML.parse(await readFile(file, "utf8"))).toMatchObject({ coin_shop: { private_fixture: "fixture-kept" } });

    let owner = true;
    const ownerApi = panelApi(undefined, [], path => path === "/panel/api/settings/web/login" ? panelWebLogin(url) : undefined,
      undefined, { handle: () => undefined, authorize: () => owner });
    expect((await ownerApi(new Request(origin + path)))?.headers.get("Cache-Control")).toBe("no-store");
    owner = false;
    expect((await ownerApi(new Request(origin + path)))?.status).toBe(401);
    expect((await save(current.revision, { icp_number: "   " }))?.status).toBe(200);
    expect((await state()).settings.icp_number).toBe("");
    expect(await (await page())!.text()).not.toContain('class="site-footer"');

    await writeFile(file, "coin_shop: {icp_number: 1234}\n");
    expect((await state()).settings.icp_number).toBe("1234");
    expect(await (await page())!.text()).toContain(">1234</a></footer>");
    const numericStage = join(root, "numeric-stage");
    await stageLegacyGlobalConfig(root, numericStage);
    expect(Bun.YAML.parse(await readFile(join(numericStage, "config/global.yaml"), "utf8"))).toEqual({ coin_shop: { icp_number: "1234" } });
  } finally {
    site.close();
    await close();
  }
});
