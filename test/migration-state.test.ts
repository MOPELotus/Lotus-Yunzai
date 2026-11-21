import { expect, test } from "bun:test";
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planLegacyState, stageLegacyState } from "../lib/migration-state.ts";
import { stageMigration } from "../scripts/migrate-stage.ts";
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

test.skipIf(!Bun.which("git"))("组合暂存一并归档拒载插件并复制存量，后段失败清理整个临时目录", () => fixture(async (source, target) => {
  const plugin = "plugins/miao-plugin/package.json";
  const manifest = '{"name":"miao-plugin"}\n';
  await put(source, plugin, manifest);
  const compatible = "plugins/small-local/index.js";
  const script = "export const localFixture = true;\n";
  await put(source, compatible, script);
  await put(source, group, groupBytes);
  await put(source, legacyPool, pool(ids[0]));
  const profile = "user: {qq: 42}\nprofile: {id: 1}\naccount: {cookie: isolated-fixture}\n";
  await put(source, "plugins/Lotus-ReFactor/data/users/42.yaml", profile);
  await put(source, "data/users/42.yaml", profile);
  await put(target, "plugins/system/package.json", '{"name":"@lotus-yunzai/system"}\n');
  for (const args of [["init", "-q"], ["add", "plugins"],
    ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: target, stdout: "ignore", stderr: "ignore" });
    expect(result.exitCode).toBe(0);
  }
  const staged = await stageMigration(source, target);
  expect(staged.backup).toMatchObject({ status: "published", archived: 2 });
  expect(staged.retained).toMatchObject({ status: "published", retained: [{ path: "plugins/small-local" }] });
  expect(staged.profiles).toEqual({ sources: 2, imported: 1, unchanged: 1 });
  expect(await readFile(join(staged.directory, "plugin-archive", "backup", plugin), "utf8")).toBe(manifest);
  expect(await readFile(join(staged.directory, "plugin-archive", compatible), "utf8")).toBe(script);
  expect(await readFile(join(staged.state.directory, group))).toEqual(groupBytes);
  expect(await readFile(join(staged.state.directory, legacyPool), "utf8")).toBe(pool(ids[0]));
  const preparedProfile = join(staged.state.directory, "data/users/42.yaml");
  expect(await readFile(preparedProfile, "utf8")).toBe(profile);
  expect((await lstat(preparedProfile)).mode & 0o777).toBe(0o600);
  expect((await readdir(target)).sort()).toEqual([".git", "plugins"]);

  const siblings = (await readdir(dirname(target))).sort();
  await put(source, "data/users/42.yaml", profile.replace("isolated-fixture", "conflicting-fixture"));
  await expect(stageMigration(source, target)).rejects.toThrow("1 个冲突");
  expect((await readdir(dirname(target))).sort()).toEqual(siblings);
  await put(source, "data/users/42.yaml", profile);
  await put(source, legacyPool, "{invalid]");
  await expect(stageMigration(source, target)).rejects.toThrow("星铁旧逐抽卡池");
  expect((await readdir(dirname(target))).sort()).toEqual(siblings);
  expect(await readFile(join(source, plugin), "utf8")).toBe(manifest);
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
