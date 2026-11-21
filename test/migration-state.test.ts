import { expect, test } from "bun:test";
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";
import { accountScopePermission, readMasterPermissions } from "../lib/permissions.ts";
import { readLotusGlobalConfig } from "../lib/lotus-global-config.ts";
import { readServerSettings } from "../lib/server.ts";
import { planLegacyState, stageLegacyState } from "../lib/migration-state.ts";
import { stageMigration } from "../scripts/migrate-stage.ts";
import { migrateInstallation } from "../scripts/migrate.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const group = "config/config/group.yaml";
const user = 42;
const uid = "100000002";
const legacyPool = `data/srJson/${user}/${uid}/11.json`;
const backupPool = `data/srJson.backup/${user}/${uid}/11.json`;
const groupBytes = Buffer.from("\uFEFF# 保留旧注释\r\ndefault: {onlyReplyAt: 1, botAlias: [迁移别名], groupCD: 0, singleCD: 0}\r\n");
const ids = ["1774275200000000001", "1774275200000000002"] as const;
function pool(id: string) {
  return JSON.stringify([{ uid, id, gacha_type: "11", gacha_id: "2005", item_id: "1001",
    time: "2025-07-15 12:00:09", lang: "zh-cn", name: "希儿", item_type: "角色", rank_type: "5" }]) + "\n";
}

async function put(root: string, file: string, data: string | Uint8Array) {
  const path = join(root, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

async function fixture(run: (source: string, target: string) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-migration-state-"));
  const source = join(temporary, "old");
  const target = join(temporary, "candidate");
  try {
    await Promise.all([mkdir(source), mkdir(target)]);
    await run(source, target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test.skipIf(!Bun.which("git"))("一体化迁移发布已验证的配置、数据和插件，可重试且不改旧安装", () => fixture(async (source, target) => {
  const plugin = "plugins/miao-plugin/package.json";
  const manifest = '{"name":"miao-plugin"}\n';
  await put(source, plugin, manifest);
  const compatible = "plugins/small-local/index.js";
  const script = "export const localFixture = true;\n";
  await put(source, compatible, script);
  const held = "missing-dependency/index.js";
  const heldScript = 'import "lotus-migration-unavailable-test-dependency";\n';
  await put(source, `plugins/${held}`, heldScript);
  await put(source, group, groupBytes);
  await put(source, legacyPool, pool(ids[0]));
  await put(source, "data/textJson/fixture.json", "{}\n");
  const oldGlobal = "plugins/Lotus-Plugin/config/global.yaml";
  const exampleGlobal = "schedule: '0 30 4 * * ?'\npermissionControl: {mode: whitelist, whitelist: [42]}\ncoin_shop: {enable: false, panel_session_hours: 15, host: external-local-only}\nremote: {enable: true}\n";
  await put(source, oldGlobal, exampleGlobal);
  await put(source, "config/global.yaml", "scheduler: {enable: false}\n");
  await put(source, "config/config/other.yaml", 'master: ["99:42"]\nautoGroup: 0\n');
  await put(source, "config/config/server.yaml", "port: 9123\nhttps: null\n");
  await put(source, "config/config/milky.yaml", "enable: false\n");
  const profile = "user: {qq: 42}\nprofile: {id: 1}\naccount: {cookie: isolated-fixture}\n";
  await put(source, "plugins/Lotus-ReFactor/data/users/42.yaml", profile);
  await put(source, "data/users/42.yaml", profile);
  const date = "2026-11-21";
  const oldSchedule = `plugins/Lotus-ReFactor/data/schedules/${date}.json`;
  const scheduled = { qq: "42", profileId: 1, name: "", time: "04:30", mode: "fixed", notified: false };
  const originalSchedule = JSON.stringify({
    version: 1, date, mode: "fixed", window: { window_start: "00:00", window_end: "23:30", notify_before: true },
    generatedAt: `${date}T00:00:00.000+08:00`,
    entries: [{ ...scheduled, done: false, runningAt: `${date}T04:30:00.000+08:00` },
      { ...scheduled, profileId: 2, done: true, ok: true }],
  });
  await put(source, oldSchedule, originalSchedule);
  await put(source, "plugins/Lotus-Plugin/data/schedules/2026-11-20.json", "");
  await put(target, "package.json", '{"name":"lotus-yunzai"}\n');
  await put(target, "plugins/system/package.json", '{"name":"@lotus-yunzai/system"}\n');
  for (const args of [["init", "-q"], ["add", "package.json", "plugins"],
    ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: target, stdout: "ignore", stderr: "ignore" });
    expect(result.exitCode).toBe(0);
  }
  const staged = await stageMigration(source, target);
  expect(staged.backup).toMatchObject({ status: "published", archived: 3 });
  expect(staged.retained).toMatchObject({ status: "published", retained: [{ path: "plugins/small-local" }] });
  expect(staged.profiles).toEqual({ sources: 2, imported: 1, unchanged: 1 });
  expect(staged.schedules).toEqual({ days: 1, entries: 2, emptyFiles: 1 });
  expect(await readFile(join(staged.directory, "plugin-archive", "backup", plugin), "utf8")).toBe(manifest);
  expect(await readFile(join(staged.directory, "plugin-archive", compatible), "utf8")).toBe(script);
  expect(await readFile(join(staged.state.directory, group))).toEqual(groupBytes);
  expect(await readFile(join(staged.state.directory, legacyPool), "utf8")).toBe(pool(ids[0]));
  const preparedProfile = join(staged.state.directory, "data/users/42.yaml");
  expect(await readFile(preparedProfile, "utf8")).toBe(profile);
  expect((await lstat(preparedProfile)).mode & 0o777).toBe(0o600);
  expect((await readdir(target)).sort()).toEqual([".git", "package.json", "plugins"]);

  const siblings = (await readdir(dirname(target))).sort();
  await put(source, "data/users/42.yaml", profile.replace("isolated-fixture", "conflicting-fixture"));
  await expect(stageMigration(source, target)).rejects.toThrow("1 个冲突");
  expect((await readdir(dirname(target))).sort()).toEqual(siblings);
  await put(source, "data/users/42.yaml", profile);
  await put(source, legacyPool, "{invalid]");
  await expect(stageMigration(source, target)).rejects.toThrow("星铁旧逐抽卡池");
  expect((await readdir(dirname(target))).sort()).toEqual(siblings);
  expect(await readFile(join(source, plugin), "utf8")).toBe(manifest);

  await put(source, legacyPool, pool(ids[0]));
  const result = await migrateInstallation(source, target);
  expect(result).toMatchObject({ status: "published", archiveCount: 3, profiles: { imported: 1 },
    schedules: { days: 1, entries: 2, emptyFiles: 1 },
    heldPlugins: [{ path: "plugins/missing-dependency", reason: "unresolved-dependency" }] });
  expect(result.paths).toEqual(["backup", "config", "data", "plugins/small-local"]);
  expect(await readFile(join(target, "backup", plugin), "utf8")).toBe(manifest);
  expect(result.gameData.archived).toEqual([{ path: "backup/legacy-data/textJson", files: 1, bytes: 3 }]);
  expect(await readFile(join(target, "backup/legacy-data/textJson/fixture.json"), "utf8")).toBe("{}\n");
  expect(result.globalConfig.sections.sort()).toEqual(["coin_shop", "permissions", "scheduler"]);
  expect(result.coreConfig).toEqual({ files: 1, deferredOwners: { master: 0, masterQQ: 0 } });
  const migratedRoot = Bun.pathToFileURL(`${target}/`);
  expect((await readMasterPermissions(migratedRoot)).isMaster(99, 42)).toBe(true);
  expect(result.networkConfig).toEqual({ groups: ["server", "milky"], deferred: ["server.onebot.authorization"] });
  expect((await readServerSettings(migratedRoot, {})).http?.port).toBe(9123);
  expect((await readServerSettings(migratedRoot, { LOTUS_ONEBOT_TOKEN: "fixture" })).oneBot?.port).toBe(9123);
  const globalConfig = await readLotusGlobalConfig(migratedRoot);
  expect(globalConfig).toEqual({
    scheduler: { enable: false, mode: "fixed", fixed_time: "04:30" },
    permissions: { default_policy: "deny", users: { allow: ["42"], deny: [] } },
    coin_shop: { enable: false, panel_session_hours: 15 },
  });
  const allowed = accountScopePermission(globalConfig, "checkin.refresh");
  expect(allowed({ user_id: 42, isMaster: false })).toBe(true);
  expect(allowed({ user_id: 43, isMaster: false })).toBe(false);
  expect(await readFile(join(target, "backup", oldGlobal), "utf8")).toBe(exampleGlobal);
  expect(await readFile(join(target, compatible), "utf8")).toBe(script);
  expect(await Bun.file(join(target, "plugins", held)).exists()).toBe(false);
  expect(await readFile(join(target, "backup/held-plugins", held), "utf8")).toBe(heldScript);
  expect(await readFile(join(target, group))).toEqual(groupBytes);
  expect(await readFile(join(target, legacyPool), "utf8")).toBe(pool(ids[0]));
  expect(await readFile(join(target, "data/users/42.yaml"), "utf8")).toBe(profile);
  expect((await createCheckinScheduleStore(join(target, "data/schedules")).read(date))?.entries).toEqual([
    expect.objectContaining({ profileId: 1, done: true, stage: "legacy-unconfirmed" }),
    expect.objectContaining({ profileId: 2, done: true, ok: true }),
  ]);
  expect(await readdir(join(target, "data/schedules"))).toEqual([`${date}.json`]);
  expect(await readFile(join(source, oldSchedule), "utf8")).toBe(originalSchedule);
  expect(await readFile(join(target, "backup", oldSchedule), "utf8")).toBe(originalSchedule);
  expect(await Bun.file(join(target, plugin)).exists()).toBe(false);
  expect(await readFile(join(source, plugin), "utf8")).toBe(manifest);
  expect(await migrateInstallation(source, target)).toMatchObject({ status: "already-published", paths: result.paths });
}));

test("旧群配置和星铁逐抽可独立暂存，并由隔离宿主原指令实际读取", () => fixture(async (source, target) => {
  const preserved = { [group]: groupBytes, [legacyPool]: Buffer.from(pool(ids[0])), [backupPool]: Buffer.from(pool(ids[1])) };
  for (const [path, data] of Object.entries(preserved)) await put(source, path, data);
  const excluded = [".env", "config/config/other.yaml", "config/config/bot.yaml", "config/config/redis.yaml",
    "config/config/server.yaml", "data/users/42.yaml", "data/srJson/42/100000002/notes.txt"];
  for (const path of excluded) await put(source, path, "fixture-private-var: never copied\n");

  const originalTarget = "default: {onlyReplyAt: 0} # 候选原文件\n";
  await put(target, group, originalTarget);
  await put(target, legacyPool, "[]\n");
  const plan = await planLegacyState(source);
  expect(plan).toEqual([
    { path: group, files: 1, bytes: groupBytes.length },
    { path: "data/srJson", files: 1, bytes: Buffer.byteLength(pool(ids[0])) },
    { path: "data/srJson.backup", files: 1, bytes: Buffer.byteLength(pool(ids[1])) },
  ]);
  expect((await readdir(target)).sort()).toEqual(["config", "data"]);

  const { directory, plan: staged } = await stageLegacyState(source, target);
  expect(staged).toEqual(plan);
  for (const path of [directory, join(directory, "config/config"), join(directory, dirname(legacyPool))]) {
    expect((await lstat(path)).mode & 0o777).toBe(0o700);
  }
  for (const [path, bytes] of Object.entries(preserved)) {
    expect(await readFile(join(source, path))).toEqual(bytes);
    expect(await readFile(join(directory, path))).toEqual(bytes);
    expect((await lstat(join(directory, path))).mode & 0o777).toBe(0o600);
  }
  for (const path of excluded) expect(await Bun.file(join(directory, path)).exists()).toBe(false);

  const guard = `
const actualFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "127.0.0.1") throw Error("isolated migration fixture");
  return actualFetch(input, options);
};
`;
  await withDualGatewayFixture("isolated-state-staging", "disablePrivate: false\n", async ({ root, onebot, sendOneBot }) => {
    const groupMessage = { message_type: "group", sub_type: "normal", group_id: 77, sender: { user_id: user } };
    sendOneBot("#版本", groupMessage);
    await Bun.sleep(100);
    expect(onebot.calls).toEqual([]);
    sendOneBot("迁移别名 #版本", groupMessage);
    const version = await onebot.next("send_msg");
    expect(version.params.group_id).toBe(77);
    expect(String(version.params.message)).toContain("Lotus-Yunzai 版本");
    version.respond({ message_id: 101 });

    async function exportFile(command: string) {
      sendOneBot(command);
      const upload = await onebot.next("upload_private_file");
      expect(upload.params).toMatchObject({ user_id: user, name: uid + ".json" });
      const file = String(upload.params.file);
      expect(file).toStartWith("base64://");
      const exported = JSON.parse(Buffer.from(file.slice("base64://".length), "base64").toString("utf8"));
      upload.respond({ file_id: "isolated-file-confirmed" });
      const receipt = await onebot.next("send_msg");
      expect(receipt.params).toMatchObject({ user_id: user, message: expect.stringContaining("共 1 条星铁逐抽记录") });
      receipt.respond({ message_id: 102 });
      return exported;
    }
    const current = await exportFile("#星铁导出记录");
    expect(current.hkrpg).toEqual([expect.objectContaining({ uid, list: [expect.objectContaining({ id: ids[0] })] })]);

    // The adopted checkout is disposable. Remove its live pool to exercise the real backup fallback.
    await rm(join(root, legacyPool));
    const backup = await exportFile("#星铁导出记录jsonv2");
    expect(backup.list).toEqual([expect.objectContaining({ id: ids[1] })]);
  }, 3_500, guard, async (root) => {
    for (const path of ["config", "data"]) await cp(join(directory, path), join(root, path), { recursive: true });
    await symlink(fileURLToPath(new URL("../packages/", import.meta.url)), join(root, "packages"), "dir");
    await cp(new URL("../plugins/starrail/", import.meta.url), join(root, "plugins", "starrail"), {
      recursive: true, filter: path => !path.endsWith("/.git"),
    });
    await put(root, "config/bot.yaml", "cache_group_member: false\nupdate_time: 0\n");
    await put(root, ".env", "LOTUS_PROFILE_DIR=fixture-profiles\n");
    await put(root, "fixture-profiles/42.yaml", Bun.YAML.stringify({
      user: { qq: String(user) }, profile: { id: 1 },
      account: { stuid: "71", current_uid: { sr: uid }, game_roles: { sr: [{ uid, region: "prod_gf_cn",
        game_biz: "hkrpg_cn", nickname: "隔离档案" }] } },
    }));
  });
  expect(await readFile(join(directory, legacyPool))).toEqual(preserved[legacyPool]);
  expect(await readFile(join(source, legacyPool))).toEqual(preserved[legacyPool]);
  expect(await readFile(join(target, group), "utf8")).toBe(originalTarget);
  expect(await readFile(join(target, legacyPool), "utf8")).toBe("[]\n");
}), 13_000);

test("配置软链、档案目录软链、硬链接和非法逐抽均不能生成可用暂存", () => fixture(async (source, target) => {
  await put(target, "outside", "outside-source\n");
  await mkdir(join(source, "config/config"), { recursive: true });
  await symlink(join(target, "outside"), join(source, group));
  await expect(planLegacyState(source)).rejects.toThrow("普通文件");
  await expect(stageLegacyState(source, target)).rejects.toThrow("普通文件");
  await rm(join(source, group));

  await put(source, group, groupBytes);
  await mkdir(join(source, "data/srJson"), { recursive: true });
  await symlink(target, join(source, "data/srJson/42"));
  await expect(stageLegacyState(source, target)).rejects.toThrow("实体目录");
  await rm(join(source, "data/srJson/42"));

  const bytes = "[]\n";
  await put(source, "cache", bytes);
  await mkdir(dirname(join(source, legacyPool)), { recursive: true });
  await link(join(source, "cache"), join(source, legacyPool));
  await expect(stageLegacyState(source, target)).rejects.toThrow("无硬链接");
  await rm(join(source, legacyPool));

  await put(source, legacyPool, "{invalid}");
  await expect(stageLegacyState(source, target)).rejects.toThrow("UTF-8 JSON 数组");
  await expect(stageLegacyState(source, source)).rejects.toThrow("副本之外");
  expect(await readdir(target)).toEqual(["outside"]);
  expect(await readFile(join(source, group))).toEqual(groupBytes);
  expect(await readFile(join(source, legacyPool), "utf8")).toBe("{invalid}");

  await put(source, legacyPool, bytes);
  await put(source, group, "[无效群配置]");
  await expect(stageLegacyState(source, target)).rejects.toThrow("无法读取 config/config/group.yaml");
  const stop = AbortSignal.abort(new Error("取消暂存"));
  await expect(stageLegacyState(source, target, stop)).rejects.toThrow("取消暂存");
  expect(await readdir(target)).toEqual(["outside"]);
}));
