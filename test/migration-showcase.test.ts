import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectShowcaseSettings } from "../lib/migration-showcase.ts";
import { panelGameSettings } from "../lib/panel-game-settings.ts";
import { panelApi } from "../lib/panel.ts";
import { rejectionReason } from "../lib/plugins/policy.ts";
import { genshinShowcaseTarget } from "../plugins/genshin/panel/showcase-client.ts";
import { readGenshinShowcaseServer } from "../plugins/genshin/panel/showcase-config.ts";
import { showcaseTarget } from "../plugins/starrail/panel-showcase.ts";
import { readShowcaseServer } from "../plugins/starrail/panel-showcase-config.ts";
import { migrateInstallation } from "../scripts/migrate.ts";

async function put(root: string, path: string, text: string) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, { mode: 0o600 });
}

test.skipIf(!Bun.which("git"))("迁入原铁展柜来源，保留现配及面板保存，三类区服读回实际端点", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-migration-showcase-"));
  const environment = {
    LOTUS_GENSHIN_SHOWCASE_SERVER: Bun.env.LOTUS_GENSHIN_SHOWCASE_SERVER,
    LOTUS_STAR_RAIL_SHOWCASE_SERVER: Bun.env.LOTUS_STAR_RAIL_SHOWCASE_SERVER,
  };
  for (const key of Object.keys(environment)) delete Bun.env[key];
  try {
    const source = join(root, "old"), target = join(root, "new");
    const plugin = "plugins/renamed-miao-fixture";
    const original = [
      "/*",
      "export const srProfileServer = '222'",
      "*/",
      "export const profileServer = '443';",
      "export const srProfileServer = '234'; // 本期设置",
      "throw new Error('旧配置不得执行')",
    ].join("\r\n");
    await put(source, `${plugin}/package.json`, '{"name":"miao-plugin"}');
    await put(source, `${plugin}/config/cfg.js`, original);
    await put(source, "config/global.yaml", "genshin: {showcase_server: '024'}\n");
    await put(target, "package.json", '{"name":"lotus-yunzai"}');
    await put(target, "plugins/.fixture", "fixture");
    for (const args of [["init", "-q"], ["add", "package.json", "plugins/.fixture"],
      ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: target }).exitCode).toBe(0);
    }

    const migrated = await migrateInstallation(source, target);
    expect(migrated).toMatchObject({ status: "published", globalConfig: { sections: ["genshin", "starrail"] } });
    expect(migrated.globalConfig.deferredShowcase).toBeUndefined();
    expect(await readFile(join(target, "backup", plugin, "config/cfg.js"), "utf8")).toBe(original);
    expect(await readFile(join(source, plugin, "config/cfg.js"), "utf8")).toBe(original);
    const targetUrl = Bun.pathToFileURL(target + "/");
    const gs = await readGenshinShowcaseServer(targetUrl, "");
    const sr = await readShowcaseServer(targetUrl, "");
    expect([gs, sr]).toEqual(["024", "234"]);
    const uids = ["123456789", "523456789", "623456789"];
    const roles = ["cn_gf01", "cn_qd01", "os_usa"].map((region, index) =>
      ({ region, uid: uids[index]!, gameBiz: index === 2 ? "hk4e_global" : "hk4e_cn" }));
    expect(roles.map(role => genshinShowcaseTarget(role, gs).provider)).toEqual(["mgg", "enka", "hutao"]);
    expect(["prod_gf_cn", "prod_qd_cn", "prod_official_usa"].map((region, index) => showcaseTarget(
      { region, uid: uids[index]!, gameBiz: index === 2 ? "hkrpg_global" : "hkrpg_cn" }, sr).provider)).toEqual(["mihomo", "avocado", "enka"]);

    const route = panelGameSettings(targetUrl, "showcase");
    const pathName = "/panel/api/settings/business/games";
    const panel = panelApi("showcase-migration-test", [], path => path === pathName ? route : undefined);
    const url = "http://localhost" + pathName;
    const headers = { Authorization: "Bearer showcase-migration-test", "Content-Type": "application/json" };
    const initial = await panel(new Request(url, { headers }));
    expect(initial?.status).toBe(200);
    const { values } = await initial!.json() as { values: Record<string, unknown> };
    expect(values).toMatchObject({ genshinSource: "024", starrailSource: "234" });
    const action = await panel(new Request(url, {
      method: "PUT", headers, body: JSON.stringify({ previous: values, values: { ...values, starrailSource: "444" } }),
    }));
    expect(action?.status).toBe(200);
    const path = join(target, "config/global.yaml");
    const edited = await readFile(path, "utf8");
    expect(await readShowcaseServer(targetUrl, "")).toBe("444");
    expect(await migrateInstallation(source, target)).toMatchObject({ status: "already-published" });
    expect(await readFile(path, "utf8")).toBe(edited);
  } finally {
    for (const [key, value] of Object.entries(environment)) if (value !== undefined) Bun.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
});

test("只迁受支持的来源位置并逐区报告私人和不支持的公开来源", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-migration-showcase-archive-"));
  try {
    const archive = { directory, plugins: [{ path: "plugins/miao-plugin", status: "archive", kind: "directory",
      reason: rejectionReason(["miao-plugin"], [])!, identity: "fixture" }] } as const;
    const path = "miao-plugin/config/cfg.js";
    await put(directory, path, "export const profileServer = '213';\nexport const srProfileServer = '14';\n");
    expect(await projectShowcaseSettings({}, archive)).toEqual({
      config: { genshin: { showcase_server: "200" }, starrail: { showcase_server: "040" } },
      deferred: [
        { game: "genshin", region: "渠道服", reason: "private-provider" },
        { game: "genshin", region: "国际服", reason: "unsupported-region" },
        { game: "starrail", region: "官服", reason: "private-provider" },
        { game: "starrail", region: "国际服", reason: "private-provider" },
      ],
    });
    await put(directory, path, "export const profileServer = '4';\nexport const srProfileServer = choose();\n");
    expect(await projectShowcaseSettings({}, archive)).toEqual({
      config: { genshin: { showcase_server: "4" } },
      deferred: [{ game: "starrail", reason: "invalid-setting" }],
    });
    const modern = { genshin: { showcase_server: 22 }, starrail: { showcase_server: "034" } };
    expect(await projectShowcaseSettings(modern, archive)).toEqual({
      config: { genshin: { showcase_server: "22" }, starrail: { showcase_server: "034" } }, deferred: [],
    });
    const [first] = archive.plugins;
    const only = { ...first, path: "plugins/miao-one" };
    const other = { ...first, path: "plugins/miao-two" };
    await put(directory, "miao-one/config/cfg.js", "export const profileServer = '44';\nexport const srProfileServer = '2';\n");
    await put(directory, "miao-two/config/cfg.js", "export const profileServer = '24';\nexport const srProfileServer = '2';\n");
    expect(await projectShowcaseSettings({}, { directory, plugins: [only, other] })).toEqual({
      config: { starrail: { showcase_server: "2" } },
      deferred: [{ game: "genshin", reason: "ambiguous-plugin" }],
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
