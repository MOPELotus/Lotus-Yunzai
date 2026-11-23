import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { editChatPermissions, parsePermissionEdit } from "../lib/permission-command-edits.ts";
import { panelGlobalPermissions } from "../lib/panel-global-permissions.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("旧权限只读命令在绑定主人会话出图，普通群主不能查看或写入", async () => {
  const config = "permissions: {default_policy: deny, users: {allow: [42], deny: [77]}, scopes: {checkin.refresh: {policy: inherit}}}\n";
  await withDualGatewayFixture("permission-chat-fixture", 'master: ["99:42", "100:43"]\ndisablePrivate: false\n',
    async ({ root, sendOneBot, sendMilky, onebot, milky }) => {
      const group = { message_type: "group", sub_type: "normal", group_id: 701, sender: { role: "owner" } };
      sendOneBot("#权限名单", { ...group, user_id: 44 });
      const rejected = await onebot.next("send_msg");
      expect(rejected.params).toMatchObject({ group_id: 701, message: "只有机器人主人可以查看或修改业务权限。" });
      rejected.respond({ message_id: 1 });

      sendOneBot("#权限配置", group);
      const owner = await onebot.next("send_msg");
      expect(owner.params).toMatchObject({ group_id: 701, message: [expect.objectContaining({ type: "image" })] });
      owner.respond({ message_id: 2 });

      await sendMilky("#签到白名单列表");
      const privateOwner = await milky.next("send_private_message");
      expect(privateOwner.params).toMatchObject({ user_id: 43, message: [expect.objectContaining({ type: "image" })] });
      privateOwner.respond({ message_seq: 3 });

      expect(await readFile(join(root, "config/global.yaml"), "utf8")).toBe(config);
      expect(await Bun.file(join(root, "data/audit/permissions.jsonl")).exists()).toBe(false);
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
    }, 6_000, undefined, async (root) => {
      await mkdir(join(root, "config"), { recursive: true });
      await writeFile(join(root, "config/global.yaml"), config);
      await writeFile(join(root, "config/group.yaml"), "default: {groupCD: 0, singleCD: 0}\n");
    });
}, 18_000);

test("旧权限修改校验名单语义，审计不可用或保存前失去授权时保留原配置", async () => {
  expect(parsePermissionEdit("#自动签到白名单")).toEqual({ type: "defaultPolicy", policy: "deny" });
  expect(parsePermissionEdit("#添加黑名单44")).toEqual({ type: "listUpdate", action: "deny", subject: "users", id: "44" });
  expect(parsePermissionEdit("#删除白名单 44")).toEqual({ type: "listUpdate", action: "remove", subject: "users", id: "44" });
  expect(parsePermissionEdit("#权限群移除 701")).toEqual({ type: "listUpdate", action: "remove", subject: "groups", id: "701" });
  expect(parsePermissionEdit("#权限设置 tools.install 允许")).toBe("invalid");
  expect(parsePermissionEdit("#权限设置 captcha.manage 允许")).toBe("unsupported");
  const root = await mkdtemp(join(tmpdir(), "lotus-chat-permissions-"));
  try {
    const installation = pathToFileURL(root + "/");
    const file = join(root, "config/global.yaml"), audit = join(root, "data/audit/permissions.jsonl");
    await mkdir(join(root, "config"));
    await mkdir(audit, { recursive: true });
    const config = "permissions: {default_policy: allow}\n";
    await writeFile(file, config);
    const signal = new AbortController().signal;
    const edit = { type: "defaultPolicy", policy: "deny" } as const;
    expect(await editChatPermissions(installation, edit, { signal, actor: "42", active: () => true })).toMatch("操作");
    expect(await readFile(file, "utf8")).toBe(config);

    await rm(audit, { recursive: true });
    let checked = 0;
    expect(await editChatPermissions(installation, edit, { signal, actor: "42", active: () => ++checked < 3 })).toMatch("未能修改");
    expect(await readFile(file, "utf8")).toBe(config);

    const panel = panelGlobalPermissions(installation);
    const { revision } = await (await panel(new Request("http://loopback"), () => true)).json();
    expect(await editChatPermissions(installation, edit, { signal, actor: "42", active: () => true })).toMatchObject({ changed: true });
    const stale = await panel(new Request("http://loopback", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision, patch: { "users.allow": ["44"] } }),
    }), () => true);
    expect(stale.status).toBe(409);
    expect(Bun.YAML.parse(await readFile(file, "utf8"))).toEqual({ permissions: { default_policy: "deny" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("旧权限修改在双协议使用现有名单和作用域设置，按同一操作写入私有审计", async () => {
  const config = "# preserve comments\npermissions: {default_policy: allow, users: {allow: [44]}, scopes: {checkin.refresh: {policy: inherit}}}\nother: {sample: kept}\n";
  await withDualGatewayFixture("permission-chat-edits", 'master: ["99:42", "100:43"]\ndisablePrivate: false\n',
    async ({ root, sendOneBot, sendMilky, onebot, milky }) => {
      const file = join(root, "config/global.yaml");
      const audit = join(root, "data/audit/permissions.jsonl");
      sendOneBot("#权限拒绝用户 @44", { user_id: 44 });
      const denied = await onebot.next("send_msg");
      expect(denied.params).toMatchObject({ user_id: 44, message: "只有机器人主人可以查看或修改业务权限。" });
      denied.respond({ message_id: 1 });
      expect(await readFile(file, "utf8")).toBe(config);
      expect(await Bun.file(audit).exists()).toBe(false);

      sendOneBot("#权限拒绝用户 @44");
      const changed = await onebot.next("send_msg");
      expect(changed.params).toMatchObject({ user_id: 42, message: [expect.objectContaining({ type: "image" })] });
      changed.respond({ message_id: 2 });
      const actual = await readFile(file, "utf8");
      expect(actual).toStartWith("# preserve comments\n");
      expect(Bun.YAML.parse(actual)).toMatchObject({ permissions: { users: { allow: [], deny: ["44"] } }, other: { sample: "kept" } });

      await sendMilky("#权限设置 group.members.export 拒绝");
      const scope = await milky.next("send_private_message");
      expect(scope.params).toMatchObject({ user_id: 43, message: [expect.objectContaining({ type: "image" })] });
      scope.respond({ message_seq: 3 });
      expect(Bun.YAML.parse(await readFile(file, "utf8"))).toMatchObject({
        permissions: { scopes: { "checkin.refresh": { policy: "inherit" }, "group.members.export": { policy: "deny" } } },
      });
      await sendMilky("#权限设置 remote.spawn 允许");
      const unsupported = await milky.next("send_private_message");
      expect(unsupported.params).toMatchObject({ message: [{ data: { text: "该业务作用域当前不可通过聊天配置。" } }] });
      unsupported.respond({ message_seq: 4 });
      const rows = (await readFile(audit, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      expect(rows).toEqual([
        expect.objectContaining({ actor: "42", phase: "plan", result: "pending", command: { type: "listUpdate", subject: "users", action: "deny", id: "44" } }),
        expect.objectContaining({ actor: "42", phase: "result", result: "ok", operation: rows[0].operation }),
        expect.objectContaining({ actor: "43", phase: "plan", result: "pending", command: { type: "scopePolicy", scope: "group.members.export", policy: "deny" } }),
        expect.objectContaining({ actor: "43", phase: "result", result: "ok", operation: rows[2].operation }),
      ]);
      expect((await stat(audit)).mode & 0o077).toBe(0);
    }, 6_000, undefined, async (root) => {
      await writeFile(join(root, "config/global.yaml"), config);
    });
}, 18_000);
