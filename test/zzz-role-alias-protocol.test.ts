import assert from "node:assert/strict";
import { test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const valkey = Bun.which("valkey-server");

test.skipIf(!valkey)("双协议别名添加、旧称屏蔽、查询、撤权和重启", async () => {
  const project = join(import.meta.dir, "..");
  const root = await mkdtemp(join(tmpdir(), "lotus-zzz-role-alias-"));
  await mkdir(join(root, "fontconfig-cache"));
  await copyHost(root);
  disableMemberPrewarm(root);
  await writeFile(join(root, "config/config/bot.yaml"), "cache_group_member: false\nonline_msg_exp: 0\n");
  const ownerFile = join(root, "config/config/other.yaml");
  const owners = 'master: ["99:51", "100:52"]\nmasterQQ: [51, 52]\n';
  await writeFile(ownerFile, owners);
  for (const name of ["zzz", "atlas"]) {
    const source = join(project, "plugins", name);
    const target = join(root, "plugins", name);
    await cp(source, target, { recursive: true, filter: path => !path.endsWith("/node_modules") && !path.endsWith("/.git") });
    await symlink(join(source, "node_modules"), join(target, "node_modules"), "dir");
  }
  await writeFile(join(root, "config/global.yaml"), "scheduler: { enable: false }\ncoin_shop: { enable: false }\n");
  const token = "isolated-rank-admin-test";
  const atlas = join(root, "atlas"), legacy = join(root, "legacy");
  await mkdir(atlas);
  const names = [["1011", "安比"], ["1381", "零号·安比"]];
  const records = Object.fromEntries(names.map(([id,name]) => [id, { id, name, rarity: "A级", path: `items/${id}.json` }]));
  await writeFile(join(atlas, "map.json"), JSON.stringify({ games: { zzz: { locales: { zh: { pages: {
    character: { version: "3.3", recordCount: names.length, records },
  } } } } } }));
  await mkdir(join(legacy, "config"), { recursive: true });
  await mkdir(join(legacy, "resources"));
  const oldAlias = join(legacy, "config", "alias.yaml");
  const oldBytes = "安比: [合成古别名, 合成歧义]\n零号·安比: [合成歧义]\n";
  await writeFile(oldAlias, oldBytes);
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  const password = crypto.randomUUID();
  const redisUrl = `redis://:${password}@127.0.0.1:${port}`;
  const db = Bun.spawn([valkey!, "--bind", "127.0.0.1", "--port", String(port), "--requirepass", password,
    "--save", "", "--appendonly", "no", "--dir", root], { stdout: "pipe", stderr: "ignore" });
  const initial = db.stdout.getReader();
  let output = "";
  while (!output.includes("Ready to accept connections")) {
    const item = await initial.read();
    if (item.done) throw Error("隔离存储初始化失败");
    output += new TextDecoder().decode(item.value);
  }
  initial.releaseLock();
  const redis = new Bun.RedisClient(redisUrl, { autoReconnect: false });
  await redis.connect();

  const frames: Record<"onebot" | "milky", any[]> = { onebot: [], milky: [] };
  let revoke = false;
  const membership = (group_id: number) => [42, 43, 51, 52].map(user_id => ({ group_id, user_id, nickname: "合成成员" }));
  const milky = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    assert.equal(request.headers.get("authorization"), "Bearer " + token);
    const action = new URL(request.url).pathname.split("/").at(-1);
    if (action === "get_group_member_list") {
      const params = await request.json();
      if (params.group_id === 77 && revoke) {
        revoke = false;
        await writeFile(ownerFile, 'master: ["99:51"]\nmasterQQ: [51]\n');
        await Bun.sleep(650);
      }
      return Response.json({ status: "ok", retcode: 0, data: { members: membership(params.group_id) } });
    }
    if (action === "get_login_info") return Response.json({ status: "ok", retcode: 0, data: { uin: 100 } });
    if (action === "send_group_message" || action === "send_private_message") {
      frames.milky.push(await request.json());
      return Response.json({ status: "ok", retcode: 0, data: { message_seq: frames.milky.length + 100 } });
    }
    return new Response("", { status: 404 });
  } });
  await writeFile(join(root, "config/milky.yaml"), `enable: true\nhost: 127.0.0.1\nport: ${milky.port}\nconnection: webhook\naccess_token: ${token}\n`);
  let host: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let socket: WebSocket | undefined;
  let hooks: ((event_type: string, data: object) => Promise<Response>) | undefined;
  let errors: undefined | Promise<string>;
  let sequence = 0, bootCount = 0;
  async function stop() {
    if (!host) return;
    socket?.close();
    host.kill();
    await host.exited;
    const log = (await errors) ?? "";
    await writeFile(join(root, `host-${bootCount}.log`), log);
    assert.doesNotMatch(log, /UNEXPECTED_EXTERNAL|CPU 后端/u);
    host = undefined;
  }
  async function start() {
    bootCount++;
    host = Bun.spawn([process.execPath, "--no-env-file", "app.ts"], { cwd: root,
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
      env: { PATH: process.env.PATH, XDG_CACHE_HOME: join(root, "fontconfig-cache"), LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "0",
        LOTUS_ONEBOT_TOKEN: token, LOTUS_VALKEY_URL: redisUrl,
        LOTUS_ATLAS_DATA_DIR: atlas, LOTUS_ZZZ_LEGACY_RESOURCES_DIR: join(legacy, "resources") },
    });
    errors = new Response(host.stderr).text();
    const reader = host.stdout.getReader();
    let banner = "";
    while (!banner.includes("Lotus-Yunzai 已启动")) {
      const part = await reader.read();
      if (part.done) throw Error(banner + await errors);
      banner += new TextDecoder().decode(part.value);
    }
    reader.releaseLock();
    assert.match(banner, /已加载 zzz/u);
    const ws = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(banner)?.[0];
    const http = /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(banner)?.[1];
    assert(ws && http);
    hooks = (event_type, data) => fetch(http + "/milky", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ self_id: 100, time: 1700000000, event_type, data }) });
    for (let i = 0; ; i++) {
      if ((await hooks("fixture_test", {})).status === 200) break;
      assert(i < 60); await Bun.sleep(25);
    }
    socket = new WebSocket(ws, { headers: { Authorization: "Bearer " + token, "X-Client-Role": "Universal", "X-Self-ID": "99" } } as unknown as string[]);
    const bound = socket;
    bound.addEventListener("message", ({ data }) => {
      const item = JSON.parse(String(data));
      if (/^send_.*msg$/u.test(item.action)) frames.onebot.push(item);
      if (item.echo) {
        const reply = item.action === "get_group_member_list" ? membership(item.params.group_id) :
          item.action === "get_login_info" ? { user_id: 99 } : { message_id: 200 + frames.onebot.length };
        bound.send(JSON.stringify({ echo: item.echo, status: "ok", retcode: 0, data: reply }));
      }
    });
    await new Promise<void>((resolve,reject) => { bound.addEventListener("open", () => resolve(), { once: true }); bound.addEventListener("error", reject, { once: true }); });
  }

  async function ask(proto: "onebot" | "milky", text: string, user = 42, group: number | null = 77) {
    const cursor = frames[proto].length;
    if (proto === "onebot") socket!.send(JSON.stringify({
      self_id: 99, user_id: user, ...(group && { group_id: group }), post_type: "message", message_type: group ? "group" : "private",
      sub_type: group ? "normal" : "friend", message_id: ++sequence, message: text,
    }));
    else assert.equal((await hooks!("message_receive", { message_seq: ++sequence, sender_id: user, peer_id: group ?? user,
      message_scene: group ? "group" : "friend", time: 1700000000, segments: [{ type: "text", data: { text } }] })).status, 200);
    for (let i=0; frames[proto].length === cursor; i++) {
      if (i > 400) throw Error("no response " + text + " " + proto);
      await Bun.sleep(25);
    }
    const frame = frames[proto][cursor];
    const message = (proto === "onebot" ? frame.params : frame).message;
    return typeof message === "string" ? message : message.map((segment: { data: { text?: string } }) => segment.data.text ?? "").join("");
  }

  try {
    await start();
    assert.match(await ask("onebot", "%安比别名"), /合成古别名/);
    assert.match(await ask("milky", "#角色图鉴 绝区零 合成古别名"), /安比/);
    assert.match(await ask("onebot", "%添加安比别名合成新别名"), /仅限主人设置/);
    assert.match(await ask("onebot", "%添加安比别名合成新别名", 51), /已添加/);
    assert.match(await ask("milky", "#角色图鉴 绝区零 合成新别名"), /安比/);
    assert.match(await ask("milky", "%合成新别名别名"), /合成新别名/);
    assert.match(await ask("milky", "%添加安比别名零号安比", 52), /已存在/);
    assert.match(await ask("milky", "%删除别名合成歧义", 52), /唯一/);
    assert.match(await ask("milky", "%删除别名安比", 52), /无法删除/);
    revoke = true;
    assert.match(await ask("milky", "%删除别名合成新别名", 52), /仅限主人设置/);
    assert.match(await ask("onebot", "%安比别名"), /合成新别名/);
    assert.equal(revoke, false);
    await stop();
    await writeFile(ownerFile, owners);
    await start();
    assert.match(await ask("milky", "%删除别名合成古别名", 52), /已删除/);
    assert.match(await ask("onebot", "#角色图鉴 绝区零 合成古别名"), /未找到/);
    await stop();
    await start();
    assert.match(await ask("onebot", "#角色图鉴 绝区零 合成新别名"), /安比/);
    assert.doesNotMatch(await ask("milky", "%安比别名"), /古别名/);
    assert.equal(await readFile(oldAlias, "utf8"), oldBytes);
  } finally {
    await stop();
    await milky.stop(true);
    redis.close();
    db.kill();
    await db.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
