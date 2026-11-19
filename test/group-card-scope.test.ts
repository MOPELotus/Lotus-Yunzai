import { expect, test } from "bun:test";
import { bindGroupCard } from "../lib/adapters/group-card.ts";
import type { GroupMembership } from "../lib/messages.ts";

test("群名片写入仅允许原群与原始消息中的唯一成员", async () => {
  const writes: unknown[] = [];
  let botRole: GroupMembership["botRole"] | undefined = "member";
  const setCard = bindGroupCard({
    botId: 99, groupId: 56, message: [{ type: "at", qq: "99" }, { type: "at", qq: "42" }],
    active: () => true,
    memberRole: async (group, user) => group === 56 ? (user === 99 ? botRole : "member") : undefined,
    async write(...args) { writes.push(args); return "unknown"; },
  });
  expect(await setCard("新名片", 57, 42)).toBe("rejected");
  expect(await setCard("新名片", undefined, 43)).toBe("rejected");
  expect(await setCard("新名片")).toBe("rejected");
  expect(await setCard("新名片", undefined, 42)).toBe("insufficient-role");
  expect(writes).toEqual([]);
  botRole = "admin";
  expect(await setCard("新名片", undefined, 42)).toBe("unknown");
  expect(writes).toEqual([[56, 42, "新名片"]]);
});

test("私聊只可改本机器人群名片，查询期间失去会话时不写入", async () => {
  const writes: unknown[] = [];
  let active = true;
  const setCard = bindGroupCard({
    botId: 99, message: [], active: () => active,
    async memberRole(group, user) {
      if (group === 57) active = false;
      if (user === 99 && (group === 56 || group === 57)) return "member";
    },
    async write(...args) { writes.push(args); return "confirmed"; },
  });
  expect(await setCard("", 56, 42)).toBe("rejected");
  expect(await setCard("", 58)).toBe("missing-group");
  expect(await setCard("", 56)).toBe("confirmed");
  expect(await setCard("不应写入", 57)).toBe("rejected");
  expect(writes).toEqual([[56, 99, ""]]);
});
