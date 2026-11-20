import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readLotusGlobalConfig } from "../lib/lotus-global-config.ts";
import { accountScopePermission } from "../lib/permissions.ts";
import { copyHost } from "./host-fixture.ts";

const owner = { user_id: 42, isMaster: true };
const member = { user_id: 51, isMaster: false };
const primary = "config/global.yaml";
const original = "plugins/Lotus-Plugin/config/global.yaml";
const alternate = "plugins/Lotus-ReFactor/config/global.yaml";

async function fixture(files: Record<string, string>, check: (root: URL) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-legacy-global-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      const file = join(directory, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contents);
    }
    await check(pathToFileURL(directory + "/"));
    for (const [name, contents] of Object.entries(files)) {
      expect(await readFile(join(directory, name), "utf8")).toBe(contents);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test.each([
  "permissionControl: {mode: whitelist, whitelist: [42], blackList: [51]}\n",
  "permission_control: {mode: whitelist, whiteList: [42], blacklist: [51]}\n",
  "checkin: {permissionControl: {mode: whitelist, white_list: [42], black_list: [51]}}\n",
  "checkin: {permission_control: {mode: whitelist, white_list: [42], black_list: [51]}}\n",
])("原签到权限名称仍保护明确禁用配置 %s", async contents => {
  await fixture({ [original]: contents }, async root => {
    const config = await readLotusGlobalConfig(root);
    expect(config.permissions).toEqual({ default_policy: "deny", users: { allow: ["42"], deny: ["51"] } });
    const refresh = accountScopePermission(config, "checkin.refresh");
    expect(refresh(owner)).toBe(true);
    expect(refresh(member)).toBe(false);
    expect(refresh({ user_id: 56, isMaster: true })).toBe(false);
  });
});

test("主配置只覆盖同项权限，保留旧根名单及另一作用域的明确禁止", async () => {
  await fixture({
    [original]: "permissionControl: {black_list: [51]}\npermissions:\n  users: {deny: [52]}\n" +
      "  groups: {deny: [7701]}\n  scopes: {checkin.refresh: {policy: deny}, scheduler.manage: {policy: deny}}\n",
    [alternate]: "permissions: {users: {deny: [53]}}\n",
    [primary]: "permissions:\n  users: {allow: [42]}\n  groups: {allow: [7702]}\n" +
      "  scopes: {scheduler.manage: {policy: master_only}}\n",
  }, async root => {
    const config = await readLotusGlobalConfig(root);
    const refresh = accountScopePermission(config, "checkin.refresh");
    expect(refresh(owner)).toBe(false);
    expect(refresh(member)).toBe(false);
    const manage = accountScopePermission(config, "scheduler.manage");
    expect(manage(owner)).toBe(true);
    expect(manage({ user_id: 52, isMaster: true })).toBe(false);
    expect(manage({ user_id: 53, isMaster: true })).toBe(true);
    expect(manage({ ...owner, group_id: 7701 })).toBe(false);
  });
});

test("旧 schedule 保留原固定时刻，已明确设置的新版字段按优先顺序覆盖", async () => {
  await fixture({ [alternate]: "schedule: '9 7 * * *'\r\nscheduler: {enable: false}\r\n" }, async root => {
    expect((await readLotusGlobalConfig(root)).scheduler).toEqual({ enable: false, mode: "fixed", fixed_time: "07:09" });
  });
  await fixture({
    [alternate]: "schedule: '0 9 7 * * ? *'\nscheduler: {enable: false, fixed_time: '02:10'}\n",
    [primary]: "scheduler: {fixed_time: '06:17'}\n",
  }, async root => {
    expect((await readLotusGlobalConfig(root)).scheduler).toEqual({ enable: false, mode: "fixed", fixed_time: "06:17" });
  });
});

test("已绑定的 OneBot 主人和普通成员都受原刷新禁令约束", async () => {
  const token = "lotus-global-permission-fixture";
  await fixture({
    [original]: "permission_control: {mode: whitelist, white_list: [88]}\n" +
      "scheduler: {enable: false}\ncoin_shop: {enable: false}\n",
    [primary]: "permissions: {scopes: {scheduler.manage: {policy: master_only}}}\n",
    "config/config/other.yaml": 'master: ["99:42"]\n',
    "config/config/bot.yaml": "cache_group_member: false\nonline_msg_exp: 0\n",
  }, async root => {
    await copyHost(root.pathname);
    const host = Bun.spawn([process.execPath, "--no-env-file", "app.ts"], {
      cwd: root.pathname, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
    });
    const reader = host.stdout.getReader();
    const decoder = new TextDecoder();
    let socket: WebSocket | undefined;
    const deadline = setTimeout(() => host.kill("SIGKILL"), 6000);
    try {
      let log = "";
      let url: string | undefined;
      while (!url) {
        const result = await reader.read();
        if (result.done) throw new Error(log + await new Response(host.stderr).text());
        log += decoder.decode(result.value, { stream: true });
        url = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(log)?.[0];
      }
      const Gateway = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
      socket = new Gateway(url, { headers: {
        Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": "99",
      } });
      const replies = new Map<number, string>();
      socket.addEventListener("message", ({ data }) => {
        const frame = JSON.parse(data);
        if (frame.action === "send_msg") replies.set(frame.params.user_id, frame.params.message);
        if (frame.echo !== undefined) socket?.send(JSON.stringify({ echo: frame.echo, status: "ok",
          retcode: 0, data: { message_id: 15 } }));
      });
      await new Promise<void>((resolve, reject) => {
        socket?.addEventListener("open", () => resolve(), { once: true });
        socket?.addEventListener("error", reject, { once: true });
      });
      for (const user_id of [42, 51]) socket.send(JSON.stringify({ self_id: 99, user_id, message_id: user_id,
        post_type: "message", message_type: "private", sub_type: "friend", message: "#刷新Cookie" }));
      const until = performance.now() + 2500;
      while (replies.size < 2 && performance.now() < until) await Bun.sleep(20);
      for (const user of [42, 51]) expect(replies.get(user)).toContain("当前不允许刷新登录信息");
    } finally {
      clearTimeout(deadline);
      socket?.close();
      host.kill("SIGTERM");
      await host.exited;
      reader.releaseLock();
    }
  });
});
