import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import type { BbsCheckinForum } from "./bbs-checkin.ts";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readGameRecordPayload } from "./game-record.ts";

const forumIds = {
  "1": 1, "2": 26, "3": 30, "4": 37, "5": 34, "6": 52, "8": 57, "9": 948, "10": 950,
} as const satisfies Record<BbsCheckinForum, number>;
const forumUrl = "https://bbs-api.miyoushe.com/painter/wapi/getRecentForumPostList";
const pageSize = 20;
const maxResponseBytes = 1024 * 1024;
const postIdPattern = /^[1-9]\d{0,19}$/u;

export interface BbsForumPost {
  readonly postId: string;
  readonly forumId: number;
  readonly gameId: number;
}

interface BbsForumPostsOptions {
  readonly signal?: AbortSignal;
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function parsePosts(list: unknown, forumId: number, gameId: number): BbsForumPost[] {
  const invalid = () => new HoyoRequestError("response", $t("bbs-forum-posts.text_d6f2d91ea7"));
  if (!Array.isArray(list) || list.length > pageSize) throw invalid();
  const posts: BbsForumPost[] = [];
  const seen = new Set<string>();
  for (const value of list) {
    const row = object(value);
    const forum = object(row?.forum);
    const post = object(row?.post);
    const postId = post?.post_id;
    if (forum?.id !== forumId || forum.game_id !== gameId ||
        post?.f_forum_id !== forumId || post.game_id !== gameId ||
        typeof postId !== "string" || !postIdPattern.test(postId)) throw invalid();
    if (seen.has(postId)) continue;
    seen.add(postId);
    posts.push({ postId, forumId, gameId });
  }
  return posts;
}

/** Lists the recent public posts of one configured game without account credentials. */
export async function readBbsForumPosts(game: BbsCheckinForum, transport: HoyoTransport,
  { signal }: BbsForumPostsOptions = {},
): Promise<readonly BbsForumPost[]> {
  if (typeof game !== "string" || !Object.hasOwn(forumIds, game)) {
    throw new HoyoRequestError("invalid-input", $t("bbs-forum-posts.text_4c9d96afdf"));
  }
  const forumId = forumIds[game];
  const endpoint = new URL(forumUrl);
  endpoint.search = new URLSearchParams({
    forum_id: String(forumId), is_good: "false", page_size: String(pageSize), sort_type: "1",
  }).toString();
  const expectedUrl = endpoint.href;
  const timeout = AbortSignal.timeout(10_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const unavailable = () => new HoyoRequestError("transport", $t("bbs-forum-posts.text_3b59e5f86f"));
  signal?.throwIfAborted();
  let response: Response;
  try {
    response = await transport(endpoint, {
      method: "GET", headers: { Accept: "application/json" }, credentials: "omit",
      redirect: "error", referrerPolicy: "no-referrer", signal: deadline,
    });
  } catch {
    signal?.throwIfAborted();
    throw unavailable();
  }
  const challenge = response.headers.get("x-rpc-aigis")?.trim();
  if (deadline.aborted || response.redirected || (response.url && response.url !== expectedUrl) ||
      response.status !== 200 || (challenge && challenge !== "{}")) {
    void response.body?.cancel().catch(() => undefined);
    signal?.throwIfAborted();
    if (timeout.aborted) throw unavailable();
    throw new HoyoRequestError("http", $t("bbs-forum-posts.text_a1c6becc82"), response.status);
  }
  const payload = await readGameRecordPayload(response, maxResponseBytes, deadline);
  signal?.throwIfAborted();
  if (timeout.aborted) throw unavailable();
  const retcode = payload?.retcode;
  if (typeof retcode !== "number" || !Number.isSafeInteger(retcode)) {
    throw new HoyoRequestError("response", $t("bbs-forum-posts.text_d6f2d91ea7"));
  }
  if (retcode !== 0) throw new HoyoRequestError("api", $t("bbs-forum-posts.text_efca073e18"), response.status, retcode);
  return parsePosts(object(payload?.data)?.list, forumId, Number(game));
}
