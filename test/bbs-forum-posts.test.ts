import { expect, test } from "bun:test";
import { readBbsForumPosts, type BbsCheckinForum } from "@lotus-yunzai/hoyo-client";

const id = "9007199254740993";

function row(postId: unknown = id, game = 8, forum = 57) {
  return {
    post: { post_id: postId, game_id: game, f_forum_id: forum, content: "正文不进入返回结果" },
    forum: { id: forum, game_id: game },
    self_operation: null,
  };
}

function page(list: unknown[]) {
  return Response.json({ retcode: 0, data: { list, is_last: false, last_id: "忽略后续游标" } });
}

test("使用固定的游戏到版块映射，仅匿名读取官方目录单页", async () => {
  const mapping = { "1": 1, "2": 26, "3": 30, "4": 37, "5": 34, "6": 52, "8": 57, "9": 948, "10": 950 } as const;
  let calls = 0;
  for (const game of Object.keys(mapping) as (keyof typeof mapping)[]) {
    const forum = mapping[game];
    const posts = await readBbsForumPosts(game, async (endpoint, request) => {
      calls++;
      expect(endpoint.origin).toBe("https://bbs-api.miyoushe.com");
      expect(endpoint.pathname).toBe("/painter/wapi/getRecentForumPostList");
      expect(Object.fromEntries(endpoint.searchParams)).toEqual({
        forum_id: String(forum), is_good: "false", page_size: "20", sort_type: "1",
      });
      expect(request).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
      expect(request.body).toBeUndefined();
      expect(Object.fromEntries(new Headers(request.headers))).toEqual({ accept: "application/json" });
      return page([row(id, Number(game), forum), row(id, Number(game), forum), row("9007199254740992", Number(game), forum)]);
    });
    expect(posts).toEqual([
      { postId: id, gameId: Number(game), forumId: forum },
      { postId: "9007199254740992", gameId: Number(game), forumId: forum },
    ]);
  }
  expect(calls).toBe(9);
});

test("有效空页返回空数组，非法分区及越界、串区、坏 ID 拒绝", async () => {
  await expect(readBbsForumPosts("8", async () => page([]))).resolves.toEqual([]);
  for (const invalid of ["", "7", "08", "toString", "57", 8]) {
    await expect(readBbsForumPosts(invalid as BbsCheckinForum, async () => { throw new Error("请求不可达"); }))
      .rejects.toMatchObject({ code: "invalid-input" });
  }
  for (const invalid of [
    [row(), { ...row(), forum: { id: 57, game_id: 2 } }],
    [row(), { ...row(), forum: { id: 26, game_id: 8 } }],
    [row(), { ...row(), post: { ...row().post, f_forum_id: 26 } }],
    [row(), { ...row(), post: { ...row().post, game_id: 2 } }],
    [row(), null], [row(2)], [row("0002")], [row("javascript:fixture")], [row("9".repeat(21))],
    Array.from({ length: 21 }, () => row()),
  ]) {
    await expect(readBbsForumPosts("8", async () => page(invalid))).rejects.toMatchObject({ code: "response" });
  }
});

test("HTTP 拒绝、上游错误、验证、错路由与错误数据不会冒充空目录", async () => {
  const secret = "fixture-upstream-message";
  for (const [respond, error] of [
    [() => new Response(secret, { status: 403 }), { code: "http", status: 403 }],
    [() => new Response(secret, { status: 429 }), { code: "http", status: 429 }],
    [() => new Response(secret, { headers: { "x-rpc-aigis": secret } }), { code: "http" }],
    [() => Response.redirect("https://invalid.example", 302), { code: "http", status: 302 }],
    [() => Object.defineProperty(page([]), "url", { value: "https://bbs-api.miyoushe.com/another-route" }), { code: "http" }],
    [() => Response.json({ retcode: -100, message: secret }), { code: "api", retcode: -100 }],
    [() => Response.json({ retcode: 0, data: {} }), { code: "response" }],
    [() => Response.json({ retcode: "0", data: { list: [] } }), { code: "response" }],
    [() => new Response("x".repeat(1024 * 1024 + 1)), { code: "response" }],
    [() => { throw new Error(secret); }, { code: "transport" }],
  ] as const) {
    let calls = 0;
    const pending = readBbsForumPosts("8", async () => { calls++; return respond(); });
    await expect(pending).rejects.toMatchObject(error);
    await expect(pending).rejects.not.toThrow(secret);
    expect(calls).toBe(1);
  }
});

test("支持发送前取消，并释放取消时仍在等待的响应流", async () => {
  const pre = new AbortController();
  pre.abort(new Error("fixture pre-aborted"));
  await expect(readBbsForumPosts("8", async () => { throw new Error("请求不可达"); }, { signal: pre.signal }))
    .rejects.toBe(pre.signal.reason);

  const controller = new AbortController();
  const pulling = Promise.withResolvers<void>();
  let cancelled = false;
  const pending = readBbsForumPosts("8", async (_endpoint, request) => {
    expect(request.signal).toBeDefined();
    return new Response(new ReadableStream({
      pull() { pulling.resolve(); },
      cancel() { cancelled = true; },
    }));
  }, { signal: controller.signal });
  await pulling.promise;
  controller.abort(new Error("fixture stream cancelled"));
  await expect(pending).rejects.toBe(controller.signal.reason);
  expect(cancelled).toBe(true);
});
