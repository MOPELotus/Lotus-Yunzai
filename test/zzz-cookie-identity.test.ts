import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore, importProfiles, profileCookieAccountId } from "@lotus-yunzai/account";
import { createProfileHoyoClient } from "@lotus-yunzai/hoyo-client";
import { lockFile } from "../lib/file-lock.ts";
import { ownedRankRole } from "../plugins/zzz/challenge-rank.ts";
import { createZzzMonthlyArchive } from "../plugins/zzz/monthly-archive.ts";
import { createZzzMonthlyCommands } from "../plugins/zzz/monthly-command.ts";

const uid = "82521042", region = "prod_gf_cn", game_biz = "nap_cn";
const role = { uid, region, game_biz };
const qq = "42";
const variants = [
  { id: 1, cookie: "cookie_token_v2=v2_cookie;account_mid_v2=fixture-mid;account_id_v2=71526",
    token: "v2_login", loginCookie: "stoken=v2_login;stuid=71526;mid=fixture-mid;" },
  { id: 2, cookie: "cookie_token=legacy-cookie;account_id=71526;ltoken=legacy-ltoken;ltuid=71526",
    token: "legacy-login", loginCookie: "stoken=legacy-login;stuid=71526;" },
  { id: 3, cookie: "cookie_token_v2=v2_cookie;account_mid_v2=fixture-mid;account_id_v2=71526;ltuid=79524",
    token: "v2_login", loginCookie: "stoken=v2_login;stuid=71526;mid=fixture-mid;" },
] as const;
const deviceFor = (id: number) => ({ bound: true, id: `fixture-device-${id}`, fp: `0123456789ab${id}` });

test("旧档导入后 v2-only 与 v1 Cookie 可走同档绝区零设备及请求，冲突零出站", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzz-cookie-identity-"));
  const originals = join(root, "legacy"), dest = join(root, "current");
  try {
    await mkdir(originals);
    const filenames = variants.map(({ id }) => id === 1 ? qq + ".yaml" : qq + "-" + id + ".yaml");
    const sourceFiles = variants.map(({ id, cookie, token, loginCookie }) => Bun.YAML.stringify({
      user: { qq }, profile: { id }, account: { cookie, stoken: token, stoken_cookie: loginCookie,
        game_roles: { zzz: [role] }, current_uid: { zzz: uid } },
      device: deviceFor(id),
    }));
    await Promise.all(filenames.map((name, i) => writeFile(join(originals, name), sourceFiles[i]!)));
    expect(await importProfiles(originals, dest, true)).toMatchObject({ imported: 3 });
    const profiles = createProfileStore(dest);
    const sent: string[] = [];
    const client = createProfileHoyoClient(profiles, async (url, request) => {
      const headers = new Headers(request.headers);
      const cookie = headers.get("cookie");
      expect(request.redirect).toBe("error");
      sent.push(url.pathname);
      if (url.pathname.endsWith("/avatar/info")) {
        const variant = variants.slice(0, 2).find(row => row.cookie === cookie);
        if (!variant) throw new Error("测试收到了其它 Cookie。");
        const device = deviceFor(variant.id);
        expect(headers.get("x-rpc-device_id")).toBe(device.id);
        expect(headers.get("x-rpc-device_fp")).toBe(device.fp);
        return Response.json({ retcode: 0, data: { ...role, avatar_list: [{ id: 1151, name_mi18n: "11号", level: 60, rank: 0, rarity: "S" }] } });
      }
      if (url.pathname.endsWith("/genAuthKey")) {
        const variant = variants.slice(0, 2).find(row => row.loginCookie === cookie);
        if (!variant) throw new Error("测试收到了其它登录 Cookie。");
        const device = deviceFor(variant.id);
        expect(headers.get("x-rpc-device_id")).toBe(device.id);
        expect(headers.get("x-rpc-device_fp")).toBe(device.fp);
        expect(JSON.parse(String(request.body))).toMatchObject({ game_uid: Number(uid), region, game_biz });
        return Response.json({ retcode: 0, data: { authkey: "fixture-authkey", ...role } });
      }
      throw new Error("测试不接受其它请求。");
    });
    const archived = join(root, "archived");
    await mkdir(archived);
    await writeFile(join(archived, uid + ".json"), JSON.stringify([{ ...role, data_month: "202410", month_data: {
      list: [{ data_type: "PolychromesData", count: 28 }],
    } }]));
    const archive = createZzzMonthlyArchive(join(root, "new-monthly"), [archived], lockFile);
    const query = createZzzMonthlyCommands(profiles, client, archive, new AbortController().signal);
    for (const id of [1, 2]) {
      const selected = await profiles.requestSelectedContext(qq, id, "zzz");
      expect(profileCookieAccountId(selected.account)).toBe("71526");
      expect(profileCookieAccountId({ ...selected.account, stokenCookie: "" })).toBe("71526");
      expect([selected.account.stuid, selected.account.ltuid]).toEqual(["", ""]);
      expect(await client.fetchZzzPanel(selected, { ids: [1151], roleInterval: 0 })).toMatchObject({ uid });
      expect((await client.fetchZzzGachaAuthKey(selected)).url.searchParams.get("authkey")).toBe("fixture-authkey");
      expect((await ownedRankRole(profiles, qq, id))?.role.uid).toBe(uid);
      expect(await query({ user_id: 42, message_type: "private" }, id, { collect: true, page: 2 })).toContain("共 1 页");
    }
    const conflicting = await profiles.requestSelectedContext(qq, 3, "zzz");
    expect(profileCookieAccountId(conflicting.account)).toBeUndefined();
    await expect(client.fetchZzzPanel(conflicting, { ids: [1151], roleInterval: 0 })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(client.fetchZzzGachaAuthKey(conflicting)).rejects.toMatchObject({ code: "invalid-input" });
    expect(await ownedRankRole(profiles, qq, 3)).toBeUndefined();
    expect(await query({ user_id: 42, message_type: "private" }, 3, { collect: true, page: 2 })).toContain("Cookie 与当前登录账号不一致");
    expect(sent).toEqual([
      "/event/game_record_zzz/api/zzz/avatar/info", "/binding/api/genAuthKey",
      "/event/game_record_zzz/api/zzz/avatar/info", "/binding/api/genAuthKey",
    ]);
    expect(await Promise.all(filenames.map(file => readFile(join(originals, file), "utf8")))).toEqual(sourceFiles);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
