import { expect, test } from "bun:test";
import { postArkQuery } from "../lib/rank-statistics.ts";

const signal = () => new AbortController().signal;
const reset = () => Object.assign(new Error("fixture connection reset"), { code: "ECONNRESET" });

test("Ark明确查询POST共用三次预算并保留同一路由、请求体和信号", async () => {
  let calls = 0;
  const bodies: unknown[] = [];
  const active = signal();
  const result = await postArkQuery("rank/data", { uid: "100000001", id: 10000002, update: 0 }, active, async (url, init) => {
    expect(url).toBe("https://ark.ivny.cn/rank/data");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
    expect(init.signal?.aborted).toBe(false);
    bodies.push(JSON.parse(String(init.body)));
    if (++calls === 1) throw reset();
    if (calls === 2) return new Response("busy", { status: 503 });
    return Response.json({ retcode: 100, data: { rank: 3 } });
  });
  expect(result).toEqual({ payload: { retcode: 100, data: { rank: 3 } } });
  expect(calls).toBe(3);
  expect(bodies).toEqual(Array.from({ length: 3 }, () => ({ uid: "100000001", id: 10000002, update: 0, version: "2.1.0" })));
});

test("所有已明确rank查询仅重试暂时错误，业务retcode和auth使用记录不重放", async () => {
  for (const route of ["rank/specific", "rank/self", "rank/custom", "rank/custom/specific", "rank/stygian"] as const) {
    let calls = 0;
    const result = await postArkQuery(route, {}, signal(), async () => ++calls === 1
      ? new Response("busy", { status: 503 }) : Response.json({ retcode: 104 }));
    expect(result).toEqual({ payload: { retcode: 104 } });
    expect(calls).toBe(2);
  }
  for (const [route, query] of [["auth/usage", {}], ["rank/data", { update: 1 }]] as const) {
    let calls = 0;
    await postArkQuery(route, query, signal(), async () => { calls++; throw reset(); });
    expect(calls).toBe(1);
  }
  let calls = 0;
  await postArkQuery("rank/specific", {}, signal(), async () => { calls++; return new Response("limited", { status: 429 }); });
  expect(calls).toBe(1);
});

test("Ark查询取消会终止预算，不从头重做workflow", async () => {
  const controller = new AbortController();
  let calls = 0;
  await postArkQuery("rank/specific", {}, controller.signal, async () => { calls++; controller.abort(); throw reset(); });
  expect(calls).toBe(1);
});
