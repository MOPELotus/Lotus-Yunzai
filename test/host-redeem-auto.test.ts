import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

test.each([
  { label: "官方注明截止时间", template: { codeTipText: "兑换码将于2032年4月15日12:00:00过期。" } },
  { label: "官方未注明截止时间", template: {} },
])("$label 时续期同档案，首次提交前记账，明确风控停止本批", async ({ template }) => {
  const root = await mkdtemp(join(tmpdir(), "lotus-redeem-auto-"));
  const botToken = "fixture-redeem-onebot";
  const original = "profile: {id: 1}\naccount: {stuid: '72', cookie: 'account_id=72;cookie_token=other;'}\n";
  const journal = "data/redeemCodes/auto.json";
  const id = createHash("sha256").update(JSON.stringify(["71", "gs", "7.2", "81"])).digest("hex");
  try {
    await copyHost(root);
    await mkdir(join(root, "data/users"), { recursive: true });
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "data/users/42.yaml"), original);
    await writeFile(join(root, "data/users/42-2.yaml"), [
      "enabled: false", "profile: {id: 2}",
      "account: {stuid: '71', stoken: v2_login, mid: mid, cookie: 'account_id=71;cookie_token=expired;', current_uid: {gs: '81'}}",
    ].join("\n"));
    await writeFile(join(root, "config/global.yaml"), "coin_shop: {enable: false}\n");
    disableMemberPrewarm(root);
    await writeFile(join(root, "fixture-redeem.js"), `
      import assert from "node:assert/strict";
      import {appendFileSync, readFileSync} from "node:fs";
      const DateConstructor = Date;
      const origin = DateConstructor.parse("2032-04-14T12:59:56.500Z") - performance.now();
      const now = () => Math.floor(origin + performance.now());
      globalThis.Date = new Proxy(DateConstructor, {
        get: (target, key, receiver) => key === "now" ? now : Reflect.get(target, key, receiver),
        construct: (target, args, constructor) => Reflect.construct(target, args.length ? args : [now()], constructor),
        apply: () => new DateConstructor(now()).toString(),
      });
      const live = "https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=fixture-live";
      const reply = data => Response.json({retcode:0, data});
      const codes = ["FIXTURE-A", "FIXTURE-B", "FIXTURE-C"];
      globalThis.fetch = async (request, init) => {
        const url = new URL(request);
        appendFileSync("fixture-requests", url.pathname + "\\n");
        const chosen = url.searchParams;
        const cookie = new Headers(init.headers).get("cookie");
        assert.equal(init.redirect, "error");
        if (url.pathname === "/account/ma-cn-session/app/exchange") {
          assert.equal(url.origin, "https://passport-api.mihoyo.com");
          assert.equal(init.method, "POST");
          const {dst_token_type} = JSON.parse(init.body);
          assert.ok(dst_token_type === 2 || dst_token_type === 4);
          const ltoken = dst_token_type === 2;
          appendFileSync("fixture-calls", ltoken ? "ltoken\\n" : "cookie\\n");
          return reply({token:{token:ltoken ? "v2_fresh" : "v2_fresh_cookie"},user_info:{aid:"71"}});
        }
        assert.equal(init.method ?? "GET", "GET");
        switch (url.pathname) {
          case "/apihub/api/home/new":
            assert.equal(cookie, null);
            return reply({navigator: chosen.get("gids") === "2" ? [{name:"前瞻特别节目",link:live}] : []});
          case "/post/wapi/userPost": return reply({list:[],is_last:true});
          case "/post/wapi/searchPosts": return reply({posts:[]});
          case "/event/miyolive/index":
            return reply({streamer:{aid:"75276539"},live:{title:"原神7.2前瞻",start:"2032-04-14 19:00:00",remain:0,code_ver:"fixture"},
              template:${JSON.stringify(template)}});
          case "/event/miyolive/refreshCode": return reply({code_list:codes.map(code=>({code,to_get_time:0}))});
          case "/binding/api/getUserGameRolesByCookie":
            appendFileSync("fixture-calls", "roles\\n");
            assert.equal(chosen.get("game_biz"), "hk4e_cn");
            if (cookie === "account_id=71;cookie_token=expired;") return Response.json({retcode:-100});
            assert.match(cookie, /cookie_token_v2=v2_fresh_cookie/);
            return reply({list:[{game_biz:"hk4e_cn",game_uid:"81",region:"cn_gf01"},{game_biz:"hk4e_cn",game_uid:"82",region:"cn_qd01"}]});
          case "/common/apicdkey/api/webExchangeCdkey":
            assert.equal(url.host, "hk4e-api.mihoyo.com");
            assert.equal(chosen.get("uid"), "81");
            assert.equal(chosen.get("region"), "cn_gf01");
            assert.match(cookie, /cookie_token_v2=v2_fresh_cookie/);
            const batch = JSON.parse(readFileSync(${JSON.stringify(journal)}, "utf8"));
            assert.equal(batch[${JSON.stringify(id)}].status, "started");
            const code = chosen.get("cdkey");
            appendFileSync("fixture-calls", code + "\\n");
            return code === "FIXTURE-A" ? reply({}) : Response.json({retcode:-1035});
          default: throw new Error("unexpected loopback fixture request " + url.pathname);
        }
      };
    `);
    const host = Bun.spawn([process.execPath, "--preload", "./fixture-redeem.js", "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, TZ: "UTC", LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: botToken,
        LOTUS_PROFILE_DIR: join(root, "data/users") },
    });
    const errors = new Response(host.stderr).text();
    const reader = host.stdout.getReader();
    let socket: WebSocket | undefined;
    const stop = setTimeout(() => host.kill("SIGKILL"), 10_000);
    try {
      let output = "";
      const decoder = new TextDecoder();
      let endpoint: string | undefined;
      while (!endpoint) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(output + await errors);
        output += decoder.decode(chunk.value, { stream: true });
        endpoint = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0];
      }
      const Gateway = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
      const gateway = socket = new Gateway(endpoint, { headers: {
        Authorization: `Bearer ${botToken}`, "X-Client-Role": "Universal", "X-Self-ID": "99",
      } });
      const messages: string[] = [];
      gateway.addEventListener("message", ({ data }) => {
        const frame = JSON.parse(data);
        if (frame.action === "send_msg") messages.push(String(frame.params.message));
        if (frame.echo) gateway.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0,
          data: frame.action === "get_friend_list" ? [{ user_id: 42 }] : { message_id: 1 } }));
      });
      await new Promise<void>((resolve, reject) => {
        gateway.addEventListener("open", () => resolve(), { once: true });
        gateway.addEventListener("error", reject, { once: true });
      });
      gateway.send(JSON.stringify({ post_type: "message", message_type: "private", sub_type: "friend", self_id: 99,
        user_id: 42, message_id: 1, message: "#注册自动兑换前瞻（兑换码）2" }));
      const deadline = performance.now() + 7_000;
      while (messages.length < 2 && performance.now() < deadline) await Bun.sleep(10);
      if (messages.length < 2) {
        host.kill("SIGTERM");
        await host.exited;
        throw new Error(JSON.stringify({ messages, output, stderr: await errors,
          requests: await readFile(join(root, "fixture-requests"), "utf8").catch(() => ""),
          calls: await readFile(join(root, "fixture-calls"), "utf8").catch(() => "") }));
      }
      expect(messages[0]).toContain("档案 2 已开启");
      expect(messages[1]).toMatch(/档案 2.*UID 81[\s\S]*FIXTURE-A：使用成功[\s\S]*FIXTURE-B：请求已被拒绝[\s\S]*FIXTURE-C：未提交/u);
      expect(await readFile(join(root, "fixture-calls"), "utf8")).toBe("roles\nltoken\ncookie\nroles\nFIXTURE-A\nFIXTURE-B\n");
      expect(JSON.parse(await readFile(join(root, journal), "utf8"))[id]).toMatchObject({ status: "finished" });
      expect(await readFile(join(root, "data/users/42.yaml"), "utf8")).toBe(original);
      expect(Bun.YAML.parse(await readFile(join(root, "data/users/42-2.yaml"), "utf8"))).toMatchObject({
        enabled: false, auto_redeem: { enable: true, games: ["gs", "sr", "zzz"], local_enrollment: true },
      });
      gateway.send(JSON.stringify({ post_type: "message", message_type: "private", sub_type: "friend", self_id: 99,
        user_id: 42, message_id: 2, message: "#关闭自动兑换前瞻码2" }));
      const closed = performance.now() + 1_500;
      while (messages.length < 3 && performance.now() < closed) await Bun.sleep(10);
      expect(messages[2]).toContain("档案 2 已关闭");
      expect(Bun.YAML.parse(await readFile(join(root, "data/users/42-2.yaml"), "utf8"))).toMatchObject({
        enabled: false, auto_redeem: { enable: false, games: ["gs", "sr", "zzz"], local_enrollment: true },
      });
    } finally {
      clearTimeout(stop);
      socket?.close();
      host.kill("SIGTERM");
      await host.exited;
      reader.releaseLock();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
