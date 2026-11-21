import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { lockFile } from "../lib/file-lock.ts";
import { createProfileStore } from "@lotus-yunzai/account";
import { createHoyoClient, normalizeGenshinMonthly } from "../packages/hoyo-client/index.ts";
import { createGenshinMonthlyArchive } from "../plugins/genshin/monthly-archive.ts";
import { createGenshinMonthlyQuery, matchGenshinMonthly } from "../plugins/genshin/monthly-command.ts";

const identity = { qq: "42", accountId: "8080", uid: "500000003", region: "cn_qd01" };
const now = () => Date.UTC(2027, 0, 2, 12);
const cookie = "account_id=8080;cookie_token=fixture;ltuid=8080;ltoken=fixture";
const raw = (month: number, count: number, isUpdate?: boolean) => ({
  bind_uid: identity.uid, bind_region: identity.region, data_month: month, isUpdate,
  month_data: { current_primogems: count, current_mora: 0, last_primogems: 77, last_mora: 0,
    group_by: [{ action_id: 3, action: "每日活跃", num: count, percent: count ? 100 : 0 }] },
});
const record = (year: number, month: number, count: number, finalized: boolean, fetchedAt: number) => ({
  year, finalized, fetchedAt, snapshot: normalizeGenshinMonthly(raw(month, count), month, identity.uid, identity.region)!,
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lotus-genshin-note-archive-"));
  const legacy = join(root, "NoteData");
  const current = join(root, "monthly");
  const profiles = join(root, "profiles");
  await Promise.all([mkdir(legacy), mkdir(profiles)]);
  const role = { uid: identity.uid, region: identity.region, game_biz: "hk4e_cn" };
  const profile = Bun.YAML.stringify({ user: { qq: identity.qq }, profile: { id: 1 }, account: {
    cookie, stuid: identity.accountId, stoken: "fixture", game_roles: { gs: [role] }, current_uid: { gs: identity.uid },
  } });
  await writeFile(join(profiles, "42.yaml"), profile, { mode: 0o600 });
  const legacyFile = join(legacy, identity.uid + ".json");
  const savedFile = join(current, identity.qq, identity.uid + ".json");
  const bytes = JSON.stringify({ 2025: { 9: raw(9, 99, true) }, 2026: { 10: raw(10, 250), 11: raw(11, 0, true),
    12: raw(12, 81, true) } }, null, 2);
  await writeFile(legacyFile, bytes, { mode: 0o600 });
  return { root, legacyFile, savedFile, bytes, profiles: createProfileStore(profiles),
    archive: createGenshinMonthlyArchive(current, legacy, lockFile) };
}

test("旧 NoteData 保持字节、月份缺口、冻结态与零，新存档只提交同 QQ 同账号月份", async () => {
  const f = await fixture();
  try {
    const verify = async () => {};
    const summarize = (rows: Awaited<ReturnType<typeof f.archive.read>>) =>
      rows.map(row => [row.year, row.snapshot.month, row.finalized, row.snapshot.primogems]);
    expect(summarize(await f.archive.read(identity))).toEqual([
      [2026, 12, true, 81], [2026, 11, true, 0], [2026, 10, false, 250], [2025, 9, true, 99],
    ]);
    await Promise.all([
      f.archive.record(identity, record(2027, 1, 130, false, 21), verify),
      f.archive.record(identity, record(2027, 1, 120, false, 20), verify),
      f.archive.record(identity, record(2026, 12, 0, true, 21), verify),
      f.archive.record(identity, record(2026, 11, 600, false, 20), verify),
    ]);
    expect(summarize(await f.archive.read(identity))).toEqual([
      [2027, 1, false, 130], [2026, 12, true, 0], [2026, 11, true, 0], [2026, 10, false, 250], [2025, 9, true, 99],
    ]);
    expect(await readFile(f.legacyFile, "utf8")).toBe(f.bytes);
    expect((await stat(f.savedFile)).mode & 0o777).toBe(0o600);
    expect((await stat(f.legacyFile)).mode & 0o777).toBe(0o600);
    const saved = await readFile(f.savedFile, "utf8");
    let checks = 0;
    await expect(f.archive.record(identity, record(2027, 1, 2, false, 22),
      async () => { if (++checks === 3) throw Error("档案已变化"); })).rejects.toThrow("档案已变化");
    expect(checks).toBe(3);
    await expect(f.archive.read({ ...identity, accountId: "9000" })).rejects.toThrow(/归属无效/);
    expect(await readFile(f.savedFile, "utf8")).toBe(saved);
    await rm(f.legacyFile);
    await symlink(f.savedFile, f.legacyFile);
    await expect(f.archive.read(identity)).rejects.toThrow();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("月札记确认空响应时标明使用旧档，失败保留错误和存档，拒绝错 QQ 及他人角色", async () => {
  const f = await fixture();
  try {
    let mode = "empty";
    let requests = 0;
    const client = createHoyoClient(async (url) => {
      requests++;
      expect(url.searchParams.get("bind_uid")).toBe(identity.uid);
      expect(url.searchParams.get("month")).toBe("12");
      if (mode === "empty") return Response.json({ retcode: 0, data: null });
      if (mode === "emptyObject") return Response.json({ retcode: 0, data: { data_month: 12, month_data: {} } });
      if (mode === "limit") return new Response(null, { status: 429 });
      return Response.json({ retcode: 0, data: raw(12, 320) });
    }, { profiles: f.profiles, async exchange() { throw Error("fixture should not refresh"); } });
    const query = createGenshinMonthlyQuery(f.profiles, client, new AbortController().signal, { now, archive: f.archive,
      async render() { throw Error("text receipt fixture"); },
    });
    const parsed = matchGenshinMonthly("札记十二月")!;
    const caller = { user_id: 42, self_id: 99, message_type: "private" };
    await expect(query(parsed, { ...caller, user_id: 43 })).resolves.toMatch(/先登录档案/);
    await expect(query(parsed, { ...caller, message: [{ type: "at", qq: 43 }] })).resolves.toMatch(/本人/);
    expect(requests).toBe(0);
    await expect(query(parsed, caller)).resolves.toEqual([
      expect.stringMatching(/原石 81/u), "米游社本次未返回该月数据，已显示本地存档。",
    ]);
    expect(await Bun.file(f.savedFile).exists()).toBe(false);
    mode = "emptyObject";
    await expect(query(parsed, caller)).resolves.toEqual([
      expect.stringMatching(/原石 81/u), "米游社本次未返回该月数据，已显示本地存档。",
    ]);
    expect(await Bun.file(f.savedFile).exists()).toBe(false);
    mode = "live";
    await expect(query(parsed, caller)).resolves.toMatch(/原石 320/u);
    const saved = await readFile(f.savedFile, "utf8");
    expect(JSON.parse(saved)).toMatchObject({ version: 1, ...identity, months: [{ year: 2026, month: 12, finalized: true }] });
    mode = "limit";
    await expect(query(parsed, caller)).resolves.toMatch(/过于频繁/u);
    expect(await readFile(f.savedFile, "utf8")).toBe(saved);
    expect(await readFile(f.legacyFile, "utf8")).toBe(f.bytes);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
