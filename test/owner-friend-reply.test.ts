import { expect, test } from "bun:test";
import { bindOwnerFriendReply } from "../lib/adapters/owner-friend-reply.ts";

test("好友身份读取期间停机或撤销主人权限后不继续发送", async () => {
  const lookup = Promise.withResolvers<boolean>();
  const scope = new AbortController();
  let owner = true;
  let reads = 0;
  let writes = 0;
  const reply = bindOwnerFriendReply({ account: 99, signal: scope.signal, isOwner: () => owner,
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
