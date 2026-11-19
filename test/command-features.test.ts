import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CommandRegistry, sendCommandReply } from "../lib/commands.ts";
import { readGroupDispatch } from "../lib/group-dispatch.ts";
import type { MessageEvent } from "../lib/messages.ts";

const legacyLabel = "[Lotus-Plugin] Gacha Log";
const gachaLabel = "[gacha] 抽卡记录";
const group: MessageEvent = {
  msg: "*战绩", raw_message: "*战绩", message: "*战绩", post_type: "message", message_type: "group",
  isGroup: true, isPrivate: false, isMaster: false, self_id: 99, user_id: 42, group_id: 77, reply: () => true,
};

test("引用回复沿用原消息并将撤回选项交给当前协议", async () => {
  const sent: unknown[][] = [];
  const event = { reply: (...args: Parameters<MessageEvent["reply"]>) => { sent.push(args); return true; } };
  await sendCommandReply(event, { type: "quoted", message: "保留" });
  await sendCommandReply(event, { type: "quoted", message: "稍后撤回", options: { recallMsg: 20 } });
  expect(sent).toEqual([["保留", true], ["稍后撤回", true, { recallMsg: 20 }]]);
});

test("旧抽卡记录功能标签仅影响真正带该标签的入口", async () => {
  const registry = new CommandRegistry();
  const seen: string[] = [];
  registry.registerModule({
    name: "@lotus-yunzai/starrail", commands: {},
    fallbackFeatures: ({ normalizedMessage }) => normalizedMessage === "#星铁抽卡记录" ? [gachaLabel] : [],
    fallback(_message, { normalizedMessage }) { seen.push(normalizedMessage); return normalizedMessage; },
  });
  const disabled = (names: readonly string[]) => !names.includes(gachaLabel);
  const enabled = (names: readonly string[]) => names.includes(gachaLabel);
  const dispatch = (allowed: typeof disabled, command: string) => registry.dispatchFallback(group, allowed, () => false, command);
  expect(await dispatch(disabled, "#星铁战绩")).toBe("#星铁战绩");
  expect(await dispatch(disabled, "#星铁抽卡记录")).toBeUndefined();
  expect(await dispatch(enabled, "#星铁战绩")).toBeUndefined();
  expect(await dispatch(enabled, "#星铁抽卡记录")).toBe("#星铁抽卡记录");
  expect(seen).toEqual(["#星铁战绩", "#星铁抽卡记录"]);
});

test("旧配置选择器匹配当前模块名称，禁用优先且保持其他功能可用", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-feature-names-"));
  try {
    await mkdir(join(root, "config"));
    await writeFile(join(root, "config", "group.yaml"), Bun.YAML.stringify({
      "77": { disable: [legacyLabel, "[Lotus-Plugin] Profile Settings"] },
      "78": { enable: ["[Lotus-Plugin] Checkin Admin", "[Lotus-Plugin] Music"] },
      "79": { enable: [gachaLabel], disable: [legacyLabel] },
    }));
    const { allows } = await readGroupDispatch(pathToFileURL(`${root}/`));
    expect(allows(group, [gachaLabel])).toBe(false);
    expect(allows(group, ["@lotus-yunzai/cloud-profile"])).toBe(false);
    expect(allows(group, ["@lotus-yunzai/checkin-group-registration"])).toBe(false);
    expect(allows(group, ["@lotus-yunzai/starrail"])).toBe(true);
    expect(allows({ ...group, group_id: 78 }, ["@lotus-yunzai/checkin-roster"])).toBe(true);
    expect(allows({ ...group, group_id: 78 }, ["[media] 点歌"])).toBe(true);
    expect(allows({ ...group, group_id: 78 }, ["[media] B 站解析"])).toBe(false);
    expect(allows({ ...group, group_id: 79 }, [gachaLabel])).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
