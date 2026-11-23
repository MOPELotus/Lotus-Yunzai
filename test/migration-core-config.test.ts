import { expect, test } from "bun:test";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readAutoQuit } from "../lib/auto-quit.ts";
import { readLocalConfig } from "../lib/config.ts";
import { readFriendRequests } from "../lib/friend-requests.ts";
import { readGroupDispatch } from "../lib/group-dispatch.ts";
import { readGroupInvitations } from "../lib/group-invitations.ts";
import { stageLegacyCoreConfig } from "../lib/migration-core-config.ts";
import { readMasterPermissions } from "../lib/permissions.ts";
import type { FriendRequest, GroupNotice, GroupRequest, MessageEvent } from "../lib/messages.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const url = (root: string) => pathToFileURL(root + sep);
const previous = (root: string, name: string) => join(root, "config", "config", name + ".yaml");

async function write(root: string, name: string, data: string) {
  await mkdir(join(root, "config", "config"), { recursive: true });
  await writeFile(previous(root, name), data);
}

async function fixture(run: (source: string, stage: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-migration-core-"));
  const source = join(directory, "old");
  const stage = join(directory, "stage");
  try {
    await Promise.all([mkdir(source), mkdir(stage)]);
    await run(source, stage);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const notifyMasters = async () => 0;
const reply = () => true;
const friend = (userId: number, approve: FriendRequest["approve"]): FriendRequest => ({
  post_type: "request", request_type: "friend", sub_type: "add", isGroup: false, isPrivate: true,
  self_id: 99, user_id: userId, flag: String(userId), isMaster: false, approve, notifyMasters, reply,
});
const invite = (userId: number, isMaster: boolean, approve: GroupRequest["approve"]): GroupRequest => ({
  post_type: "request", request_type: "group", sub_type: "invite", isGroup: true, isPrivate: false,
  self_id: 99, user_id: userId, group_id: 77, flag: String(userId), isMaster, approve, notifyMasters, reply,
});
const joined = (inspectAutoQuit: GroupNotice["inspectAutoQuit"], leaveGroup: GroupNotice["leaveGroup"]): GroupNotice => ({
  post_type: "notice", notice_type: "group", sub_type: "increase", isGroup: true, isPrivate: false,
  self_id: 99, user_id: 99, group_id: 77, time: 1, isMaster: false, inspectAutoQuit, leaveGroup, reply,
});
const message = (body: string): MessageEvent => ({
  post_type: "message", message_type: "private", sub_type: "friend", self_id: 99, user_id: 42,
  msg: body, raw_message: body, message: body, atBot: false, isGroup: false, isPrivate: true, isMaster: false, reply,
});

test("只为存在旧配置的副本恢复 TRSS 默认主人、黑名单、请求策略和调度", () => fixture(async (source, stage) => {
  let approvals = 0;
  const approve = async () => { approvals++; return true; };
  expect(await stageLegacyCoreConfig(source, stage)).toEqual({ files: 0, deferredOwners: { master: 0, masterQQ: 0 } });
  expect((await readMasterPermissions(url(stage))).terminal).toBe(false);
  expect(await (await readFriendRequests(url(stage), 0))(friend(42, approve))).toBeUndefined();
  expect(await (await readGroupInvitations(url(stage))).review(invite(42, true, approve))).toBe("skip");
  expect(await (await readAutoQuit(url(stage), () => []))(joined(async () => ({ memberIds: [99], botRole: "member" }), approve))).toBe(false);
  expect((await readGroupDispatch(url(stage))).prepare(message("/版本")).event.msg).toBe("/版本");
  expect(await readLocalConfig(url(stage), "bot", { update_time: 1440 })).toEqual({});

  await write(source, "other", "{}\n");
  await write(source, "bot", "# 裁剪旧配置\n");
  expect(await stageLegacyCoreConfig(source, stage)).toEqual({ files: 2, deferredOwners: { master: 0, masterQQ: 0 } });
  expect((await readMasterPermissions(url(stage))).terminal).toBe(true);
  const dispatch = await readGroupDispatch(url(stage));
  expect(dispatch.allowsInbound({ user_id: 528_952_540 })).toBe(false);
  expect(dispatch.allowsInbound({ user_id: 42, group_id: 213_938_015 })).toBe(false);
  expect(dispatch.prepare(message("/版本")).event.msg).toBe("#版本");
  expect(await readLocalConfig(url(stage), "bot", { update_time: 1440 })).toEqual({ update_time: 1440 });

  const approveFriend = await readFriendRequests(url(stage), 0);
  expect(await approveFriend(friend(42, approve))).toBe("confirmed");
  expect(await approveFriend(friend(528_952_540, approve))).toBeUndefined();
  const { review } = await readGroupInvitations(url(stage));
  expect(await review(invite(44, false, approve))).toBe("skip");
  expect(await review(invite(42, true, approve))).toBe("confirmed");
  const quit = await readAutoQuit(url(stage), () => []);
  expect(await quit(joined(async threshold => {
    expect(threshold).toBe(50);
    return { memberIds: [99, ...Array.from({ length: 49 }, (_, i) => i + 100)], botRole: "member" };
  }, approve))).toBe(true);
  expect(approvals).toBe(3);
}));

test("只筛选可迁字段，保留明确禁用、旧邀请字符串语义和原会话主人豁免", () => fixture(async (source, stage) => {
  const bot = '"/→#": false\nupdate_time: 0\nrestart_time: 17\nupdate_cron: "22 4 * * *"\nrestart_cron: "3 5 * * *"\nstop_cron: "0 1 * * *"\nstart_cron: ["0 2 * * *", "0 3 * * *"]\nfile_watch: false\nproxyAddress: "https://proxy-secret.invalid"\npuppeteer_ws: "wss://browser-secret.invalid"\n';
  const other = 'master: ["99:42", "100:43"]\nmasterQQ: [42]\ndisablePrivate: true\ndisableMsg: 原私聊暂不开放\ndisableAdopt: [联调放行]\nwhiteUser: [42, 51]\nblackUser: [55]\nwhiteGroup: [77]\nblackGroup: [78]\nautoFriend: 0\nautoGroup: "1"\nautoQuit: 0\nextraAuth: {token: fixture-secret}\n';
  await write(source, "other", other);
  await write(source, "bot", bot);
  await write(source, "server", "websocket: fixture-secret\n");
  expect(await stageLegacyCoreConfig(source, stage)).toEqual({ files: 2, deferredOwners: { master: 0, masterQQ: 0 } });
  expect((await lstat(previous(stage, "other"))).mode & 0o777).toBe(0o600);
  const oldYaml = await readFile(previous(stage, "other"), "utf8");
  const oldBot = await readFile(previous(stage, "bot"), "utf8");
  expect(oldYaml).not.toContain("secret");
  expect(oldBot).not.toContain("secret");
  expect(await Bun.file(previous(stage, "server")).exists()).toBe(false);
  expect(await readLocalConfig(url(stage), "bot", { update_time: 1440 })).toEqual({
    "/→#": false, update_time: 0, restart_time: 17, update_cron: "22 4 * * *", restart_cron: "3 5 * * *",
    stop_cron: "0 1 * * *", start_cron: ["0 2 * * *", "0 3 * * *"], file_watch: false,
  });
  const dispatch = await readGroupDispatch(url(stage));
  expect(dispatch.prepare(message("/版本")).event.msg).toBe("/版本");
  expect(dispatch.allowsInbound({ user_id: 42, group_id: 77 })).toBe(true);
  expect(dispatch.allowsInbound({ user_id: 55, group_id: 77 })).toBe(false);
  expect(dispatch.allowsInbound({ user_id: 42, group_id: 78 })).toBe(false);
  const forbid = async () => { throw new Error("no protocol operation"); };
  expect(await (await readFriendRequests(url(stage), 0))(friend(42, forbid))).toBeUndefined();
  expect(await (await readAutoQuit(url(stage), () => []))(joined(forbid, forbid))).toBe(false);
  const { review } = await readGroupInvitations(url(stage));
  expect(await review(invite(51, false, forbid))).toBe("skip");
  expect(await review(invite(42, true, async () => true))).toBe("confirmed");

  // Only the test checkout's scheduler fields are disabled so the roundtrip cannot fire.
  const config = '"/→#": true\nupdate_time: 0\nfile_watch: false\ncache_group_member: false\nonline_msg_exp: 0\n';
  await withDualGatewayFixture("migration-core-private", "", async ({ onebot, sendOneBot }) => {
    const check = async (name: string, uid: number, wanted: string) => {
      sendOneBot(name, { user_id: uid });
      const frame = await onebot.next("send_msg");
      expect(frame.params.user_id).toBe(uid);
      expect(String(frame.params.message)).toContain(wanted);
      frame.respond({ message_id: 234 });
    };
    await check("/版本", 51, "原私聊暂不开放");
    await check("/版本", 42, "Lotus-Yunzai 版本");
  }, 2_500, undefined, async (root) => {
    await rm(join(root, "config", "other.yaml"));
    await cp(previous(stage, "other"), previous(root, "other"));
    await write(root, "bot", config);
  });
  expect(await readFile(previous(source, "other"), "utf8")).toBe(other);
  expect(await readFile(previous(source, "bot"), "utf8")).toBe(bot);
}));

test("迁入旧核心配置时沿用默认文件，用户配置按顶层键覆盖", () => fixture(async (source, stage) => {
  const directory = join(source, "config", "default_config");
  await mkdir(directory, { recursive: true });
  const defaults = '"/→#": false\nupdate_time: 133\nlog_object: {depth: 4, sorted: true}\nsecret: fixture-ignored\n';
  await writeFile(join(directory, "bot.yaml"), defaults);
  await writeFile(join(directory, "other.yaml"), 'master: ["99:42"]\nautoFriend: 0\nblackGroup: [81]\n');
  await write(source, "bot", "log_object: {length: 51}\n");

  expect(await stageLegacyCoreConfig(source, stage)).toEqual({ files: 2, deferredOwners: { master: 0, masterQQ: 0 } });
  expect(await readLocalConfig(url(stage), "bot", { update_time: 1440 })).toEqual({
    "/→#": false, update_time: 133, log_object: { length: 51 },
  });
  const dispatch = await readGroupDispatch(url(stage));
  expect(dispatch.prepare(message("/版本")).event.msg).toBe("/版本");
  expect(dispatch.allowsInbound({ user_id: 42, group_id: 81 })).toBe(false);
  expect(dispatch.allowsInbound({ user_id: 42, group_id: 82 })).toBe(true);
  const requests = await readFriendRequests(url(stage), 0);
  expect(await requests(friend(54, async () => { throw new Error("关闭自动加好友时不调用网关"); }))).toBeUndefined();
  expect(await readFile(join(directory, "bot.yaml"), "utf8")).toBe(defaults);
  expect(await Bun.file(previous(source, "other")).exists()).toBe(false);
}));

test("只激活明确的数字和终端主人，旧适配器绑定原样留在私有备份", () => fixture(async (source, stage) => {
  const provider = ["legacy-bot:legacy-user", "legacy-bot:99:51", "99:legacy-user", " 99:51 "];
  const globalProvider = ["legacy-user", "legacy-user:51"];
  const original = Bun.YAML.stringify({
    master: ["stdin:stdin", "99:42", ...provider, "100:43"],
    masterQQ: [42, ...globalProvider, "stdin"],
  });
  await write(source, "other", original);
  expect(await stageLegacyCoreConfig(source, stage)).toEqual({
    files: 1, deferredOwners: { master: provider.length, masterQQ: globalProvider.length },
  });
  const active = await readLocalConfig(url(stage), "other");
  expect(active.master).toEqual(["stdin:stdin", "99:42", "100:43"]);
  expect(active.masterQQ).toEqual([42, "stdin"]);
  const access = await readMasterPermissions(url(stage));
  expect(access.terminal).toBe(true);
  expect(access.isMaster(99, 42)).toBe(true);
  expect(access.isMaster(100, 43)).toBe(true);
  expect(access.isMaster(99, 51)).toBe(false);
  expect(access.isMaster(100, 42)).toBe(false);
  expect(access.legacyMasterIds()).toEqual([42]);

  const directory = join(stage, "backup/core-config");
  const archive = join(directory, "other-provider-owners.yaml");
  expect((await lstat(directory)).mode & 0o777).toBe(0o700);
  expect((await lstat(archive)).mode & 0o777).toBe(0o600);
  expect(Bun.YAML.parse(await readFile(archive, "utf8"))).toEqual({ master: provider, masterQQ: globalProvider });
  expect(await readFile(previous(source, "other"), "utf8")).toBe(original);
}));

test("暂存拒绝软链和现有文件，只回收本次已写出的文件", () => fixture(async (source, stage) => {
  await write(source, "other", "master: []\n");
  await write(source, "bot", "update_time: 0\n");
  await write(stage, "bot", "# 目标原值\n");
  await expect(stageLegacyCoreConfig(source, stage)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await Bun.file(previous(stage, "other")).exists()).toBe(false);
  expect(await readFile(previous(stage, "bot"), "utf8")).toBe("# 目标原值\n");
  await rm(previous(source, "other"));
  await symlink(previous(stage, "bot"), previous(source, "other"));
  await expect(stageLegacyCoreConfig(source, stage)).rejects.toThrow("无硬链接的普通文件");
  expect(await readFile(previous(stage, "bot"), "utf8")).toBe("# 目标原值\n");
}));
