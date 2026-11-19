import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ProfileAccountContext } from "../packages/account/index.ts";
import {
  readBbsMissionState, submitBbsCheckin, type BbsCheckinForum,
} from "../packages/hoyo-client/bbs-checkin.ts";

const fixture: ProfileAccountContext = {
  qq: "42", profileId: 2, revision: "test-revision",
  account: {
    stuid: "67890", ltuid: "67890", mid: "fixture-mid", stoken: "v2_fixture-login", ltoken: "v2_fixture-ltoken",
    cookie: "ltoken_v2=v2_fixture-ltoken; ltuid_v2=67890; ltmid_v2=fixture-mid; cookie_token_v2=v2_fixture-cookie",
    stokenCookie: "stuid=67890; stoken=v2_fixture-login; mid=fixture-mid",
  },
  device: { id: "fixture-device", fp: "fixture-fp", model: "Fixture", name: "Fixture name", androidVersion: "14", raw: {} },
};

test("固定 Web GET 只发送该账号的普通 Cookie，投影官方任务字段和零值", async () => {
  const trace: string[] = [];
  const source = { ...fixture, account: { ...fixture.account, cookie: fixture.account.cookie + "; stoken=v2_fixture-login; stuid=67890" } };
  const state = await readBbsMissionState(source, async (url, init) => {
    trace.push("get");
    expect(url.href).toBe("https://bbs-api.miyoushe.com/apihub/wapi/getUserMissionsState?point_sn=myb");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("Cookie")).toBe(fixture.account.cookie);
    expect(headers.get("x-rpc-client_type")).toBe("5");
    const [time, nonce, hash] = headers.get("DS")!.split(",");
    expect(nonce).toMatch(/^[a-z0-9]{6}$/u);
    expect(hash).toBe(createHash("md5").update(`salt=4751cb5557bfad5e249e58462c39fb0a&t=${time}&r=${nonce}`).digest("hex"));
    return Response.json({ retcode: 0, data: {
      uid: 67890, total_points: 5, already_received_points: 0, today_total_points: "120",
      states: [
        { mission_id: 58, happened_times: 1, continuous_cycle_times: 6, is_get_award: true, token: "ignored" },
        { mission_id: "59", happened_times: "0", mission: { threshold: 3 }, is_get_award: 0 },
        { mission_id: 79, happened_times: null },
      ],
      extra: "ignored",
    } });
  }, {}, async () => { trace.push("guard"); });
  expect(trace).toEqual(["guard", "get", "guard"]);
  expect(state).toEqual({
    totalPoints: 5, receivedPoints: 0, todayTotalPoints: 120,
    states: [
      { missionId: 58, happenedTimes: 1, continuousCycleTimes: 6, isGetAward: true },
      { missionId: 59, happenedTimes: 0, threshold: 3, isGetAward: false },
      { missionId: 79 },
    ],
  });
});

test("分区 POST 用同档案配对设备和写入凭据，并对实际字符串 body 签名", async () => {
  let calls = 0;
  for (const [retcode, outcome] of [[0, "accepted"], [1008, "already"]] as const) {
    expect(await submitBbsCheckin(fixture, async (url, init) => {
      calls++;
      expect(url.href).toBe("https://bbs-api.miyoushe.com/apihub/app/api/signIn");
      expect(init.method).toBe("POST");
      expect(init.body).toBe('{"gids":"6"}');
      expect(init.redirect).toBe("error");
      const headers = new Headers(init.headers);
      expect(headers.get("Cookie")).toBe(fixture.account.cookie + "; stoken=v2_fixture-login; stuid=67890; mid=fixture-mid");
      expect(headers.get("x-rpc-device_id")).toBe("fixture-device");
      expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
      expect(headers.get("x-rpc-client_type")).toBe("2");
      const [time, nonce, hash] = headers.get("DS")!.split(",");
      expect(Number(nonce)).toBeGreaterThanOrEqual(100001);
      expect(Number(nonce)).toBeLessThan(200000);
      expect(hash).toBe(createHash("md5").update(`salt=t0qEgfub6cvueAPgR5m9aQWWVciEer7v&t=${time}&r=${nonce}&b=${init.body}&q=`).digest("hex"));
      return Response.json({ retcode, data: retcode === 0 ? { gids: 6 } : null });
    }, "6")).toBe(outcome);
  }
  expect(calls).toBe(2);
});

test("冲突账号、冲突 MID 或 STOKEN、缺设备以及非白名单分区均不派发", async () => {
  let calls = 0;
  const transport = async () => { calls++; return Response.json({ retcode: 0 }); };
  for (const account of [
    { ...fixture.account, ltuid: "12345" },
    { ...fixture.account, stokenCookie: fixture.account.stokenCookie + "; stuid=12345" },
    { ...fixture.account, stokenCookie: fixture.account.stokenCookie + "; stmid_v2=other-mid" },
    { ...fixture.account, stoken: "v2_other" },
    { ...fixture.account, cookie: "cookie_token_v2=another-identity-unproven" },
  ]) {
    await expect(submitBbsCheckin({ ...fixture, account }, transport, "6")).rejects.toMatchObject({ code: "invalid-input" });
  }
  await expect(readBbsMissionState({
    ...fixture, account: { ...fixture.account, cookie: fixture.account.cookie + "; account_id_v2=12345" },
  }, transport)).rejects.toMatchObject({ code: "invalid-input" });
  await expect(submitBbsCheckin({ ...fixture, device: { ...fixture.device, fp: "" } }, transport, "6"))
    .rejects.toMatchObject({ code: "invalid-input" });
  for (const value of ["7", "toString", "6?other", 6]) {
    await expect(submitBbsCheckin(fixture, transport, value as BbsCheckinForum)).rejects.toMatchObject({ code: "invalid-input" });
  }
  expect(calls).toBe(0);
});

test("状态异常和写入拒绝分类不泄露远端消息、不把全局状态解释成分区确认", async () => {
  const expired = () => Response.json({ retcode: -100, message: "fixture-secret" });
  await expect(readBbsMissionState(fixture, async () => expired())).rejects.toMatchObject({ reason: "cookie-expired" });
  await expect(submitBbsCheckin(fixture, async () => expired(), "6")).rejects.toMatchObject({ reason: "login-expired" });
  for (const [reply, expected] of [
    [() => new Response(null, { status: 401 }), { code: "http", status: 401 }],
    [() => new Response(null, { status: 429 }), { reason: "rate-limited" }],
    [() => Response.json({ retcode: 10041, message: "fixture-secret" }), { reason: "risk" }],
    [() => Response.json({ retcode: 0, data: { is_risk: true } }), { reason: "risk" }],
    [() => Response.json({ retcode: 0 }, { headers: { "x-rpc-aigis": '{"answer":"fixture-secret"}' } }), { reason: "risk" }],
    [() => Response.json({ retcode: 1008, data: { gids: "8" } }), { code: "response" }],
    [() => Response.json({ retcode: 0, data: { gids: ["6"] } }), { code: "response" }],
    [() => Response.json({ retcode: 0, data: "unrecognized" }), { code: "response" }],
    [() => Response.json({ retcode: 423, message: "fixture-secret" }),
      { code: "api", message: "官方社区接口拒绝请求。" }],
  ] as const) {
    await expect(submitBbsCheckin(fixture, async () => reply(), "6")).rejects.toMatchObject(expected);
  }
  for (const data of [
    {},
    { states: [], uid: 12345 },
    { states: [], total_points: -1 },
    { states: [{ mission_id: 58 }, { mission_id: "58" }] },
    { states: [{ mission_id: 58, is_get_award: "false" }] },
  ]) {
    await expect(readBbsMissionState(fixture, async () => Response.json({ retcode: 0, data })))
      .rejects.toMatchObject({ code: "response" });
  }
  const state = await readBbsMissionState(fixture, async () => Response.json({ retcode: 0, data: { states: [], total_points: null } }));
  expect(state).toEqual({ states: [] });
});

test("中途档案变化屏蔽任何结果，取消、失败、畸形或超大响应均不重放写入", async () => {
  let calls = 0;
  let active = true;
  const changed = new Error("fixture revision changed");
  const guard = async () => { if (!active) throw changed; };
  await expect(submitBbsCheckin(fixture, async () => {
    active = false;
    calls++;
    return Response.json({ retcode: 0 });
  }, "6", {}, guard)).rejects.toBe(changed);
  const abort = new AbortController();
  abort.abort();
  await expect(submitBbsCheckin(fixture, async () => { calls++; return Response.json({ retcode: 0 }); },
    "6", { signal: abort.signal })).rejects.toMatchObject({ code: "transport" });
  await expect(submitBbsCheckin(fixture, async () => { calls++; throw new Error("fixture-secret"); }, "6"))
    .rejects.toMatchObject({ code: "transport", message: "社区签到提交结果未确认。" });
  await expect(submitBbsCheckin(fixture, async () => { calls++; return new Response("x".repeat(131_073)); }, "6"))
    .rejects.toMatchObject({ code: "response", message: "社区签到提交结果未确认。" });
  expect(calls).toBe(3);
});
