import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { copyHost } from "./host-fixture.ts";
import { lockFile } from "../lib/file-lock.ts";
import { readGroupRecallPermissions } from "../lib/quoted-recall.ts";
import { createManagedBlacklist, readManagedWhitelist } from "../plugins/group/managed-blacklist.ts";

test("面板群通知用宿主令牌和版本控制保存全部默认开关与撤回缓存", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-panel-notice-"));
  const token = "group-notice-panel-fixture";
  let host: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await copyHost(root);
    await cp(new URL("../plugins/group", import.meta.url), join(root, "plugins/group"), {
      recursive: true,
      filter: path => !path.endsWith("/.git") && !path.endsWith("/node_modules"),
    });
    await mkdir(join(root, "config"), { recursive: true });
    const file = join(root, "config/group-notice.yaml");
    const original = "# 保留注释\ndefault: { groupMessage: false, privateMessage: true }\n" +
      '42: { groupMessage: false }\n"99:42": { groupRecall: false }\n"bot:99": { notificationsAll: true }\n' +
      '"bot:99:42": { groupMessage: false, groupRecall: true, other: 1 }\n';
    await writeFile(file, original);
    host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0", LOTUS_PANEL_TOKEN: token },
    });
    const processHost = host;
    timer = setTimeout(() => processHost.kill("SIGKILL"), 6_000);
    const errors = new Response(host.stderr).text();
    const stream = host.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let seen = "";
    let endpoint: URL;
    try {
      for (;;) {
        const match = /http:\/\/127\.0\.0\.1:\d+\/status/u.exec(seen);
        if (match) {
          endpoint = new URL("/panel/api/settings/group/notices", match[0]);
          break;
        }
        const next = await stream.read();
        if (next.done) throw new Error(`通知面板测试宿主没有启动。\n${seen}\n${await errors}`);
        seen += next.value;
      }
    } finally {
      stream.releaseLock();
    }

    async function request(method = "GET", body?: unknown, credential = token, path?: string) {
      return fetch(path ? new URL(path, endpoint) : endpoint, {
        method, signal: AbortSignal.timeout(3_000),
        headers: { Authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    expect((await request("GET", undefined, "other-panel-token")).status).toBe(401);
    expect((await request("POST")).status).toBe(405);
    const reading = await request();
    expect(reading.status).toBe(200);
    expect(reading.headers.get("Cache-Control")).toBe("no-store");
    const before = await reading.json() as { revision: string; settings: Record<string, boolean | number>; writable: boolean };
    expect(before.writable).toBe(true);
    expect(Object.keys(before.settings)).toHaveLength(15);
    expect(before.settings).toMatchObject({ groupMessage: false, privateMessage: true, PrivateRecall: false,
      friendRequest: false, groupInviteRequest: false, friendNumberChange: false, notificationsAll: true, msgSaveDeltime: 600 });
    expect(Object.keys(before).sort()).toEqual(["revision", "settings", "writable"]);

    const patch = { groupMessage: true, addGroupApplication: true, privateMessage: false, PrivateRecall: true,
      friendRequest: true, groupInviteRequest: true, friendNumberChange: true, notificationsAll: false, msgSaveDeltime: 300 };
    const save = { revision: before.revision, patch };
    expect((await request("PUT", { ...save, path: "config/other.yaml" })).status).toBe(400);
    expect((await request("PUT", { ...save, patch: { msgSaveDeltime: 0 } })).status).toBe(400);
    expect((await request("PUT", { ...save, patch: { default: { notificationsAll: false } } })).status).toBe(400);
    expect((await request("PUT", save, "other-panel-token")).status).toBe(401);
    expect(await readFile(file, "utf8")).toBe(original);

    const saved = await request("PUT", save);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ settings: patch, writable: true });
    expect(await (await request()).json()).toMatchObject({ settings: patch });
    const changed = await readFile(file, "utf8");
    expect(changed).toContain("# 保留注释");
    expect(changed).toContain("privateMessage: false");
    expect(changed).toContain('42: { groupMessage: false }\n"99:42": { groupRecall: false }\n"bot:99": { notificationsAll: true }');
    expect((await request("PUT", { revision: before.revision, patch: { groupMessage: false } })).status).toBe(409);
    expect(await readFile(file, "utf8")).toBe(changed);

    const scopePath = "?scope=bot%3A99%3A42";
    const scope = await (await request("GET", undefined, token, scopePath)).json() as typeof before;
    expect(scope).toMatchObject({ scope: "bot:99:42", scopes: ["42", "bot:99", "bot:99:42"], writable: true,
      settings: { groupMessage: false, groupRecall: true, botBeenBanned: null } });
    expect((await request("GET", undefined, token, "?scope=../default")).status).toBe(400);
    expect((await request("PUT", { revision: scope.revision, patch: { groupMessage: true } }, token, "?scope=42")).status).toBe(409);
    expect((await request("PUT", { revision: scope.revision, patch: { groupMessage: null, groupRecall: null, botBeenBanned: true } },
      token, scopePath)).status).toBe(200);
    const cleared = await (await request("GET", undefined, token, scopePath)).json();
    expect(cleared).toMatchObject({ settings: { groupMessage: null, groupRecall: null, botBeenBanned: true } });
    expect(Bun.YAML.parse(await readFile(file, "utf8"))).toMatchObject({ "bot:99:42": { botBeenBanned: true, other: 1 } });

    const moderationFile = join(root, "config/groupAdmin.yaml");
    const legacyManagement = join(root, "plugins/yenai-plugin/config/config");
    await mkdir(legacyManagement, { recursive: true });
    await writeFile(join(legacyManagement, "groupAdmin.yaml"), 'groupAddNotice: {openGroup: [88], msg: 旧提醒}\n' +
      'whiteQQ: [10]\nrecallMsgPer: {bot: owner, member: master}\n' +
      'groupVerify: {openGroup: [88], mode: 模糊, time: "120", range: {min: 3, max: 60}, SuccessMsgs: {88: 旧文案, 0: 默认旧文案}}\n');
    await writeFile(moderationFile, 'groupVerify: {range: {min: 5, keep: true}, time: 180}\nblackQQ: [20] # 保持\n');
    const base = "/panel/api/settings/native/";
    const routingPath = base + "group-routing";
    const likesFile = join(root, "config/group.yaml");
    const groupRouting = join(root, "config/config/group.yaml");
    const groupDefaults = join(root, "config/default_config/group.yaml");
    const inheritedRouting = "default: {onlyReplyAt: 1}\n43: {botAlias: [旧群别名]}\n";
    await mkdir(join(root, "config/config"), { recursive: true });
    await mkdir(join(root, "config/default_config"), { recursive: true });
    await writeFile(groupDefaults, inheritedRouting);
    await writeFile(likesFile, "enable: true\ncount: 5\n");
    await writeFile(groupRouting, '# 旧安装\ndefault: { groupCD: 0, extra: 42 }\n42:\n  onlyReplyAt: 1 # 仅响应提及\n');
    const routingResult = await request("GET", undefined, token, routingPath);
    expect(routingResult.status).toBe(200);
    const { values: routing } = await routingResult.json() as { values: { file: string; rules: Record<string, object> } };
    expect(routing).toEqual({ file: "config/config/group.yaml", rules: { default: { groupCD: 0 }, 42: { onlyReplyAt: 1 } } });
    const routingSave = { previous: routing, values: {
      ...routing, rules: { ...routing.rules, default: { groupCD: 5 }, "99:42": { disable: ["群公告"] } },
    } };
    expect((await request("PUT", { ...routingSave, values: {
      ...routingSave.values, rules: { default: { unrelated: true } },
    } }, token, routingPath)).status).toBe(400);
    const routingSaved = await request("PUT", routingSave, token, routingPath);
    expect(routingSaved.status).toBe(200);
    expect(await routingSaved.json()).toMatchObject({ values: routingSave.values });
    expect((await request("PUT", routingSave, token, routingPath)).status).toBe(409);
    const routingYaml = await readFile(groupRouting, "utf8");
    expect(routingYaml).toContain("仅响应提及");
    expect(Bun.YAML.parse(routingYaml)).toMatchObject({
      default: { groupCD: 5, extra: 42 }, 42: { onlyReplyAt: 1 }, "99:42": { disable: ["群公告"] },
    });
    expect(await readFile(likesFile, "utf8")).toBe("enable: true\ncount: 5\n");
    expect(await readFile(groupDefaults, "utf8")).toBe(inheritedRouting);
    await writeFile(likesFile, "enable: true\ncount: 5\n42: { onlyReplyAt: 2 }\n");
    const { values: modernRouting } = await (await request("GET", undefined, token, routingPath)).json() as { values: typeof routing };
    expect(modernRouting).toEqual({ file: "config/group.yaml", rules: { 42: { onlyReplyAt: 2 } } });
    const clearedRules = await request("PUT", { previous: modernRouting, values: { ...modernRouting, rules: {} } }, token, routingPath);
    expect(clearedRules.status).toBe(200);
    expect(await clearedRules.json()).toMatchObject({ values: { file: "config/group.yaml", rules: { default: {} } } });
    expect(Bun.YAML.parse(await readFile(likesFile, "utf8"))).toEqual({ enable: true, count: 5, default: {} });
    expect(await readFile(groupRouting, "utf8")).toBe(routingYaml);
    const moderationPath = base + "group-moderation";
    const moderationResult = await request("GET", undefined, token, moderationPath);
    expect(moderationResult.status).toBe(200);
    const moderation = await moderationResult.json() as { values: Record<string, unknown> };
    expect(moderation.values).toMatchObject({ noticeGroups: [88], noticeMessage: "旧提醒", verifyGroups: [88], verifyMode: "模糊",
      verifySeconds: 180, verifyMin: 5, verifyMax: 60, verifyMessages: { 88: "旧文案", 0: "默认旧文案" },
      whiteQQ: [10], blackQQ: [20], recallBot: "owner", recallMember: "master" });
    expect((await request("PUT", { previous: moderation.values, values: { ...moderation.values, verifyMin: 70 } }, token, moderationPath)).status).toBe(400);
    expect((await request("PUT", { previous: moderation.values, values: { ...moderation.values, recallBot: "invalid" } }, token, moderationPath)).status).toBe(400);
    const managementSave = { previous: moderation.values, values: { ...moderation.values, verifyMax: 80, verifyMessages: { 0: "默认旧文案", 99: "本群新文案" },
      verifyGroups: [99], noticeGroups: [99], noticeMessage: "审核提醒。\n请查看。", whiteQQ: [], recallBot: "admin", recallMember: "owner" } };
    const managementSaved = await request("PUT", managementSave, token, moderationPath);
    expect(managementSaved.status).toBe(200);
    expect(await managementSaved.json()).toMatchObject({ values: managementSave.values });
    expect((await request("PUT", managementSave, token, moderationPath)).status).toBe(409);
    const managementYaml = await readFile(moderationFile, "utf8");
    expect(managementYaml).toContain("# 保持");
    expect(Bun.YAML.parse(managementYaml)).toMatchObject({ blackQQ: [20], groupVerify: { range: { keep: true, min: 5, max: 80 }, SuccessMsgs: { 88: "", 99: "本群新文案" } } });
    const managementRoot = pathToFileURL(root + "/");
    expect(await readGroupRecallPermissions(managementRoot)).toEqual({ bot: "admin", member: "owner" });
    expect(await readManagedWhitelist(managementRoot)).toEqual(new Set());
    const blackListUpdate = { ...managementSave.values, blackQQ: [40], whiteQQ: [41], noBan: true, VoteKick: true, minNum: 6 };
    expect((await request("PUT", { previous: managementSave.values, values: blackListUpdate }, token, moderationPath)).status).toBe(200);
    const groupManagement = createManagedBlacklist(managementRoot, lockFile);
    expect(await groupManagement.blocked(40)).toBe(true);
    expect(await groupManagement.blocked(20)).toBe(false);
    expect(await groupManagement.shouldAutoUnmute(41)).toBe(true);
    expect(await groupManagement.readGroupVoteSettings()).toMatchObject({ VoteKick: true, minNum: 6 });

    await mkdir(join(root, "config/config"), { recursive: true });
    const cardFile = join(root, "config/config/auto-group-card.yaml");
    await writeFile(cardFile, 'cron: "0 0 * * * *"\nsuffixes: [旧文案]\nnotGroup: ["88"]\nother: 保留\n');
    const cardPath = base + "group-card";
    const card = await (await request("GET", undefined, token, cardPath)).json() as { values: Record<string, unknown> };
    expect(card.values).toMatchObject({ enable: true, notGroup: [88], suffixes: ["旧文案"] });
    expect((await request("PUT", { previous: card.values, values: { ...card.values, cron: "61 0 * * * *" } }, token, cardPath)).status).toBe(400);
    const cardConfig = { ...card.values, notGroup: [99], suffixes: ["新文案"], cron: "0 30 * * * *" };
    expect((await request("PUT", { previous: card.values, values: cardConfig }, token, cardPath)).status).toBe(200);
    expect(Bun.YAML.parse(await readFile(cardFile, "utf8"))).toMatchObject({ notGroup: [99], suffixes: ["新文案"], other: "保留" });

    const leavePath = base + "group-leave-blacklist";
    const leave = await (await request("GET", undefined, token, leavePath)).json() as { values: Record<string, unknown> };
    expect(leave.values).toEqual({ enable: false, groups: [] });
    expect((await request("PUT", { previous: leave.values, values: { enable: true, groups: [99] } }, token, leavePath)).status).toBe(200);
    expect(Bun.YAML.parse(await readFile(join(root, "config/group-leave-blacklist.yaml"), "utf8"))).toEqual({ enable: true, groups: [99] });

    await writeFile(file, "default: {broken");
    const unavailable = await (await request()).json() as { revision: string; writable: boolean };
    expect(unavailable.writable).toBe(false);
    expect((await request("PUT", { revision: unavailable.revision, patch: { groupMessage: false } })).status).toBe(503);
    expect(await readFile(file, "utf8")).toBe("default: {broken");
  } finally {
    clearTimeout(timer);
    host?.kill();
    await host?.exited;
    await rm(root, { recursive: true, force: true });
  }
});
