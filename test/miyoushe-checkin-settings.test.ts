import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMiyousheWeb, MiyousheSettingsError, type MiyousheCheckinSettings } from "../lib/miyoushe-web.ts";

const origin = new URL("https://miyoushe.example.org/");
const currentRevision = "a".repeat(64);
const nextRevision = "b".repeat(64);
const games = { genshin: true, honkai_sr: true, zzz: false, honkai3rd: false, honkai2: false, tears_of_themis: false };
const os = { genshin: false, honkai_sr: true, zzz: false, honkai3rd: false, tears_of_themis: true };
const initial = { revision: currentRevision, enabled: false, notify: true, community: false, games,
  forums: [2, 6, 8], cloud: { genshin: false, zzz: true }, osEnabled: false, os } satisfies MiyousheCheckinSettings;

test("签到设置同档读写和权限，保留各独立开关并拒绝非受支持的字段", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-miyoushe-checkin-"));
  const active = new AbortController().signal;
  const data = new Map<number, MiyousheCheckinSettings>([
    [1, { ...initial, canEnable: false, cnEnabled: false }],
    [2, { ...initial, canEnable: true, cloudBound: { genshin: true, zzz: false }, osBound: true }],
  ]);
  let changeLogin = false;
  let writing = 0;
  const web = createMiyousheWeb({
    publicBase: () => origin, databasePath: join(directory, "sessions.sqlite"), assetDirectory: "web/miyoushe", signal: active,
    async loginIdentity(_qq, id) { return "session-for-" + id + ":" + changeLogin; },
    async overview({ profileId }) { return { profileId, displayName: "测试", account: { deviceBound: true, loggedIn: true, roles: [] },
      todaySchedule: null, missions: null }; },
    checkinSettings: {
      async read({ qq, profileId }, _signal, verifyLogin) {
        expect(qq).toBe("42");
        await verifyLogin();
        return { ...data.get(profileId)!, unrelated: "secret fixture",
          games: { ...data.get(profileId)!.games, hna: true },
          cloud: { ...data.get(profileId)!.cloud, token: "fixture cloud token" },
          os: { ...data.get(profileId)!.os, cookie: "fixture cookie", lang: "zh-cn" },
          forums: [...data.get(profileId)!.forums, 7] };
      },
      async save({ qq, profileId }, patch, _signal, verifyLogin) {
        expect(qq).toBe("42");
        const previous = data.get(profileId)!;
        if (!previous.enabled && patch.enabled && !previous.canEnable) throw new MiyousheSettingsError(403, "当前无权开启签到。");
        if (previous.revision !== patch.revision) throw new MiyousheSettingsError(409, "已变化。");
        for (const game of ["genshin", "zzz"] as const) if (patch.cloud[game] && !previous.cloud[game] && !previous.cloudBound?.[game]) {
          throw new MiyousheSettingsError(409, "请先在聊天中绑定。");
        }
        if (patch.games.tears_of_themis) changeLogin = true;
        await verifyLogin();
        writing++;
        const result = { ...previous, ...patch, revision: nextRevision };
        data.set(profileId, result);
        return result;
      },
    },
  });
  async function ticket(id: number) {
    const command = "#米游社功能" + id;
    const message = await web.commands.fallback!(command, {
      message_type: "private", self_id: 99, user_id: 42, isMaster: false, normalizedMessage: command,
      privateCredentialSignal: active, reply: () => true, isBotMaster: () => false,
    });
    const token = /#ticket=([\w-]{43})/u.exec(String(message))?.[1];
    const response = await web.handle(new Request(new URL("/miyoushe/api/claim", origin), { method: "POST",
      headers: { Origin: origin.origin, "Content-Type": "application/json" }, body: JSON.stringify({ ticket: token }) }));
    expect(response?.status).toBe(204);
    return response!.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  }
  function request(cookie: string, payload?: unknown, options: { readonly from?: string; readonly part?: string; readonly site?: string } = {}) {
    const hasBody = payload !== undefined;
    return web.handle(new Request(new URL("/miyoushe/api/" + (options.part ?? "checkin-settings"), origin), {
      headers: { Cookie: cookie, Origin: options.from ?? origin.origin, "Sec-Fetch-Site": options.site ?? "same-origin",
        ...(hasBody && { "Content-Type": "application/json" }) },
      ...(hasBody && { method: "POST", body: JSON.stringify(payload) }),
    }));
  }
  try {
    expect((await request(""))?.status).toBe(401);
    const one = await ticket(1), two = await ticket(2);
    expect(await (await request(two, undefined, { part: "overview" }))?.json()).toMatchObject({ checkinSettingsAvailable: true });
    expect(await (await request(one))?.json()).toEqual({
      ...initial, canEnable: false, cnEnabled: false, cloudBound: { genshin: false, zzz: false }, osBound: false,
    });
    expect(await (await request(two))?.json()).toMatchObject({ osBound: true, os });
    expect((await request(two, undefined, { site: "same-site" }))?.status).toBe(403);
    expect((await request(two, undefined, { part: "checkin-settings?profile=1" }))?.status).toBe(404);
    expect((await request(one, { ...initial, enabled: true }))?.status).toBe(403);
    expect((await request(one, { ...initial, cloud: { genshin: true, zzz: false } }))?.status).toBe(409);
    expect((await request(two, { ...initial, enabled: true }, { from: "https://other.example.org" }))?.status).toBe(403);
    for (const patch of [{ ...initial, time: "04:30" }, { ...initial, profileId: 1 }, { ...initial, cnEnabled: true },
      { ...initial, games: { ...games, hna: true } }, { ...initial, games: { ...games, honkai_sr: "false" } },
      { ...initial, community: { like: true } }, { ...initial, forums: [7] }, { ...initial, forums: ["2"] },
      { ...initial, forums: [2, 2] }, { ...initial, cloud: { genshin: false, zzz: "true" } },
      { ...initial, cloud: { ...initial.cloud, token: "injection" } }, { ...initial, cloudBound: { genshin: true, zzz: true } },
      { ...initial, os: { ...os, honkai2: true } }, { ...initial, os: { ...os, cookie: "injection" } },
      { ...initial, os: { ...os, lang: "zh-cn" } }, { ...initial, osEnabled: 1 }, { ...initial, osBound: true }]) {
      expect((await request(two, patch))?.status).toBe(400);
    }
    expect(writing).toBe(0);
    const unbound = { ...initial, osEnabled: true, os: { ...os, honkai3rd: true } };
    expect(await (await request(one, unbound))?.json()).toMatchObject({ ...unbound, revision: nextRevision, osBound: false });
    const saved = { ...initial, enabled: true, notify: false, community: true, games: { ...games, honkai2: true },
      forums: [1, 3, 4, 5, 9, 10], cloud: { genshin: true, zzz: false }, os: { ...os, zzz: true } };
    expect(await (await request(two, saved))?.json()).toMatchObject({ ...saved, revision: nextRevision });
    expect(data.get(1)).toMatchObject({ cnEnabled: false, enabled: false, community: false, osEnabled: true });
    expect((await request(two, saved))?.status).toBe(409);
    expect((await request(two, { ...saved, revision: nextRevision, games: { ...saved.games, tears_of_themis: true } }))?.status).toBe(401);
    expect((await request(two))?.status).toBe(401);
    expect(data.get(2)?.games.tears_of_themis).toBe(false);
    expect(data.get(2)?.cloud).toEqual({ genshin: true, zzz: false });
    expect(data.get(2)?.osEnabled).toBe(false);
    expect(data.get(2)?.os.zzz).toBe(true);
    expect(writing).toBe(2);
  } finally {
    web.close();
    await rm(directory, { recursive: true, force: true });
  }
});
