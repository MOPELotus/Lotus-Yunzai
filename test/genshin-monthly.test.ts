import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createProfileStore } from "../packages/account/index.ts";
import { createHoyoClient } from "../packages/hoyo-client/index.ts";
import { readGenshinMonthly } from "../packages/hoyo-client/genshin-monthly.ts";
import { createGenshinMonthlyQuery, genshinMonthlyPeriod, matchGenshinMonthly } from "../plugins/genshin/monthly-command.ts";

const uid = "500000003";
const region = "cn_qd01";
const cookie = "account_id=8080;cookie_token=before;ltuid=8080;ltoken=before";
const account = (id: number, token = cookie, selected = uid) => Bun.YAML.stringify({
  user: { qq: "42" }, profile: { id }, account: {
    cookie: token, stuid: "8080", stoken: "fixture",
    game_roles: { gs: [{ uid: selected, region, game_biz: "hk4e_cn" }] }, current_uid: { gs: selected },
  }, device: { id: "fixture-device", fp: "fixture-fp" },
});
const raw = { bind_uid: uid, bind_region: region, data_month: 12, month_data: {
  current_primogems: "0", current_mora: 20480, last_primogems: 320, last_mora: 0,
  group_by: [{ action: "活动奖励", action_id: "6", num: 0, percent: 0 }],
} };
const now = () => Date.UTC(2027, 0, 2, 12);

test("原石札记注册独立月查询，保留中文月份并正确跨年", () => {
  expect(matchGenshinMonthly("#原石")).toEqual({ month: undefined, profileId: 1 });
  expect(matchGenshinMonthly("札记十二月 档案3")).toEqual({ month: 12, profileId: 3 });
  expect(matchGenshinMonthly("＃原神原石札记两月")).toEqual({ month: 2, profileId: 1 });
  for (const command of ["#原石统计", "#去年札记统计", "#原石任务", "*星琼", "#星铁原石", "看札记", "#更新充值记录"]) {
    expect(matchGenshinMonthly(command)).toBeUndefined();
  }
  expect(genshinMonthlyPeriod(12, now())).toEqual({ year: 2026, month: 12, finalized: true, title: "12月札记" });
  expect(genshinMonthlyPeriod(11, now())).toEqual({ year: 2026, month: 11, finalized: true, title: "11月札记" });
  expect(genshinMonthlyPeriod(10, now())).toBeUndefined();
  expect(genshinMonthlyPeriod(2, now())).toBeUndefined();
  expect(genshinMonthlyPeriod(undefined, Date.UTC(2026, 11, 31, 16))).toEqual({ year: 2027, month: 1, finalized: false, title: "1月1号札记" });
});

test("本人国服旧请求签名使用选月及角色，拒绝错月和错 UID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-genshin-monthly-request-"));
  try {
    await writeFile(join(directory, "42.yaml"), account(1));
    const source = await createProfileStore(directory).requestContext("42", 1, "gs");
    const result = await readGenshinMonthly(source, async (url, init) => {
      const endpoint = new URL(url);
      expect(endpoint.href).toBe("https://hk4e-api.mihoyo.com/event/ys_ledger/monthInfo?month=12&bind_uid=500000003&bind_region=cn_qd01");
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
      const headers = new Headers(init.headers);
      expect(headers.get("cookie")).toBe(cookie);
      expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
      expect(headers.get("referer")).toBe("https://webstatic.mihoyo.com/");
      const [time, nonce, hash] = headers.get("ds")!.split(",");
      expect(hash).toBe(createHash("md5").update(`salt=xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs&t=${time}&r=${nonce}&b=&q=${endpoint.search.slice(1)}`).digest("hex"));
      return Response.json({ retcode: 0, data: raw });
    }, { month: 12 });
    expect(result.snapshot).toEqual({ month: 12, primogems: 0, mora: 20480, priorPrimogems: 320, priorMora: 0,
      sources: [{ id: 6, name: "活动奖励", count: 0, percent: 0 }] });
    for (const data of [{ ...raw, bind_uid: "500000004" }, { ...raw, data_month: 1 }, { ...raw, bind_region: "cn_gf01" }]) {
      await expect(readGenshinMonthly(source, async () => Response.json({ retcode: 0, data }), { month: 12 }))
        .rejects.toMatchObject({ code: "response" });
    }
    await expect(readGenshinMonthly(source, async () => Response.json({ retcode: 0, data: null }), { month: 12 }))
      .resolves.toEqual({ snapshot: undefined });
    await expect(readGenshinMonthly({ ...source, role: { ...source.role, uid: "800000003", region: "os_asia", gameBiz: "hk4e_global" } },
      async () => { throw Error("should not contact endpoint"); }, { month: 12 })).rejects.toMatchObject({ code: "invalid-input" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("显式档案续期一次，其他档案不写，换档后丢弃正在出图的回执", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-genshin-monthly-query-"));
  try {
    const second = join(directory, "42-2.yaml");
    const first = join(directory, "42.yaml");
    const other = account(1, cookie.replace("before", "other"));
    await writeFile(first, other);
    await writeFile(second, account(2));
    const profiles = createProfileStore(directory);
    const after = "account_id=8080;cookie_token=after;ltuid=8080;ltoken=after";
    const cookies: string[] = [];
    let exchanges = 0;
    let staleDuringRender = false;
    const client = createHoyoClient(async (_url, init) => {
      cookies.push(new Headers(init.headers).get("cookie")!);
      return cookies.length === 1 ? Response.json({ retcode: -100 })
        : Response.json({ retcode: 0, data: raw });
    }, { profiles, async exchange(context) {
      exchanges++;
      expect([context.qq, context.profileId]).toEqual(["42", 2]);
      return { cookie: after, ltoken: "after" };
    } });
    const caller = { user_id: 42, self_id: 99, message_type: "private" };
    const query = createGenshinMonthlyQuery(profiles, client, new AbortController().signal, { now,
      async render() {
        if (staleDuringRender) await writeFile(second, account(2, after, "500000004"));
        throw Error("force text receipt");
      },
    });
    const parsed = matchGenshinMonthly("#札记12月 档案2")!;
    await expect(query(parsed, { ...caller, isDelegated: true })).resolves.toMatch(/本人/);
    await expect(query({ ...parsed, month: 9 }, caller)).resolves.toMatch(/最近三个月/);
    expect(cookies).toEqual([]);
    await expect(query(parsed, caller)).resolves.toMatch(/12月札记.*\n当月获取：原石 0，摩拉 20480/u);
    expect(cookies).toEqual([cookie, after]);
    expect(exchanges).toBe(1);
    expect(await readFile(first, "utf8")).toBe(other);
    staleDuringRender = true;
    await expect(query(parsed, caller)).resolves.toMatch(/档案已变化/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("札记先尝试四倍原图，超限时仅重绘一次两倍图，换档后停止交付", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-genshin-monthly-budget-"));
  try {
    const file = join(directory, "42.yaml");
    await writeFile(file, account(1));
    const profiles = createProfileStore(directory);
    const client = createHoyoClient(async () => Response.json({ retcode: 0, data: raw }), { profiles,
      async exchange() { throw Error("the valid Cookie should not be refreshed"); },
    });
    const engine = { renderer: "GPU", api: "Vulkan", device: "fixture", msaa: [],
      threads: 1, textContrast: 0, textGamma: 1 } as const;
    const full = Buffer.alloc(256, 4);
    const reduced = Buffer.alloc(128, 2);
    const scales: number[] = [];
    let changeDuring: 4 | 2 | undefined;
    const query = createGenshinMonthlyQuery(profiles, client, new AbortController().signal, { now,
      async render(_snapshot, _uid, _title, _signal, { scale = 4 } = {}) {
        scales.push(scale);
        if (changeDuring === scale) await writeFile(file, account(1, cookie, "500000004"));
        return { png: scale === 4 ? full : reduced, engine: { ...engine, msaa: [] } };
      },
    });
    const parsed = matchGenshinMonthly("#札记12月")!;
    const caller = { user_id: 42, self_id: 99, message_type: "private" };
    await expect(query(parsed, { ...caller, inlineImageByteLimit: full.byteLength }))
      .resolves.toEqual({ type: "image", file: full });
    expect(scales.splice(0)).toEqual([4]);
    await expect(query(parsed, { ...caller, inlineImageByteLimit: reduced.byteLength }))
      .resolves.toEqual({ type: "image", file: reduced });
    expect(scales.splice(0)).toEqual([4, 2]);
    await expect(query(parsed, { ...caller, inlineImageByteLimit: reduced.byteLength - 1 })).resolves.toMatch(/当月获取/u);
    expect(scales.splice(0)).toEqual([4, 2]);
    for (const scale of [4, 2] as const) {
      changeDuring = scale;
      await expect(query(parsed, { ...caller, inlineImageByteLimit: reduced.byteLength })).resolves.toMatch(/档案已变化/u);
      expect(scales.splice(0)).toEqual(scale === 4 ? [4] : [4, 2]);
      await writeFile(file, account(1));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
