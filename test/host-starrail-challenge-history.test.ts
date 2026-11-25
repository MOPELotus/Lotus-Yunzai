import { linkHostPackages } from "./host-fixture.ts";
import { expect, test } from "bun:test";
import { appendFile, cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const preload = `
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
const native = globalThis.fetch;
const { appendFileSync } = require("node:fs");
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return native(input, init);
  if (url.origin !== "https://api-takumi-record.mihoyo.com") throw Error("isolated challenge fixture has no upstream network");
  const path = url.pathname.split("/").at(-1);
  if (!["challenge", "challenge_boss", "challenge_story", "challenge_peak"].includes(path)) throw Error("unexpected API");
  const query = url.searchParams;
  const cookie = new Headers(init.headers).get("Cookie");
  const schedule = query.get("schedule_type");
  const detail = query.get("need_all") === "true";
  const uid = query.get("role_id");
  appendFileSync("seen-challenges", [path, schedule, detail, uid, cookie].join(":") + "\\n");
  if (path === "challenge_peak") {
    const period = (number, status) => ({
      group: { name_mi18n: "合成第 " + number + " 期", game_version: "4." + number, status },
      boss_stars: 3, mob_stars: 6,
    });
    const rows = detail ? [period(6, "New"), period(5, "End"), period(4, "End"), period(3, "End")] : [period(5, "End")];
    return Response.json({ retcode: 0, data: { role_id: uid,
      challenge_peak_records: rows, challenge_peak_best_record_brief: { total_battle_num: 7 } } });
  }
  if (path === "challenge" && detail) return Response.json({ retcode: 10102 });
  return Response.json({ retcode: 0, data: { role_id: uid, groups: [], all_floor_detail: [] } });
};
`;

function images(value: unknown): Buffer[] {
  return Array.from(JSON.stringify(value).matchAll(/base64:\/\/([A-Za-z0-9+/=]+)/gu), match => Buffer.from(match[1]!, "base64"));
}

test("星铁历史超过三期完整转发，双协议读简易前期、空页及海外拦截", async () => {
  await withDualGatewayFixture("starrail-challenge-history-fixture", "disablePrivate: false\n", async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
    const artifacts = Bun.env.LOTUS_SR_CHALLENGE_EVIDENCE;
    const capture = async (label: string, value: unknown) => {
      const cards = images(value);
      expect(cards).toHaveLength(1);
      const png = cards[0]!;
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      if (artifacts) await Bun.write(join(artifacts, label + ".png"), png);
      return png.readUInt32BE(20);
    };
    sendOneBot("*往期仲裁");
    const heading = await onebot.next("send_private_forward_msg");
    expect(JSON.stringify(heading.params)).toContain("UID 100000123 · 4 期");
    heading.respond({ message_id: 11 });
    const first = await onebot.next("send_private_forward_msg");
    first.respond({ message_id: 12 });
    const next = await onebot.next("send_private_forward_msg");
    next.respond({ message_id: 13 });
    expect(await capture("history-page-1", first.params)).toBeGreaterThan(await capture("history-page-2", next.params));
    sendOneBot("*上期简易仲裁2");
    const prior = await onebot.next("send_msg");
    prior.respond({ message_id: 14 });
    await capture("previous-single", prior.params);
    expect((await sendMilky("#星铁上期简易虚构2")).status).toBe(200);
    const empty = await milky.next("send_private_message");
    empty.respond({ message_seq: 15 });
    await capture("empty-story", empty.params);
    sendOneBot("*深渊");
    const three = await onebot.next("send_msg");
    three.respond({ message_id: 16 });
    await capture("all-core-modes", three.params);
    expect((await sendMilky("*混沌3")).status).toBe(200);
    const denied = await milky.next("send_private_message");
    expect(JSON.stringify(denied.params)).toContain("国服角色");
    denied.respond({ message_seq: 17 });
    const seen = await readFile(join(root, "seen-challenges"), "utf8");
    expect(seen.trim().split("\n")).toEqual([
      "challenge_peak:3:true:100000123:cookie_token=cn-42-1", "challenge_peak:3:false:100000124:cookie_token=cn-42-2",
      "challenge_story:2:false:100000126:cookie_token=cn-43-2", "challenge:1:true:100000123:cookie_token=cn-42-1",
      "challenge:1:false:100000123:cookie_token=cn-42-1", "challenge_story:1:true:100000123:cookie_token=cn-42-1",
      "challenge_boss:1:true:100000123:cookie_token=cn-42-1",
    ]);
    if (artifacts) await appendFile(join(artifacts, "host-routes.log"), seen);
  }, 15_000, preload, async root => {
    const plugin = join(import.meta.dir, "../plugins/starrail");
    const installed = join(root, "plugins/starrail");
    await cp(plugin, installed, { recursive: true, filter: file => ![".git", "node_modules", "test"].includes(basename(file)) });
    await symlink(join(plugin, "node_modules"), join(installed, "node_modules"), "dir");
    await linkHostPackages(root);
    const evidence = Bun.env.LOTUS_SR_CHALLENGE_EVIDENCE;
    if (evidence && await Bun.file(join(evidence, "theme/floor12.png")).exists()) {
      await cp(join(evidence, "theme"), join(root, "data/starrail/challenge-theme"), { recursive: true });
    }
    await mkdir(join(root, "profiles"), { recursive: true });
    for (const [qq, id, uid, region, gameBiz] of [
      [42, 1, 100000123, "prod_gf_cn", "hkrpg_cn"], [42, 2, 100000124, "prod_gf_cn", "hkrpg_cn"],
      [43, 2, 100000126, "prod_gf_cn", "hkrpg_cn"], [43, 3, 600000127, "prod_official_usa", "hkrpg_global"],
    ] as const) {
      await writeFile(join(root, "profiles", id === 1 ? `${qq}.yaml` : `${qq}-${id}.yaml`), [
        "version: 1", `user: { qq: "${qq}" }`, `profile: { id: ${id} }`, "account:",
        `  cookie: "cookie_token=cn-${qq}-${id}"`, `  stuid: "${qq}"`, "  stoken: fixture-session",
        `  game_roles: { sr: [{ uid: "${uid}", region: "${region}", game_biz: "${gameBiz}" }] }`,
        `  current_uid: { sr: "${uid}" }`, `device: { id: "device-${qq}-${id}" }`, "",
      ].join("\n"));
    }
  });
}, 70_000);
