import { expect, test } from "bun:test";
import { loadGroupRankQqAvatars } from "../lib/group-rank-qq-avatars.ts";

test("QQ头像按账号去重及失败回退角色头像", async () => {
  const calls: string[] = [];
  const image = Buffer.from([1, 2, 3]);
  const signal = new AbortController().signal;
  const result = await loadGroupRankQqAvatars([42, "42", 43, undefined, "", "invalid", -1], signal,
    async (qq, options) => { calls.push(qq); expect(options?.signal).toBe(signal); if (qq === "43") throw new Error("offline"); return image; });
  expect(calls.sort()).toEqual(["42", "43"]);
  expect(result.get("42")).toBe(image);
  expect(result.has("43")).toBe(false);
  expect(result.size).toBe(1);
});
