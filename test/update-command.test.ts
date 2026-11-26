import { linkHostPackages } from "./host-fixture.ts";
import { expect, test } from "bun:test";
import { cp, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ManagedUpdateProgress } from "../lib/managed-update-protocol.ts";
import type { MessageEvent, MessageReply } from "../lib/messages.ts";
import { createUpdateCommand, hasValidUpdateTarget, isUpdateCommand } from "../lib/update-command.ts";
import { matchGenshinTalentRefresh } from "../plugins/genshin/panel/talent-refresh.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

type Request = Parameters<typeof createUpdateCommand>[0];
type Report = Parameters<Request>[3];

function fixture(request: Request = () => true) {
  const calls: { target?: string; quiet: boolean; type: string; all: boolean; force: boolean }[] = [];
  const replies: MessageReply[] = [];
  const handler = createUpdateCommand((event, target, quiet, report, all, force) => {
    calls.push({ target, quiet, type: event.message_type, all, force });
    return request(event, target, quiet, report, all, force);
  });
  return {
    calls, replies,
    dispatch(msg: string, event: Partial<MessageEvent> = {}) {
      return handler({
        msg, message: msg, raw_message: msg, post_type: "message", message_type: "private",
        isGroup: false, isPrivate: true, isMaster: true, boundAccount: true, self_id: 99, user_id: 42,
        reply: (reply) => { replies.push(reply); return true; },
        ...event,
      });
    },
  };
}

test("单项更新兼容紧连目标、中文目录及包名，并保留日志指令的边界", async () => {
  const { dispatch, calls, replies } = fixture();
  for (const text of ["#更新日志", "#更新日志system", "#静更新日志", "#安静更新日志system", "#强制更新日志", " #更新图鉴 ",
    "#更新抽卡记录", " #更新抽卡记录2 ", "#更新面板", "#更新面板2", "#更新全部面板 500000001",
    "#更新充值记录", " #更新充值统计 ", "#更新消费记录", "#更新消费统计",
    "#强制静更新", "#静全部强制更新", "请发 #更新"]) {
    expect(isUpdateCommand(text)).toBe(false);
    await dispatch(text);
  }

  expect(isUpdateCommand(" #更新图鉴插件 ")).toBe(true);
  expect(hasValidUpdateTarget(" #更新图鉴 ")).toBe(false);
  expect(hasValidUpdateTarget("#更新 图鉴")).toBe(true);
  expect(hasValidUpdateTarget("#更新 面板")).toBe(true);
  expect(hasValidUpdateTarget("#更新 抽卡记录")).toBe(true);
  expect(hasValidUpdateTarget("#更新 充值记录")).toBe(true);
  expect(isUpdateCommand("#静更新")).toBe(true);
  expect(isUpdateCommand("#安静更新 @lotus-yunzai/system")).toBe(true);
  await dispatch("#更新");
  await dispatch("#更新图鉴插件-2.0");
  await dispatch("#静更新system");
  await dispatch("#安静更新 @lotus-yunzai/system", { message_type: "terminal", boundAccount: undefined });
  expect(calls).toEqual([
    { target: undefined, quiet: false, type: "private", all: false, force: false },
    { target: "图鉴插件-2.0", quiet: false, type: "private", all: false, force: false },
    { target: "system", quiet: true, type: "private", all: false, force: false },
    { target: "@lotus-yunzai/system", quiet: true, type: "terminal", all: false, force: false },
  ]);
  expect(replies).toEqual([]);
});

test("配队业务更新和已停用的旧指令都不会触发仓库更新", async () => {
  const { dispatch, calls } = fixture();
  for (const text of [" #更新配队资源 ", "#强制更新配队资源", "#更新配队资源 参数", "#强制更新配队资源 参数",
    "#更新摩拉资源", "#强制更新摩拉资源", "#更新摩拉资源 参数"]) {
    expect(isUpdateCommand(text)).toBe(false);
    expect(hasValidUpdateTarget(text)).toBe(false);
    await dispatch(text);
  }
  expect(calls).toEqual([]);
  for (const text of ["#更新 配队资源", "#强制更新 配队资源", "#更新其他资源"]) {
    expect(isUpdateCommand(text)).toBe(true);
    expect(hasValidUpdateTarget(text)).toBe(true);
    await dispatch(text);
  }
  expect(calls.map(({ target, force }) => ({ target, force }))).toEqual([
    { target: "配队资源", force: false },
    { target: "配队资源", force: true },
    { target: "其他资源", force: false },
  ]);
});

test("旧角色攻略更新指令交给攻略模块，带空格的明确仓库目标仍由宿主更新", async () => {
  const { dispatch, calls } = fixture();
  for (const text of [" #更新钟离攻略 ", "#更新钟离一图流", "#更新心海攻略4", "#更新早柚攻略7",
    "#更新刻晴素材", "#原神更新刻晴材料", "#星铁更新符玄突破",
    "#更新攻略资源", "#强制更新攻略资源", "#更新攻略资源 参数"]) {
    expect(isUpdateCommand(text)).toBe(false);
    expect(hasValidUpdateTarget(text)).toBe(false);
    await dispatch(text);
  }
  expect(calls).toEqual([]);
  expect(hasValidUpdateTarget("#更新 钟离攻略")).toBe(true);
  expect(hasValidUpdateTarget("#更新 心海攻略4")).toBe(true);
  expect(hasValidUpdateTarget("#更新 刻晴素材")).toBe(true);
  await dispatch("#更新 钟离攻略");
  expect(calls.map(({ target }) => target)).toEqual(["钟离攻略"]);
});

test("外部抽卡同步和已停用的旧同步指令都不会触发仓库更新", async () => {
  const { dispatch, calls } = fixture();
  for (const text of ["#同步外部抽卡记录2", "#更新小助手抽卡记录", "#更新提瓦特小助手祈愿历史2 旧参数"]) {
    expect(isUpdateCommand(text)).toBe(false);
    expect(hasValidUpdateTarget(text)).toBe(false);
    await dispatch(text);
  }
  expect(calls).toEqual([]);
});

test("原神天赋更新到达业务匹配器并保留明确的仓库更新目标", async () => {
  const { dispatch, calls, replies } = fixture();
  for (const [message, profileId] of [["#更新所有角色技能", 1], ["#强制更新行迹档案2", 2],
    [" #更新角色天赋 profile 3 ", 3], ["#原神强制更新所有角色技能", 1]] as const) {
    expect(matchGenshinTalentRefresh(message)?.profileId).toBe(profileId);
    expect(isUpdateCommand(message)).toBe(false);
    expect(hasValidUpdateTarget(message)).toBe(false);
    await dispatch(message, { isMaster: false });
  }
  expect(calls).toEqual([]);
  expect(replies).toEqual([]);
  for (const message of ["#更新 所有角色技能", "#强制更新行迹插件"]) {
    expect(matchGenshinTalentRefresh(message)).toBeUndefined();
    expect(hasValidUpdateTarget(message)).toBe(true);
    await dispatch(message);
  }
  expect(calls.map(({ target }) => target)).toEqual(["所有角色技能", "行迹插件"]);
});

test("OneBot 和 Milky 好友能从旧入口进入原神天赋刷新", async () => {
  await withDualGatewayFixture("genshin-talent-update", "disablePrivate: false\n", async ({ onebot, milky, sendOneBot, sendMilky }) => {
    sendOneBot("#更新所有角色技能");
    const onebotReply = await onebot.next("send_msg");
    expect(JSON.stringify(onebotReply.params)).toContain("请先登录档案 1");
    onebotReply.respond({ message_id: 151 });

    expect((await sendMilky("#强制更新行迹档案2")).status).toBe(200);
    const milkyReply = await milky.next("send_private_message");
    expect(JSON.stringify(milkyReply.params)).toContain("请先登录档案 2");
    milkyReply.respond({ message_seq: 152 });
  }, 4_000, undefined, async root => {
    await linkHostPackages(root);
    const source = join(import.meta.dir, "../plugins/genshin");
    const target = join(root, "plugins", "genshin");
    await cp(source, target, { recursive: true, dereference: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
    await symlink(join(source, "node_modules"), join(target, "node_modules"), "dir");
  });
}, 12_000);

test("旧星铁模拟插件更新走有权限的模块托管更新，真实抽卡更新保持原路由", async () => {
  const { dispatch, calls, replies } = fixture();
  for (const text of ["*抽卡更新", "#星铁抽卡插件更新", "#崩坏星穹铁道抽卡插件强制更新"]) {
    expect(isUpdateCommand(text)).toBe(true);
    expect(hasValidUpdateTarget(text)).toBe(true);
    await dispatch(text);
  }
  for (const text of ["#星铁更新抽卡记录", "*抽卡记录", "*抽卡插件更新 加料"]) {
    expect(isUpdateCommand(text)).toBe(false);
    expect(hasValidUpdateTarget(text)).toBe(false);
    await dispatch(text);
  }
  await dispatch("#星铁抽卡插件更新", { isMaster: false });
  expect(calls.map(({ target, force }) => ({ target, force }))).toEqual([
    { target: "starrail", force: false }, { target: "starrail", force: false }, { target: "starrail", force: true },
  ]);
  expect(replies).toEqual(["暂无权限，只有主人才能操作"]);
});

test("全量更新传递 all 标志并拒绝插件后缀", async () => {
  const { dispatch, calls, replies } = fixture();
  for (const command of ["#全部更新", "#全部静更新", " #全部安静更新 "]) {
    expect(isUpdateCommand(command)).toBe(true);
    await dispatch(command);
  }
  for (const command of ["#全部更新system", "#全部静更新 system", "#全部安静更新 @lotus-yunzai/system", "#全部更新日志", "#全部更新\n"]) {
    expect(isUpdateCommand(command)).toBe(true);
    await dispatch(command);
  }
  expect(calls).toEqual([
    { target: undefined, quiet: false, type: "private", all: true, force: false },
    { target: undefined, quiet: true, type: "private", all: true, force: false },
    { target: undefined, quiet: true, type: "private", all: true, force: false },
  ]);
  expect(replies).toEqual(Array(5).fill("请只发送 #全部更新、#全部静更新 或 #全部安静更新。"));
});

test("强制更新兼容静默、单项和全量写法，沿用权限与目标校验", async () => {
  const { dispatch, calls, replies } = fixture((_event, _target, _quiet, report) => { report("checking"); return true; });
  for (const command of ["#强制更新", "#静强制更新system", "#安静强制更新 @lotus-yunzai/system",
    "#全部强制更新", "#全部静强制更新", "#全部安静强制更新"]) {
    expect(isUpdateCommand(command)).toBe(true);
    await dispatch(command);
  }
  await dispatch("#强制更新", { boundAccount: false });
  await dispatch("#全部强制更新", { message_type: "terminal", isMaster: false });
  await dispatch("#强制更新 ../system");
  await dispatch("#全部静强制更新 system");
  expect(calls).toEqual([
    { target: undefined, quiet: false, type: "private", all: false, force: true },
    { target: "system", quiet: true, type: "private", all: false, force: true },
    { target: "@lotus-yunzai/system", quiet: true, type: "private", all: false, force: true },
    { target: undefined, quiet: false, type: "private", all: true, force: true },
    { target: undefined, quiet: true, type: "private", all: true, force: true },
    { target: undefined, quiet: true, type: "private", all: true, force: true },
  ]);
  expect(replies).toEqual([
    "开始强制更新，正在检查。", "开始强制更新，正在检查。",
    "暂无权限，只有主人才能操作", "暂无权限，只有主人才能操作",
    "请输入有效的插件名，例如 #强制更新 system 或 #强制更新 @lotus-yunzai/system。",
    "请只发送 #全部强制更新、#全部静强制更新 或 #全部安静强制更新。",
  ]);
});

test("只允许已绑定机器人的主人或授权终端，拒绝路径和控制字符", async () => {
  const { dispatch, calls, replies } = fixture();
  for (const event of [
    { isMaster: false, sender: { role: "owner", isMaster: true } },
    { boundAccount: false }, { boundAccount: undefined }, { message_type: "terminal", isMaster: false },
  ] satisfies Partial<MessageEvent>[]) await dispatch("#更新system", event);

  const invalid = ["../system", "foo/bar", "@foo/../system", "@foo/", "system\x00", "system\n", "x y", "a".repeat(215)];
  for (const target of invalid) await dispatch(`#更新 ${target}`);
  expect(calls).toEqual([]);
  expect(replies.slice(0, 4)).toEqual(Array(4).fill("暂无权限，只有主人才能操作"));
  expect(replies.slice(4)).toEqual(Array(invalid.length).fill("请输入有效的插件名，例如 #更新 system 或 #更新 @lotus-yunzai/system。"));
  await dispatch("#更新", { message_type: "group", isGroup: true, isPrivate: false });
  expect(calls).toEqual([{ target: undefined, quiet: false, type: "group", all: false, force: false }]);
});

test("Milky 更新只使用专用权限和有效会话，授权校验沿用更新参数语法", async () => {
  const target = { adapter: "milky", isMaster: false, boundAccount: false, canManageProcess: true } as const;
  const { dispatch, calls, replies } = fixture(async (_event, _target, _quiet, report) => {
    await Promise.resolve();
    report("checking");
    return true;
  });
  await dispatch("#更新", target);
  await dispatch("#更新system", { ...target, message_type: "group", group_id: 10 });
  for (const event of [
    { ...target, canManageProcess: false, isMaster: true, boundAccount: true }, { ...target, self_id: 0 },
    { ...target, user_id: Number.MAX_SAFE_INTEGER + 1 }, { ...target, message_type: "group" as const, group_id: undefined },
    { ...target, message_type: "terminal" as const, isMaster: true },
  ]) await dispatch("#更新", event);
  expect(calls.map(({ type }) => type)).toEqual(["private", "group"]);
  expect(replies).toEqual([
    "开始更新，正在检查。", "开始更新，正在检查。",
    ...Array(5).fill("暂无权限，只有主人才能操作"),
  ]);
  for (const text of ["#更新", " #静更新system", "#更新 @lotus-yunzai/system", "#全部强制更新"]) {
    expect(hasValidUpdateTarget(text)).toBe(true);
  }
  for (const text of ["#更新日志", "#全部更新system", "#更新 ../system", "#更新 system\n", "未知命令"]) {
    expect(hasValidUpdateTarget(text)).toBe(false);
  }
});

test("进度消息按收到顺序发送，静默仅省略正常进度和已是最新", async () => {
  const statuses: ManagedUpdateProgress[] = ["checking", "building", "switching", "current", "busy", "dirty",
    "ahead", "diverged", "rejected", "unavailable", "failed"];
  const regular = fixture((_event, _target, _quiet, report) => { statuses.forEach(report); return true; });
  await regular.dispatch("#更新");
  expect(regular.replies).toHaveLength(statuses.length);
  expect(regular.replies.slice(0, 4)).toEqual([
    "开始更新，正在检查。", "正在准备候选版本。", "正在切换到候选版本。", "当前已是最新版本。",
  ]);
  const quiet = fixture((_event, _target, _quiet, report) => { statuses.forEach(report); return true; });
  await quiet.dispatch("#静更新");
  expect(quiet.replies).toEqual(regular.replies.slice(4));

  let reportLater: Report | undefined;
  const delayed = fixture((_event, _target, _quiet, report) => { reportLater = report; return true; });
  const began = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  const replies: MessageReply[] = [];
  await delayed.dispatch("#更新", {
    async reply(message) {
      replies.push(message);
      if (replies.length === 1) {
        began.resolve();
        await release.promise;
        throw new Error("first delivery failed");
      }
      done.resolve();
      return true;
    },
  });
  reportLater!("checking");
  reportLater!("failed");
  await began.promise;
  expect(replies).toEqual(["开始更新，正在检查。"]);
  release.resolve();
  await done.promise;
  expect(replies).toEqual(["开始更新，正在检查。", "更新失败，请检查宿主日志。"]);
});

test("IPC 不可用给出受管启动方式，异常不回显底层内容", async () => {
  const offline = fixture(() => false);
  await offline.dispatch("#静更新");
  expect(offline.replies).toEqual(["当前未启用受管更新。请在宿主目录运行 bun run start 后重试。"]);
  const failed = fixture(() => { throw new Error("private fixture error"); });
  await failed.dispatch("#更新");
  expect(failed.replies).toEqual(["发送更新请求失败，请稍后重试。"]);
});

test("验证逐项非终态进度不提前结束更新以及安静模式无过程输出", async () => {
  const statuses: ManagedUpdateProgress[] = ["checking", "detail:Lotus-Yunzai:checking", "detail:genshin:current",
    "detail:media:updating", "building", "waiting:30", "switching"];
  const normal = fixture((_e, _r, _q, report) => { for (const status of statuses) report(status); return true; });
  await normal.dispatch("#全部更新");
  expect(normal.replies).toEqual(["开始更新，正在检查。", "正在检查 Lotus-Yunzai。", "genshin 已是最新。",
    "正在更新 media。", "正在准备候选版本。", "正在准备候选版本，已耗时 30 秒。", "正在切换到候选版本。"]);
  const quiet = fixture((_e, _r, _q, report) => { for (const status of statuses) report(status); report("current"); return true; });
  await quiet.dispatch("#全部安静更新");
  expect(quiet.replies).toEqual([]);
});
