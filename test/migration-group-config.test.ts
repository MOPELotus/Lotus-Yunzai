import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readGroupDispatch } from "../lib/group-dispatch.ts";
import { stageLegacyGroupConfig } from "../lib/migration-group-config.ts";
import { stageLegacyKeywords } from "../lib/migration-keywords.ts";
import { stageLegacyState } from "../lib/migration-state.ts";
import { legacyAutoGroupCardScript } from "../lib/plugins/metadata.ts";
import { readGroupRecallPermissions } from "../lib/quoted-recall.ts";
import { createAutoGroupCard } from "../plugins/group/auto-group-card.ts";
import { readGroupLeaveBlacklist } from "../plugins/group/group-leave-blacklist.ts";
import { readLikeSettings } from "../plugins/group/like-settings.ts";
import { createManagedBlacklist } from "../plugins/group/managed-blacklist.ts";
import { configuredPrivateNotice, createPrivateNoticeReader, privateNoticeSetting } from "../plugins/group/private-notice-config.ts";
import { createGroupScreenedWords } from "../plugins/group/screened-words.ts";
import { configuredNoticeLogLevel, configuredNoticeSchedule } from "../plugins/notice/schedule.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

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
  expect(report.deferred).toEqual(["notice.pushSettings"]);
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
  expect(configuredNoticeLogLevel(root, "")).toBe("debug");
  expect(Bun.YAML.parse(await readFile(new URL("config/notice.yaml", root), "utf8"))).toEqual({ enableSchedule: false, scheduleTime: "09:02-09:17", logger: "debug" });
  expect(await readFile(new URL("config/group.yaml", root), "utf8")).not.toContain("opaque");
}));

test("迁移固定旧自动群名片的无文件默认值，并保留显式关闭", () => fixture(async (source, state) => {
  const config = "config/auto-group-card.yaml";
  const retired = { ...legacyAutoGroupCardScript, status: "archive", kind: "script", reason: "归档旧自动群名片" } as const;
  const differentScript = { ...retired, path: "plugins/自动群名片.js" };
  const report = await stageLegacyGroupConfig(source, state, undefined, [differentScript, {
    ...retired, identity: "irrelevant",
  }]);
  expect(report.active).toEqual([]);
  expect(await Bun.file(join(state, config)).exists()).toBe(false);

  const restored = await stageLegacyGroupConfig(source, state, undefined, [retired]);
  expect(restored).toEqual({ active: [config], archived: [], deferred: [] });
  expect(Bun.YAML.parse(await readFile(join(state, config), "utf8"))).toEqual({ enable: true });
  const signal = new AbortController().signal;
  const current = createAutoGroupCard({ root: pathToFileURL(state + sep), signal, accounts: () => [] });
  expect(await current.configuration()).toEqual({ cron: "0 0,30 * * * *" });

  const explicitLegacyConfig = "config/config/auto-group-card.yaml";
  await file(source, explicitLegacyConfig, "enable: false\n");
  const disabled = join(dirname(state), "disabled");
  await mkdir(disabled, { mode: 0o700 });
  const disabledResult = await stageLegacyGroupConfig(source, disabled, undefined, [retired]);
  expect(disabledResult.archived).toEqual([archive + explicitLegacyConfig]);
  expect(Bun.YAML.parse(await readFile(join(disabled, config), "utf8"))).toEqual({ enable: false });
  const explicitlyDisabled = createAutoGroupCard({ root: pathToFileURL(disabled + sep), signal, accounts: () => [] });
  expect(await explicitlyDisabled.configuration()).toBeUndefined();
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

test("旧屏蔽规则停用时仍迁移，暂存后的群管无需加载旧插件", () => fixture(async (source, state) => {
  const old = "plugins/flower-plugin/";
  const original = "- 跨群旧词\n- 100\n";
  await file(source, old + "defSet/wordListener.yaml", "enable: false\ntime: 60\nreplyText: 默认回执\n");
  await file(source, old + "config/wordListener.yaml", "enable: true\ntime: 82\nreplyText: 当前回执\n");
  await file(source, "config/group-screened-words.yaml", "enable: false\n");
  await file(source, old + "resources/blackword/global/2024-01.yaml", original);
  await file(source, old + "resources/blackword/global/2024-02.yaml", "- 跨群旧词\n- 最近新增\n");
  await file(source, old + "resources/blackword/77/2024-01.yaml", "- 仅限群七七\n");
  await file(source, old + "resources/blackword/78/2024-01.yaml", "- 已从群八移除\n");
  await file(source, "data/group/screened-words/78.yaml", "[]\n");
  const { active, archived } = await stageLegacyGroupConfig(source, state);
  expect([...active].sort()).toEqual(["config/group-screened-words.yaml", "data/group/screened-words/77.yaml",
    "data/group/screened-words/78.yaml", "data/group/screened-words/global.yaml"]);
  expect(archived).toContain(archive + old + "resources/blackword/global/2024-01.yaml");
  expect(await readFile(join(state, archive + old + "resources/blackword/global/2024-01.yaml"), "utf8")).toBe(original);
  expect(await readFile(join(source, old + "resources/blackword/global/2024-01.yaml"), "utf8")).toBe(original);
  expect(Bun.YAML.parse(await readFile(join(state, "config/group-screened-words.yaml"), "utf8"))).toEqual({ enable: false, time: 82, replyText: "当前回执" });
  expect(Bun.YAML.parse(await readFile(join(state, "data/group/screened-words/78.yaml"), "utf8"))).toEqual([]);
  expect(await Bun.file(join(state, old + "config/wordListener.yaml")).exists()).toBe(false);
  const signal = new AbortController().signal;
  const words = createGroupScreenedWords(pathToFileURL(state + sep), async () => ({ close() {} }), signal);
  expect(await words.match(77, "最近新增", signal)).toBeUndefined();
  await words.command({ message_type: "private", self_id: 99, user_id: 42, isBotMaster: user => user === 42,
    privateCredentialSignal: signal, message_id: 1, normalizedMessage: "#抽卡设置屏蔽词开启" });
  expect(await words.match(79, "当前含跨群旧词", signal)).toMatchObject({ seconds: 82, screenedReply: "当前回执" });
  expect(await words.match(77, "仅限群七七", signal)).toBeDefined();
  expect(await words.match(78, "仅限群七七 已从群八移除", signal)).toBeUndefined();
}));

test("旧安装的顶层群配置迁移后，实际 OneBot 词条保留主人限制和触发者提及", () => fixture(async (source, state) => {
  const path = "config/group.yaml";
  const original = "# 旧安装顶层群路由\n" +
    "default: { groupCD: 0, singleCD: 0, addLimit: 0, addAt: false, addReply: false, addRecall: 0 }\n" +
    "'99:77': { addLimit: 2, addAt: true }\n";
  await file(source, path, original);
  await file(source, "config/config/group.yaml", "default: { addLimit: 0, addAt: false }\n");
  const keywordPath = "data/messageJson/77.json";
  const keywords = JSON.stringify({ 旧词: [[{ type: "text", text: "原词条" }]] });
  await file(source, keywordPath, keywords);
  const { directory } = await stageLegacyState(source, state);
  const { active } = await stageLegacyGroupConfig(source, directory);
  expect(active).toEqual([path]);
  await stageLegacyKeywords(source, directory);

  await withDualGatewayFixture("migration-legacy-keyword-routing", "", async ({ onebot, sendOneBot, root }) => {
    const group = { message_type: "group", sub_type: "normal", group_id: 77, sender: { user_id: 42, role: "member" } };
    sendOneBot("旧词", group);
    const trigger = await onebot.next("send_msg");
    expect(trigger.params.group_id).toBe(77);
    trigger.respond({ message_id: 101 });
    sendOneBot("#添加新词", group);
    const edit = await onebot.next("send_msg");
    expect(edit.params.group_id).toBe(77);
    edit.respond({ message_id: 102 });
    const message = trigger.params.message;
    expect({
      text: JSON.stringify(message).includes("原词条"),
      mentioned: Array.isArray(message) && message.some(part => part.type === "at" && part.data?.qq === "42"),
      limited: String(edit.params.message).includes("只有主人才能操作"),
    }).toEqual({ text: true, mentioned: true, limited: true });
    expect(await readFile(join(root, keywordPath), "utf8")).toBe(keywords);
  }, 2_500, undefined, async root => {
    for (const path of ["config", "data"]) await cp(join(directory, path), join(root, path), { recursive: true });
    await file(root, "config/bot.yaml", "cache_group_member: false\nupdate_time: 0\nfile_watch: false\n");
  });
  expect(await readFile(join(directory, archive, path), "utf8")).toBe(original);
  expect(await readFile(join(source, path), "utf8")).toBe(original);
}));
