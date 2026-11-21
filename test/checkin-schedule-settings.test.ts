import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { persistCheckinScheduleSettings } from "../lib/checkin-schedule-settings.ts";
import { readLotusGlobalConfig } from "../lib/lotus-global-config.ts";
import { accountScopePermission } from "../lib/permissions.ts";

const lockName = ".global.yaml.lotus-global.sqlite";
const master = { canWrite: () => true };

async function fixture(run: (root: URL, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-schedule-settings-"));
  try {
    await run(pathToFileURL(`${directory}/`), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function setup(directory: string, text: string, legacy = false) {
  const file = join(directory, legacy ? "config/config/global.yaml" : "config/global.yaml");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

test("沿用旧插件的调度与权限，显式改时刻只写主配置并保留旧开关", () => fixture(async (root, directory) => {
  const legacy = "scheduler: {enable: false, mode: random, run_due_cron: '0 4 * * * *'}\r\n" +
    "permissions: {default_policy: deny, users: {deny: [42]}, scopes: {scheduler.manage: {policy: master_only}}}\r\n";
  const renamed = "scheduler: {enable: true, mode: fixed}\ncoin_shop: {enable: false}\natlas: {version: false}\n";
  const previous = await setup(join(directory, "plugins/Lotus-Plugin"), legacy);
  const secondary = await setup(join(directory, "plugins/Lotus-ReFactor"), renamed);
  const primary = join(directory, "config/global.yaml");
  const permission = (user_id: number) => ({
    canWrite: (document: Readonly<Record<string, unknown>>) => accountScopePermission(document, "scheduler.manage")({ user_id, isMaster: true }),
  });
  const current = await readLotusGlobalConfig(root);
  expect(current).toMatchObject({ scheduler: { enable: false, mode: "random" },
    permissions: { default_policy: "deny" }, coin_shop: { enable: false }, atlas: { version: false } });
  await expect(persistCheckinScheduleSettings(root, { type: "mode", mode: "fixed", time: "7:08" }, permission(42)))
    .rejects.toMatchObject({ reason: "permission" });
  expect(await Bun.file(primary).exists()).toBe(false);
  const edited = await persistCheckinScheduleSettings(root, { type: "mode", mode: "fixed", time: "7:08" }, permission(51));
  expect(edited).toEqual({ enable: false, mode: "fixed", fixed_time: "07:08", run_due_cron: "0 4 * * * *" });
  expect(Bun.YAML.parse(await readFile(primary, "utf8"))).toEqual({ scheduler: { mode: "fixed", fixed_time: "07:08" } });
  expect(await readLotusGlobalConfig(root)).toMatchObject({ scheduler: edited, coin_shop: { enable: false } });
  expect(await readFile(previous, "utf8")).toBe(legacy);
  expect(await readFile(secondary, "utf8")).toBe(renamed);

  const before = await readFile(primary, "utf8");
  await expect(persistCheckinScheduleSettings(root, { type: "mode", mode: "random" }, {
    canWrite(document) {
      writeFileSync(previous, legacy.replace("deny: [42]", "deny: [42, 51]"));
      return permission(51).canWrite(document);
    },
  })).rejects.toMatchObject({ reason: "conflict" });
  expect(await readFile(primary, "utf8")).toBe(before);

  await writeFile(primary, "permissions: {default_policy: allow, scopes: {scheduler.manage: {policy: allow}}}\n" +
    "scheduler: {enable: true}\ncoin_shop: {enable: true}\n");
  const overridden = await readLotusGlobalConfig(root);
  expect(overridden).toMatchObject({ scheduler: { enable: true }, coin_shop: { enable: true } });
  expect(accountScopePermission(overridden, "scheduler.manage")({ user_id: 42, isMaster: false })).toBe(false);
  await writeFile(primary, "permissions: {users: {deny: []}, scopes: {scheduler.manage: {policy: allow}}}\n");
  const explicitlyCleared = await readLotusGlobalConfig(root);
  expect(accountScopePermission(explicitlyCleared, "scheduler.manage")({ user_id: 42, isMaster: false })).toBe(true);
}));

test("优先更新平铺全局配置并保留既有调度字段、注释、其他段落和文件权限", () => fixture(async (root, directory) => {
  const legacyContent = "scheduler: {mode: random}\n";
  const legacy = await setup(directory, legacyContent, true);
  const flat = await setup(directory, `# 全局配置
scheduler: # 调度设定
  mode: fixed # 运行模式
  fixed_time: "04:30" # 固定时间
  run_due_cron: "0 * * * * ? *"
  random:
    window_start: "01:00"
    notify_before: false
metadata: &metadata {hidden: false} # 未知字段
other: *metadata
`);
  await chmod(flat, 0o640);
  const info = await stat(flat);
  const initial = await persistCheckinScheduleSettings(root, { type: "mode", mode: "random" }, master);
  expect(initial).toEqual({
    mode: "random", fixed_time: "04:30", run_due_cron: "0 * * * * ? *",
    random: { window_start: "01:00", notify_before: false },
  });
  const fixed = await persistCheckinScheduleSettings(root, { type: "mode", mode: "fixed", time: "7:05" }, master);
  expect(fixed).toEqual({ ...initial, mode: "fixed", fixed_time: "07:05" });
  expect(await persistCheckinScheduleSettings(root, { type: "mode", mode: "fixed" }, master)).toEqual(fixed);
  const after = await persistCheckinScheduleSettings(root, { type: "plan-cron", time: "23:59" }, master);
  expect(after).toEqual({ ...fixed, plan_generate_cron: "0 59 23 * * ? *" });
  const output = await readFile(flat, "utf8");
  for (const kept of ["# 全局配置", "# 调度设定", "# 运行模式", "# 固定时间", "# 未知字段", "&metadata", "*metadata"]) {
    expect(output).toContain(kept);
  }
  expect(Bun.YAML.parse(output)).toEqual({ scheduler: after, metadata: { hidden: false }, other: { hidden: false } });
  expect(await readFile(legacy, "utf8")).toBe(legacyContent);
  const updated = await stat(flat);
  expect(updated.mode & 0o777).toBe(0o640);
  expect([updated.uid, updated.gid]).toEqual([info.uid, info.gid]);
  await persistCheckinScheduleSettings(root, { type: "plan-cron", time: "23:59" }, master);
  expect(await readFile(flat, "utf8")).toBe(output);
  expect((await stat(flat)).ino).toBe(updated.ino);
  expect((await readdir(dirname(flat))).sort()).toEqual([lockName, "config", "global.yaml"]);
}));

test("支持旧配置位置及共享规范路径的符号链接，串行写入保留独立变更", () => fixture(async (root, directory) => {
  const legacy = await setup(directory, "legacy: true\n", true);
  const target = join(directory, "managed-global.yaml");
  await writeFile(target, "scheduler: {enable: false}\n");
  const flat = join(directory, "config/global.yaml");
  await symlink("../managed-global.yaml", flat);
  await Promise.all([
    persistCheckinScheduleSettings(root, { type: "mode", mode: "fixed", time: "0:00" }, master),
    persistCheckinScheduleSettings(root, { type: "plan-cron", time: "9:07" }, master),
  ]);
  expect((await lstat(flat)).isSymbolicLink()).toBe(true);
  expect(Bun.YAML.parse(await readFile(target, "utf8"))).toEqual({
    scheduler: { enable: false, mode: "fixed", fixed_time: "00:00", plan_generate_cron: "0 7 9 * * ? *" },
  });
  expect(await readFile(legacy, "utf8")).toBe("legacy: true\n");
  await rm(flat);
  await persistCheckinScheduleSettings(root, { type: "mode", mode: "random" }, master);
  expect(await readFile(legacy, "utf8")).toBe("legacy: true\nscheduler:\n  mode: random\n");
}));

test("没有全局配置时按权限写入首选位置，空注释文件可原地补入设置", () => fixture(async (root, directory) => {
  await expect(persistCheckinScheduleSettings(root, { type: "mode", mode: "random" }, { canWrite: () => false }))
    .rejects.toMatchObject({ reason: "permission" });
  expect(await readdir(directory)).toEqual([]);
  expect(await persistCheckinScheduleSettings(root, { type: "mode", mode: "fixed" }, master))
    .toEqual({ mode: "fixed" });
  const flat = join(directory, "config/global.yaml");
  expect((await stat(flat)).mode & 0o777).toBe(0o600);
  await writeFile(flat, "# 仅有注释\n");
  await persistCheckinScheduleSettings(root, { type: "mode", mode: "random" }, master);
  expect(await readFile(flat, "utf8")).toContain("# 仅有注释");
  expect(Bun.YAML.parse(await readFile(flat, "utf8"))).toEqual({ scheduler: { mode: "random" } });
}));

test("无效时间、损坏配置或会改动其他引用的锚点拒绝保存", () => fixture(async (root, directory) => {
  const legacy = await setup(directory, "legacy: true\n", true);
  const flat = await setup(directory, "scheduler: {mode: fixed}\n");
  for (const time of ["24:00", "23:60", "9:0", " 9:00", "九点"]) {
    await expect(persistCheckinScheduleSettings(root, { type: "mode", mode: "fixed", time }, master))
      .rejects.toMatchObject({ reason: "invalid-input" });
  }
  for (const content of [
    "scheduler: []\n", "scheduler: {mode: nonsense}\n", "scheduler: {mode: fixed, fixed_time: '24:01'}\n",
    "scheduler: {random: {window_start: '10:00', window_end: '02:00'}}\n",
    "scheduler: {mode: fixed}\nscheduler: {mode: random}\n",
    "scheduler: &schedule {mode: fixed}\nalias: *schedule\n", "scheduler: [\n",
  ]) {
    await writeFile(flat, content);
    await expect(persistCheckinScheduleSettings(root, { type: "mode", mode: "random" }, master))
      .rejects.toMatchObject({ reason: "config" });
    expect(await readFile(flat, "utf8")).toBe(content);
  }
  await rm(flat);
  await symlink("../missing-global.yaml", flat);
  await expect(persistCheckinScheduleSettings(root, { type: "mode", mode: "random" }, master))
    .rejects.toMatchObject({ reason: "config" });
  expect(await readFile(legacy, "utf8")).toBe("legacy: true\n");
}));

test("签到调度覆盖共享配置的选定字段并继续继承其他值", () => fixture(async (root, directory) => {
  const before = "\uFEFF# 旧配置\r\nshared: &shared {mode: random, enable: false, fixed_time: '04:30'}\r\n" +
    "scheduler: *shared # 签到调度\r\nother: *shared\r\n";
  const file = await setup(directory, before, true);
  expect(await persistCheckinScheduleSettings(root, { type: "mode", mode: "fixed", time: "9:30" }, master))
    .toEqual({ mode: "fixed", enable: false, fixed_time: "09:30" });
  const edited = before.replace("scheduler: *shared", 'scheduler: {<<: *shared, mode: fixed, fixed_time: "09:30"}');
  expect(await readFile(file, "utf8")).toBe(edited);

  await writeFile(file, edited.replace("enable: false", "enable: true"));
  expect(await persistCheckinScheduleSettings(root, { type: "mode", mode: "random" }, master))
    .toEqual({ mode: "random", enable: true, fixed_time: "09:30" });
  const after = await readFile(file, "utf8");
  expect(after).toBe(edited.replace("enable: false", "enable: true").replace("mode: fixed", "mode: random"));
  expect(Bun.YAML.parse(after)).toMatchObject({ other: { mode: "random", enable: true, fixed_time: "04:30" } });
}));

test("锁内重新检查最新权限，外部编辑或取消后不发布暂存配置", () => fixture(async (root, directory) => {
  const flat = await setup(directory, "permissions: {mayEdit: true}\n");
  const lock = new Database(join(dirname(flat), lockName));
  const latest = "permissions: {mayEdit: false}\n";
  let checked = false;
  try {
    lock.exec("BEGIN IMMEDIATE");
    const pending = persistCheckinScheduleSettings(root, { type: "mode", mode: "random" }, {
      canWrite(document) {
        checked = true;
        return (document.permissions as { mayEdit?: boolean }).mayEdit === true;
      },
    });
    void pending.catch(() => undefined);
    await Bun.sleep(45);
    expect(checked).toBe(false);
    await writeFile(flat, latest);
    lock.exec("ROLLBACK");
    await expect(pending).rejects.toMatchObject({ reason: "permission" });
    expect(checked).toBe(true);
  } finally {
    lock.close();
  }
  expect(await readFile(flat, "utf8")).toBe(latest);
  const externallyUpdated = "permissions: {mayEdit: false}\nexternal: edit\n";
  await expect(persistCheckinScheduleSettings(root, { type: "mode", mode: "random" }, {
    canWrite() {
      writeFileSync(flat, externallyUpdated);
      return true;
    },
  })).rejects.toMatchObject({ reason: "conflict" });
  const abort = new AbortController();
  await expect(persistCheckinScheduleSettings(root, { type: "mode", mode: "random" }, {
    signal: abort.signal,
    canWrite() { abort.abort(); return true; },
  })).rejects.toMatchObject({ reason: "cancelled" });
  expect(await readFile(flat, "utf8")).toBe(externallyUpdated);
  expect((await readdir(dirname(flat))).sort()).toEqual([lockName, "global.yaml"]);
}));

test("块状设置只改目标标量或插入目标字段，权限与原文 BOM、CRLF 和指令逐字保留", () => fixture(async (root, directory) => {
  const permissions = [
    "permissions: # 权限注释原位",
    "  users: {deny: [44], allow: []}",
    "  scopes: {scheduler.manage: {policy: master_only}}",
  ].join("\r\n");
  const original = [
    "\uFEFF%YAML 1.2", "---", "# 测试😀", "scheduler: # 调度注释原位", "    mode: 'fixed' # 原格式",
    "    fixed_time: 04:30", "    unknown: |+", "      元数据", "", "# 权限段落", permissions,
    "...   # 文件结束", "# 文档外", "",
  ].join("\r\n");
  const file = await setup(directory, original);
  await persistCheckinScheduleSettings(root, { type: "mode", mode: "random" }, master);
  const random = original.replace("mode: 'fixed'", "mode: 'random'");
  expect(await readFile(file)).toEqual(Buffer.from(random));
  await persistCheckinScheduleSettings(root, { type: "plan-cron", time: "8:01" }, master);
  const expected = random.replace("# 权限段落", '    plan_generate_cron: "0 1 8 * * ? *"\r\n# 权限段落');
  expect(await readFile(file)).toEqual(Buffer.from(expected));
}));

test("保留同一行的 flow mapping 布局，安全替换别名标量并保留折叠 cron 的行注释", () => fixture(async (root, directory) => {
  const original = "{permissions: [44], scheduler: {mode: fixed,}, tail: {a: [2]}}\n";
  const file = await setup(directory, original);
  await persistCheckinScheduleSettings(root, { type: "mode", mode: "fixed", time: "4:30" }, master);
  expect(await readFile(file, "utf8")).toBe(original.replace("mode: fixed", 'fixed_time: "04:30", mode: fixed'));

  const inherited = [
    "values: &default {mode: fixed}",
    "default_cron: &cron '0 0 0 * * ? *'",
    "scheduler: {<<: *default, plan_generate_cron: *cron}",
    "permissions: [44]", "",
  ].join("\n");
  await writeFile(file, inherited);
  await persistCheckinScheduleSettings(root, { type: "mode", mode: "random" }, master);
  const withMode = inherited.replace("scheduler: {", "scheduler: {mode: random, ");
  expect(await readFile(file, "utf8")).toBe(withMode);
  await persistCheckinScheduleSettings(root, { type: "plan-cron", time: "14:04" }, master);
  expect(await readFile(file, "utf8")).toBe(withMode.replace("plan_generate_cron: *cron", 'plan_generate_cron: "0 4 14 * * ? *"'));

  const folded = "scheduler:\n  plan_generate_cron: >- # 保留 cron 注释\n    0 0 0 * * ? *\npermissions: [44]\n";
  await writeFile(file, folded);
  await persistCheckinScheduleSettings(root, { type: "plan-cron", time: "3:06" }, master);
  expect(await readFile(file, "utf8")).toBe(folded.replace(">- # 保留 cron 注释\n    0 0 0 * * ? *", '"0 6 3 * * ? *" # 保留 cron 注释'));
}));

test("新增 scheduler 保留流式根、空文档的结束符和原有尾部文本", () => fixture(async (root, directory) => {
  const file = await setup(directory, "");
  for (const [before, after] of [
    [
      "%YAML 1.2\n--- {permissions: [44]}\n...\n# 文档外",
      "%YAML 1.2\n--- {scheduler: {mode: random}, permissions: [44]}\n...\n# 文档外",
    ],
    [
      "%YAML 1.2\n--- # 起始\n# 空文档\n... # 结束\n",
      "%YAML 1.2\n--- # 起始\n# 空文档\nscheduler:\n  mode: random\n... # 结束\n",
    ],
    [
      "permissions: # 权限\n  deny: [44]\n# 尾部",
      "permissions: # 权限\n  deny: [44]\nscheduler:\n  mode: random\n# 尾部",
    ],
    ["permissions: [44] # 无末尾换行", "permissions: [44] # 无末尾换行\nscheduler:\n  mode: random"],
    ["\uFEFF", "\uFEFFscheduler:\n  mode: random\n"],
  ] as const) {
    await writeFile(file, before);
    await persistCheckinScheduleSettings(root, { type: "mode", mode: "random" }, master);
    expect(await readFile(file)).toEqual(Buffer.from(after));
  }
}));
