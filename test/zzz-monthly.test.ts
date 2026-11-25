import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore, type ProfileRequestContext } from "@lotus-yunzai/account";
import { createProfileHoyoClient, HoyoRequestError, normalizeZzzMonthly } from "@lotus-yunzai/hoyo-client";
import { lockFile } from "../lib/file-lock.ts";
import { readZzzMonthly } from "../packages/hoyo-client/zzz-monthly.ts";
import { createZzzMonthlyArchive } from "../plugins/zzz/monthly-archive.ts";
import { createZzzMonthlyCommands } from "../plugins/zzz/monthly-command.ts";
import { zzzMonthlyDate, zzzMonthlyTotals } from "../plugins/zzz/monthly-model.ts";

const role = { uid: "12345678", region: "prod_gf_cn" };
const identity = { ...role, qq: "42" };
const source = { qq: identity.qq, profileId: 2, game: "zzz", revision: "fixture-revision",
  account: { cookie: "cookie_token=fixture-cookie" }, device: { id: "fixture-device", fp: "fixture-fp" },
  role: { ...role, gameBiz: "nap_cn" },
} as ProfileRequestContext;
const body = (month: string, value: number, optional_month: readonly (string | number)[] = []) => ({
  ...role, data_month: month, current_month: "202601", optional_month,
  month_data: { list: [{ data_type: "PolychromesData", count: value }, { data_type: "MatserTapeData", count: 0 }],
    income_components: [{ action: "daily_activity_rewards", num: 0, percent: "17.20" }] },
});
const record = (month: string, value: number) => normalizeZzzMonthly(body(month, value), role).record!;

test("月报在中国时区解析本月与跨年上月，拒绝非法和未来月份", () => {
  const january = new Date("2025-12-31T16:00:01Z");
  expect(zzzMonthlyDate(undefined, "上", january)).toBe("202512");
  expect(zzzMonthlyDate(undefined, "上", new Date("2025-12-31T15:59:59Z"))).toBe("202511");
  expect(zzzMonthlyDate("2024", "2", january)).toBe("202402");
  expect(zzzMonthlyDate("2025", undefined, january)).toBe("");
  expect(zzzMonthlyDate(undefined, "2", january)).toBeUndefined();
  expect(zzzMonthlyDate("2025", "13", january)).toBeUndefined();
});

test("统计仅刷新官方可用月份并按旧签名，保留零、缺值和身份", async () => {
  const seen: string[] = [];
  let guarded = 0;
  const result = await readZzzMonthly(source, async (url, request) => {
    expect(url.origin + url.pathname).toBe("https://api-takumi.mihoyo.com/event/nap_ledger/month_info");
    expect(request).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
    expect(request.body).toBeUndefined();
    const headers = new Headers(request.headers);
    const [t, r, hash] = headers.get("DS")!.split(",");
    expect(hash).toBe(createHash("md5").update(`salt=xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs&t=${t}&r=${r}&b=&q=uid=12345678&region=prod_gf_cn`).digest("hex"));
    expect(headers.get("Origin")).toBe("https://act.mihoyo.com");
    expect(headers.get("Referer")).toBe("https://act.mihoyo.com/");
    expect(headers.get("Cookie")).toBe("cookie_token=fixture-cookie");
    expect(headers.get("x-rpc-device_id")).toBe("fixture-device");
    expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
    const month = url.searchParams.get("month");
    expect(url.search).toBe(`?uid=12345678&region=prod_gf_cn&month=${month}`);
    seen.push(month!);
    return Response.json({ retcode: 0, data: month === "202511" ? null :
      body(month || "202601", 15, month ? [] : ["202601", 202512, "202512", "202511"]) });
  }, { month: "", collect: true }, async () => { guarded++; });
  expect(seen).toEqual(["", "202512", "202511"]);
  expect(guarded).toBe(6);
  expect(result.months.map(row => row.data_month)).toEqual(["202601", "202512"]);
  expect(zzzMonthlyTotals(result.months)).toEqual([30, 0, undefined]);
  expect(() => normalizeZzzMonthly(body("202511", 20), role, "202512")).toThrow(HoyoRequestError);
  expect(() => normalizeZzzMonthly({ ...body("202512", 0), uid: "22345678" }, role)).toThrow(HoyoRequestError);
  expect(() => normalizeZzzMonthly({ ...body("202512", 0), region: "prod_qd_cn" }, role)).toThrow(HoyoRequestError);
});

test("旧月报只读，窗口缩短和并发请求保留已知月份、同月旧项和最新覆写", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzz-monthly-fixture-"));
  try {
    const old = join(root, "legacy");
    await mkdir(old);
    const oldFile = join(old, identity.uid + ".json");
    const bytes = JSON.stringify([body("202410", 23), body("202512", 26)]);
    await writeFile(oldFile, bytes);
    const archive = createZzzMonthlyArchive(join(root, "new"), [old], lockFile);
    let valid = true;
    const verify = async () => { if (!valid) throw new Error("档案改变"); };
    const incoming = record("202512", 50);
    const partial = { ...incoming, month_data: { list: [{ data_type: "PolychromesData", count: 51 }], income_components: [] } };
    await Promise.all([
      archive.update(identity, [partial, record("202601", 30)], 40, verify),
      archive.update(identity, [record("202512", 25), record("202511", 28)], 30, verify),
    ]);
    await archive.update(identity, [record("202601", 34)], 41, verify);
    const values = await archive.read(identity);
    expect(values.map(row => row.data_month)).toEqual(["202601", "202512", "202511", "202410"]);
    expect(values[1]?.month_data.list).toEqual([{ data_type: "PolychromesData", count: 51 }, { data_type: "MatserTapeData", count: 0 }]);
    expect(values[1]?.month_data.income_components[0]?.num).toBe(0);
    expect(await readFile(oldFile, "utf8")).toBe(bytes);
    valid = false;
    await expect(archive.update(identity, [record("202508", 10)], 42, verify)).rejects.toThrow("档案改变");
    expect(await archive.read(identity)).toEqual(values);
    await expect(archive.read({ ...identity, region: "prod_qd_cn" })).rejects.toThrow("UID 或区服");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("月报不会回退到另一已认证角色，也不会以不一致的 Cookie 读取旧档", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzz-monthly-selection-"));
  try {
    const profilesDirectory = join(root, "profiles");
    const old = join(root, "legacy");
    await mkdir(profilesDirectory);
    await mkdir(old);
    await writeFile(join(old, role.uid + ".json"), JSON.stringify([body("202410", 23)]));
    const profile = (id: number, selected: string, cookieAccount: string) => [
      'user: { qq: "42" }', `profile: { id: ${id} }`, "account:",
      `  cookie: "cookie_token=fixture; account_id=${cookieAccount}"`, '  stoken: "fixture-stoken"', '  stuid: "43"',
      `  game_roles: { zzz: [{ uid: "${role.uid}", region: ${role.region}, game_biz: nap_cn }] }`,
      `  current_uid: { zzz: "${selected}" }`,
    ].join("\n");
    await writeFile(join(profilesDirectory, "42.yaml"), profile(1, "23456789", "43"));
    await writeFile(join(profilesDirectory, "42-2.yaml"), profile(2, role.uid, "44"));
    const profiles = createProfileStore(profilesDirectory);
    expect((await profiles.savedRole("42", 1, "zzz")).uid).toBe("23456789");
    expect((await profiles.requestContext("42", 1, "zzz")).role.uid).toBe(role.uid);
    const wire: string[] = [];
    const client = createProfileHoyoClient(profiles, async url => {
      wire.push(url.pathname);
      return Response.json({ retcode: 0, data: null });
    });
    const archive = createZzzMonthlyArchive(join(root, "new"), [old], lockFile);
    const query = createZzzMonthlyCommands(profiles, client, archive, new AbortController().signal);
    const context = { user_id: 42, message_type: "private" };
    const options = { collect: false, year: "2024", month: "10" };
    expect(await query(context, 1, options)).toBe("profile 1 没有同步绝区零 UID。");
    expect(wire).toEqual([]);
    expect(await query(context, 2, options)).toBe("档案 Cookie 与当前登录账号不一致，请刷新或重新扫码登录。");
    expect(wire).toEqual([]);
    expect(await readFile(join(old, role.uid + ".json"), "utf8")).toBe(JSON.stringify([body("202410", 23)]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("国际服月报由本人选档，按官方月份回读并保留旧档", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzz-monthly-overseas-"));
  try {
    const old = join(root, "legacy");
    await mkdir(old);
    const role = { uid: "1000000023", region: "prod_gf_us", gameBiz: "nap_global" };
    const identity = { ...role, qq: "42" };
    const oldMonth = { ...body("202410", 23), ...role };
    await writeFile(join(old, role.uid + ".json"), JSON.stringify([oldMonth]));
    const profile = join(root, "42-2.yaml");
    const config = `user: { qq: "42" }
profile: { id: 2 }
account:
  cookie: "cookie_token=domestic-only; account_id=43"
  stoken: fixture-stoken
  stuid: "43"
  current_uid: { zzz: "${role.uid}" }
games:
  os:
    verified_account_id: "44"
    verified_realm: US
    verified_activity_cookie: "ltuid=44; ltoken=international-fixture"
`;
    await writeFile(profile, config);
    const profiles = createProfileStore(root);
    const requests: string[] = [];
    let mismatched = false;
    let expired = false;
    let change = false;
    const client = createProfileHoyoClient(profiles, async (url, request) => {
      expect(new Headers(request.headers).get("cookie")).toBe("ltuid=44; ltoken=international-fixture");
      expect(request).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
      requests.push(url.href);
      if (url.hostname === "api-account-os.hoyolab.com") {
        expect(url.pathname).toBe("/binding/api/getUserGameRolesByLtoken");
        expect(url.search).toBe("?game_biz=nap_global");
        return Response.json({ retcode: 0, data: { list: [{
          game_uid: role.uid, region: role.region, game_biz: role.gameBiz,
        }] } });
      }
      expect(url.origin + url.pathname).toBe("https://sg-public-api.hoyolab.com/event/nap_ledger/month_info");
      const month = url.searchParams.get("month") ?? "";
      expect(url.search).toBe(`?uid=${role.uid}&region=${role.region}&month=${month}`);
      if (change) await writeFile(profile, config.replace("international-fixture", "new-international-fixture"));
      if (expired) return Response.json({ retcode: -100, data: null });
      return Response.json({ retcode: 0, data: {
        ...body(month || "202601", 15, month ? [] : ["202601", 202512, "202512"]),
        ...role, game_biz: role.gameBiz, ...(mismatched && { uid: "1000000024" }),
      } });
    });
    const archive = createZzzMonthlyArchive(join(root, "new"), [old], lockFile);
    const query = createZzzMonthlyCommands(profiles, client, archive, new AbortController().signal);
    const context = { user_id: 42, message_type: "private", privateCredentialSignal: new AbortController().signal };
    expect(await query({ ...context, message_type: "group" }, 2, { collect: true })).toBe("绝区零国际服月报请从本人私聊查询。");
    expect(await query({ ...context, privateCredentialSignal: undefined }, 2, { collect: true })).toBe("绝区零国际服月报请从本人私聊查询。");
    expect(await query({ ...context, isDelegated: true }, 2, { collect: true })).toBe("请从登录档案对应的 QQ 会话查询绝区零月报。");
    expect(await query({ ...context, privateCredentialSignal: AbortSignal.abort() }, 2, { collect: true })).toEqual([]);
    expect(requests).toEqual([]);
    const result = await query(context, 2, { collect: true });
    expect(typeof result === "string" ? result.includes("绝区零月报 ·") : "type" in result && result.type === "image").toBe(true);
    expect(requests).toHaveLength(3);
    expect((await archive.read(identity)).map(month => month.data_month)).toEqual(["202601", "202512", "202410"]);
    const saved = await archive.read(identity);

    mismatched = true;
    expect(await query(context, 2, { collect: false, year: "2025", month: "11" })).toMatch(/获取月报数据失败/u);
    expect(await archive.read(identity)).toEqual(saved);
    expired = true;
    expect(await query(context, 2, { collect: false, year: "2025", month: "11" })).toContain("Cookie 已失效");
    expect(await archive.read(identity)).toEqual(saved);
    change = true;
    expect(await query(context, 2, { collect: true })).toBe("绝区零档案已变化，请重新查询月报。");
    expect(await archive.read(identity)).toEqual(saved);

    const oldProfile = config.slice(0, config.indexOf("games:")).replace("  current_uid:",
      `  game_roles: { zzz: [{ uid: "${role.uid}", region: ${role.region}, game_biz: ${role.gameBiz} }] }\n  current_uid:`);
    await writeFile(profile, oldProfile);
    const before = requests.length;
    const savedResult = await query(context, 2, { collect: false, year: "2024", month: "10" });
    expect(typeof savedResult === "string" ? savedResult.includes("本次未更新") : "type" in savedResult && savedResult.type === "image").toBe(true);
    expect(requests).toHaveLength(before);
    expect(await readFile(join(old, role.uid + ".json"), "utf8")).toBe(JSON.stringify([oldMonth]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
