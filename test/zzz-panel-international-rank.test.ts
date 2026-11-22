import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "@lotus-yunzai/account";
import { createProfileHoyoClient } from "@lotus-yunzai/hoyo-client";
import { createPanelRankIdentityReader, panelRankMode } from "../plugins/zzz/panel-rank-identity.ts";
import { zzzPanelRankCommand } from "../plugins/zzz/panel-rank-model.ts";

const regions = [
  ["1000000001", "prod_gf_us"], ["1300000001", "prod_gf_jp"],
  ["1500000001", "prod_gf_eu"], ["1700000001", "prod_gf_sg"],
] as const;
const account = "81";
const response = (data: unknown) => Response.json({ retcode: 0, data });

test("国际服面板群榜保持旧指令兼容，也可明确选择国际服", () => {
  expect(zzzPanelRankCommand("%显示国际服角色面板排名2")).toEqual({ kind: "visibility", enable: true, international: true, profileId: 2 });
  expect(zzzPanelRankCommand("%隐藏海外服角色面板排名")).toEqual({ kind: "visibility", enable: false, international: true, profileId: 1 });
  expect(panelRankMode("prod_gf_cn:12345678")).toBe("cn");
  expect(panelRankMode("prod_qd_cn:612345678")).toBe("cn");
  expect(panelRankMode("prod_gf_jp:1300000001")).toBeUndefined();
});

test("四国际区只接受已核验 HoYoLAB 同档案目录，本地公开选角不能证明归属", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzz-international-rank-"));
  const filename = join(root, "42.yaml");
  function profile(uid?: string, serial = account, verified = true) {
    return ['user: { qq: "42" }', "profile: { id: 1 }", "account:",
      '  cookie: "cookie_token=only-domestic; account_id=43"', '  stuid: "43"', '  stoken: "fixture-stoken"',
      ...(uid ? [`  current_uid: { zzz: "${uid}" }`] : []),
      "games:", "  os:", "    enable: false", "    zzz: { checkin: false }", `    cookie: "account_id=${serial}; cookie_token=only-login"`,
      ...(verified ? [`    verified_account_id: "${serial}"`, "    verified_realm: SG",
        `    verified_activity_cookie: "ltuid=${serial}; ltoken=authenticated-fixture"`] : []),
    ].join("\n");
  }
  const profiles = createProfileStore(root);
  let rows: unknown[] = [];
  let alter = false;
  const requests: string[] = [];
  const client = createProfileHoyoClient(profiles, async (url, init) => {
    expect(url.href).toBe("https://api-account-os.hoyolab.com/binding/api/getUserGameRolesByLtoken?game_biz=nap_global");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    const cookie = new Headers(init.headers).get("Cookie")!;
    expect(cookie).toMatch(/^ltuid=(81|82); ltoken=authenticated-fixture$/u);
    requests.push(cookie.split(";")[0]!);
    if (alter) await writeFile(filename, profile(regions[1][0], "82"));
    return response({ list: rows });
  });
  const reader = () => createPanelRankIdentityReader(profiles, client, new AbortController().signal);
  const item = (uid: string, region: string, chosen = false, game_biz = "nap_global") =>
    ({ game_uid: uid, region, game_biz, is_chosen: chosen });
  try {
    for (const [uid, region] of regions) {
      rows = [item(uid, region)];
      await writeFile(filename, profile(uid), { mode: 0o600 });
      expect((await profiles.internationalCheckin("42", 1, "zzz")).status).toBe("disabled");
      const resolve = reader();
      const selected = await resolve("42", 1);
      expect(selected?.uid).toBe(uid);
      expect(selected?.region).toBe(region);
      expect(selected?.value).toMatch(new RegExp(`^selected:${region}:${uid}:[a-f0-9]{64}$`));
      const chosen = await resolve("42", 1, "international");
      expect(chosen?.value).toMatch(new RegExp(`^international:${region}:${uid}:[a-f0-9]{64}$`));
      expect((await resolve("42", 1, "selected", selected!.revision))?.uid).toBe(uid);
      const count = requests.length;
      const saved = reader();
      expect(await saved.registered("42", 1, selected!.value, selected!.revision)).toEqual(selected);
      expect(await saved.registered("42", 1, chosen!.value)).toEqual(chosen);
      const wrongRegion = region === "prod_gf_eu" ? "prod_gf_jp" : "prod_gf_eu";
      expect(await saved.registered("42", 1, selected!.value.replace(region, wrongRegion))).toBeUndefined();
      expect(requests).toHaveLength(count);
    }
    expect(requests).toHaveLength(4);
    rows = [item(...regions[1])];
    await writeFile(filename, profile(regions[0][0]), { mode: 0o600 });
    expect(await reader()("42", 1, "selected")).toBeUndefined();
    rows = [item(regions[0][0], regions[1][1])];
    expect(await reader()("42", 1, "international")).toBeUndefined();
    rows = [item(...regions[0], false, "nap_cn")];
    expect(await reader()("42", 1, "international")).toBeUndefined();
    rows = [item(...regions[0]), item(...regions[1])];
    expect(await reader()("42", 1, "international")).toBeUndefined();
    rows = [item(...regions[0]), item(...regions[1], true)];
    expect((await reader()("42", 1, "international"))?.uid).toBe(regions[1][0]);
    const count = requests.length;
    await writeFile(filename, profile(regions[1][0], account, false), { mode: 0o600 });
    expect(await reader()("42", 1, "international")).toBeUndefined();
    expect(requests).toHaveLength(count);

    await writeFile(filename, profile(regions[1][0]), { mode: 0o600 });
    const before = await reader()("42", 1, "selected");
    alter = true;
    const changed = reader();
    expect(await changed("42", 1, "selected")).toBeUndefined();
    alter = false;
    expect(await changed("42", 1, "selected", before!.revision)).toBeUndefined();
    const after = await reader()("42", 1, "selected");
    expect(after?.uid).toBe(before?.uid);
    expect(after?.value).not.toBe(before?.value);

    const countAfterAuthorization = requests.length;
    const offline = reader();
    expect(await offline.registered("42", 1, before!.value)).toBeUndefined();
    expect(await offline.registered("42", 1, after!.value, before!.revision)).toBeUndefined();
    expect(await offline.registered("42", 1, after!.value)).toEqual(after);
    await writeFile(filename, profile(regions[0][0], "82"), { mode: 0o600 });
    expect(await offline.registered("42", 1, after!.value)).toBeUndefined();
    expect(await offline.registered("42", 1, after!.value.replace(/^selected:/u, "international:"))).toMatchObject({ uid: regions[1][0] });
    expect(requests).toHaveLength(countAfterAuthorization);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
