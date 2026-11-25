import { linkHostPackages } from "./host-fixture.ts";
import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createProfileStore, forGameCommandSender, gameCommandProfileId, withGameCommandProfiles } from "@lotus-yunzai/account";
import { createGameProfileDefaults } from "../lib/game-profile-defaults.ts";
import { lockFile } from "../lib/file-lock.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const gameRoles = {
  gs: ["100000101", "100000102"],
  sr: ["100001101", "100001103"],
  zzz: ["82000101", "82000104"],
} as const;
const groups = ["gs", "sr", "zzz"] as const;
const preferencesPath = "data/account/game-defaults";

function archive(qq: number, id: number, credentials: number, uids: Partial<Record<keyof typeof gameRoles, string>>) {
  const game_roles = Object.fromEntries(groups.map(game => {
    const uid = uids[game];
    return [game, uid ? [{ uid, nickname: "样本", level: 60,
      region: game === "gs" ? "cn_gf01" : "prod_gf_cn",
      game_biz: game === "gs" ? "hk4e_cn" : game === "sr" ? "hkrpg_cn" : "nap_cn" }] : []];
  }));
  return Bun.YAML.stringify({ user: { qq: String(qq) }, profile: { id },
    device: { id: `fixture-device-${qq}-${id}`, fp: "0123456789abc", bound: true }, account: {
    stuid: String(credentials), stoken: "fixture-stoken", cookie: `account_id=${credentials}; ltoken=fixture-cookie`,
    current_uid: uids, game_roles,
  } });
}

test("默认档案按本人、游戏和会话分层，授权撤回后撤去默认覆盖", async () => {
  let allowed = true;
  const scope = { user: 42, profiles: { gs: 2, sr: 3 }, isCurrent: () => allowed };
  await withGameCommandProfiles(scope, async () => {
    await Promise.resolve();
    expect(gameCommandProfileId("gs")).toBe(2);
    expect(gameCommandProfileId("gs", 1)).toBe(1);
    expect(gameCommandProfileId("sr", "2")).toBe(2);
    expect(gameCommandProfileId("zzz")).toBe(1);
    expect(forGameCommandSender(43, false, () => gameCommandProfileId("gs"))).toBe(1);
    expect(forGameCommandSender(42, true, () => gameCommandProfileId("sr"))).toBe(1);
    expect(forGameCommandSender(42, false, () => gameCommandProfileId("sr"))).toBe(3);
    allowed = false;
    expect(gameCommandProfileId("sr")).toBe(1);
  });
  expect(gameCommandProfileId("gs")).toBe(1);
});

test("默认档与本人的账号身份绑定，换号、清除和归档后失效", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-game-default-store-"));
  try {
    const dir = join(root, "profiles");
    await mkdir(dir);
    const initial = archive(42, 2, 4202, { gs: gameRoles.gs[1] });
    const path = join(dir, "42-2.yaml");
    await Bun.write(path, initial);
    const profiles = createProfileStore(dir);
    const service = createGameProfileDefaults(join(root, "defaults"), profiles, lockFile);
    const revision = (await profiles.roleCatalog("42", 2)).revision;
    const scope = { user: 42, signal: new AbortController().signal, isCurrent: () => true };
    expect(await service.select("gs", 2, gameRoles.gs[1], revision, { ...scope, isCurrent: () => false })).toBe(false);
    expect(await service.select("gs", 2, gameRoles.gs[0], revision, scope)).toBe(false);
    expect(await service.select("gs", 2, gameRoles.gs[1], revision, { ...scope, user: 43 })).toBe(false);
    expect(await service.select("gs", 2, gameRoles.gs[1], revision, scope)).toBe(true);
    expect(await service.read("42")).toEqual({ gs: 2 });
    expect(await service.read("43")).toEqual({});
    const saved = await Bun.file(join(root, "defaults", "42", "1.json")).text();
    expect(saved).not.toContain("4202");
    expect(saved).not.toContain("fixture");

    await Bun.write(path, archive(42, 2, 9999, { gs: gameRoles.gs[1] }));
    expect(await service.read("42")).toEqual({});
    await Bun.write(path, initial);
    await profiles.clearLogin("42", 2);
    expect(await service.read("42")).toEqual({});
    await Bun.write(path, initial);
    await rename(path, join(dir, "42-2.archive"));
    expect(await service.read("42")).toEqual({});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OneBot 与 Milky 切三游本人账号档案，重启保留，指定档案1与分游戏归档正确", async () => {
  const preload = `
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
Bun.env.LOTUS_PASSPORT_QR_RESOURCES = "./missing-render-fixture";
Bun.env.LOTUS_GENSHIN_SHOWCASE_SERVER = "0";
Bun.env.LOTUS_STAR_RAIL_SHOWCASE_SERVER = "0";
const builtinFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1") return builtinFetch(input, options);
  const publicUid = url.pathname.split("/").at(-1);
  if (["profile.microgg.cn", "api.mihomo.me"].includes(url.hostname) && /^[0-9]+$/.test(publicUid ?? "")) {
    const headers = new Headers(options?.headers);
    if (headers.has("Cookie") || headers.has("Authorization")) throw Error("public queries must have no credentials");
    await Bun.write("./queried-public-uid.txt", publicUid);
    return new Response(null, { status: 404 });
  }
  await Bun.write("./unexpected-network.txt", "attempted");
  throw Error("fixture forbids outbound network");
}, { preconnect: builtinFetch.preconnect });
`;
  const persisted = await mkdtemp(join(tmpdir(), "lotus-game-default-restart-"));
  const prepare = async (root: string) => {
    await linkHostPackages(root);
    for (const name of ["genshin", "starrail", "zzz"]) {
      const source = join(import.meta.dir, "../plugins", name), target = join(root, "plugins", name);
      await cp(source, target, { recursive: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
      await symlink(join(source, "node_modules"), join(target, "node_modules"), "dir");
    }
  };
  let sequence = 200;
  async function checkReply(
    root: string,
    next: () => Promise<{ params: unknown; respond: (data: unknown) => void }>,
    expected: string,
    confirm: () => { message_id: number } | { message_seq: number },
  ) {
    const queried = join(root, "queried-public-uid.txt");
    await writeFile(queried, "");
    let reply = await next();
    const message = JSON.stringify(reply.params);
    if (message.includes("仅发送游戏 UID") || message.includes("查询此绑定 UID 的公开展板")) {
      reply.respond(confirm());
      reply = await next();
      expect(await readFile(queried, "utf8")).toBe(expected);
      expect(JSON.stringify(reply.params)).toMatch(/暂无原神角色面板|公开星铁展板未找到此角色/u);
    } else {
      expect(message).toContain(expected);
    }
    expect(JSON.stringify(reply.params)).not.toContain("fixture-cookie");
    reply.respond(confirm());
  }
  try {
    await withDualGatewayFixture("game-account-default-contract", "disablePrivate: false\n", async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
      const one = async (command: string, expected: string) => {
        sendOneBot(command);
        await checkReply(root, () => onebot.next("send_msg"), expected, () => ({ message_id: sequence++ }));
      };
      const milkyReply = async (command: string, expected: string, user = 42) => {
        expect((await sendMilky(command, { sender_id: user, peer_id: user })).status).toBe(200);
        await checkReply(root, async () => {
          const reply = await milky.next("send_private_message");
          expect(reply.params).toMatchObject({ user_id: user });
          return reply;
        }, expected, () => ({ message_seq: sequence++ }));
      };
      await one("#面板", gameRoles.gs[0]);
      await milkyReply("*面板", gameRoles.sr[0]);
      await one("%面板", gameRoles.zzz[0]);
      await one("#UID2", "原神默认档案为 2");
      await milkyReply("*UID2", "星铁默认档案为 3");
      await one("%UID2", "绝区零默认档案为 4");
      await milkyReply("#面板", gameRoles.gs[1]);
      await one("*面板", gameRoles.sr[1]);
      await milkyReply("/zzz面板", gameRoles.zzz[1]);
      await milkyReply("#UID1 档案1", "档案 1 · 原神当前角色已选为");
      await one("#原神面板", gameRoles.gs[1]);
      await one("#面板1", gameRoles.gs[0]);
      await milkyReply("*面板1", gameRoles.sr[0]);
      await one("%面板1", gameRoles.zzz[0]);
      await milkyReply("#面板", "100000131", 43);
      expect(await Bun.file(join(root, "unexpected-network.txt")).exists()).toBe(false);
      await cp(join(root, "profiles"), join(persisted, "profiles"), { recursive: true });
      await cp(join(root, preferencesPath), join(persisted, "defaults"), { recursive: true });
    }, 3000, preload, async root => {
      await prepare(root);
      const profiles = join(root, "profiles");
      await mkdir(profiles);
      await Bun.write(join(profiles, "42.yaml"), archive(42, 1, 4201, { gs: gameRoles.gs[0], sr: gameRoles.sr[0], zzz: gameRoles.zzz[0] }));
      await Bun.write(join(profiles, "42-2.yaml"), archive(42, 2, 4202, { gs: gameRoles.gs[1] }));
      await Bun.write(join(profiles, "42-3.yaml"), archive(42, 3, 4203, { sr: gameRoles.sr[1] }));
      await Bun.write(join(profiles, "42-4.yaml"), archive(42, 4, 4204, { zzz: gameRoles.zzz[1] }));
      await Bun.write(join(profiles, "43.yaml"), archive(43, 1, 4301, { gs: "100000131" }));
    });

    await withDualGatewayFixture("game-account-default-restart", "disablePrivate: false\n", async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
      const one = async (command: string, expected: string) => {
        sendOneBot(command);
        await checkReply(root, () => onebot.next("send_msg"), expected, () => ({ message_id: sequence++ }));
      };
      await one("#面板", gameRoles.gs[1]);
      await one("*面板", gameRoles.sr[1]);
      await one("%面板", gameRoles.zzz[1]);
      await rename(join(root, "profiles", "42-2.yaml"), join(root, "profiles", "42-2.archived"));
      await one("#原神面板", gameRoles.gs[0]);
      await one("#面板2", "请先登录档案 2");
      await one("#星铁面板", gameRoles.sr[1]);
      expect((await sendMilky("%UID1", { sender_id: 42, peer_id: 42 })).status).toBe(200);
      const reset = await milky.next("send_private_message");
      expect(JSON.stringify(reset.params)).toContain("绝区零默认档案为 1");
      reset.respond({ message_seq: sequence++ });
      await one("#绝区零面板", gameRoles.zzz[0]);
      expect(await Bun.file(join(root, "unexpected-network.txt")).exists()).toBe(false);
    }, 3000, preload, async root => {
      await prepare(root);
      await cp(join(persisted, "profiles"), join(root, "profiles"), { recursive: true });
      await mkdir(join(root, "data", "account"), { recursive: true });
      await cp(join(persisted, "defaults"), join(root, preferencesPath), { recursive: true });
    });
  } finally {
    await rm(persisted, { recursive: true, force: true });
  }
}, 20_000);
