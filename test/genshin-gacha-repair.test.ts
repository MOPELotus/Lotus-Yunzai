import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "../packages/account/index.ts";
import { createHoyoClient } from "../packages/hoyo-client/index.ts";
import { createGenshinGachaHistoryStore } from "../plugins/genshin/gacha-store.ts";
import { createGenshinGachaRepair, GenshinGachaRepairCancelledError, gachaRepairCommand } from "../plugins/genshin/gacha-repair.ts";
import { createGenshinGachaSync } from "../plugins/genshin/gacha-sync.ts";
import { lockFile } from "../lib/file-lock.ts";

const uid = "512345678";
const row = (id: string, name: string, type = 301) => ({ id, name, uid, gacha_type: String(type) });

test("抽卡全量修复一次性令牌支持重启、失败重试、异档并发与运行中重开", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-gacha-repair-state-"));
  try {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const seen: [string, number, boolean][] = [];
    let now = 10_000, defer = false, fail = false;
    const sync: ReturnType<typeof createGenshinGachaSync>["sync"] = async (qq, profile = 1, _options, publishRepair) => {
      seen.push([qq, profile, !!publishRepair]);
      if (defer) {
        entered.resolve();
        await finish.promise;
      }
      if (fail) throw new Error("模拟半池失败");
      publishRepair?.(() => {});
      return { uid, region: "cn_qd01", profileId: profile, refreshedCookie: false,
        records: { 301: [], 302: [], 500: [], 200: [] }, pools: [] };
    };
    const state = join(directory, "repair.sqlite");
    const first = createGenshinGachaRepair(state, sync, lockFile, () => now);
    first.set("42", true);
    const restarted = createGenshinGachaRepair(state, sync, lockFile, () => now);
    fail = true;
    await expect(restarted.update("42", 1, {})).rejects.toThrow("模拟半池失败");
    fail = false;
    defer = true;
    const inFlight = restarted.update("42", 3, {});
    await entered.promise;
    expect(await restarted.update("42", 4, {})).toBeUndefined();
    const secondProcessView = first.update("42", 4, {});
    restarted.set("42", true);
    defer = false;
    await restarted.update("44", 1, {});
    finish.resolve();
    await expect(inFlight).rejects.toBeInstanceOf(GenshinGachaRepairCancelledError);
    await secondProcessView;
    await restarted.update("42", 9, {});
    await restarted.update("42", 1, {});
    restarted.set("42", true);
    now += 600_000;
    await restarted.update("42", 2, {});
    restarted.set("42", true);
    restarted.set("42", false);
    await restarted.update("42", 5, {});
    expect(seen).toEqual([["42", 1, true], ["42", 3, true], ["44", 1, false],
      ["42", 4, false], ["42", 9, true], ["42", 1, false], ["42", 2, false], ["42", 5, false]]);
    for (const command of ["#设置全量更新抽卡记录开", "#设置全量获取祈愿记录off", "#设置全量更新抽卡记录 开"]) {
      expect(gachaRepairCommand.test(command)).toBe(true);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("只有完整同档官方更新可修正同 ID 字段，历史旧记录和本地元数据保留", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-gacha-repair-"));
  try {
    const profileDir = join(directory, "profiles"), archive = join(directory, "archive");
    await mkdir(profileDir);
    const profile = join(profileDir, "42-2.yaml");
    const profileData = `version: 1
user: { qq: "42" }
profile: { id: 2 }
account:
  cookie: "account_id_v2=80;account_mid_v2=fixture-mid;cookie_token_v2=v2_fixture-cookie"
  stoken_cookie: "stoken=v2_fixture;stuid=80;mid=fixture-mid;ltoken_v2=v2_fixture-ltoken"
  stuid: "80"
  stoken: v2_fixture
  game_roles: { gs: [{ uid: "${uid}", region: cn_qd01, game_biz: hk4e_cn }] }
  current_uid: { gs: "${uid}" }
`;
    await writeFile(profile, profileData);
    await mkdir(join(archive, "42", uid), {recursive:true});
    const prior = [{ ...row("80", "旧值"), imported: { version: 2 }, note: "本地备注" }, row("20", "窗口外")];
    const priorBytes = JSON.stringify(prior);
    const file = join(archive, "42", uid, "301.json");
    await writeFile(file, priorBytes);
    let fail = true, change = false, closeDuringFetch = false;
    const profileStore = createProfileStore(profileDir);
    const client = createHoyoClient(async (url) => {
      if (url.pathname === "/binding/api/genAuthKey") return Response.json({retcode:0,data:{authkey:"fixture"}});
      const type = Number(url.searchParams.get("gacha_type"));
      const page = Number(url.searchParams.get("page"));
      if (type === 500 && fail) return Response.json({retcode:400});
      if (type === 200 && change) await writeFile(profile, profileData.replace("fixture-ltoken", "changed-ltoken"));
      if (type === 200 && closeDuringFetch) repair.set("42", false);
      const list = type === 301 && page === 1 ? [
        row("90", "新值"), {...row("80", "官方修正"), imported: false, note: "不要覆盖备注"}, row("70", "补缺"),
      ] : [];
      return Response.json({retcode:0,data:{list}});
    }, { profiles: profileStore, async exchange() { throw new Error("no exchange expected"); } });
    const store = createGenshinGachaHistoryStore(archive, lockFile);
    const sync = createGenshinGachaSync(profileStore, client, store);
    const repair = createGenshinGachaRepair(join(directory, "repair.sqlite"), sync.sync, lockFile);
    repair.set("42", true);

    await expect(repair.update("42", 2, { intervalMs: 0 })).rejects.toMatchObject({ code: "api" });
    expect(await readFile(file, "utf8")).toBe(priorBytes);
    fail = false;
    change = true;
    await expect(repair.update("42", 2, { intervalMs: 0 })).rejects.toMatchObject({ code: "profile-changed" });
    expect(await readFile(file, "utf8")).toBe(priorBytes);
    change = false;
    closeDuringFetch = true;
    await expect(repair.update("42", 2, { intervalMs: 0 })).rejects.toBeInstanceOf(GenshinGachaRepairCancelledError);
    expect(await readFile(file, "utf8")).toBe(priorBytes);
    closeDuringFetch = false;
    repair.set("42", true);
    const updated = await repair.update("42", 2, { intervalMs: 0 });
    expect(updated?.pools.map(pool => [pool.type, pool.corrected])).toEqual([[301, 1], [302, 0], [500, 0], [200, 0]]);
    expect((await store.read("42", uid))[301]).toEqual([row("90", "新值"), {
      ...prior[0], name: "官方修正",
    }, row("70", "补缺"), row("20", "窗口外")]);
    const saved = await readFile(file, "utf8");
    const ordinary = await repair.update("42", 2, { intervalMs: 0 });
    expect(ordinary?.pools.every(pool => pool.corrected === undefined)).toBe(true);
    expect(await readFile(file, "utf8")).toBe(saved);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
