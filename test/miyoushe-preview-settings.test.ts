import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMiyousheWeb, MiyoushePreviewSettingsError, type MiyoushePreviewSettings } from "../lib/miyoushe-web.ts";

const origin = new URL("https://miyoushe.example.org");
const revision = "a".repeat(64);
const nextRevision = "b".repeat(64);
const initial = { enabled: false, games: ["gs", "zzz"], revision } satisfies MiyoushePreviewSettings;
const scope = new AbortController().signal;

async function fixture(use: (context: {
  web: ReturnType<typeof createMiyousheWeb>; records: Map<string, MiyoushePreviewSettings>;
  login: Map<string, string>; issueCookie: (user: number, profile: number) => Promise<string>;
  pauseSave: (run: () => Promise<void>) => void;
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-preview-settings-"));
  const records = new Map<string, MiyoushePreviewSettings>([
    ["42:2", initial], ["42:1", { ...initial, games: ["sr"] }], ["43:1", { ...initial, games: ["gs"], canEnable: false }],
  ]);
  const login = new Map([...records.keys()].map(key => [key, key]));
  let beforeSave: (() => Promise<void>) | undefined;
  const web = createMiyousheWeb({
    publicBase: () => origin, databasePath: join(directory, "auth.sqlite"), assetDirectory: "web/miyoushe", signal: scope,
    async loginIdentity(qq, profileId) { return login.get(qq + ":" + profileId) ?? ""; },
    async overview({ profileId }) { return { profileId, displayName: "测试档案", account: { loggedIn: true, deviceBound: true, roles: [] },
      todaySchedule: null, missions: null }; },
    previewSettings: {
      async read({ qq, profileId }, _signal, verify) {
        await verify();
        return { ...records.get(qq + ":" + profileId)!, unrelated: "forbidden" };
      },
      async save({ qq, profileId }, patch, _signal, verify) {
        const key = qq + ":" + profileId;
        const previous = records.get(key)!;
        if (patch.revision !== previous.revision) throw new MiyoushePreviewSettingsError(409, "设置已变化，请刷新。");
        if (!previous.enabled && previous.canEnable === false && patch.enabled) {
          throw new MiyoushePreviewSettingsError(403, "当前没有开启权限。");
        }
        await beforeSave?.();
        await verify();
        const result = { ...previous, enabled: patch.enabled, games: patch.games, revision: nextRevision };
        records.set(key, result);
        return result;
      },
    },
  });
  async function issueCookie(user_id: number, profile: number) {
    const command = "#米游社功能" + profile;
    const reply = await web.commands.fallback!(command, {
      message_type: "private", self_id: 99, user_id, isMaster: false, normalizedMessage: command,
      privateCredentialSignal: scope, reply: () => true, isBotMaster: () => false,
    });
    const ticket = /#ticket=([\w-]{43})/u.exec(String(reply))?.[1];
    expect(ticket).toBeString();
    const response = await web.handle(new Request(new URL("/miyoushe/api/claim", origin), { method: "POST",
      headers: { Origin: origin.origin, "Content-Type": "application/json" }, body: JSON.stringify({ ticket }) }));
    expect(response?.status).toBe(204);
    return response!.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  }
  try { await use({ web, login, records, issueCookie, pauseSave(run) { beforeSave = run; } }); }
  finally { web.close(); await rm(directory, { recursive: true, force: true }); }
}

function get(cookie?: string, site = "same-origin", path = "preview-settings") {
  return new Request(new URL("/miyoushe/api/" + path, origin), {
    headers: { "Sec-Fetch-Site": site, ...(cookie && { Cookie: cookie }) },
  });
}

function post(cookie: string, input: unknown, from = origin.origin) {
  return new Request(new URL("/miyoushe/api/preview-settings", origin), {
    method: "POST", headers: { Cookie: cookie, Origin: from, "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
}

test("前瞻设置复用同档会话，校验写入权限和来源，关闭时仍保留游戏选择", async () => {
  await fixture(async ({ web, records, issueCookie }) => {
    expect((await web.handle(get()))?.status).toBe(401);
    const two = await issueCookie(42, 2), one = await issueCookie(42, 1), blocked = await issueCookie(43, 1);
    const overview = await web.handle(get(two, "same-origin", "overview"));
    expect(await overview?.json()).toMatchObject({ previewSettingsAvailable: true });
    const reading = await web.handle(get(two));
    expect(reading?.headers.get("Cache-Control")).toBe("no-store");
    expect(await reading?.json()).toEqual({ ...initial, canEnable: true, waitingForHistory: false });
    expect(await (await web.handle(get(one)))?.json()).toMatchObject({ games: ["sr"] });
    expect((await web.handle(get(two, "same-site")))?.status).toBe(403);
    expect((await web.handle(get(two, "same-origin", "preview-settings?profile=1")))?.status).toBe(404);
    expect((await web.handle(post(two, { ...initial, enabled: true }, "https://other.example.org")))?.status).toBe(403);
    expect((await web.handle(post(blocked, { ...initial, enabled: true })))?.status).toBe(403);
    for (const data of [{ ...initial, qq: "43" }, { ...initial, profileId: 1 }, { ...initial, games: ["bh3"] },
      { ...initial, games: ["gs", "gs"] }, { ...initial, revision: "stale" }, { ...initial, enabled: true, games: [] }]) {
      expect((await web.handle(post(two, data)))?.status).toBe(400);
    }
    const choice = { enabled: false, games: ["zzz"], revision };
    expect(await (await web.handle(post(two, choice)))?.json()).toMatchObject({ ...choice, revision: nextRevision });
    expect((await web.handle(post(two, { ...initial, enabled: true })))?.status).toBe(409);
    expect((await web.handle(post(two, { enabled: true, games: ["zzz"], revision: nextRevision })))?.status).toBe(200);
    expect(records.get("42:2")).toMatchObject({ enabled: true, games: ["zzz"] });
    expect(records.get("42:1")).toMatchObject({ enabled: false, games: ["sr"] });
    expect(records.get("43:1")).toMatchObject({ enabled: false, games: ["gs"] });
  });
});

test("写入期间档案换绑使旧会话失效，旧请求不能保存", async () => {
  await fixture(async ({ web, records, login, issueCookie, pauseSave }) => {
    const cookie = await issueCookie(42, 2);
    pauseSave(async () => { login.set("42:2", "rebound"); });
    expect((await web.handle(post(cookie, { ...initial, enabled: true })))?.status).toBe(401);
    expect((await web.handle(get(cookie)))?.status).toBe(401);
    expect(records.get("42:2")).toEqual(initial);
  });
});
