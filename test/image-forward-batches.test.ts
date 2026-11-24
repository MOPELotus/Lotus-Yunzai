import { expect, test } from "bun:test";
import { sendCommandReply } from "../lib/commands.ts";
import type { BatchedImageForward } from "@lotus-yunzai/skia/forward-images";

const batches: BatchedImageForward = {
  type: "forward-image-batches",
  batches: ["第 1 段", "第 2 段", "第 3 段"].map((title, index) => [title, { type: "image", file: new Uint8Array([index]) }]),
};

test("图鉴按协议逐批确认，明确失败或结果未知时停止且不单发剩余图", async () => {
  for (const outcome of ["sent", "rejected", "unknown", "unavailable"] as const) {
    const attempts: string[] = [];
    const replies: unknown[] = [];
    await sendCommandReply({
      forward: outcome === "unavailable" ? undefined : async nodes => {
        attempts.push(String(nodes[0]));
        if (attempts.length !== 2 || outcome === "sent") return true;
        if (outcome === "rejected") return false;
        throw new Error("delivery not confirmed");
      },
      reply: async reply => { replies.push(reply); return true; },
    }, batches);
    if (outcome === "sent") {
      expect(attempts).toEqual(["第 1 段", "第 2 段", "第 3 段"]);
      expect(replies).toEqual([]);
    } else if (outcome === "unavailable") {
      expect(attempts).toEqual([]);
      expect(replies).toEqual(["当前会话无法分段合并转发图片。"]);
    } else {
      expect(attempts).toEqual(["第 1 段", "第 2 段"]);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain(outcome === "rejected" ? "未发送" : "未确认");
    }
  }
});

test("每批发送前重新核对档案，并区分权限变化和传输回执未知", async () => {
  let current = true;
  const attempts: string[] = [];
  const replies: unknown[] = [];
  await sendCommandReply({
    forward: async nodes => {
      attempts.push(String(nodes[0]));
      current = false;
      return true;
    },
    reply: async value => { replies.push(value); return true; },
  }, {
    ...batches,
    async beforeSend() {
      if (!current) throw new Error("profile changed");
    },
  });
  expect(attempts).toEqual(["第 1 段"]);
  expect(replies).toEqual(["会话或档案已变更，余下图片已停止发送。"]);
});

test("生成下一批图片前等待上一批回执，回执失败后关闭生成器", async () => {
  const trace: string[] = [];
  const firstAck = Promise.withResolvers<boolean>();
  const firstSent = Promise.withResolvers<void>();
  const dispatch = sendCommandReply({
    async forward(nodes) {
      const title = String(nodes[0]);
      trace.push(`发送 ${title}`);
      if (title !== "1") return false;
      firstSent.resolve();
      return firstAck.promise;
    },
    async reply() { return true; },
  }, {
    type: "forward-image-batches",
    batches: (async function* () {
      try {
        for (const title of ["1", "2", "3"]) {
          trace.push(`生成 ${title}`);
          yield [title];
        }
      } finally {
        trace.push("收尾");
      }
    })(),
  });
  await firstSent.promise;
  expect(trace).toEqual(["生成 1", "发送 1"]);
  firstAck.resolve(true);
  await dispatch;
  expect(trace).toEqual(["生成 1", "发送 1", "生成 2", "发送 2", "收尾"]);
});
