import { expect, test } from "bun:test";
import { sendCommandReply } from "../lib/commands.ts";

test("合并转发只在全部批次收到确切回执后通知调用者", async () => {
  for (const outcome of ["confirmed", "rejected", "unknown"] as const) {
    const events: string[] = [];
    await sendCommandReply({
      async forward(nodes) {
        events.push("forward:" + nodes.join(""));
        if (nodes[0] === "甲") return true;
        if (outcome === "unknown") throw Error("回执丢失");
        return outcome === "confirmed";
      },
      async reply() {
        events.push("fallback");
        return true;
      },
    }, {
      type: "forward", nodes: ["甲", "乙"], batchSize: 1,
      onDelivered() { events.push("delivered"); },
    });
    expect(events).toEqual(["forward:甲", "forward:乙", ...(outcome === "unknown" ? [] : [outcome === "confirmed" ? "delivered" : "fallback"])]);
  }
});
