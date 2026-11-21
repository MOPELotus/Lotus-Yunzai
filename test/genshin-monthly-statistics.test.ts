import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createProfileStore } from "@lotus-yunzai/account";
import { lockFile } from "../lib/file-lock.ts";
import { createHoyoClient, normalizeGenshinMonthly } from "../packages/hoyo-client/index.ts";
import { createGenshinMonthlyArchive } from "../plugins/genshin/monthly-archive.ts";
import { createGenshinStatisticsQuery, matchGenshinStatistics } from "../plugins/genshin/monthly-statistics-command.ts";
import { buildGenshinStatistics, genshinStatisticsPeriod } from "../plugins/genshin/monthly-statistics-model.ts";

const uid = "500000003";
const region = "cn_qd01";
const now = () => Date.UTC(2027, 0, 2, 12);
const body = (month: number, primogems?: number, mora?: number, isUpdate?: boolean) => ({
  uid, region, data_month: month, isUpdate, month_data: { current_primogems: primogems, current_mora: mora,
    group_by: primogems === undefined ? [] : [{ action: "活动奖励", action_id: 6, num: primogems, percent: primogems ? 100 : 0 }] },
});
const recorded = (year: number, month: number, count?: number, mora?: number) => ({
  year, finalized: month !== 1, fetchedAt: 1, snapshot: normalizeGenshinMonthly(body(month, count, mora), month, uid, region)!,
});

test("原神原石统计区分最近十二月、今年和指定年份，汇总只计实际已收录月份", () => {
  expect(matchGenshinStatistics("#原石统计")).toEqual({ selection: undefined, profileId: 1 });
  expect(matchGenshinStatistics("＃2026年札记统计 档案2")).toEqual({ selection: "2026年", profileId: 2 });
  for (const command of ["#原石", "#原石任务", "*星琼统计", "#充值统计", "今年札记"]) expect(matchGenshinStatistics(command)).toBeUndefined();
  const rows = [
    recorded(2026, 1, 300, 0), recorded(2026, 3, 0, 3000), recorded(2026, 11, 130, 1200),
    recorded(2026, 12, 400, 2700), recorded(2027, 1, undefined, 100), recorded(2027, 2, 99, 99),
  ];
  const rolling = buildGenshinStatistics(uid, rows, genshinStatisticsPeriod(now(), undefined)!)!;
  expect(rolling.months.map(row => [row.year, row.snapshot.month, row.snapshot.primogems])).toEqual([
    [2026, 3, 0], [2026, 11, 130], [2026, 12, 400], [2027, 1, undefined],
  ]);
  expect(rolling).toMatchObject({ primogems: 530, mora: 7000, sources: [{ name: "活动奖励", total: 530 }],
    bestPrimogems: { year: 2026, snapshot: { month: 12 } }, bestMora: { year: 2026, snapshot: { month: 3 } } });
  expect(buildGenshinStatistics(uid, rows, genshinStatisticsPeriod(now(), "去年")!)?.primogems).toBe(830);
  expect(buildGenshinStatistics(uid, rows, genshinStatisticsPeriod(now(), "今年")!)?.primogems).toBeUndefined();
  expect(genshinStatisticsPeriod(now(), "2028年")).toBeUndefined();
});

test("指定年份只读本人旧账本，默认最多补最近三月且保留失败、已完成月份和换档状态", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-genshin-statistics-"));
  try {
    const legacy = join(root, "NoteData"), profilesPath = join(root, "profiles"), fresh = join(root, "monthly");
    await Promise.all([mkdir(legacy), mkdir(profilesPath)]);
    const profile = join(profilesPath, "42.yaml");
    const file = join(legacy, uid + ".json");
    const legacyBytes = JSON.stringify({ 2026: { 8: body(8, 3, 500, true), 11: body(11, 123, 12300, true),
      12: body(12, 9, 79, false) } });
    await writeFile(file, legacyBytes, { mode: 0o600 });
    const profileFor = (roleUid: string) => Bun.YAML.stringify({ user: { qq: "42" }, profile: { id: 1 }, account: {
      cookie: "account_id=8080;cookie_token=statistics;ltuid=8080;ltoken=statistics", stuid: "8080", stoken: "fixture",
      game_roles: { gs: [{ uid: roleUid, region, game_biz: "hk4e_cn" }] }, current_uid: { gs: roleUid },
    } });
    await writeFile(profile, profileFor(uid), { mode: 0o600 });
    const profiles = createProfileStore(profilesPath);
    let throttle = false, change = false, expired = true, exchanges = 0;
    const called: number[] = [];
    const credentials: (string | null)[] = [];
    const client = createHoyoClient(async (url, request) => {
      const month = Number(url.searchParams.get("month"));
      called.push(month);
      credentials.push(new Headers(request.headers).get("cookie"));
      if (expired) {
        expired = false;
        return Response.json({ retcode: -100 });
      }
      return throttle ? new Response(null, { status: 429 })
        : Response.json({ retcode: 0, data: body(month, month === 12 ? 100 : 0, 0) });
    }, { profiles, async exchange(context) {
      exchanges++;
      expect([context.qq, context.profileId]).toEqual(["42", 1]);
      return { cookie: "account_id=8080;cookie_token=renewed;ltuid=8080;ltoken=renewed", ltoken: "renewed" };
    } });
    const archive = createGenshinMonthlyArchive(fresh, legacy, lockFile);
    const query = createGenshinStatisticsQuery(profiles, client, archive, new AbortController().signal, { now,
      async render() {
        if (change) await writeFile(profile, profileFor("500000004"));
        throw Error("text fixture");
      },
    });
    const caller = { user_id: 42, self_id: 99, message_type: "private" };
    const explicit = matchGenshinStatistics("#去年札记统计")!;
    const rolling = matchGenshinStatistics("#原石统计")!;
    await expect(query(explicit, { ...caller, isDelegated: true })).resolves.toMatch(/本人/);
    await expect(query(explicit, { ...caller, user_id: 43 })).resolves.toMatch(/先登录/);
    await expect(query(explicit, caller)).resolves.toMatch(/2026年原石统计.*\n已归档 3\/12 个月\n总原石：135/u);
    expect(called).toEqual([]);
    await expect(query(rolling, caller)).resolves.toMatch(/最近12个月原石统计.*\n已归档 4\/12 个月\n总原石：226/u);
    expect(called.splice(0)).toEqual([12, 12, 1]);
    expect(exchanges).toBe(1);
    expect(credentials.map(value => value?.includes("cookie_token=renewed"))).toEqual([false, true, true]);
    const saved = join(fresh, "42", uid + ".json");
    const bytes = await readFile(saved, "utf8");
    throttle = true;
    const receipt = await query(rolling, caller);
    expect(receipt).toEqual([expect.stringMatching(/总原石：226/u), expect.stringMatching(/过于频繁.*已显示本地存档/u)]);
    expect(called.splice(0)).toEqual([1]);
    expect(await readFile(saved, "utf8")).toBe(bytes);
    expect(await readFile(file, "utf8")).toBe(legacyBytes);
    change = true;
    await expect(query(explicit, caller)).resolves.toMatch(/档案已变化/);
    expect(called).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
