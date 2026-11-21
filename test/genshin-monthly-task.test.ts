import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createProfileStore } from "@lotus-yunzai/account";
import { lockFile } from "../lib/file-lock.ts";
import { createHoyoClient } from "../packages/hoyo-client/index.ts";
import { createGenshinMonthlyArchive } from "../plugins/genshin/monthly-archive.ts";
import { createGenshinMonthlyTask, genshinMonthlyTaskCommand } from "../plugins/genshin/monthly-task.ts";

const main = { uid: "100000001", region: "cn_gf01", game_biz: "hk4e_cn" };
const channel = { uid: "500000002", region: "cn_qd01", game_biz: "hk4e_cn" };
const overseas = { uid: "800000003", region: "os_asia", game_biz: "hk4e_global" };
const roleBody = (role: typeof main, month: number, count: number) => ({
  bind_uid: role.uid, bind_region: role.region, data_month: month,
  month_data: { current_primogems: count, current_mora: 0, group_by: [] },
});
const roleAccount = {
  main: { qq: "42", accountId: "9001", uid: main.uid, region: main.region },
  channel: { qq: "43", accountId: "9002", uid: channel.uid, region: channel.region },
};
const january = Date.UTC(2027, 0, 2, 12);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lotus-genshin-ledger-task-"));
  const location = join(root, "profiles"), legacy = join(root, "legacy"), data = join(root, "archive");
  await Promise.all([mkdir(location), mkdir(legacy)]);
  const old = join(legacy, main.uid + ".json");
  const legacyBytes = JSON.stringify({ 2026: { 11: { ...roleBody(main, 11, 55), isUpdate: true } } });
  await writeFile(old, legacyBytes, { mode: 0o600 });
  function profile(qq: string, id: number, accountId: string, roles: readonly typeof main[], selected = roles[0]!.uid) {
    return Bun.YAML.stringify({ user: { qq }, profile: { id }, account: { stuid: accountId, stoken: "fixture",
      cookie: `account_id=${accountId};cookie_token=before;ltuid=${accountId};ltoken=before`,
      game_roles: { gs: roles }, current_uid: { gs: selected },
    } });
  }
  await writeFile(join(location, "42.yaml"), profile("42", 1, "9001", [main, overseas]), { mode: 0o600 });
  await writeFile(join(location, "42-2.yaml"), profile("42", 2, "9001", [main]), { mode: 0o600 });
  await writeFile(join(location, "43.yaml"), profile("43", 1, "9002", [channel]), { mode: 0o600 });
  return { root, data, old, legacyBytes, profiles: createProfileStore(location),
    archive: createGenshinMonthlyArchive(data, legacy, lockFile) };
}

test("主人原石任务对国服角色去重并最多补三月，同档续期且回执只有真实结果", async () => {
  const f = await fixture();
  try {
    let exchanges = 0;
    const calls: [string, number, boolean][] = [];
    const client = createHoyoClient(async (url, request) => {
      const uid = url.searchParams.get("bind_uid")!;
      const month = Number(url.searchParams.get("month"));
      const headers = new Headers(request.headers);
      calls.push([uid, month, headers.get("cookie")!.includes("cookie_token=after")]);
      if (calls.length === 1) return Response.json({ retcode: -100 });
      if (uid === channel.uid && month === 11) return Response.json({ retcode: 0, data: null });
      return Response.json({ retcode: 0, data: roleBody(uid === main.uid ? main : channel, month, month === 12 ? 0 : 10) });
    }, { profiles: f.profiles, async exchange(source) {
      exchanges++;
      expect([source.qq, source.profileId]).toEqual(["42", 1]);
      return { cookie: "account_id=9001;cookie_token=after;ltuid=9001;ltoken=after", ltoken: "after" };
    } });
    const task = createGenshinMonthlyTask(f.profiles, client, f.archive, new AbortController().signal,
      { now: () => january, pause: async () => {} });
    const replies: string[] = [];
    const owner = { user_id: 20, self_id: 99, message_type: "group", isMaster: true,
      reply: (reply: string) => replies.push(reply) };
    expect(genshinMonthlyTaskCommand.test("#原石任务")).toBe(true);
    expect(genshinMonthlyTaskCommand.test("#星琼任务")).toBe(false);
    expect(genshinMonthlyTaskCommand.test("#原石统计")).toBe(false);
    await expect(task({ ...owner, isMaster: false })).resolves.toMatch(/主人/);
    await expect(task({ ...owner, isDelegated: true })).resolves.toMatch(/主人/);
    expect(calls).toEqual([]);
    await expect(task(owner)).resolves.toBe("已处理 2/2 个角色，0 个未完成。保存 4 个月，保留已有 1 个月，官方未返回数据 1 个月。");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/最多查询最近三个月/);
    expect(replies[0]).not.toMatch(/100000001|500000002|9001/);
    expect(exchanges).toBe(1);
    expect(calls).toEqual([
      [main.uid, 12, false], [main.uid, 12, true], [main.uid, 1, true],
      [channel.uid, 11, false], [channel.uid, 12, false], [channel.uid, 1, false],
    ]);
    expect((await f.archive.read(roleAccount.main)).map(row => [row.year, row.snapshot.month, row.snapshot.primogems])).toEqual([
      [2027, 1, 10], [2026, 12, 0], [2026, 11, 55],
    ]);
    expect((await f.archive.read(roleAccount.channel)).map(row => row.snapshot.month)).toEqual([1, 12]);
    expect(await readFile(f.old, "utf8")).toBe(f.legacyBytes);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("原石任务跨北京时间月界和停机时不写未核验数据，也不发成功回执", async () => {
  const f = await fixture();
  try {
    const caller = { user_id: 20, self_id: 99, message_type: "private", isMaster: true, reply() {} };
    let time = Date.UTC(2026, 11, 31, 15, 59, 59);
    const active = new AbortController();
    const contacted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const client = createHoyoClient(async (url) => {
      contacted.resolve();
      await release.promise;
      return Response.json({ retcode: 0, data: roleBody(main, Number(url.searchParams.get("month")), 9) });
    }, { profiles: f.profiles, async exchange() { throw Error("unexpected expiry"); } });
    const run = createGenshinMonthlyTask(f.profiles, client, f.archive, active.signal, { now: () => time, pause: async () => {} });
    const running = run(caller);
    await contacted.promise;
    await expect(run(caller)).resolves.toMatch(/正在执行/);
    time += 2_000;
    release.resolve();
    await expect(running).resolves.toMatch(/北京时间已跨月.*\n已处理 0\/2.*保存 0 个月/u);
    expect(await Bun.file(join(f.data, "42", main.uid + ".json")).exists()).toBe(false);

    const ending = new AbortController();
    const contacted2 = Promise.withResolvers<void>();
    const release2 = Promise.withResolvers<void>();
    let calls = 0;
    const second = createHoyoClient(async (url) => {
      calls++;
      contacted2.resolve();
      await release2.promise;
      return Response.json({ retcode: 0, data: roleBody(main, Number(url.searchParams.get("month")), 9) });
    }, { profiles: f.profiles, async exchange() { throw Error("unexpected expiry"); } });
    const stopRun = createGenshinMonthlyTask(f.profiles, second, f.archive, ending.signal, { now: () => time, pause: async () => {} });
    const stopping = stopRun(caller);
    await contacted2.promise;
    ending.abort();
    release2.resolve();
    await expect(stopping).resolves.toBeUndefined();
    expect(calls).toBe(1);
    expect(await Bun.file(join(f.data, "42", main.uid + ".json")).exists()).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("原石任务遇到官方限流停止余下账号，保留角色成功与官方空响应的区别", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const client = createHoyoClient(async () => {
      calls++;
      return new Response(null, { status: 429 });
    }, { profiles: f.profiles, async exchange() { throw Error("unexpected expiry"); } });
    const task = createGenshinMonthlyTask(f.profiles, client, f.archive, new AbortController().signal,
      { now: () => january, pause: async () => {} });
    const context = { user_id: 20, self_id: 99, message_type: "private", isMaster: false,
      isBotMaster: (id: number) => id === 20, reply() {} };
    await expect(task(context)).resolves.toMatch(/过于频繁.*\n已处理 1\/2 个角色，1 个未完成.*官方未返回数据 0 个月/u);
    expect(calls).toBe(1);
    expect(await Bun.file(join(f.data, "42", main.uid + ".json")).exists()).toBe(false);

    let permitted = true, lateCalls = 0;
    const late = createHoyoClient(async url => {
      lateCalls++;
      permitted = false;
      return Response.json({ retcode: 0, data: roleBody(main, Number(url.searchParams.get("month")), 7) });
    }, { profiles: f.profiles, async exchange() { throw Error("unexpected expiry"); } });
    const current = createGenshinMonthlyTask(f.profiles, late, f.archive, new AbortController().signal,
      { now: () => january, pause: async () => {} });
    await expect(current({ ...context, isBotMaster: () => permitted })).resolves.toBeUndefined();
    expect(lateCalls).toBe(1);
    expect(await Bun.file(join(f.data, "42", main.uid + ".json")).exists()).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
