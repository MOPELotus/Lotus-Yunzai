import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readGachaDisplaySettings } from "../lib/gacha-display-settings.ts";
import { legacyGachaDisplayConfig, stageLegacyGachaDisplayConfig } from "../lib/migration-gacha-display.ts";
import { panelGachaSettings } from "../lib/panel-gacha-settings.ts";
import { rejectionReason } from "../lib/plugins/policy.ts";

const legacy = `
  // Matching export text in a comment does not count.
  // export const detailCfg = { maxLog: 999 }
export const luckCfg = {
  enable: false,
  minSample: 0,
  levels: [{ min: 0, title: '测试评级', desc: '样本 // 注释符保留', color: '#CCDDFF' }],
  model: { gs: { 301: { base: 0.01 } }, sr: { 12: { upRate: 0.8 } } }
}
export const detailCfg = { maxLog: 0 }
// Stat setting follows the earlier export.
export const statCfg = { maxVersion: 18 }
`;

test("legacy literal policy leaves executable settings deferred and preserves independent settings", () => {
  expect(legacyGachaDisplayConfig(legacy)).toEqual({
    config: {
      enabled: false, minSample: 0, levels: [{ min: 0, title: "测试评级", desc: "样本 // 注释符保留", color: "#CCDDFF" }],
      models: { gs: { 301: { base: 0.01 } }, sr: { 12: { upRate: 0.8 } } }, detailRows: 0, versionRows: 18,
    },
    deferred: false,
  });
  expect(legacyGachaDisplayConfig(legacy.replace("maxVersion: 18", "maxVersion: (() => { throw Error('不执行') })()")))
    .toMatchObject({ config: { enabled: false, detailRows: 0 }, deferred: true });
  expect(legacyGachaDisplayConfig(legacy + "\nexport const isSys = true")).toEqual({ config: {}, deferred: true });
});

test("migration imports only the active gacha.js and authorized panel edits reach runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-gacha-display-"));
  try {
    const archive = join(directory, "archive");
    const config = join(archive, "miao-plugin/config");
    const stage = join(directory, "next");
    const root = pathToFileURL(stage + "/");
    await mkdir(config, { recursive: true });
    await mkdir(stage);
    await writeFile(join(config, "gacha_default.js"), legacy);
    const plugins = [{ path: "plugins/miao-plugin", identity: "miao-plugin", kind: "directory", status: "archive",
      reason: rejectionReason(["miao-plugin"], [])! }] as const;
    expect(await stageLegacyGachaDisplayConfig(archive, stage, plugins)).toEqual({ active: false, deferred: false });
    expect(await readGachaDisplaySettings(root)).toMatchObject({ detailRows: 30, versionRows: 10, luck: { enabled: true, minSample: 3 } });
    await writeFile(join(config, "gacha.js"), Uint8Array.of(0xff));
    expect(await stageLegacyGachaDisplayConfig(archive, stage, plugins)).toEqual({ active: false, deferred: true });
    await writeFile(join(config, "gacha.js"), legacy);
    expect(await stageLegacyGachaDisplayConfig(archive, stage, plugins)).toEqual({ active: true, deferred: false });
    const handler = panelGachaSettings(root);
    const url = "http://localhost/panel/api/settings/native/gacha-display";
    expect((await handler(new Request(url), () => false)).status).toBe(401);
    const { values } = await (await handler(new Request(url), () => true)).json();
    expect(values).toMatchObject({ enabled: false, detailRows: 0, versionRows: 18 });
    const put = (next: unknown) => handler(new Request(url, { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ previous: values, values: next }) }), () => true);
    expect((await put({ ...values, models: { gs: { 301: { base: 2 } } } })).status).toBe(400);
    expect((await put({ ...values, enabled: true, versionRows: 0 })).status).toBe(200);
    expect((await put({ ...values, detailRows: 5 })).status).toBe(409);
    expect(await readGachaDisplaySettings(root)).toMatchObject({
      detailRows: 0, versionRows: 0, luck: { enabled: true, minSample: 0 }, models: { sr: { 12: { upRate: 0.8 } } },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
