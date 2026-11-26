import { expect, test } from "bun:test";
import { isUncertainDeliveryNotice } from "../lib/quiet-delivery-notices.ts";
import { sendCommandReply } from "../lib/commands.ts";

test("发送结果未知时不提醒且不重发，确认成功与明确失败照常处理", async () => {
  const sent: unknown[] = [];
  const event = { reply: async (value: unknown) => { sent.push(value); return true; } };
  for (const value of ["合并转发结果未确认，请在聊天中核对。", "语音送达未确认，请在会话中核对。", "音乐登录二维码送达未确认，请重试。"]) {
    expect(isUncertainDeliveryNotice(value)).toBe(true);
    await sendCommandReply(event, value);
  }
  expect(sent).toEqual([]);
  for (const value of ["发送失败", "发送成功", "回执未确认时不会重发", "账号未确认，请重新登录。"])
    expect(isUncertainDeliveryNotice(value)).toBe(false);
});
