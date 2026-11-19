import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { readGenshinPanel } from "../packages/hoyo-client/genshin-panel.ts";

const source: ProfileRequestContext = {
  qq: "42", profileId: 2, game: "gs", revision: "fixture",
  role: { uid: "500000001", region: "cn_qd01", gameBiz: "hk4e_cn", nickname: "fixture", level: 60, chosen: true },
  account: { cookie: "cookie_token=fixture; account_id=82", stoken: "", stokenCookie: "", stuid: "82", ltuid: "82", mid: "", ltoken: "" },
  device: { id: "bound-panel-device", fp: "fixture-fp", name: "", model: "", androidVersion: "", raw: {} },
};

test("原神按旧 list 和 detail 读取同档国服角色，并对实际 POST 正文签名", async () => {
  const calls: string[] = [];
  const avatars = [{ base: { id: 10000089 } }, { base: { id: 10000073 } }];
  const { avatars: read } = await readGenshinPanel(source, async (url, init) => {
    expect(url.origin).toBe("https://api-takumi-record.mihoyo.com");
    expect(url.search).toBe("");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toBe(source.account.cookie);
    expect(headers.get("x-rpc-device_id")).toBe(source.device.id);
    expect(headers.get("x-rpc-device_fp")).toBe(source.device.fp);
    const body = String(init?.body);
    const [time, nonce, actual] = headers.get("DS")!.split(",");
    expect(actual).toBe(createHash("md5").update(`salt=xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs&t=${time}&r=${nonce}&b=${body}&q=`).digest("hex"));
    calls.push(url.pathname);
    const base = { role_id: source.role.uid, server: "cn_qd01" };
    if (url.pathname.endsWith("/list")) {
      expect(JSON.parse(body)).toEqual(base);
      return Response.json({ retcode: 0, data: { ...base, list: [{ id: 10000089 }, { id: "10000073" }] } });
    }
    expect(JSON.parse(body)).toEqual({ ...base, character_ids: [10000089, 10000073] });
    return Response.json({ retcode: 0, data: { ...base, list: [...avatars].reverse() } });
  }, {});
  expect(calls).toEqual(["/game_record/app/genshin/api/character/list", "/game_record/app/genshin/api/character/detail"]);
  expect(read).toEqual(avatars);
});

test("原神旧面板不拿空目录、错档、错角色或风险响应替换现有数据", async () => {
  for (const mode of ["empty", "risk", "mismatch", "incomplete", "changed"] as const) {
    let calls = 0;
    let generation = "old";
    const pending = readGenshinPanel(source, async () => {
      calls++;
      if (mode === "risk") return Response.json({ retcode: 0 }, { headers: { "x-rpc-aigis": "fixture" } });
      if (mode === "changed") generation = "new";
      if (mode === "mismatch") return Response.json({ retcode: 0, data: { role_id: "500000002", list: [] } });
      return Response.json({ retcode: 0, data: { list: calls === 2 || mode === "empty" ? [] : [{ id: 10000089 }] } });
    }, {}, async () => { if (generation === "new") throw new Error("档案已换绑"); });
    if (mode === "empty") expect(await pending).toEqual({ avatars: [] });
    else await expect(pending).rejects.toThrow();
    expect(calls).toBe(mode === "incomplete" ? 2 : 1);
  }
});
