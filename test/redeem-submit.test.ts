import { expect, test } from "bun:test";
import type { Game, ProfileAccountContext } from "@lotus-yunzai/account";
import { previewRedeemIdentity, submitPreviewCode, type PreviewRedeemStatus } from "../packages/hoyo-client/redeem-submit.ts";

const role = { uid: "123456789", region: "cn_gf01" };
const legacy = "account_id=77; cookie_token=test-legacy-token";
const modern = "account_id_v2=77; account_mid_v2=test-mid; cookie_token_v2=v2_test";

function profile(cookie: string = legacy, extra: Partial<ProfileAccountContext["account"]> = {}): ProfileAccountContext {
  return {
    qq: "42", profileId: 1, revision: "test-revision",
    account: { cookie, stuid: "77", ltuid: "77", ltoken: "", mid: "", stoken: "", stokenCookie: "", ...extra },
    device: { id: "", fp: "", name: "", model: "", androidVersion: "", raw: {} },
  };
}

test("submits the fixed legacy endpoint, region and query for each China-server game", async () => {
  for (const [game, host, biz, region] of [
    ["gs", "hk4e-api.mihoyo.com", "hk4e_cn", "cn_qd01"],
    ["sr", "public-operation-hkrpg.mihoyo.com", "hkrpg_cn", "prod_gf_cn"],
    ["zzz", "public-operation-nap.mihoyo.com", "nap_cn", "prod_qd_cn"],
  ] as const) {
    const events: string[] = [];
    const result = await submitPreviewCode(profile(), game, { ...role, region }, "LOTUS_测试1", async (url, init) => {
      events.push("send");
      expect(url.origin).toBe(`https://${host}`);
      expect(url.pathname).toBe("/common/apicdkey/api/webExchangeCdkey");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        cdkey: "LOTUS_测试1", game_biz: biz, region, uid: role.uid, lang: "zh-cn", t: expect.stringMatching(/^\d+$/u),
      });
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      expect(init.credentials).toBe("omit");
      expect(init.signal?.aborted).toBe(false);
      const headers = new Headers(init.headers);
      expect(headers.get("referer")).toBe("https://webstatic.mihoyo.com/");
      expect(headers.get("cookie")).toBe(legacy);
      expect(headers.get("accept")).toBe("application/json");
      return Response.json({ retcode: 0, data: {} });
    }, undefined, async () => { events.push("verify"); });
    expect(result).toEqual({ status: "succeeded" });
    expect(events).toEqual(["verify", "send"]);
  }
});

test("forwards only the approved fields of matching token families", async () => {
  const publicFields = `${modern}; ltuid=77; ltoken=sample-ltoken; ltuid_v2=77; ltmid_v2=test-mid; ltoken_v2=v2_sample-ltoken; mid=test-mid`;
  const source = profile(`${publicFields}; stoken=private-a; stuid=77; uid=77; theme=dark; ds_cookie=private-b`, {
    mid: "test-mid", stoken: "private-c", stokenCookie: "stuid=77; stoken=private-d; stmid_v2=test-mid",
  });
  expect(previewRedeemIdentity(source)).toBe("77");
  const reply = await submitPreviewCode(source, "gs", role, "EXAMPLE", async (_url, init) => {
    expect(new Headers(init.headers).get("cookie")).toBe(publicFields);
    return Response.json({ retcode: 0 });
  });
  expect(reply.status).toBe("succeeded");
  expect(previewRedeemIdentity(profile(`${legacy}; account_id=77`))).toBe("77");
  expect(previewRedeemIdentity(profile(legacy, { stuid: "", ltuid: "" }))).toBe("77");
});

test("stops before preflight or transport on mismatched identities, malformed cookies, invalid codes or foreign roles", async () => {
  const badProfiles = [
    profile(`${legacy}; account_id=88`), profile(`${legacy}; uid=88`), profile(`${legacy}; login_uid=88`),
    profile(`${legacy}; cookie_token=other`), profile(`${legacy}; cookie_token`),
    profile(`${legacy}; other=\r\nInjected: yes`), profile("account_id=77; cookie_token=quoted \"token\""),
    profile("ltuid=77; ltoken=test"), profile("account_id=77; cookie_token=v2_test"),
    profile("account_id_v2=77; cookie_token_v2=v2_test"), profile(`${modern}; ltoken_v2=v2_orphan`),
    profile(modern, { mid: "foreign-mid" }), profile(legacy, { ltuid: "88" }),
    profile(legacy, { stokenCookie: "stuid=88; stoken=test" }),
  ];
  const forbidden = async (): Promise<never> => { throw new Error("A blocked request must never reach this hook"); };
  for (const source of badProfiles) {
    expect(previewRedeemIdentity(source)).toBeUndefined();
    expect(await submitPreviewCode(source, "gs", role, "EXAMPLE", forbidden, undefined, forbidden)).toEqual({ status: "blocked" });
  }
  const source = profile();
  expect(await submitPreviewCode(source, "gs", { ...role, region: "prod_gf_cn" }, "EXAMPLE", forbidden)).toEqual({ status: "blocked" });
  expect(await submitPreviewCode(source, "sr", { ...role, region: "prod_official_usa" }, "EXAMPLE", forbidden)).toEqual({ status: "blocked" });
  expect(await submitPreviewCode(source, "zzz", { ...role, uid: "123&role=456", region: "prod_gf_cn" }, "EXAMPLE", forbidden)).toEqual({ status: "blocked" });
  expect(await submitPreviewCode(source, "bh3" as Game, role, "EXAMPLE", forbidden)).toEqual({ status: "blocked" });
  for (const invalid of ["", "code&lang=es", "two codes", "X".repeat(65)]) {
    expect(await submitPreviewCode(source, "gs", role, invalid, forbidden)).toEqual({ status: "invalid" });
  }
});

test("classifies verified API outcomes and never retries uncertain responses", async () => {
  const cases: ReadonlyArray<readonly [() => Response, PreviewRedeemStatus]> = [
    [() => Response.json({ retcode: 0 }), "succeeded"],
    [() => Response.json({ retcode: 0, data: { msg: "该兑换码已经被使用" } }), "already-used"],
    [() => Response.json({ retcode: -999, message: "Already redeemed" }), "already-used"],
    [() => Response.json({ retcode: -2001 }), "expired"],
    [() => Response.json({ retcode: -2003 }), "invalid"],
    ...[-2016, -1071, -1033, -1035].map(retcode => [() => Response.json({ retcode }), "blocked"] as const),
    ...[401, 403, 429].map(status => [() => new Response("blocked", { status }), "blocked"] as const),
    [() => Response.json({ retcode: -999, message: "未使用" }), "unknown"],
    [() => Response.json({ message: "已经使用" }), "unknown"],
    [() => Response.json({ retcode: "0" }), "unknown"],
    [() => new Response("<html>redirect</html>"), "unknown"],
    [() => new Response("error", { status: 500 }), "unknown"],
    [() => Response.redirect("https://example.invalid/redirect-target"), "unknown"],
    [() => Response.json({ retcode: 0 }, { headers: { "Content-Length": "65537" } }), "unknown"],
  ];
  for (const [response, status] of cases) {
    let requests = 0;
    const result = await submitPreviewCode(profile(), "gs", role, "EXAMPLE", async () => {
      requests++;
      return response();
    });
    expect(result).toEqual({ status });
    expect(requests).toBe(1);
  }
});

test("separates preflight refusal from an uncertain dispatch", async () => {
  const source = profile();
  const changed = new Error("profile changed");
  let attempts = 0;
  const transport = async () => { attempts++; throw new Error("connection closed"); };
  await expect(submitPreviewCode(source, "gs", role, "EXAMPLE", transport, undefined, async () => {
    throw changed;
  })).rejects.toBe(changed);
  expect(attempts).toBe(0);
  const preflightAbort = new AbortController();
  await expect(submitPreviewCode(source, "gs", role, "EXAMPLE", transport, preflightAbort.signal, async () => {
    preflightAbort.abort(changed);
  })).rejects.toBe(changed);
  expect(attempts).toBe(0);
  expect(await submitPreviewCode(source, "gs", role, "EXAMPLE", transport)).toEqual({ status: "unknown" });
  expect(attempts).toBe(1);
  const activeAbort = new AbortController();
  const result = await submitPreviewCode(source, "gs", role, "EXAMPLE", async () => {
    activeAbort.abort(changed);
    return Response.json({ retcode: 0 });
  }, activeAbort.signal);
  expect(result).toEqual({ status: "unknown" });
});
