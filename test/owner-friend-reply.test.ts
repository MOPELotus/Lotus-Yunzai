import { expect, test } from "bun:test";
import { bindOwnerFriendReply } from "../lib/adapters/owner-friend-reply.ts";

test("好友身份读取期间停机或撤销主人权限后不继续发送", async () => {
  const lookup = Promise.withResolvers<boolean>();
  const scope = new AbortController();
  let owner = true;
  let reads = 0;
  let writes = 0;
  const reply = bindOwnerFriendReply({ account: 99, signal: scope.signal, isOwner: () => owner, source: "#回复42 一条文字",
    isFriend: () => { reads++; return lookup.promise; },
    send: async () => { writes++; return "confirmed"; },
  });
  expect(await reply(99, "不要发给自己")).toBe("unavailable");
  const waiting = reply(42, "不再授权");
  owner = false;
  lookup.resolve(true);
  expect(await waiting).toBe("unavailable");
  owner = true;
  scope.abort();
  expect(await reply(42, "已停止")).toBe("unavailable");
  expect(reads).toBe(1);
  expect(writes).toBe(0);
});

test("图文回复在取得消息段后再次核对好友关系", async () => {
  let reads = 0;
  let writes = 0;
  const reply = bindOwnerFriendReply({ account: 99, signal: new AbortController().signal, isOwner: () => true,
    source: [{ type: "text", text: "#回复42" }, { type: "face", id: "14" }],
    isFriend: async () => ++reads === 1,
    send: async () => { writes++; return "confirmed"; },
  });
  expect(await reply(42, [{ sourceIndex: 1 }])).toBe("not-friend");
  expect(reads).toBe(2);
  expect(writes).toBe(0);
});
