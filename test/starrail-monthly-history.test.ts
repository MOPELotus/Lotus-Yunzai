import { linkHostPackages } from "./host-fixture.ts";
import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { stageLegacyGameData } from "../lib/migration-game-data.ts";
import { createStarRailMonthlyArchive } from "../plugins/starrail/monthly-archive.ts";
import { matchStarRailMonthly, starRailRecentPeriods, starRailStatisticsPeriod } from "../plugins/starrail/monthly-period.ts";
import { buildStarRailMonthlyStatistics } from "../plugins/starrail/monthly-statistics.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const who = { qq: "42", accountId: "42", uid: "100000126", gameBiz: "hkrpg_cn", region: "prod_gf_cn" };
const time = Date.parse("2026-01-01T00:00:00+08:00");
const older = (key: string, hcoin: number) => ({
  data_month: key, isUpdate: true, uid: who.uid, game_biz: who.gameBiz, region: who.region,
  month_data: { current_hcoin: hcoin, current_rails_pass: 0, group_by: [{ action_name: "活动", num: hcoin }] },
  day_data: { current_hcoin: 0, current_rails_pass: 0, last_hcoin: 0, last_rails_pass: 0 },
});
async function put(root: string, path: string, content: string) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

test("星琼月份、既有简写档号与流水分开，跨年查上年十一、十二和当前一月", () => {
  expect(matchStarRailMonthly("*星琼十二月档案2")).toEqual({ type: "month", legacy: true, month: 12, profileId: 2 });
  expect(matchStarRailMonthly("*星琼12")).toEqual({ type: "month", legacy: true, month: 12, profileId: 1 });
  expect(matchStarRailMonthly("*星琼 档案12")).toEqual({ type: "month", legacy: true, month: undefined, profileId: 12 });
  expect(matchStarRailMonthly("*星琼获取12")).toEqual({ type: "month", legacy: false, month: undefined, profileId: 12 });
  for (const text of ["*今年星琼统计", "#星铁今年星琼统计", "#今年星铁星琼统计"])
    expect(matchStarRailMonthly(text)).toEqual({ type: "statistics", selection: "今年", profileId: 1 });
  expect(matchStarRailMonthly("#星铁星琼任务")).toEqual({ type: "task" });
  for (const text of ["*星琼记录", "#绝区零星琼", "#星铁日历", "*星琼任务档案2"])
    expect(matchStarRailMonthly(text)).toBeUndefined();
  expect(starRailRecentPeriods(time).map(row => row.key)).toEqual(["202511", "202512", "202601"]);
  expect(starRailStatisticsPeriod(time, "今年")?.last).toBe(2026 * 12 + 1);
  expect(starRailStatisticsPeriod(time, "去年")?.last).toBe(2025 * 12 + 12);
  expect(starRailStatisticsPeriod(time, "2027年")).toBeUndefined();
});

test("普通暂存保留旧星铁月历原字节，读入月份零值并按时期统计，不接受错归属响应或改号更新", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "lotus-monthly-copy-"));
  const source = join(fixture, "old"), stage = join(fixture, "stage");
  const legacy = join(source, "data/SR_NoteData", `${who.uid}.json`);
  const raw = JSON.stringify({ 2024: { 12: older("202412", 8) }, 2025: { 11: older("202511", 0), 12: older("202512", 113) } });
  try {
    await put(source, `data/SR_NoteData/${who.uid}.json`, raw);
    await mkdir(stage, { mode: 0o700 });
    const staged = await stageLegacyGameData(source, stage);
    const archiveRoot = join(stage, "backup/legacy-data/SR_NoteData");
    expect(staged.archived).toContainEqual({ path: "backup/legacy-data/SR_NoteData", files: 1, bytes: Buffer.byteLength(raw) });
    expect(await readFile(join(archiveRoot, `${who.uid}.json`), "utf8")).toBe(raw);
    const archive = createStarRailMonthlyArchive(join(stage, "data/starrail/monthly"), [archiveRoot], lockFile);
    const saved = await archive.read(who);
    expect(buildStarRailMonthlyStatistics(who.uid, saved, starRailStatisticsPeriod(time, "去年")!)).toMatchObject({ hcoin: 113, railsPass: 0 });
    expect(buildStarRailMonthlyStatistics(who.uid, saved, starRailStatisticsPeriod(time)!)?.months.map(row => row.key))
      .toEqual(["202511", "202512"]);
    const initial = saved[0]!;
    await expect(archive.record(who, { ...initial, key: "202601", fetchedAt: time }, async () => { throw new Error("改号"); }))
      .rejects.toThrow("改号");
    expect(await archive.read(who)).toEqual(saved);
    await writeFile(join(archiveRoot, `${who.uid}.json`), JSON.stringify({ 2025: { 12: { ...older("202512", 113), uid: "100000127" } } }));
    await expect(archive.read(who)).rejects.toThrow("归属不一致");
    expect(await readFile(legacy, "utf8")).toBe(raw);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

const newest = starRailRecentPeriods(Date.now()).at(-1)!.key;
const historyYear = Number(newest.slice(0, 4)) - 1;
const past = `${historyYear}12`;
const evidence = Bun.env.LOTUS_SR_MONTHLY_EVIDENCE;
const wire = (month: string, uid: string) => ({ ...older(month, 640), uid, isUpdate: undefined });
const preload = `
Bun.env.LOTUS_PROFILE_DIR = "./data/users";
const actualFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === "https://api-takumi.mihoyo.com" && url.pathname === "/event/srledger/month_info") {
    const headers = new Headers(options?.headers);
    const uid = url.searchParams.get("uid");
    if (!["100000126", "100000127"].includes(uid) || headers.get("x-rpc-device_fp") !== "fixture-fp" ||
      !headers.get("Cookie")?.includes("fixture-cookie")) throw Error("请求归属错");
    const month = url.searchParams.get("month") || ${JSON.stringify(newest)};
    require("node:fs").appendFileSync(process.cwd() + "/requests.txt", uid + ":" + month + "\\n");
    return Promise.resolve(Response.json({ retcode: 0, data: { ...${JSON.stringify(wire(newest, who.uid))}, data_month: month, uid } }));
  }
  if (url.hostname === "127.0.0.1") return actualFetch(input, options);
  throw Error("隔离验收无外部网络");
};`;

test("实际 OneBot 和 Milky 入口返回本人月历、旧年档和统计，主人任务拒绝非主人", async () => {
  await withDualGatewayFixture("starrail-month-history", 'master: ["99:42"]\n', async ({ root, sendOneBot, sendMilky, onebot, milky }) => {
    const result = async (queue: typeof onebot, action: string, id: number, label?: string) => {
      const next = await queue.next(action);
      next.respond({ message_id: id, message_seq: id });
      const payload = JSON.stringify(next.params);
      if (label) expect(payload).toContain(label);
      if (label?.includes("记录 *星琼")) {
        const encoded = /base64:\/\/([A-Za-z0-9+/=]+)/u.exec(payload)?.[1];
        expect(encoded).toBeDefined();
        if (evidence && encoded) await Bun.write(join(evidence, `protocol-${id}.png`), Buffer.from(encoded, "base64"));
      }
      return payload;
    };
    sendOneBot("*星琼 档案2");
    await result(onebot, "send_msg", 11, "记录 *星琼 档案2");
    expect((await readFile(join(root, "requests.txt"), "utf8")).trim().split("\n").every(value => value.startsWith("100000126:"))).toBe(true);
    sendOneBot("*星琼统计 档案2");
    await result(onebot, "send_msg", 16, "记录 *星琼 档案2");
    const twoMonthsEarlier = starRailRecentPeriods(Date.now())[0]!.key;
    sendOneBot(`*星琼${Number(twoMonthsEarlier.slice(4))}月档案2`);
    await result(onebot, "send_msg", 17, "记录 *星琼 档案2");
    expect(await readFile(join(root, "requests.txt"), "utf8")).toContain(`100000126:${twoMonthsEarlier}`);
    sendOneBot("*星琼", { user_id: 44 });
    await result(onebot, "send_msg", 18, "请先登录档案 1");
    const requestsBeforeHistory = await readFile(join(root, "requests.txt"), "utf8");
    await sendMilky("*去年星琼统计");
    await result(milky, "send_private_message", 12, "记录 *星琼");
    expect(await readFile(join(root, "requests.txt"), "utf8")).toBe(requestsBeforeHistory);
    await sendMilky("*星琼任务");
    await result(milky, "send_private_message", 13, "仅当前机器人的主人");
    sendOneBot("*星琼任务");
    await result(onebot, "send_msg", 14, "开始保存");
    await result(onebot, "send_msg", 15, "星琼任务结束");
    expect(await readFile(join(root, "requests.txt"), "utf8")).toContain("100000127:");
  }, 9_000, preload, async root => {
    const stars = join(root, "plugins/starrail");
    await cp(new URL("../plugins/starrail", import.meta.url), stars, {
      recursive: true, filter: path => !/\/(?:\.git|node_modules|test)(?:\/|$)/u.test(path),
    });
    await symlink(join(import.meta.dir, "../plugins/starrail/node_modules"), join(stars, "node_modules"), "dir");
    await linkHostPackages(root);
    await put(root, "config/global.yaml", "scheduler: {enable: false}\ncoin_shop: {enable: false}\n");
    for (const [qq, uid, id] of [["42", "100000126", 2], ["43", "100000127", 1]] as const) {
      await put(root, `data/users/${qq}${id === 1 ? "" : `-${id}`}.yaml`, `version: 1
user: { qq: "${qq}" }
profile: { id: ${id} }
account:
  cookie: "cookie_token=fixture-cookie; account_id=${qq}; ltuid=${qq}"
  stoken: fixture-stoken
  stuid: "${qq}"
  ltuid: "${qq}"
  game_roles: { sr: [{ uid: "${uid}", region: prod_gf_cn, game_biz: hkrpg_cn }] }
  current_uid: { sr: "${uid}" }
device: { id: fixture-device, fp: fixture-fp }
`);
      await put(root, `backup/legacy-data/SR_NoteData/${uid}.json`, JSON.stringify({ [historyYear]: {
        12: { ...older(past, 320), uid },
      } }));
    }
  });
}, 30_000);
