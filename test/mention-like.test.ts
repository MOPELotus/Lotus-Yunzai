import { expect, test } from "bun:test";
import { bindMentionLike, mentionedProfileId } from "../lib/adapters/mention-like.ts";

test("定向点赞只从解码后的单个有效非机器人 @ 绑定目标", () => {
  const at = (qq: number | string) => ({ type: "at", qq });
  expect(mentionedProfileId([at(99), at("42")], 99, 51)).toBe(42);
  expect(mentionedProfileId([at(99)], 99, 51)).toBeUndefined();
  expect(mentionedProfileId([at(51)], 99, 51)).toBeUndefined();
  expect(mentionedProfileId([at("all"), at(42)], 99, 51)).toBeUndefined();
  expect(mentionedProfileId([at(42), at(43)], 99, 51)).toBeUndefined();
  expect(mentionedProfileId([at(42), at("42")], 99, 51)).toBeUndefined();
  expect(mentionedProfileId([{ type: "text", text: "[CQ:at,qq=42]" }], 99, 51)).toBeUndefined();
  expect(mentionedProfileId([at("9007199254740992")], 99, 51)).toBeUndefined();
});

test("点赞写入前复核成员资格，并在会话失效后停在发送前", async () => {
  const session = new AbortController();
  const member = Promise.withResolvers<boolean>();
  let writes = 0;
  const target = bindMentionLike(42, session.signal, () => member.promise, async () => true, async count => {
    writes++;
    return count;
  });
  expect(await target.like(11)).toBe(0);
  const running = target.like(5);
  session.abort();
  member.resolve(true);
  expect(await running).toBe(0);
  expect(await target.isFriend()).toBe(false);
  expect(writes).toBe(0);
});
