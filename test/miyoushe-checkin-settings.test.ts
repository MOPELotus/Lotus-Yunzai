import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMiyousheWeb, MiyousheSettingsError, type MiyousheCheckinSettings } from "../lib/miyoushe-web.ts";

const origin = new URL("https://miyoushe.example.org/");
const currentRevision = "a".repeat(64);
const nextRevision = "b".repeat(64);
const games = { genshin: true, honkai_sr: true, zzz: false, honkai3rd: false, honkai2: false, tears_of_themis: false };
const initial = { revision: currentRevision, enabled: false, notify: true, community: false, games } satisfies MiyousheCheckinSettings;

test("签到设置同档读写和权限，保留各独立开关并拒绝非受支持的字段", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-miyoushe-checkin-"));
  const active = new AbortController().signal;
  const data = new Map<number, MiyousheCheckinSettings>([
    [1, { ...initial, canEnable: false, cnEnabled: false }], [2, { ...initial, canEnable: true }],
  ]);
  let changeLogin = false;
  let writing = 0;
  const web = createMiyousheWeb({
    origin: () => origin, databasePath: join(directory, "sessions.sqlite"), assetDirectory: "web/miyoushe", signal: active,
    async loginIdentity(_qq, id) { return "session-for-" + id + ":" + changeLogin; },
    async overview({ profileId }) { return { profileId, displayName: "测试", account: { deviceBound: true, loggedIn: true, roles: [] },
      todaySchedule: null, missions: null }; },
    checkinSettings: {
      async read({ qq, profileId }, _signal, verifyLogin) {
        expect(qq).toBe("42");
        await verifyLogin();
        return { ...data.get(profileId)!, unrelated: "secret fixture",
          games: { ...data.get(profileId)!.games, hna: true } };
      },
      async save({ qq, profileId }, patch, _signal, verifyLogin) {
        expect(qq).toBe("42");
        const previous = data.get(profileId)!;
        if (!previous.enabled && patch.enabled && !previous.canEnable) throw new MiyousheSettingsError(403, "当前无权开启签到。");
        if (previous.revision !== patch.revision) throw new MiyousheSettingsError(409, "已变化。");
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
    expect(await (await request(one))?.json()).toEqual({ ...initial, canEnable: false, cnEnabled: false });
    expect((await request(two, undefined, { site: "same-site" }))?.status).toBe(403);
    expect((await request(two, undefined, { part: "checkin-settings?profile=1" }))?.status).toBe(404);
    expect((await request(one, { ...initial, enabled: true }))?.status).toBe(403);
    expect((await request(two, { ...initial, enabled: true }, { from: "https://other.example.org" }))?.status).toBe(403);
    for (const patch of [{ ...initial, time: "04:30" }, { ...initial, profileId: 1 }, { ...initial, cnEnabled: true },
      { ...initial, games: { ...games, hna: true } }, { ...initial, games: { ...games, honkai_sr: "false" } },
      { ...initial, community: { like: true } }]) {
      expect((await request(two, patch))?.status).toBe(400);
    }
    expect(writing).toBe(0);
    const saved = { ...initial, enabled: true, notify: false, community: true, games: { ...games, honkai2: true } };
    expect(await (await request(two, saved))?.json()).toMatchObject({ ...saved, revision: nextRevision });
    expect(data.get(1)).toMatchObject({ cnEnabled: false, enabled: false, community: false });
    expect((await request(two, saved))?.status).toBe(409);
    expect((await request(two, { ...saved, revision: nextRevision, games: { ...saved.games, tears_of_themis: true } }))?.status).toBe(401);
    expect((await request(two))?.status).toBe(401);
    expect(data.get(2)?.games.tears_of_themis).toBe(false);
    expect(writing).toBe(1);
  } finally {
    web.close();
    await rm(directory, { recursive: true, force: true });
  }
});
