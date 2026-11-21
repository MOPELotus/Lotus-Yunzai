import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore, type ProfileRequestContext } from "@lotus-yunzai/account";
import { createHoyoClient, GameRecordRequestError } from "@lotus-yunzai/hoyo-client";

const uid = "100000126", channelUid = "500000126";
const data = {
  month: "11",
  day_data: { current_hcoin: 0, current_rails_pass: 1, last_hcoin: 57, last_rails_pass: "0" },
  month_data: { current_hcoin: "1137", current_rails_pass: 9,
    group_by: [{ action_name: "任务", num: 334 }, { action_name: "活动", num: 803 }, { action_name: "其他", num: 0 }] },
  unused: "must-not-project",
};
const old = "cookie_token=fixture-old; account_id=42; ltuid=42";
const newCookie = "cookie_token=fixture-new; account_id=42; ltuid=42";
const source = {
  qq: "42", profileId: 2, game: "sr", revision: "fixture", role: { uid, region: "prod_gf_cn", gameBiz: "hkrpg_cn" },
  device: { id: "fixture-device", fp: "fixture-fp" }, account: { cookie: old },
} as ProfileRequestContext;
const response = (data: unknown, retcode = 0) => Response.json({ retcode, data });

test("星铁月收入沿用固定当月参数、完整签名以及国服档案设备，返回旧字段精度", async () => {
  const requests: string[] = [];
  const client = createHoyoClient(async (url, options) => {
    expect(url.origin).toBe("https://api-takumi.mihoyo.com");
    expect(url.pathname).toBe("/event/srledger/month_info");
    const query = url.search.slice(1);
    requests.push(query);
    const headers = new Headers(options.headers);
    const [time, nonce, hash] = headers.get("DS")!.split(",");
    expect(hash).toBe(createHash("md5").update(`salt=xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs&t=${time}&r=${nonce}&b=&q=${query}`).digest("hex"));
    expect(headers.get("Cookie")).toBe(old);
    expect(headers.get("x-rpc-device_id")).toBe("fixture-device");
    expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
    expect(headers.get("Origin")).toBe("https://webstatic.mihoyo.com");
    expect(options).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", body: undefined });
    return response(data);
  });
  expect((await client.fetchStarRailMonthly(source)).snapshot).toEqual({
    month: "11", monthly: { hcoin: 1137, railsPass: 9 }, today: { hcoin: 0, railsPass: 1 },
    yesterday: { hcoin: 57, railsPass: 0 },
    groups: [{ name: "任务", count: 334 }, { name: "活动", count: 803 }, { name: "其他", count: 0 }],
  });
  await client.fetchStarRailMonthly({ ...source, role: { ...source.role, uid: channelUid, region: "prod_qd_cn" } });
  expect(requests).toEqual([
    `lang=zh-cn&uid=${uid}&region=prod_gf_cn&month=`,
    `lang=zh-cn&uid=${channelUid}&region=prod_qd_cn&month=`,
  ]);
});

test("星铁月收入校验区服和设备，区分无数据、错归属、坏字段与风控", async () => {
  let requests = 0, result = response(null);
  const client = createHoyoClient(async () => { requests++; return result; });
  for (const other of [
    { ...source, role: { ...source.role, uid: "800000126", region: "prod_official_asia", gameBiz: "hkrpg_global" } },
    { ...source, role: { ...source.role, region: "" } },
    { ...source, role: { ...source.role, uid: channelUid } },
    { ...source, device: { ...source.device, fp: "" } },
  ]) await expect(client.fetchStarRailMonthly(other)).rejects.toMatchObject({ code: "invalid-input" });
  expect(requests).toBe(0);
  expect((await client.fetchStarRailMonthly(source)).snapshot).toBeNull();
  for (const wrong of [
    { ...data, role: { game_uid: channelUid } },
    { ...data, region: "prod_qd_cn" },
    { ...data, game_biz: "nap_cn" },
    { ...data, day_data: { ...data.day_data, current_hcoin: -1 } },
    { ...data, month_data: { ...data.month_data, group_by: [{ action_name: "未知", num: 1.1 }] } },
  ]) {
    result = response(wrong);
    await expect(client.fetchStarRailMonthly(source)).rejects.toMatchObject({ code: "response" });
  }
  result = new Response("blocked", { headers: { "x-rpc-aigis": '{"session":"synthetic"}' } });
  await expect(client.fetchStarRailMonthly(source)).rejects.toBeInstanceOf(GameRecordRequestError);
});

test("星铁月收入仅续期被选中的档案一次，复用原设备，换绑时不给旧响应", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-sr-monthly-"));
  const profiles = createProfileStore(directory);
  const path = join(directory, "42-2.yaml"), other = join(directory, "42.yaml");
  const saved = `version: 1
user: { qq: "42" }
profile: { id: 2 }
account:
  cookie: "${old}"
  stoken: fixture-stoken
  stuid: "42"
  ltuid: "42"
  game_roles: { sr: [{ uid: "${uid}", region: prod_gf_cn, game_biz: hkrpg_cn }] }
  current_uid: { sr: "${uid}" }
device: { id: fixture-device, fp: fixture-fp }
`;
  const untouched = saved.replace("id: 2", "id: 1").replace("fixture-old", "fixture-other");
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path, saved);
    await writeFile(other, untouched);
    let exchanges = 0, plan: "expired" | "risk" | "changed" = "expired";
    const requests: string[] = [];
    const client = createHoyoClient(async (url, options) => {
      const headers = new Headers(options.headers);
      expect(url.searchParams.get("uid")).toBe(uid);
      expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
      const cookie = headers.get("Cookie")!;
      requests.push(cookie);
      if (plan === "risk") return response({}, 1034);
      if (plan === "changed") await writeFile(path, saved.replaceAll(uid, "100000127"));
      if (cookie === old) return response({}, -100);
      return response(data);
    }, { profiles, async exchange(context) {
      exchanges++;
      expect([context.qq, context.profileId]).toEqual(["42", 2]);
      return { cookie: newCookie, ltoken: "fixture-renewed" };
    } });
    expect((await client.fetchStarRailMonthly(await profiles.requestContext("42", 2, "sr"))).refreshedCookie).toBe(true);
    expect(requests).toEqual([old, newCookie]);
    expect(exchanges).toBe(1);
    expect(await readFile(other, "utf8")).toBe(untouched);
    plan = "risk";
    await expect(client.fetchStarRailMonthly(await profiles.requestContext("42", 2, "sr"))).rejects.toMatchObject({ reason: "risk" });
    plan = "changed";
    await expect(client.fetchStarRailMonthly(await profiles.requestContext("42", 2, "sr"))).rejects.toMatchObject({ code: "profile-changed" });
    expect(exchanges).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
