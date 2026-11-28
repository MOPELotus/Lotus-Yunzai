import {physicalGpuFixture,functionalRenderingPreload,physicalRenderingPreload} from "./physical-gpu-fixture.ts";
import { expect, test } from "bun:test";
import { cp, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { zzzTuningPools } from "../packages/hoyo-client/index.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";
import { linkHostBuiltinResources } from "./host-fixture.ts";

const gpu = await physicalGpuFixture();
if (!gpu.available) console.warn("[GPU]", gpu.reason);

const avatar = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const preload = `
const nativeFetch = globalThis.fetch;
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
Bun.env.LOTUS_SKIA_MODE = "gpu";
Bun.env.LOTUS_ZZZ_INVENTORY_THEME_DIR = "./no-old-art";
const roles = new Map([["123456789", 42], ["223456789", 43]]);
const tickets = ["RECHARGE_MONOCHROME", "POLYCHROME", "ENCRYPTED_MASTER_TAPE", "MASTER_TAPE", "BOOPON"];
let input = [];
globalThis.fetch = async (address, options) => {
  const url = new URL(address instanceof Request ? address.url : address);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return nativeFetch(address, options);
  if (url.hostname === "q1.qlogo.cn") {
    if (![...roles.values()].includes(Number(url.searchParams.get("nk")))) throw Error("头像请求不是当前操作者");
    return new Response(Uint8Array.fromBase64("${avatar}"), { headers: { "content-type": "image/png" } });
  }
  if (url.origin === "https://act-api-takumi.mihoyo.com" && url.pathname === "/event/nap_gacha_record/api/zzz/index") {
    const uid = url.searchParams.get("uid");
    if (new Headers(options.headers).get("Cookie") !== "cookie_token=fixture-zzz-" + roles.get(uid)) {
      throw Error("档案串到了另一会话");
    }
    input.push(uid);
    await Bun.write("./requests.json", JSON.stringify(input));
    return Response.json({ retcode: 0, data: {
      uid, region: "prod_gf_cn",
      cur_tickets: tickets.map((key, index) => ({ ticket_type: "GACHA_TICKET_TYPE_" + key, ticket_cnt: index + roles.get(uid) })),
    } });
  }
  throw Error("隔离验收禁止外部请求：" + url.origin + url.pathname);
};
`;

async function sources(root: string) {
  await linkHostBuiltinResources(root);
  const source = join(import.meta.dir, "../plugins/zzz");
  const destination = join(root, "plugins", "zzz");
  await cp(source, destination, { recursive: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
  await symlink(join(source, "node_modules"), join(destination, "node_modules"), "dir");
  const profiles = join(root, "profiles");
  await mkdir(profiles, { recursive: true });
  for (const [qq, id, uid] of [[42, 2, 123456789], [43, 1, 223456789]]) {
    await writeFile(join(profiles, `${qq}${id === 1 ? "" : "-" + id}.yaml`), `user: { qq: "${qq}" }
profile: { id: ${id} }
account:
  cookie: cookie_token=fixture-zzz-${qq}
  stoken: test-stoken
  stuid: "${qq}"
  game_roles: { zzz: [{ uid: "${uid}", region: prod_gf_cn, game_biz: nap_cn, nickname: "样本${qq}", level: 60 }] }
  current_uid: { zzz: "${uid}" }
`);
  }
}

function imageBytes(params: unknown) {
  const encoded = /base64:\/\/([A-Za-z0-9+/]+={0,2})/u.exec(JSON.stringify(params))?.[1];
  if (!encoded) throw Error(JSON.stringify(params));
  return Uint8Array.fromBase64(encoded);
}

for (const rendering of [false, true]) test.skipIf(rendering && !gpu.available)(`正常宿主经 OneBot 群和 Milky 私聊直查不同档案库存，旧别名及防串档 [${rendering ? "GPU" : "functional"}]`, async () => {
  await withDualGatewayFixture("zzz-inventory-fixture", "disablePrivate: false\n",
    async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
      sendOneBot("%母带2", { message_type: "group", sub_type: "normal", group_id: 600 });
      const group = await onebot.next("send_msg");
      expect(group.params).toMatchObject({ group_id: 600 });
      const first = rendering ? imageBytes(group.params) : JSON.stringify(group.params);
      if (rendering) expect(await new Bun.Image(first as Uint8Array).metadata()).toMatchObject({ width: 2240, height: 1524, format: "png" });
      else { expect(first).toContain("档案 2"); expect(first).toContain("123456789"); for (const amount of [42,43,44,45,46]) expect(first).toContain(String(amount)); }
      group.respond({ message_id: 156 });

      await sendMilky("#zzz存货");
      const friend = await milky.next("send_private_message");
      expect(friend.params).toMatchObject({ user_id: 43 });
      const second = rendering ? imageBytes(friend.params) : JSON.stringify(friend.params);
      if (rendering) expect(await new Bun.Image(second as Uint8Array).metadata()).toMatchObject({ width: 2240, height: 1524, format: "png" });
      else { expect(second).toContain("档案 1"); expect(second).toContain("223456789"); }
      expect(second).not.toEqual(first);
      friend.respond({ message_seq: 157 });

      sendOneBot("#绝区零存货2", { message_type: "group", sub_type: "normal", group_id: 600,
        message: [{ type: "text", data: { text: "#绝区零存货2" } }, { type: "at", data: { qq: "43" } }] });
      const denied = await onebot.next("send_msg");
      expect(JSON.stringify(denied.params)).toContain("只能查询自己");
      expect(await Bun.file(join(root, "requests.json")).json()).toEqual(["123456789", "223456789"]);
      expect(await readdir(join(root, "data", "zzzTuningStats")).catch(() => [])).toEqual([]);
    }, 8_000, preload + (rendering ? physicalRenderingPreload : functionalRenderingPreload), sources);
}, 18_000);

test.skipIf(!gpu.available)("国服统计仅当前登录可读，网关确认后才查实时库存，并可读仅含 Cookie 身份的旧逐抽档", async () => {
  await withDualGatewayFixture("zzz-tuning-profile-fixture", "disablePrivate: false\n",
    async ({ root, onebot, sendOneBot }) => {
      sendOneBot("%抽卡记录3");
      const cleared = await onebot.next("send_msg");
      expect(JSON.stringify(cleared.params)).toContain("请先登录档案 3");
      expect(await Bun.file(join(root, "requests.json")).exists()).toBe(false);

      sendOneBot("%抽卡记录2");
      const refused = await onebot.next("send_private_forward_msg");
      expect([...JSON.stringify(refused.params).matchAll(/base64:\/\/[A-Za-z0-9+/=]+/gu)]).toHaveLength(6);
      const stats = imageBytes(refused.params);
      expect(stats.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(refused.echo).toBeString();
      expect(await new Bun.Image(stats).metadata()).toMatchObject({ format: "png" });
      refused.respond(null, "failed");
      await Bun.sleep(75);
      expect(onebot.calls).toHaveLength(0);
      expect(await Bun.file(join(root, "requests.json")).exists()).toBe(false);

      sendOneBot("%角色记录2");
      const accepted = await onebot.next("send_msg");
      expect(accepted.echo).toBeString();
      accepted.respond({ message_id: 160 });
      const summary = await onebot.next("send_msg");
      expect(JSON.stringify(summary.params)).toContain("档案 2");
      expect(JSON.stringify(summary.params)).toContain("原装母带");
      expect(await Bun.file(join(root, "requests.json")).json()).toEqual(["123456789"]);

      sendOneBot("%逐抽记录4");
      const archive = await onebot.next("send_private_forward_msg");
      archive.respond({ message_id: 162 });
      await Bun.sleep(50);
      while (onebot.calls.length) {
        const batch = await onebot.next("send_private_forward_msg");
        batch.respond({ message_id: 163 });
        await Bun.sleep(50);
      }
      expect(await new Bun.Image(imageBytes(archive.params)).metadata()).toMatchObject({ format: "png" });
      sendOneBot("%逐抽记录5");
      const conflicting = await onebot.next("send_msg");
      expect(JSON.stringify(conflicting.params)).toContain("还没有绝区零逐抽记录");
      expect(await Bun.file(join(root, "requests.json")).json()).toEqual(["123456789"]);
    }, 30_000, preload + physicalRenderingPreload, async root => {
      await sources(root);
      const theme = join(root, "data", "zzz", "gacha-theme");
      const graphics = [
        "common/images/bg.jpg", "common/images/SuitBg.png", "common/images/UIDBg.png", "common/images/RANK_S.png",
        "gachalog/images/IconTabUP.png", "gachalog/images/bg1.png", "gachalog/images/bg2.png", "gachalog/images/bg3.png",
        ...[4, 1, 16, 12, 6].map(number => `gachalog/images/emoji/${number}.png`),
      ];
      await Promise.all([...graphics, "common/fonts/inpinhongmengti.ttf"].map(async file => {
        const destination = join(theme, file);
        await mkdir(dirname(destination), { recursive: true });
        if (file.endsWith(".ttf")) await cp("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", destination);
        else await writeFile(destination, Uint8Array.fromBase64(avatar));
      }));
      const uid = "123456789";
      const profile = (id: number, account: string) => `user: { qq: "42" }
profile: { id: ${id} }
account:
${account}  game_roles: { zzz: [{ uid: "${uid}", nickname: "样本42", level: 60 }] }
  current_uid: { zzz: "${uid}" }
`;
      const current = "  cookie: cookie_token_v2=fixture; ltuid_v2=42\n  stoken: fixture-stoken\n";
      await Promise.all([
        writeFile(join(root, "profiles", "42-3.yaml"), profile(3, "")),
        writeFile(join(root, "profiles", "42-4.yaml"), profile(4, current)),
        writeFile(join(root, "profiles", "42-5.yaml"), profile(5, current + "  stuid: \"43\"\n")),
      ]);
      const summaries = join(root, "data", "zzzTuningStats", "42");
      const flat = join(root, "data", "ZZZ-Plugin", "gacha");
      await Promise.all([mkdir(summaries, { recursive: true }), mkdir(flat, { recursive: true })]);
      await Promise.all([
        writeFile(join(summaries, uid + ".json"), JSON.stringify({
          version: 1, uid, region: "prod_gf_cn", profileId: 2, currentVersion: "1.2",
          totalDraws: 25, totalS: 0, inventory: { masterTape: 20 }, updatedAt: "2026-11-20T01:00:00.000Z",
          pools: Object.entries(zzzTuningPools).map(([type, { name }]) => ({ type, name,
            totalDraws: 5, totalS: 0, upCount: null, averageUp: null, pity: null,
            guaranteedWithin: null, records: [], periods: [] })),
        })),
        writeFile(join(flat, uid + ".json"), JSON.stringify({ "独家频段": [{
          uid, id: "9223372036854775807", gacha_id: "51430", gacha_type: "2", item_id: "14101", count: "1",
          time: "2026-01-05 02:30:00", name: "样本代理人", lang: "zh-cn", item_type: "代理人", rank_type: "4",
        }] })),
      ]);
    });
}, 90_000);
