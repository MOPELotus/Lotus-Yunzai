import { expect, test } from "bun:test";
import { readLegacyPanelRecovery } from "../lib/legacy-panel-recovery.ts";

const uid = "123450001";
const qq = "730521";
const signal = () => new AbortController().signal;
const raw = (game: "gs" | "sr") => {
  const id = game === "gs" ? 10000046 : 1102;
  return { uid, avatars: { [id]: { id, name: "合成角色", level: 80, _source: game === "gs" ? "enka" : "EnkaHSR", artis: {} } } };
};
const success = (playerData: unknown) => Response.json({ retcode: 100, data: { playerData } });

test("旧首次拉档只调用固定只读接口，不携带 Cookie 或令牌", async () => {
  for (const game of ["gs", "sr"] as const) {
    const expected = raw(game);
    const result = await readLegacyPanelRecovery({ game, uid, qq }, signal(), async (url, init) => {
      expect(url.href).toBe("https://ark.ivny.cn/panel/data");
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
      expect(init.credentials).toBe("omit");
      expect(init.referrerPolicy).toBe("no-referrer");
      expect([...new Headers(init.headers).keys()]).toEqual(["accept", "content-type"]);
      expect(JSON.parse(String(init.body))).toEqual({ uid, type: game, qq: Number(qq), version: "2.1.0" });
      return success(game === "gs" ? expected : { ...expected, uid: Number(uid) });
    });
    expect(result).toEqual({ state: "ready", playerData: game === "gs" ? expected : { ...expected, uid: Number(uid) } });
  }
});

test("旧端未验证、没有历史和其他错误分别处理", async () => {
  for (const [code, state] of [[304, "unverified"], [307, "missing"], [103, "unavailable"], [201, "unavailable"]] as const) {
    expect(await readLegacyPanelRecovery({ game: "gs", uid, qq }, signal(), async () => Response.json({ retcode: code })))
      .toEqual({ state });
  }
  expect(await readLegacyPanelRecovery({ game: "gs", uid, qq }, signal(), async () => { throw new Error("offline"); }))
    .toEqual({ state: "unavailable" });
  for (const identity of [{ uid: "123450001/other" }, { uid: "123450001?raw=1" }, { qq: "730521 " }, { qq: "9999999999999999" }]) {
    let called = false;
    expect(await readLegacyPanelRecovery({ game: "gs", uid, qq, ...identity }, signal(), async () => {
      called = true;
      return success(raw("gs"));
    })).toEqual({ state: "invalid" });
    expect(called).toBe(false);
  }
});

test("拒绝错误档案、异常归档、凭据、大小超限和重定向", async () => {
  for (const playerData of [
    { ...raw("gs"), uid: "123450002" },
    { avatars: raw("gs").avatars },
    { ...raw("gs"), avatars: [] },
    { ...raw("gs"), avatars: { wrong: { id: "wrong" } } },
    { ...raw("gs"), avatars: { "10000046": { id: 10000045 } } },
    { ...raw("gs"), cookie: "仅测试" },
    { ...raw("gs"), avatars: { "10000046": { id: 10000046, weapon: { "AUTH-KEY": "仅测试" } } } },
    { ...raw("gs"), avatars: { "10000046": { id: 10000046, artis: [{ attr: { stoken_v2: "仅测试" } }] } } },
    { ...raw("gs"), extra: "x".repeat(2 * 1024 * 1024) },
    JSON.stringify(raw("gs")),
  ]) {
    expect(await readLegacyPanelRecovery({ game: "gs", uid, qq }, signal(), async () => success(playerData)))
      .toEqual({ state: "invalid" });
  }
  const mismatch = success(raw("gs"));
  Object.defineProperty(mismatch, "url", { value: "https://another.example.invalid/panel/data" });
  for (const response of [Response.redirect("https://another.example.invalid"), mismatch]) {
    expect(await readLegacyPanelRecovery({ game: "gs", uid, qq }, signal(), async () => response))
      .toEqual({ state: "unavailable" });
  }
  for (const response of [new Response("<bad>"), new Response(Uint8Array.of(0xc0), { headers: { "Content-Type": "application/json" } }),
    Response.json({ retcode: 100 }, { headers: { "Content-Length": "2097153" } })]) {
    expect(await readLegacyPanelRecovery({ game: "gs", uid, qq }, signal(), async () => response))
      .toEqual({ state: "invalid" });
  }
});
