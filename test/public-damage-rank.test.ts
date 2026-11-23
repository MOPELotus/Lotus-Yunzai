import { expect, test } from "bun:test";
import { fetchPublicDamageRank, matchPublicDamageRank, queryPublicDamageRank } from "../lib/rank-statistics.ts";

const signal = new AbortController().signal;
const uid = "100000000";
const gs = async (name: string) => name === "雷电将军" ? { id: 10000052, name } : undefined;
const sr = async (name: string) => name === "希儿" ? { id: 1102, name } : undefined;

test("显式 UID 位次识别历史紧连写法、独立的星铁前缀及分隔角色编号", () => {
  expect(matchPublicDamageRank(`#角色排名雷电将军${uid}`, "gs")?.query).toEqual({ uid, name: "雷电将军" });
  expect(matchPublicDamageRank(`#原神角色排名 10000052 ${uid}`, "gs")?.query).toEqual({ uid, name: "10000052" });
  expect(matchPublicDamageRank(`*角色排名希儿${uid}`, "sr")?.query).toEqual({ uid, name: "希儿" });
  expect(matchPublicDamageRank(`#星铁角色排名 希儿 ${uid}`, "sr")?.query).toEqual({ uid, name: "希儿" });
  expect(matchPublicDamageRank(`#角色排名荧${uid}`, "gs")?.query).toEqual({ uid, name: "荧" });
  expect(matchPublicDamageRank("#角色排名雷电将军", "gs")?.query).toBeUndefined();
  expect(matchPublicDamageRank("#角色排名雷电将军123", "gs")?.query).toBeUndefined();
  expect(matchPublicDamageRank("#星铁角色排名希儿100000000", "gs")).toBeUndefined();
  expect(matchPublicDamageRank("#绝区零角色排名希儿100000000", "sr")).toBeUndefined();
  expect(matchPublicDamageRank("#雷电将军排名统计", "gs")).toBeUndefined();
  expect(matchPublicDamageRank("#群内雷电将军排名", "gs")).toBeUndefined();
});

test("查询只向固定位次端点发送显式 UID 和角色，原调用的更新字段固定关闭", async () => {
  const ids: number[] = [];
  const transport = async (url: string, request: RequestInit) => {
    expect(url).toBe("https://ark.ivny.cn/rank/data");
    expect(request).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
    expect(new Headers(request.headers).get("authorization")).toBeNull();
    expect(new Headers(request.headers).get("cookie")).toBeNull();
    const body = JSON.parse(String(request.body));
    expect(body).toEqual({ id: body.id, uid, update: 0, version: "2.1.0" });
    ids.push(body.id);
    return Response.json({ retcode: 100, rank: 12, score: 34.56 });
  };
  expect(await queryPublicDamageRank(`#角色排名雷电将军${uid}`, "gs", gs, signal, transport))
    .toContain("雷电将军全服伤害排名为 12，伤害评分 34.56");
  expect(await queryPublicDamageRank(`#星铁角色排名希儿${uid}`, "sr", sr, signal, transport))
    .toContain("希儿全服伤害排名为 12，伤害评分 34.56");
  expect(await queryPublicDamageRank(`#角色排名希儿${uid}`, "gs", gs, signal, transport)).toBeUndefined();
  expect(await queryPublicDamageRank(`#原神角色排名希儿${uid}`, "gs", gs, signal, transport)).toContain("找不到");
  expect(await queryPublicDamageRank("#角色排名雷电将军", "gs", gs, signal, transport)).toContain("用法");
  expect(await queryPublicDamageRank(`#角色排名雷电将军${uid}`, "gs", gs, AbortSignal.abort(), transport)).toBeUndefined();
  expect(ids).toEqual([10000052, 1102]);
});

test("位次无样本、限流或回包损坏分别回复，保留合法零伤害", async () => {
  expect(await fetchPublicDamageRank(uid, 1102, signal, async () => Response.json({ retcode: 102 })))
    .toEqual({ message: "此 UID 的该角色暂无全服伤害排名。" });
  expect(await fetchPublicDamageRank(uid, 1102, signal, async () => new Response("", { status: 429 })))
    .toEqual({ message: "排名查询过于频繁，请稍后重试。" });
  expect(await fetchPublicDamageRank(uid, 1102, signal, async () => Response.json({ retcode: 100, rank: 0, score: 0 })))
    .toEqual({ message: "排名服务返回的全服位次不完整。" });
  expect(await fetchPublicDamageRank(uid, 1102, signal, async () => Response.json({ retcode: 100, rank: "12", score: "0" })))
    .toEqual({ rank: 12, score: 0 });
});

test("两游戏正式回退入口应用各自群功能限制", async () => {
  const { CommandRegistry } = await import("../lib/commands.ts");
  const { normalizeGameCommand } = await import("../lib/command-prefix.ts");
  const { lockFile } = await import("../lib/file-lock.ts");
  const { createModule: createGenshin } = await import("../plugins/genshin/index.ts");
  const { createModule: createStarRail } = await import("../plugins/starrail/index.ts");
  const original = globalThis.fetch;
  const calls: number[] = [];
  globalThis.fetch = Object.assign(async (resource: RequestInfo | URL, init?: RequestInit) => {
    expect(String(resource)).toBe("https://ark.ivny.cn/rank/data");
    const { id } = JSON.parse(String(init?.body));
    calls.push(id);
    return Response.json({ retcode: 100, rank: 12, score: 34.56 });
  }, { preconnect: original.preconnect });
  const lifecycle = new AbortController();
  try {
    const registry = new CommandRegistry();
    registry.registerModule({ ...createGenshin({ lockFile, signal: lifecycle.signal }), name: "@lotus-yunzai/genshin" });
    registry.registerModule({ ...createStarRail({ lockFile, signal: lifecycle.signal }), name: "@lotus-yunzai/starrail" });
    async function dispatch(command: string, disabled?: string) {
      const event = normalizeGameCommand({
        msg: command, raw_message: command, message: command, post_type: "message", message_type: "group",
        isGroup: true, isPrivate: false, isMaster: false, self_id: 42, user_id: 123, group_id: 3, reply: () => true,
      });
      return registry.dispatchFallback(event, features => !disabled || !features.includes(disabled), () => false);
    }
    expect(await dispatch(`#角色排名雷电将军${uid}`)).toContain("雷电将军全服伤害排名");
    expect(await dispatch(`*角色排名希儿${uid}`)).toContain("希儿全服伤害排名");
    expect(await dispatch(`#角色排名希儿${uid}`)).toContain("希儿全服伤害排名");
    expect(await dispatch(`#角色排名雷电将军${uid}`, "[genshin] 角色面板")).toBeUndefined();
    expect(await dispatch(`*角色排名希儿${uid}`, "[starrail] 角色面板")).toBeUndefined();
    expect(calls).toEqual([10000052, 1102, 1102]);
  } finally {
    lifecycle.abort();
    globalThis.fetch = original;
  }
});
