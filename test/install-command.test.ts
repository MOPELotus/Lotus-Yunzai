import { expect, test } from "bun:test";
import { createInstallCommand, hasValidInstallTarget, isInstallCommand, parseInstallName } from "../lib/install-command.ts";
import type { MessageEvent, MessageReply } from "../lib/messages.ts";

type Callbacks = Parameters<typeof createInstallCommand>[0];

function fixture(options: Partial<Callbacks> = {}) {
  const listed: MessageEvent["message_type"][] = [];
  const installed: { shortName: string; type: MessageEvent["message_type"] }[] = [];
  const replies: MessageReply[] = [];
  const handle = createInstallCommand({
    list(event) {
      listed.push(event.message_type);
      return options.list?.(event) ?? ["TRSS-Plugin", "yenai-plugin"];
    },
    install(event, shortName, report) {
      installed.push({ shortName, type: event.message_type });
      return options.install?.(event, shortName, report) ?? true;
    },
  });
  return {
    listed, installed, replies,
    dispatch(msg: string, extra: Partial<MessageEvent> = {}) {
      return handle({
        msg, message: msg, raw_message: msg, post_type: "message", message_type: "private",
        isGroup: false, isPrivate: true, isMaster: true, boundAccount: true, self_id: 99, user_id: 42,
        reply: (message) => { replies.push(message); return true; },
        ...extra,
      });
    },
  };
}

test("安装入口兼容紧连短名、两个后缀和授权终端，保留短名大小写", async () => {
  const { dispatch, installed, replies } = fixture();
  const terminal = { message_type: "terminal", boundAccount: undefined } as const;
  expect(isInstallCommand(" #安装TRSS-Plugin ")).toBe(true);
  expect(isInstallCommand("请发送 #安装TRSS-Plugin")).toBe(false);
  expect(isInstallCommand("#更新TRSS-Plugin")).toBe(false);
  await dispatch("#安装TRSS");
  await dispatch("#安装TRSS-Plugin");
  await dispatch("#安装 TRSS-plugin ", terminal);
  await dispatch("#安装Atlas", terminal);
  await dispatch("#更新TRSS-Plugin");
  expect(installed).toEqual([
    { shortName: "TRSS", type: "private" }, { shortName: "TRSS", type: "private" },
    { shortName: "TRSS", type: "terminal" }, { shortName: "Atlas", type: "terminal" },
  ]);
  expect(replies).toEqual([]);
});

test("安装列表兼容旧后缀，保留受信名录顺序且始终使用纯文本", async () => {
  const { dispatch, installed, listed, replies } = fixture({
    async list() { return ["Atlas", "TRSS-Plugin", "Atlas", "https://example.invalid/plugin", "隐\n入", "插件"]; },
  });
  await dispatch("#安装插件");
  await dispatch("#安装插件-Plugin");
  await dispatch("#安装插件-plugin", { message_type: "terminal", boundAccount: undefined });
  expect(listed).toEqual(["private", "private", "terminal"]);
  expect(installed).toEqual([]);
  expect(replies).toEqual(Array(3).fill("可安装插件列表：\nAtlas\nTRSS-Plugin\n发送 #安装+插件名 进行安装"));
  const empty = fixture({ list: () => [] });
  await empty.dispatch("#安装插件");
  expect(empty.replies).toEqual(["暂无可安装插件"]);
});

test("安装名单和执行均检查主人权限，不接受 URL、路径、Shell 字符或控制字符", async () => {
  const { dispatch, installed, listed, replies } = fixture();
  await dispatch("#安装Atlas", { isMaster: false, sender: { role: "owner" } });
  await dispatch("#安装插件", { boundAccount: false });
  await dispatch("#安装Atlas", { boundAccount: undefined });
  await dispatch("#安装插件", { message_type: "terminal", isMaster: false, boundAccount: undefined });
  const invalid = ["", "https://example.invalid/p", "git@example.invalid:p", "file:plugin", "../target", "x/y",
    "x\\y", "--force", "x;rm", "x && y", "x..y", "x\n", "x\t", "x\x00", "-Plugin", "a".repeat(65)];
  for (const bad of invalid) {
    expect(parseInstallName(bad)).toBeUndefined();
    await dispatch(`#安装${bad}`);
  }
  expect(installed).toEqual([]);
  expect(listed).toEqual([]);
  expect(replies.slice(0, 4)).toEqual(Array(4).fill("暂无权限，只有主人才能操作"));
  expect(replies.slice(4)).toEqual(Array(invalid.length).fill("请发送 #安装插件 查看可安装插件，再用 #安装插件名 进行安装。"));
});

test("Milky 安装和目录查询只接受具备专用权限的有效会话", async () => {
  const target = { adapter: "milky", isMaster: false, boundAccount: false, canManageProcess: true } as const;
  const { dispatch, installed, listed, replies } = fixture();
  await dispatch("#安装插件", target);
  await dispatch("#安装Atlas", { ...target, message_type: "group", group_id: 30 });
  for (const event of [
    { ...target, canManageProcess: undefined, isMaster: true, boundAccount: true },
    { ...target, self_id: -2 }, { ...target, user_id: undefined },
    { ...target, message_type: "group" as const, group_id: 0.5 },
  ]) {
    await dispatch("#安装插件", event);
    await dispatch("#安装Atlas", event);
  }
  expect(listed).toEqual(["private"]);
  expect(installed).toEqual([{ shortName: "Atlas", type: "group" }]);
  expect(replies.slice(1)).toEqual(Array(8).fill("暂无权限，只有主人才能操作"));
  for (const text of [" #安装插件", "#安装 Atlas", "#安装TRSS-Plugin"]) expect(hasValidInstallTarget(text)).toBe(true);
  for (const text of ["#安装", "#安装 x/y", "#安装 ./Atlas", "#安装 Atlas\n", "#更新Atlas"]) {
    expect(hasValidInstallTarget(text)).toBe(false);
  }
});

test("按顺序回复安装状态，清楚处理关闭管理入口、列表及请求失败", async () => {
  const progress = fixture({ install(_event, _name, report) {
    report("checking");
    report("building");
    report("busy");
    report("exists");
    return true;
  } });
  await progress.dispatch("#安装Atlas");
  expect(progress.replies).toEqual(["开始安装，正在检查插件目录。", "正在准备插件和依赖。", "正在安装，请稍候再试", "该插件已安装。"]);

  const disabled = fixture({ install: () => false });
  await disabled.dispatch("#安装Atlas");
  expect(disabled.replies).toEqual(["当前未启用受管安装。请在宿主目录运行 bun run start 后重试。"]);
  const failure = fixture({
    list() { throw new Error("fixture token"); },
    async install() { throw new Error("fixture URL"); },
  });
  await failure.dispatch("#安装插件");
  await failure.dispatch("#安装Atlas");
  expect(failure.replies).toEqual(["读取可安装插件列表失败，请稍后重试。", "发送安装请求失败，请稍后重试。"]);
});
