import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { copyHost } from "./host-fixture.ts";

test("旧注册时间在本人群聊与好友私聊读取当前档案匹配的三游缓存", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-legacy-anniversary-"));
  const token = "legacy-anniversary-fixture";
  const profiles = join(root, "profiles");
  const profile = join(profiles, "42.yaml");
  const gsUid = "123456789", srUid = "234567890", zzzUid = "345678901";
  const cacheTime = Date.UTC(2025, 0, 12, 16);
  const started = Date.UTC(2024, 0, 2, 16) / 1000;
  const entry = (uid: string, region: string, gameBiz: string, data: unknown) => ({
    info_data: { game_uid: uid, region, game_biz: gameBiz, nickname: "不应回显的旧资料" },
    game_data: data, query_time: cacheTime,
  });
  function cache(location: string, folder: string, qq = 42) {
    return join(root, location, "xiaofei-plugin/data", folder, `${qq}.json`);
  }
  const gs = cache("backup/plugins", "ys_RegTime");
  const sr = cache("plugins", "sr_RegTime");
  const zzz = cache("backup/plugins", "zzz_RegTime");
  const profileContents = Bun.YAML.stringify({
    user: { qq: "42" }, profile: { id: 1 },
    device: { id: "fixture-anniversary-device", fp: "0123456789abc", bound: true },
    account: { cookie: "ltoken=fixture-cookie", stoken: "fixture-stoken", game_roles: {
      gs: [{ uid: gsUid, region: "cn_gf01", game_biz: "hk4e_cn" }],
      sr: [{ uid: srUid, region: "prod_gf_cn", game_biz: "hkrpg_cn" }],
      zzz: [{ uid: zzzUid, region: "prod_gf_cn", game_biz: "nap_cn" }],
    } },
  });
  const gsContents = JSON.stringify({ [gsUid]: entry(gsUid, "cn_gf01", "hk4e_cn",
    { data: { data: JSON.stringify({ "1-1-1": "2024-01-03" }) } }) });
  const srContents = JSON.stringify({ [srUid]: entry(srUid, "prod_gf_cn", "hkrpg_cn",
    { data: { list: [{ key: "register_date", value: "2024年1月7日" }] } }) });
  const wrongRegion = JSON.stringify({ [zzzUid]: entry(zzzUid, "prod_qd_cn", "nap_cn", { "1": started }) });
  const exactZzz = JSON.stringify({ [zzzUid]: entry(zzzUid, "prod_gf_cn", "nap_cn", { "1": started }) });
  let gateway: WebSocket | undefined;
  let host: ReturnType<typeof spawn> | undefined;
  function spawn() {
    return Bun.spawn([process.execPath, "--no-env-file", "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token, LOTUS_PROFILE_DIR: profiles },
    });
  }

  try {
    await copyHost(root);
    const appFile = join(root, "app.ts");
    await writeFile(appFile, 'globalThis.fetch = async () => Response.json({retcode:-1,message:"fixture activity unavailable"});\n' + await readFile(appFile, "utf8"));
    for (const path of [profile, gs, sr, zzz]) await mkdir(dirname(path), { recursive: true });
    await writeFile(profile, profileContents);
    await writeFile(gs, gsContents);
    await writeFile(sr, srContents);
    await writeFile(zzz, wrongRegion);
    await mkdir(join(root, "config"));
    await writeFile(join(root, "config/global.yaml"), "coin_shop: {enable: false}\nscheduler: {enable: false}\n");
    host = spawn();
    const reader = host.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    let endpoint: string | undefined;
    try {
      while (!endpoint) {
        const part = await reader.read();
        if (part.done) throw new Error(output + await new Response(host.stderr).text());
        output += decoder.decode(part.value, { stream: true });
        endpoint = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0];
      }
    } finally {
      reader.releaseLock();
    }
    const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const socket = gateway = new Socket(endpoint, {
      headers: { Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": "99" },
    });
    const replies: string[] = [];
    socket.addEventListener("message", ({ data }) => {
      const frame = JSON.parse(data);
      if (frame.action === "send_msg") replies.push(JSON.stringify(frame.params.message));
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let sequence = 0;
    function send(message: string, user = 42, scene = "friend") {
      const group = scene === "group";
      socket.send(JSON.stringify({ post_type: "message", message_type: group ? "group" : "private",
        sub_type: group ? "normal" : scene, group_id: group ? 66 : undefined,
        self_id: 99, user_id: user, message_id: ++sequence, message }));
    }
    async function reply(message: string, expected: string, user = 42, scene = "friend") {
      const count = replies.length;
      send(message, user, scene);
      const deadline = performance.now() + 2_000;
      while (replies.length === count && performance.now() < deadline) await Bun.sleep(10);
      expect(replies).toHaveLength(count + 1);
      expect(replies[count]).toContain(expected);
      return replies[count]!;
    }
    const saved = await reply("#我的原神注册时间", "注册时间 2024-01-03");
    expect(saved).toContain("缓存查询时间 2025-01-13 00:00:00");
    await reply("#刷新我的原神注册时间", "注册时间查询失败");
    expect(saved).not.toContain(gsUid);
    expect(saved).not.toContain("不应回显的旧资料");
    await reply("*我的注册时间", "注册时间 2024-01-07");
    await reply("%注册时间", "注册时间查询失败");
    await writeFile(zzz, exactZzz);
    await reply("%我的注册时间", "注册时间 2024-01-03 00:00:00");
    await reply("#注册时间", "请先登录并同步本人的游戏档案", 43);
    await reply("#注册时间", "注册时间 2024-01-03", 42, "group");
    await reply("#注册时间", "请先登录并同步本人的游戏档案", 43, "group");
    const count = replies.length;
    send("#注册时间", 42, "group_temp");
    await Bun.sleep(100);
    expect(replies).toHaveLength(count);
    await rm(zzz);
    await symlink(gs, zzz);
    await reply("#绝区零刷新注册时间", "注册时间查询失败");
    await rm(zzz);
    await rm(gs);
    await rm(sr);
    await reply("#原神我的注册时间", "注册时间 2024-01-03");
    await reply("#我的星铁注册时间", "注册时间 2024-01-07");
    expect(await readFile(join(root, "data/anniversary/gs/42.json"), "utf8")).not.toContain("不应回显的旧资料");

    expect(await readFile(profile, "utf8")).toBe(profileContents);
  } finally {
    gateway?.close();
    host?.kill("SIGTERM");
    await host?.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
