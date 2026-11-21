import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readGroupDispatch } from "../lib/group-dispatch.ts";
import { stageLegacyGroupConfig } from "../lib/migration-group-config.ts";
import { readGroupRecallPermissions } from "../lib/quoted-recall.ts";
import { createAutoGroupCard } from "../plugins/group/auto-group-card.ts";
import { readGroupLeaveBlacklist } from "../plugins/group/group-leave-blacklist.ts";
import { readLikeSettings } from "../plugins/group/like-settings.ts";
import { createManagedBlacklist } from "../plugins/group/managed-blacklist.ts";
import { configuredPrivateNotice, createPrivateNoticeReader, privateNoticeSetting } from "../plugins/group/private-notice-config.ts";
import { configuredNoticeSchedule } from "../plugins/notice/schedule.ts";

const yenai = "plugins/yenai-plugin/config/config/";
const archive = "backup/legacy-group-config/";

async function fixture(run: (source: string, state: string) => Promise<void>) {
  const temp = await mkdtemp(join(tmpdir(), "lotus-group-config-"));
  try {
    const source = join(temp, "source"), state = join(temp, "state");
    await Promise.all([mkdir(source, { mode: 0o700 }), mkdir(state, { mode: 0o700 })]);
    await run(source, state);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function file(root: string, name: string, content: string) {
  const path = join(root, name);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return writeFile(path, content, { mode: 0o600 });
}

const missing = () => { throw Error("The validation must not write runtime state."); };

test("group and notice configs use the active paths with original defaults, scopes and independent source backups", () => fixture(async (source, state) => {
  const sample = {
    "config/config/auto-group-card.yaml": "enable: true\ncron: '0 0,30 * * * *'\nnotGroup: [43]\nlegacyField: opaque\n",
    "config/config/group-leave-blacklist.yaml": "enable: true\ngroups: [42, '43']\n",
    "config/config/group.yaml": "default: { disable: [fixture-gate] }\n",
    [`${yenai}thumbUp.yaml`]: "# old inline comment\nenable: false\ncloseTips: '测试停用'\nunknown: opaque\n",
    [`${yenai}groupAdmin.yaml`]: "whiteQQ: [12]\nblackQQ: [10]\nnoBan: true\nrecallMsgPer: { bot: owner, member: master }\n" +
      "groupVerify: { openGroup: [42], time: 60, range: { min: 8, max: 18 }, SuccessMsgs: { 0: baseline, 42: hello } }\n" +
      "groupAddNotice: { openGroup: [42], msg: '审核邀请' }\n",
    "config/groupAdmin.yaml": "blackQQ: []\nrecallMsgPer: { member: owner }\ngroupVerify: { range: { max: 20 }, SuccessMsgs: { '42': 'override' } }\n",
    [`${yenai}notice.yaml`]: "default: { groupMessage: false, friendRequest: true, notificationsAll: false, msgSaveDeltime: 420 }\n" +
      "42: { groupMessage: true }\n'bot:9': { groupMessage: false }\n'bot:9:42': { groupMessage: true }\n",
    "plugins/notice-plugin/config/config_default.yaml": "enableSchedule: true\nscheduleTime: '09:02-09:17'\nlogger: debug\n",
    "plugins/notice-plugin/config/config.yaml": "enableSchedule: false\npushSettings: { maxConcurrentAccounts: 4 }\n",
  };
  for (const [path, contents] of Object.entries(sample)) await file(source, path, contents);
  // The main state stage, owned by the caller, retains TRSS routing at the legacy path.
  await file(state, "config/config/group.yaml", sample["config/config/group.yaml"]);
  const report = await stageLegacyGroupConfig(source, state);
  expect(report.active).toEqual(["config/auto-group-card.yaml", "config/group-leave-blacklist.yaml", "config/group.yaml",
    "config/groupAdmin.yaml", "config/group-notice.yaml", "config/notice.yaml"]);
  expect(report.archived).toHaveLength(Object.keys(sample).length - 1);
  expect(report.deferred).toEqual(["notice.logger", "notice.pushSettings"]);
  for (const path of report.archived) {
    expect(await readFile(join(state, path), "utf8")).toBe(sample[path.slice(archive.length) as keyof typeof sample]);
    expect((await stat(join(state, path))).mode & 0o777).toBe(0o600);
  }
  const root = pathToFileURL(state + sep), signal = new AbortController().signal;
  expect(await createAutoGroupCard({ root, signal, accounts: () => [] }).configuration()).toEqual({ cron: "0 0,30 * * * *" });
  const leave = await readGroupLeaveBlacklist(root, { get: missing, set: missing, remove: missing, appendGlobal: missing, isProtected: missing });
  expect([42, 43, 44].map(id => leave.isEnabled(id))).toEqual([true, true, false]);
  expect((await readLikeSettings({ file: new URL("config/group.yaml", root) })).settings).toMatchObject({ enable: false, recall: 20, closeTips: "测试停用" });
  expect((await readGroupDispatch(root)).allows({ group_id: 42 }, ["fixture-gate"])).toBe(false);
  const management = createManagedBlacklist(root, missing);
  expect(await management.blocked(10)).toBe(false);
  expect(await management.shouldAutoUnmute(12)).toBe(true);
  expect((await management.readGroupVoteSettings()).VoteBan).toBe(true);
  expect(await management.readGroupAddNotice(42)).toBe("审核邀请");
  expect(await management.readGroupVerificationSettings(42)).toMatchObject({ enabled: true, time: 60, min: 8, max: 20, success: "override" });
  expect(await readGroupRecallPermissions(root)).toEqual({ bot: "owner", member: "owner" });
  const notices = await createPrivateNoticeReader({ config: new URL("config/group-notice.yaml", root) })();
  expect(configuredPrivateNotice(notices, 9, "groupMessage", 42)).toBe(true);
  expect(configuredPrivateNotice(notices, 9, "groupMessage", 43)).toBe(false);
  expect(configuredPrivateNotice(notices, 9, "friendRequest")).toBe(true);
  expect(privateNoticeSetting(notices, 9, "notificationsAll")).toBe(false);
  expect(privateNoticeSetting(notices, 9, "msgSaveDeltime")).toBe(420);
  expect(configuredNoticeSchedule(root, "")).toBeUndefined();
  expect(Bun.YAML.parse(await readFile(new URL("config/notice.yaml", root), "utf8"))).toEqual({ enableSchedule: false, scheduleTime: "09:02-09:17" });
  expect(await readFile(new URL("config/group.yaml", root), "utf8")).not.toContain("opaque");
}));

test("current full-scope settings win, while ambiguous schedule aliases and linked config files are rejected", () => fixture(async (source, state) => {
  await file(source, `${yenai}notice.yaml`, "default: { friendRequest: true }\n");
  await file(source, "config/group-notice.yaml", "default: { groupRecall: false }\n");
  await file(source, "plugins/Notice-plugin/config/config_default.yaml", "enableSchedule: true\nscheduleTime: '7:00-7:30'\n");
  await file(source, "plugins/notice-plugin/config/config.yaml", "enableSchedule: true\nscheduleTime: '8:00-8:30'\n");
  await expect(stageLegacyGroupConfig(source, state)).rejects.toThrow("两处旧公告定时窗口不一致");
  await expect(readFile(join(state, "config/group-notice.yaml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await file(source, "config/notice.yaml", "enableSchedule: true\nscheduleTime: '9:15-9:35'\n");
  const late = join(source, "config/auto-group-card.yaml");
  await symlink(join(source, "config/group-notice.yaml"), late);
  await expect(stageLegacyGroupConfig(source, state)).rejects.toThrow("快照内的普通文件");
  await rm(late);
  await file(source, `${yenai}notice.yaml`, "obsolete: [bad YAML\n");
  const report = await stageLegacyGroupConfig(source, state);
  expect(report.active).toEqual(["config/group-notice.yaml", "config/notice.yaml"]);
  expect(await readFile(join(state, "config/group-notice.yaml"), "utf8")).not.toContain("friendRequest");
  expect(await readFile(join(state, archive, `${yenai}notice.yaml`), "utf8")).toBe("obsolete: [bad YAML\n");
  expect(configuredNoticeSchedule(pathToFileURL(state + sep), "")).toEqual({ start: 555, end: 575 });
}));
