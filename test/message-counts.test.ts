import { expect, test } from "bun:test";
import { createMessageCounts } from "../lib/message-counts.ts";

type Redis = NonNullable<ReturnType<Parameters<typeof createMessageCounts>[0]>>;
type Increment = [key: string, value: number];
type ScanPage = { cursor: number; keys: string[] };

function valkey() {
  const store = new Map<string, string>();
  const writes: Increment[][] = [];
  const reads: string[][] = [];
  const scans: [cursor: number, match: string][] = [];
  const pages = new Map<string, ScanPage[]>();
  const mock = {
    isReady: true,
    multi() {
      const batch: Increment[] = [];
      return {
        incrBy(key: string, value: number) { batch.push([key, value]); },
        async exec() {
          writes.push(batch);
          for (const [key, value] of batch) store.set(key, String(Number(store.get(key) ?? 0) + value));
        },
      };
    },
    async mGet(keys: string[]) {
      reads.push(keys);
      return keys.map((key) => store.get(key) ?? null);
    },
    async scan(cursor: number, options: { MATCH: string }) {
      scans.push([cursor, options.MATCH]);
      return pages.get(options.MATCH)?.shift() ?? { cursor: 0, keys: [] };
    },
  };
  return { mock, client: () => mock as unknown as Redis, store, writes, reads, scans, pages };
}

const date = () => new Date(2026, 0, 3, 0, 1);

test("按本地年月日和身份用一个事务写入 TRSS 旧键，缺失身份只略过相应维度", async () => {
  const { client, writes, reads, store } = valkey();
  const counts = createMessageCounts(client, false, date);
  expect(counts.available()).toBe(true);
  await counts.record("receive", { self_id: 99, user_id: 42, group_id: 77 }, "纯文本");
  expect(writes).toHaveLength(1);
  const expected: Increment[] = [];
  for (const scope of ["total", "bot:99", "user:42", "group:77"]) {
    for (const bucket of ["2026:01:03", "2026:01", "2026", "total"]) {
      expected.push([`Yz:count:receive:msg:${scope}:${bucket}`, 1]);
    }
  }
  expect(writes[0]).toEqual(expected);
  await counts.record("send", { user_id: 42, self_id: -99, group_id: 0 }, [{ type: "text", data: { text: "回复" } }]);
  expect(writes[1]).toHaveLength(8);
  expect(await counts.read("msg", "user:42", "2026:01:03")).toEqual({ receive: "1", send: "1" });
  expect(reads).toEqual([[
    "Yz:count:receive:msg:user:42:2026:01:03", "Yz:count:send:msg:user:42:2026:01:03",
  ]]);
  expect(await counts.read("msg", "group:77", "total")).toEqual({ receive: "1", send: "0" });
  expect(store.has("Yz:count:receive:text:total:total")).toBe(false);
});

test("允许统计扁平段、OneBot 数组、纯文本和合并转发 node，msg 始终只加一次", async () => {
  const { client, store, writes } = valkey();
  const counts = createMessageCounts(client, true, date);
  await counts.record("receive", {}, [
    { type: "image", file: "opaque" }, { type: "image", data: { file: "opaque" } },
    { type: "at", qq: 42 }, "文字", { type: "msg" }, { type: "invalid:kind" },
  ]);
  await counts.record("send", {}, "纯文字");
  await counts.record("send", {}, [{ type: "node", data: { content: [{ type: "text", data: { text: "嵌套" } }] } }]);
  expect(writes).toHaveLength(3);
  expect(store.get("Yz:count:receive:image:total:total")).toBe("2");
  expect(store.get("Yz:count:receive:at:total:total")).toBe("1");
  expect(store.get("Yz:count:receive:text:total:total")).toBe("1");
  expect(store.get("Yz:count:receive:msg:total:total")).toBe("1");
  expect(store.get("Yz:count:send:msg:total:total")).toBe("2");
  expect(store.get("Yz:count:send:text:total:total")).toBe("1");
  expect(store.get("Yz:count:send:node:total:total")).toBe("1");
  expect([...store.keys()].some((key) => key.includes("invalid:kind"))).toBe(false);
});

test("人数和群数分方向扫描并跨页去重，只接受精确匹配的数字身份键", async () => {
  const { client, pages, scans, reads } = valkey();
  const receive = "Yz:count:receive:msg:user:";
  const send = "Yz:count:send:msg:user:";
  pages.set(`${receive}*:2026:01`, [
    { cursor: 10, keys: [`${receive}12:2026:01`, `${receive}2:extra:2026:01`] },
    { cursor: 22, keys: [] },
    { cursor: 0, keys: [`${receive}12:2026:01`, `${receive}13:2026:01`, `${receive}999:total`] },
  ]);
  pages.set(`${send}*:2026:01`, [{ cursor: 0, keys: [`${send}12:2026:01`, `${send}12:2026:01`] }]);
  pages.set("Yz:count:send:node:group:*:total", [{ cursor: 0, keys: ["Yz:count:send:node:group:77:total"] }]);
  const counts = createMessageCounts(client, true, date);
  expect(await counts.read("msg", "user:*", "2026:01")).toEqual({ receive: "2", send: "1" });
  expect(scans.filter(([, match]) => match === `${receive}*:2026:01`).map(([cursor]) => cursor)).toEqual([0, 10, 22]);
  expect(await counts.read("node", "group:*", "total")).toEqual({ receive: "0", send: "1" });
  expect(reads).toEqual([]);
});

test("未连接时安静跳过写入，查询不可用时提供统一错误且不泄露底层细节", async () => {
  let redis: Redis | undefined;
  const counts = createMessageCounts(() => redis, true, date);
  expect(counts.available()).toBe(false);
  await counts.record("receive", { user_id: 1 }, "无连接");
  await expect(counts.read("msg", "total", "total")).rejects.toThrow("消息统计服务暂不可用。");

  const { client, mock, writes, store } = valkey();
  redis = client();
  mock.isReady = false;
  await counts.record("send", {}, "连接重试");
  expect(writes).toEqual([]);
  expect(counts.available()).toBe(false);
  mock.isReady = true;
  store.set("Yz:count:receive:msg:total:total", "不是合法计数");
  expect(await counts.read("msg", "total", "total")).toEqual({ receive: "0", send: "0" });
  await expect(counts.read("*", "total", "total")).rejects.toThrow("查询条件无效");
  await expect(counts.read("msg", "bot:*", "total")).rejects.toThrow("查询条件无效");
  await expect(counts.read("msg", "total", "2026:*" )).rejects.toThrow("查询条件无效");
  mock.mGet = async () => { throw new Error("Valkey 内部地址与查询键"); };
  await expect(counts.read("msg", "total", "total")).rejects.toThrow("消息统计服务暂不可用。");
});
