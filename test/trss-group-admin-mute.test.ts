import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindGroupVerificationScope, bindMessageGroupActions } from "../lib/adapters/group-moderation.ts";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const group = 77;
const oneBotId = 99;
const milkyId = 100;
const operator = 51;
const token = "group-admin-mute-fixture";
type Call = { readonly action: string; readonly params: Record<string, unknown> };
const noticeImageUrl = "https://gchat.qpic.cn/download?fixture=notice";
const noticeImageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR42mNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const imageDigest = createHash("md5").update(Buffer.from(noticeImageBase64, "base64")).digest("hex");

async function waitUntil<T>(read: () => T | undefined, description: string): Promise<T> {
  const until = performance.now() + 3_500;
  while (performance.now() < until) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error(description);
}

function liveMember({ group_id, user_id }: Call["params"]) {
  const role = user_id === milkyId || (user_id === oneBotId && group_id === 82) ? "owner" :
    [oneBotId, operator, 53].includes(Number(user_id)) ? "admin" : "member";
  return { group_id: user_id === 45 ? 80 : group_id, user_id, role };
}

test("预检期间关机时当前会话不能继续禁言", async () => {
  const requested = Promise.withResolvers<void>();
  let active = true;
  let sent = 0;
  const actions = bindMessageGroupActions({
    bot: 99, actor: 51, signal: new AbortController().signal, accepting: () => active, isMaster: () => true,
    isProtected: () => false, async role(id) {
      if (id === 42) await requested.promise;
      return id === 99 ? "admin" : "member";
    },
    async mute() { sent++; return "confirmed"; },
    async wholeMute() { sent++; return "confirmed"; },
    async kick() { sent++; return "confirmed"; },
    async title() { sent++; return "confirmed"; },
    async setAdmin() { sent++; return "confirmed"; },
  });
  const held = actions.groupMute(42, 300);
  active = false;
  requested.resolve();
  expect(await held).toBe("unavailable");
  expect(sent).toBe(0);
});

test("群投票终局复核当前角色、目标保护和暂停信号，网关确认的回复才可计时", async () => {
  const connection = new AbortController();
  const power = new AbortController();
  const roles = new Map<number, "member" | "admin" | "owner">([[99, "admin"], [54, "member"], [55, "member"], [56, "admin"]]);
  const writes: number[] = [];
  let confirmed = false;
  const vote = bindMessageGroupActions({
    bot: 99, actor: 54, signal: connection.signal, isMaster: () => false, isProtected: id => id === 56,
    role: async id => roles.get(id),
    async mute(id) { writes.push(id); return "confirmed"; },
    async kick(id) { writes.push(id); return "confirmed"; },
    async wholeMute() { return "confirmed"; },
    async title() { return "confirmed"; },
    async setAdmin() { return "confirmed"; },
    vote: { signal: power.signal, async reply() { return confirmed; } },
  }).groupVote!;
  expect(vote.connection).toBe(connection.signal);
  expect(await vote.inspect(55)).toEqual({ actor: "member", bot: "admin", target: "member", protectedTarget: false });
  expect(await vote.reply(["原群"])).toBe(false);
  confirmed = true;
  expect(await vote.reply(["原群"])).toBe(true);
  expect(await vote.execute(55, "mute", 30, false, true)).toBe("unavailable");
  expect(await vote.execute(56, "kick", 0, true)).toBe("protected");
  roles.set(55, "admin");
  expect(await vote.execute(55, "mute", 30, true)).toBe("protected");
  roles.set(99, "owner");
  expect(await vote.execute(55, "mute", 30, true)).toBe("confirmed");
  power.abort();
  expect(vote.signal.aborted).toBe(true);
  expect(await vote.execute(55, "mute", 30, true)).toBe("unavailable");
  expect(await vote.reply(["原群"])).toBe(false);
  expect(writes).toEqual([55]);
});

test("管理员手动重验在超时写出前再次核对发令者权限和成员入群时间", async () => {
  const controller = new AbortController();
  let actorRole: "member" | "admin" = "admin";
  let joined = 101;
  let kicks = 0;
  const scope = bindGroupVerificationScope({ connection: controller.signal, workflow: controller.signal,
    botId: 99, groupId: 82, actorId: 51, accepting: () => true, isMaster: () => false, isProtected: () => false,
    transport: { adapter: "onebot", async member(id) {
      if (id === 99) return { role: "owner" };
      if (id === 51) return { role: actorRole };
      return { role: "member", joinTime: joined };
    }, async send() { return true; } },
    async kick() { kicks++; return "confirmed"; },
  });
  const subject = (await scope.prepare(54))!;
  expect(await subject.inspect()).toMatchObject({ targetRole: "member", targetJoinTime: 101 });
  actorRole = "member";
  expect(await subject.kick(controller.signal, 101)).toBe("unavailable");
  actorRole = "admin";
  joined = 102;
  expect(await subject.kick(controller.signal, 101)).toBe("unavailable");
  expect(kicks).toBe(0);
});

test("双协议群管理复核名单、成员权限和各项网关回执", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-group-mute-wire-"));
  const milkyCalls: Call[] = [];
  const milkyPrivateHistory = new Map<number, Call["params"]>();
  let milkyJoinState: "pending" | "rejected" = "pending";
  let milkyJoinReceipt: number | undefined;
  let wrongMilkyAnnouncementGroup = false;
  let pendingJoinListing = false;
  let milkyFriendReviewFixture = false;
  let regularFriendReadback = "pending";
  let changingFriendReads = 0;
  let includeNoticeOwnersInFriendList = false;
  let includeNewFriendProfile = false;
  const rosterChanges = new Map<string, "admin" | "member">();
  const memberJoinTimes = new Map<string, number>();
  const memberLastSentTimes = new Map<string, number>();
  let cleanupRosterChanged = false;
  let batchRoster = false;
  const activity = (group_id: number, bot: number) => {
    const joined = 1_700_000_000;
    return [
      { group_id, user_id: bot, role: "member", join_time: joined, last_sent_time: joined },
      { group_id, user_id: operator, role: "admin", join_time: joined, last_sent_time: joined },
      { group_id, user_id: 42, role: "member", card: "从未发言夹具", join_time: joined,
        last_sent_time: group_id === 86 && cleanupRosterChanged ? joined + 60 : joined },
      { group_id, user_id: 54, role: "member", card: "已有活动夹具", join_time: joined + 5, last_sent_time: joined + 10 },
      ...(group_id === 79 && batchRoster ? [{ group_id, user_id: 77, role: "member", join_time: joined + 3, last_sent_time: joined + 3 }] : []),
      ...(group_id === 86 ? [{ group_id, user_id: 62, role: "member", join_time: joined + 1, last_sent_time: joined + 1 }] : []),
      ...(group_id === 86 && cleanupRosterChanged ? [
        { group_id, user_id: 63, role: "member", join_time: joined + 12, last_sent_time: joined + 12 },
      ] : []),
    ];
  };
  const reportedMembers = (group: unknown, bot: number) => group === 85 ? 5 : activity(Number(group), bot).length;
  function member(params: Call["params"]) {
    const baseline = liveMember(params);
    const key = `${params.group_id}:${params.user_id}`;
    return { ...baseline, role: rosterChanges.get(key) ?? baseline.role, join_time: memberJoinTimes.get(key),
      last_sent_time: memberLastSentTimes.get(key), ...(key === "88:55" ? { card: "合成私聊名片" } : {}),
      ...(key === "88:52" ? { group_id: 89 } : {}) };
  }
  function updateRole(params: Call["params"], enabled: unknown) {
    rosterChanges.set(`${params.group_id}:${params.user_id}`, enabled === true ? "admin" : "member");
  }
  function milkyJoinNotifications(params: Call["params"]) {
    const previous = { group_id: 79, notification_seq: 901, type: "invited_join_request",
      initiator_id: 72, target_user_id: 74, state: milkyJoinState };
    if (!pendingJoinListing) return { notifications: [previous] };
    if (params.is_filtered === true) return { notifications: [
      { group_id: 79, notification_seq: 991, type: "join_request", initiator_id: 73, state: "pending", is_filtered: true },
    ] };
    if (params.start_notification_seq === 890) return { notifications: [
      { group_id: 79, notification_seq: 889, type: "join_request", initiator_id: 75,
        state: "pending", is_filtered: false, comment: "合成第二页申请" },
      { group_id: 79, notification_seq: 888, type: "join_request", initiator_id: 77, state: "pending", is_filtered: false },
      { group_id: 79, notification_seq: 887, type: "join_request", initiator_id: 77, state: "pending", is_filtered: false },
    ] };
    return { notifications: [
      { group_id: 79, notification_seq: 903, type: "invited_join_request", initiator_id: 72, target_user_id: 78, state: "pending" },
      { group_id: 80, notification_seq: 902, type: "join_request", initiator_id: 76, state: "pending", is_filtered: false, comment: "隔壁群附言" },
      previous,
    ], next_notification_seq: 890 };
  }
  function milkyFriendNotifications(isFiltered: unknown) {
    const row = { initiator_id: 93, initiator_uid: "milky_fixture_sender", target_user_id: milkyId,
      is_filtered: isFiltered, time: 1_704_038_405, state: regularFriendReadback, via: "合成搜索", comment: "常规好友附言" };
    return { requests: isFiltered ? [{ ...row, state: "pending", initiator_id: 94, initiator_uid: "milky_fixture_risk", comment: "风险好友附言" }] : [
      row, { ...row, target_user_id: oneBotId, comment: "另一个账号的好友申请" },
      { ...row, initiator_id: 92, initiator_uid: "milky_fixture_accepted", state: "accepted", comment: "已处理的好友审批" },
      ...(milkyFriendReviewFixture ? [
        { ...row, state: "pending", initiator_id: 96, initiator_uid: "milky_fixture_stale" },
        { ...row, state: "pending", initiator_id: 97, initiator_uid: "milky_fixture_double" },
        { ...row, state: "pending", initiator_id: 97, initiator_uid: "milky_fixture_double", time: row.time + 1 },
        { ...row, state: "pending", initiator_id: 98, initiator_uid: "milky_fixture_changing", time: row.time + changingFriendReads++ },
        { ...row, state: "pending", initiator_id: 95, initiator_uid: "milky_fixture_unknown" },
      ] : []),
    ] };
  }
  const milky = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
      const action = new URL(request.url).pathname.split("/").at(-1)!;
      const params = await request.json() as Call["params"];
      milkyCalls.push({ action, params });
      if (action === "send_private_message") milkyPrivateHistory.set(milkyCalls.length, params);
      if (action === "send_group_message" && params.group_id === 79 && JSON.stringify(params.message).includes("邀请人：72")) {
        milkyJoinReceipt = milkyCalls.length;
      }
      if (action === "reject_group_request" && params.notification_seq === 901) milkyJoinState = "rejected";
      if (action === "accept_friend_request" && params.initiator_uid === "milky_fixture_sender") regularFriendReadback = "accepted";
      if (action === "accept_friend_request" && params.initiator_uid === "milky_fixture_unknown") return new Response(null, { status: 503 });
      if (action === "send_private_message" && params.user_id === 43 && JSON.stringify(params.message).includes("合成 Milky 未知回复")) {
        return new Response(null, { status: 503 });
      }
      if ((action === "set_group_member_mute" && params.user_id === 44) ||
          (action === "kick_group_member" && params.user_id === 44) ||
          (action === "set_group_member_admin" && params.user_id === 60044) ||
          (action === "set_group_essence_message" && params.is_set === false) ||
          (action === "send_group_message" && JSON.stringify(params.message).includes("合成未知通知")) ||
          (action === "send_group_announcement" && params.content === "模拟未知公告") ||
          (action === "set_group_whole_mute" && params.group_id !== 88 && params.is_mute === false)) return new Response(null, { status: 503 });
      if (action === "set_group_member_admin") updateRole(params, params.is_set);
      const data = action === "get_login_info" ? { uin: milkyId } : action === "get_group_member_info" ?
        { member: member(params) } : action === "send_group_message" || action === "send_private_message" ? { message_seq: milkyCalls.length }
        : action === "get_group_info" ? { group: { group_id: params.group_id, member_count: reportedMembers(params.group_id, milkyId),
          group_name: `合成 Milky ${params.group_id}` } }
        : action === "get_group_member_list" ? { members: activity(Number(params.group_id), milkyId) }
        : action === "get_group_notifications" ? milkyJoinNotifications(params)
        : action === "get_friend_requests" ? milkyFriendNotifications(params.is_filtered)
        : action === "get_friend_list" ? { friends: [{ user_id: 43 }, ...(includeNoticeOwnersInFriendList ? [{ user_id: operator }] : [])] }
        : action === "get_resource_temp_url" ? (params.resource_id === "matched-picture" ? { url: noticeImageUrl } : {})
        : action === "get_group_announcements" ? { announcements: params.group_id === 84 ? [] : [{
          group_id: wrongMilkyAnnouncementGroup ? 82 : params.group_id, announcement_id: "opaque-milky",
          content: "合成 Milky 公告 👩‍👩‍👧‍👧", image_url: "https://example.test/image",
        }] }
        : action === "get_message" && params.message_scene === "friend" ? { message: {
          message_scene: "friend", peer_id: milkyPrivateHistory.get(Number(params.message_seq))?.user_id, message_seq: params.message_seq,
          sender_id: milkyId, segments: milkyPrivateHistory.get(Number(params.message_seq))?.message,
        } }
        : action === "get_message" ? { message: {
          message_scene: "group", peer_id: params.peer_id, message_seq: params.message_seq,
          sender_id: params.message_seq === milkyJoinReceipt ? milkyId : 42,
          segments: [{ type: "text", data: { text: "被引用的合成消息" } }],
        } } : {};
      return Response.json({ status: "ok", retcode: 0, data });
    },
  });
  let host: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let socket: WebSocket | undefined;
  try {
    await copyHost(root);
    await cp(new URL("../plugins/group", import.meta.url), join(root, "plugins", "group"), {
      recursive: true, filter: path => !path.endsWith("/.git") && !path.endsWith("/node_modules"),
    });
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config/other.yaml"), 'master: ["100:51", "99:52"]\nmasterQQ: [52]\ndisablePrivate: true\n');
    await writeFile(join(root, "config/group.yaml"), "default: {groupCD: 0, singleCD: 0}\n78: {disable: [椰奶群管-基础]}\n80: {disable: [椰奶群管-黑白名单]}\n81: {disable: [椰奶群管-违禁词]}\n86: {onlyReplyAt: 1, botAlias: [助理]}\n87: {disable: [椰奶群管-群公告, 椰奶私聊群管]}\n89: {disable: [椰奶配置-通知]}\n");
    const legacyDirectory = join(root, "plugins/yenai-plugin/config/config");
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(join(legacyDirectory, "notice.yaml"), 'default: { friendRequest: false }\n"bot:99": { friendRequest: true }\n');
    const legacyList = join(legacyDirectory, "groupAdmin.yaml");
    await writeFile(legacyList, "# 原群管配置\nblackQQ: [52, 57]\nwhiteQQ: [59] # 白名单\nnoBan: false\n");
    const legacyRules = join(root, "plugins/yenai-plugin/config/group");
    await mkdir(legacyRules, { recursive: true });
    const testRules = JSON.stringify({ muteTime: 45, bannedWords: {
      合成违禁测试: { matchType: 1, penaltyType: 5 },
      合成踢黑测试: { matchType: 2, penaltyType: 6 },
    } });
    await writeFile(join(legacyRules, "79.json"), testRules);
    await writeFile(join(legacyRules, "81.json"), testRules);
    await writeFile(join(root, "config/milky.yaml"),
      `enable: true\nhost: 127.0.0.1\nport: ${milky.port}\nconnection: webhook\naccess_token: ${token}\n`);
    const noticePreload = join(root, "notice-media-fixture.ts");
    await writeFile(noticePreload, `
      const send = globalThis.fetch;
      globalThis.fetch = (source, options) => {
        const url = new URL(source instanceof Request ? source.url : String(source));
        if (url.href === ${JSON.stringify(noticeImageUrl)}) {
          return Promise.resolve(new Response(Buffer.from(${JSON.stringify(noticeImageBase64)}, "base64"), {
            headers: { "Content-Type": "image/png" }
          }));
        }
        if (url.hostname === "127.0.0.1") return send(source, options);
        return Promise.reject(new Error("隔离宿主不请求公网。"));
      };
    `);
    disableMemberPrewarm(root);
    host = Bun.spawn([process.execPath, "--preload", noticePreload, "app.ts"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_TOKEN: token } });
    const output = { stdout: "", stderr: "" };
    const read = (stream: ReadableStream<Uint8Array>, key: keyof typeof output) => {
      const decoder = new TextDecoder();
      return stream.pipeTo(new WritableStream({ write(chunk) { output[key] += decoder.decode(chunk, { stream: true }); } }));
    };
    void read(host.stdout, "stdout");
    void read(host.stderr, "stderr");
    const ws = await waitUntil(() => /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output.stdout)?.[0], output.stderr);
    const http = await waitUntil(() => /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output.stdout)?.[1], output.stderr);
    const Gateway = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const client = socket = new Gateway(ws, { headers: {
      Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": String(oneBotId),
    } });
    const oneBotCalls: Call[] = [];
    const oneBotPrivateHistory = new Map<number, Call["params"]>();
    const oneBotChangedNotices = new Set<number>();
    const oneBotJoinReceipts = new Set<number>();
    const removedOneBotAnnouncements = new Set<string>();
    let originalJoinChecked = false;
    let oneBotGatewayName = "NapCat.Onebot";
    let exposeGroupInvitation = true;
    const nowSeconds = () => Math.floor(Date.now() / 1000);
    client.onmessage = ({ data }) => {
      const { action, params, echo } = JSON.parse(data);
      oneBotCalls.push({ action, params });
      if (action === "send_msg" && params.message_type === "private") oneBotPrivateHistory.set(oneBotCalls.length, params);
      if (action === "send_msg" && params.group_id === 82 && JSON.stringify(params.message).includes("合成入群提醒")) {
        oneBotJoinReceipts.add(oneBotCalls.length);
      }
      if (action === "set_group_add_request" && params.flag === "910001") originalJoinChecked = true;
      if (action === "_del_group_notice" && params.notice_id === "opaque-image") removedOneBotAnnouncements.add(params.notice_id);
      if (action === "set_group_admin") updateRole(params, params.enable);
      const denied = action === "set_group_ban" && params.group_id === 82 && params.user_id === 44;
      const reply = action === "get_group_member_info" ? member(params)
        : action === "send_msg" ? { message_id: oneBotCalls.length }
        : action === "get_friend_list" ? [{ user_id: 42 }, ...(includeNoticeOwnersInFriendList ? [{ user_id: 52 }] : []),
          ...(includeNewFriendProfile ? [{ user_id: 46, nickname: "合成新增好友昵称" }] : [])]
        : action === "get_friend_msg_history" ? { messages: [...oneBotPrivateHistory].flatMap(([message_id, stored]) =>
          message_id === params.message_seq && stored.user_id === params.user_id ? [{
            message_id, self_id: oneBotId, user_id: oneBotId, sender: { user_id: oneBotId }, message_type: "private", sub_type: "friend",
            message: oneBotChangedNotices.has(message_id) ? [{ type: "text", data: { text: "同一回执上的别的好友内容" } }] : stored.message,
          }] : []) }
        : action === "get_group_shut_list" ? [
          { uin: "43", cardName: "合成群名片", nick: "合成昵称", role: 2, shutUpTime: nowSeconds() + 81 },
          { uin: "44", nick: "另一个群成员", role: 3, shutUpTime: nowSeconds() + 120 },
          { uin: "45", nick: "已过期", role: 2, shutUpTime: nowSeconds() - 1 },
        ] : action === "get_group_info" ? { group_id: params.group_id, member_count: reportedMembers(params.group_id, oneBotId),
          group_name: `合成 OneBot ${params.group_id}` }
        : action === "get_group_member_list" ? activity(Number(params.group_id), oneBotId)
        : action === "get_version_info" ? { app_name: oneBotGatewayName }
        : action === "_del_group_notice" ? null
        : action === "_get_group_notice" ? [
          { notice_id: "opaque-welcome", send_to_new_member: true, message: { text: "仅新成员的合成公告" } },
          { notice_id: "opaque-onebot", message: { text: "合成 OneBot 公告 & 中文" } },
          { notice_id: "opaque-image", message: { text: "", images: [{ id: "opaque-img" }] } },
        ].filter(({ notice_id }) => !removedOneBotAnnouncements.has(notice_id))
        : action === "get_group_system_msg" ? { join_requests: [
          { request_id: 910002, invitor_uin: 70, group_id: 82, checked: false, invitor_nick: "仍在等待", message: "合成待审附言" },
          { request_id: 910001, invitor_uin: 70, group_id: 82, checked: originalJoinChecked },
          { request_id: 910004, invitor_uin: 77, group_id: 83, checked: false, message: "隔壁 OneBot 群附言" },
        ], invited_requests: [
          ...(exposeGroupInvitation ? [{ request_id: 921001, invitor_uin: 71, group_id: 91, checked: false,
            invitor_nick: "合成邀请者", group_name: "合成邀请目标" }] : []),
          { request_id: 921002, invitor_uin: 73, group_id: 92, checked: true, group_name: "已经处理的邀请" },
          { request_id: 921003, invitor_uin: 74, group_id: 93, group_name: "状态未核验的邀请" },
        ] }
        : action === "get_group_ignore_add_request" ? [{ request_id: 910003, invitor_uin: 73, group_id: 82, checked: false }]
        : action === "get_msg" ? {
          message_id: params.message_id, self_id: oneBotId, group_id: params.message_id === 104 ? 84 : 82,
          message_type: "group", sender: { user_id: oneBotJoinReceipts.has(Number(params.message_id)) ? oneBotId : 42 },
          message: [{ type: "text", data: { text: "原群引用内容" } }],
        } : {};
      if (echo) client.send(JSON.stringify({ echo, status: denied ? "failed" : "ok", retcode: denied ? 100 : 0, data: reply }));
    };
    await waitUntil(() => client.readyState === WebSocket.OPEN || undefined, "OneBot 测试连接未就绪。");

    const text = (value: string) => ({ type: "text", data: { text: value } });
    let sequence = 10;
    const oneBotMessage = (message: unknown, user_id = operator, group_id = group) => ({
      post_type: "message", message_type: "group", sub_type: "normal", self_id: oneBotId, user_id,
      group_id, sender: { role: "admin" }, message_id: ++sequence, raw_message: String(sequence), message,
    });
    const send = (message: ReturnType<typeof oneBotMessage>) => client.send(JSON.stringify(message));
    const oneBotMuted = () => oneBotCalls.filter(({ action }) => action === "set_group_ban").map(({ params }) => params);
    const oneBotReplies = () => oneBotCalls.filter(({ action }) => action === "send_msg");
    const oneBotReply = (count: number) => waitUntil(() => oneBotReplies().at(count - 1), "OneBot 群管理指令未回复。");
    const at = (qq: number) => ({ type: "at", data: { qq: String(qq) } });
    send(oneBotMessage([text("#禁言"), at(oneBotId), at(42), text(" 2分钟")]));
    expect(JSON.stringify((await oneBotReply(1)).params.message)).toContain("已将 42 禁言 120 秒");
    send(oneBotMessage("#解禁42"));
    expect(JSON.stringify((await oneBotReply(2)).params.message)).toContain("解除禁言");
    send(oneBotMessage("#禁言42 60秒", 54));
    await oneBotReply(3);
    send(oneBotMessage("#禁言45", operator));
    await oneBotReply(4);
    send(oneBotMessage("#禁言52", operator));
    await oneBotReply(5);
    send(oneBotMessage("#禁言42", operator, 78));
    expect(oneBotMuted()).toEqual([
      { group_id: group, user_id: 42, duration: 120 }, { group_id: group, user_id: 42, duration: 0 },
    ]);
    expect(oneBotCalls.filter(({ action }) => action === "get_group_member_info").every(({ params }) => params.no_cache === true)).toBe(true);

    const webhook = (event_type: string, data: object) => fetch(new URL("/milky", http), { method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ event_type, self_id: milkyId, time: Math.floor(Date.now() / 1000), data }),
      signal: AbortSignal.timeout(2_000),
    });
    await waitUntil(() => milkyCalls.find(({ action }) => action === "get_login_info"), "Milky 未识别机器人。");
    const readyDeadline = performance.now() + 2_000;
    while (true) {
      const response = await webhook("fixture_unsupported", {});
      if (response.status !== 503 || performance.now() >= readyDeadline) { expect(response.status).toBe(200); break; }
      await Bun.sleep(20);
    }
    const milkyMessage = (message: string) => ({ message_scene: "group", peer_id: group, sender_id: operator,
      message_seq: ++sequence, group_member: { group_id: group, user_id: operator, role: "admin" }, segments: [text(message)],
    });
    const milkyReply = (count: number) => waitUntil(
      () => milkyCalls.filter(({ action }) => action === "send_group_message").at(count - 1), "Milky 群管理指令未回复。",
    );
    expect((await webhook("message_receive", milkyMessage("#禁言53 30秒"))).status).toBe(200);
    expect(JSON.stringify((await milkyReply(1)).params.message)).toContain("已将 53 禁言 30 秒");
    const uncertain = milkyMessage("#禁言44 3秒");
    expect((await webhook("message_receive", uncertain)).status).toBe(200);
    expect(JSON.stringify((await milkyReply(2)).params.message)).toContain("操作结果未确认");
    expect((await webhook("message_receive", uncertain)).status).toBe(200);
    await webhook("message_receive", milkyMessage("#解禁53"));
    await milkyReply(3);
    expect(milkyCalls.filter(({ action }) => action === "set_group_member_mute").map(({ params }) => params)).toEqual([
      { group_id: group, user_id: 53, duration: 30 },
      { group_id: group, user_id: 44, duration: 3 },
      { group_id: group, user_id: 53, duration: 0 },
    ]);
    expect(oneBotMuted()).toHaveLength(2);

    send(oneBotMessage("#全体禁言"));
    expect(JSON.stringify((await oneBotReply(6)).params.message)).toContain("禁言");
    send(oneBotMessage("#全员解禁"));
    expect(JSON.stringify((await oneBotReply(7)).params.message)).toContain("已关闭全体禁言");
    send(oneBotMessage("#全员禁言", 54));
    expect(JSON.stringify((await oneBotReply(8)).params.message)).toContain("管理权限");
    expect(oneBotCalls.filter(({ action }) => action === "set_group_whole_ban").map(({ params }) => params)).toEqual([
      { group_id: group, enable: true }, { group_id: group, enable: false },
    ]);

    await webhook("message_receive", milkyMessage("#全员禁言"));
    expect(JSON.stringify((await milkyReply(4)).params.message)).toContain("禁言");
    const wholeUnknown = milkyMessage("#全体解禁");
    await webhook("message_receive", wholeUnknown);
    expect(JSON.stringify((await milkyReply(5)).params.message)).toContain("未确认");
    await webhook("message_receive", wholeUnknown);
    await webhook("message_receive", milkyMessage("#解禁42"));
    await milkyReply(6);
    expect(milkyCalls.filter(({ action }) => action === "set_group_whole_mute").map(({ params }) => params)).toEqual([
      { group_id: group, is_mute: true }, { group_id: group, is_mute: false },
    ]);

    send(oneBotMessage("#踢42"));
    expect(JSON.stringify((await oneBotReply(9)).params.message)).toContain("42");
    send(oneBotMessage("#踢黑53"));
    await oneBotReply(10);
    send(oneBotMessage("#踢黑52"));
    await oneBotReply(11);
    expect(oneBotCalls.filter(({ action }) => action === "set_group_kick").map(({ params }) => params)).toEqual([
      { group_id: group, user_id: 42, reject_add_request: false },
    ]);
    await webhook("message_receive", milkyMessage("#踢黑55"));
    expect(JSON.stringify((await milkyReply(7)).params.message)).toContain("55");
    const kickUnknown = milkyMessage("#踢44");
    await webhook("message_receive", kickUnknown);
    expect(JSON.stringify((await milkyReply(8)).params.message)).toContain("未确认");
    await webhook("message_receive", kickUnknown);
    await webhook("message_receive", milkyMessage("#解禁56"));
    await milkyReply(9);
    expect(milkyCalls.filter(({ action }) => action === "kick_group_member").map(({ params }) => params)).toEqual([
      { group_id: group, user_id: 55, reject_add_request: true },
      { group_id: group, user_id: 44, reject_add_request: false },
    ]);
    const list = async () => Bun.YAML.parse(await readFile(legacyList, "utf8"));
    expect(await list()).toEqual({ blackQQ: [52, 57, 55], whiteQQ: [59], noBan: false });
    expect(await readFile(legacyList, "utf8")).toContain("# 白名单");

    send(oneBotMessage("#群管加黑名单58", 54));
    expect(JSON.stringify((await oneBotReply(12)).params.message)).toContain("没有编辑群管黑名单的权限");
    send(oneBotMessage("#群管加黑名单58"));
    await oneBotReply(13);
    expect(await list()).toEqual({ blackQQ: [52, 57, 55, 58], whiteQQ: [59], noBan: false });
    const repeated = oneBotMessage("其他群发言", 55, 79);
    send(repeated);
    expect(JSON.stringify((await oneBotReply(14)).params.message)).toContain("已踢出黑名单用户55");
    send(repeated);
    send(oneBotMessage("受保护的旧主人", 52, 79));
    send(oneBotMessage("本群关闭名单", 55, 80));

    const oneBotApply = { post_type: "request", request_type: "group", sub_type: "add",
      self_id: oneBotId, user_id: 57, group_id: 79, flag: "managed-list" };
    client.send(JSON.stringify(oneBotApply));
    client.send(JSON.stringify(oneBotApply));
    const applied = await waitUntil(() => oneBotCalls.find(({ action }) => action === "set_group_add_request"),
      "OneBot 未拒绝群管名单中的申请。");
    expect(applied.params).toEqual({ flag: "managed-list", sub_type: "add", approve: false, reason: "" });
    await webhook("group_member_increase", { group_id: 79, user_id: 58 });
    expect(JSON.stringify((await milkyReply(10)).params.message)).toContain("检测到黑名单58入群");
    const milkyApply = { group_id: 79, initiator_id: 57, notification_seq: 777, is_filtered: true };
    await webhook("group_join_request", milkyApply);
    await webhook("group_join_request", milkyApply);
    expect((await waitUntil(() => milkyCalls.find(({ action }) => action === "reject_group_request"),
      "Milky 未拒绝群管名单中的申请。")).params).toEqual({
      group_id: 79, notification_seq: 777, is_filtered: true, notification_type: "join_request", reason: "",
    });
    send(oneBotMessage("#群管删黑名单55"));
    await oneBotReply(15);
    send(oneBotMessage("已从名单移除", 55, 79));
    send(oneBotMessage("#解禁42"));
    await oneBotReply(16);
    expect(await list()).toEqual({ blackQQ: [52, 57, 58], whiteQQ: [59], noBan: false });
    expect(oneBotCalls.filter(({ action }) => action === "set_group_kick").map(({ params }) => params)).toEqual([
      { group_id: group, user_id: 42, reject_add_request: false }, { group_id: 79, user_id: 55, reject_add_request: false },
    ]);
    expect(oneBotCalls.filter(({ action }) => action === "set_group_add_request")).toHaveLength(1);
    expect(milkyCalls.filter(({ action }) => action === "reject_group_request")).toHaveLength(1);
    expect(milkyCalls.filter(({ action }) => action === "kick_group_member").at(-1)?.params).toEqual({ group_id: 79, user_id: 58 });

    const now = Math.floor(Date.now() / 1000);
    const ban = { post_type: "notice", notice_type: "group_ban", sub_type: "ban", self_id: oneBotId,
      group_id: 79, user_id: 59, operator_id: 53, duration: 300, time: now };
    client.send(JSON.stringify(ban));
    await Bun.sleep(40);
    expect(oneBotMuted().filter(({ user_id }) => user_id === 59)).toEqual([]);
    send(oneBotMessage("#群管加白名单61"));
    expect(JSON.stringify((await oneBotReply(17)).params.message)).toContain("加入群管白名单");
    send(oneBotMessage("#开启白名单自动解禁"));
    expect(JSON.stringify((await oneBotReply(18)).params.message)).toContain("没有设置白名单自动解禁的权限");
    await webhook("message_receive", milkyMessage("#开启白名单自动解禁"));
    expect(JSON.stringify((await milkyReply(11)).params.message)).toContain("已开启白名单自动解禁");
    expect(await list()).toEqual({ blackQQ: [52, 57, 58], whiteQQ: [59, 61], noBan: true });

    const freshBan = { ...ban, time: now + 1 };
    client.send(JSON.stringify(freshBan));
    client.send(JSON.stringify(freshBan));
    expect(JSON.stringify((await oneBotReply(19)).params.message)).toContain("已解除白名单用户的禁言");
    client.send(JSON.stringify({ ...freshBan, operator_id: 52 }));
    client.send(JSON.stringify(freshBan));
    client.send(JSON.stringify({ ...ban, group_id: 80, time: now + 2 }));
    client.send(JSON.stringify({ ...ban, operator_id: 52, time: now + 3 }));
    client.send(JSON.stringify({ ...ban, operator_id: oneBotId, time: now + 4 }));
    client.send(JSON.stringify({ ...ban, user_id: 61, duration: 0, sub_type: "lift_ban", time: now + 6 }));
    client.send(JSON.stringify({ ...ban, user_id: 61, time: now + 5 }));
    client.send(JSON.stringify({ ...ban, user_id: 0, time: now + 7 }));
    const milkyBan = { group_id: 79, user_id: 61, operator_id: 53, duration: 300 };
    expect((await webhook("group_mute", milkyBan)).status).toBe(200);
    expect(JSON.stringify((await milkyReply(12)).params.message)).toContain("已解除白名单用户的禁言");
    expect((await webhook("group_mute", { ...milkyBan, operator_id: operator })).status).toBe(200);
    await webhook("message_receive", milkyMessage("#关闭白名单解禁"));
    expect(JSON.stringify((await milkyReply(13)).params.message)).toContain("已关闭白名单自动解禁");
    expect(await list()).toEqual({ blackQQ: [52, 57, 58], whiteQQ: [59, 61], noBan: false });
    expect(oneBotMuted().filter(({ user_id }) => user_id === 59 || user_id === 61)).toEqual([
      { group_id: 79, user_id: 59, duration: 0 },
    ]);
    expect(milkyCalls.filter(({ action, params }) => action === "set_group_member_mute" && params.user_id === 61)
      .map(({ params }) => params)).toEqual([{ group_id: 79, user_id: 61, duration: 0 }]);

    const censored = oneBotMessage("合成违禁测试", 42, 79);
    send(censored);
    const censoredReply = JSON.stringify((await oneBotReply(20)).params.message);
    expect(censoredReply).toContain("触发违禁词：合成****");
    expect(censoredReply).toContain("禁言45秒、撤回消息");
    send(censored);
    send(oneBotMessage("合成违禁测试", 53, 79));
    send(oneBotMessage("合成违禁测试", 59, 79));
    send(oneBotMessage("合成违禁测试", 42, 81));

    const kickByRule = { ...milkyMessage("开头 合成踢黑测试 结尾"),
      peer_id: 79, sender_id: 43, group_member: { group_id: 79, user_id: 43, role: "member" } };
    expect((await webhook("message_receive", kickByRule)).status).toBe(200);
    expect(JSON.stringify((await milkyReply(14)).params.message)).toContain("踢出群聊、加入黑名单");
    expect(await list()).toEqual({ blackQQ: [52, 57, 58, 43], whiteQQ: [59, 61], noBan: false });
    await webhook("message_receive", kickByRule);
    const failedByRule = { ...milkyMessage("合成违禁测试"), peer_id: 79, sender_id: 44,
      group_member: { group_id: 79, user_id: 44, role: "member" } };
    await webhook("message_receive", failedByRule);
    expect(JSON.stringify((await milkyReply(15)).params.message)).toContain("禁言45秒结果未确认、撤回消息");
    await webhook("message_receive", failedByRule);
    await Bun.sleep(40);
    expect(oneBotMuted().filter(({ duration }) => duration === 45)).toEqual([
      { group_id: 79, user_id: 42, duration: 45 },
    ]);
    expect(oneBotCalls.filter(({ action }) => action === "delete_msg").map(({ params }) => params)).toEqual([
      { message_id: censored.message_id },
    ]);
    expect(milkyCalls.filter(({ action }) => action === "recall_group_message").map(({ params }) => params)).toEqual([
      { group_id: 79, message_seq: failedByRule.message_seq },
    ]);
    expect(milkyCalls.filter(({ action, params }) => action === "kick_group_member" && params.user_id === 43)).toHaveLength(1);
    expect(milkyCalls.filter(({ action, params }) => action === "set_group_member_mute" && params.duration === 45)).toHaveLength(1);
    expect(await readFile(join(legacyRules, "79.json"), "utf8")).toBe(testRules);

    const groupReplyWith = (value: string) => waitUntil(() => oneBotReplies().find(({ params }) =>
      JSON.stringify(params.message).includes(value)), `OneBot 未回复预期的群管理结果：${value}`);
    send(oneBotMessage("#申请头衔旅人", 42, 82));
    await groupReplyWith("已将你的头衔更换为「旅人」");
    send(oneBotMessage("#申请头衔不能设置", 42, 79));
    await groupReplyWith("请核对群成员和群主权限");
    send(oneBotMessage([text("#修改头衔不能代改"), at(42)], 51, 82));
    await groupReplyWith("没有设置该群头衔的权限");
    send(oneBotMessage([text("#设置头衔同行者"), at(42)], 52, 82));
    await groupReplyWith("同行者");
    expect(oneBotCalls.filter(({ action }) => action === "set_group_special_title").map(({ params }) => params)).toEqual([
      { group_id: 82, user_id: 42, special_title: "旅人" }, { group_id: 82, user_id: 42, special_title: "同行者" },
    ]);

    const milkyTitle = (message: string, sender_id = operator) => ({
      ...milkyMessage(message), peer_id: 79, sender_id, group_member: { group_id: 79, user_id: sender_id, role: sender_id === operator ? "admin" : "member" },
    });
    await webhook("message_receive", milkyTitle("#增加头衔屏蔽词云游"));
    expect(JSON.stringify((await milkyReply(16)).params.message)).toContain("云游");
    await webhook("message_receive", milkyTitle("#我要头衔云游", 42));
    expect(JSON.stringify((await milkyReply(17)).params.message)).toContain("头衔包含屏蔽词");
    await webhook("message_receive", milkyTitle("#我要头衔云游者", 42));
    expect(JSON.stringify((await milkyReply(18)).params.message)).toContain("云游者");
    await webhook("message_receive", milkyTitle("#切换头衔屏蔽词匹配模式"));
    expect(JSON.stringify((await milkyReply(19)).params.message)).toContain("模糊");
    await webhook("message_receive", milkyTitle("#申请头衔云游者", 42));
    expect(JSON.stringify((await milkyReply(20)).params.message)).toContain("头衔包含屏蔽词");
    await webhook("message_receive", milkyTitle("#我要头衔云游者"));
    expect(JSON.stringify((await milkyReply(21)).params.message)).toContain("云游者");
    await webhook("message_receive", milkyTitle("#申请头衔", 42));
    await milkyReply(22);
    expect(milkyCalls.filter(({ action }) => action === "set_group_member_special_title").map(({ params }) => params)).toEqual([
      { group_id: 79, user_id: 42, special_title: "云游者" }, { group_id: 79, user_id: operator, special_title: "云游者" },
      { group_id: 79, user_id: 42, special_title: "" },
    ]);
    const titles = JSON.parse(await readFile(join(root, "data/group/banned-words/79.json"), "utf8"));
    expect(titles).toEqual({ ...JSON.parse(testRules), TitleBannedWords: ["云游"], TitleFilterModeChange: 1 });
    expect(await readFile(join(legacyRules, "79.json"), "utf8")).toBe(testRules);

    const promote = oneBotMessage([text("#设置管理"), at(42), at(60042), at(42)], 52, 82);
    send(promote);
    await groupReplyWith("60042");
    send(promote);
    const priorAdminReplies = oneBotReplies().length;
    send(oneBotMessage("#设置管理60042", 52, 82));
    await oneBotReply(priorAdminReplies + 1);
    send(oneBotMessage("#取消管理60042", 51, 82));
    await oneBotReply(priorAdminReplies + 2);
    expect(oneBotCalls.filter(({ action }) => action === "set_group_admin").map(({ params }) => params)).toEqual([
      { group_id: 82, user_id: 42, enable: true }, { group_id: 82, user_id: 60042, enable: true },
    ]);

    const unknownAdmin = milkyTitle("#设置管理60044");
    await webhook("message_receive", unknownAdmin);
    expect(JSON.stringify((await milkyReply(23)).params.message)).toContain("未确认");
    await webhook("message_receive", unknownAdmin);
    const demote = milkyTitle("#取消管理");
    await webhook("message_receive", { ...demote, segments: [...demote.segments, { type: "mention", data: { user_id: 53 } }] });
    expect(JSON.stringify((await milkyReply(24)).params.message)).toContain("53");
    expect(milkyCalls.filter(({ action }) => action === "set_group_member_admin").map(({ params }) => params)).toEqual([
      { group_id: 79, user_id: 60044, is_set: true }, { group_id: 79, user_id: 53, is_set: false },
    ]);

    send(oneBotMessage("#查看禁言列表", 54, 82));
    const firstList = await waitUntil(() => oneBotCalls.find(({ action }) => action === "send_group_forward_msg"),
      "OneBot 禁言列表未转发。");
    expect(firstList.params.group_id).toBe(82);
    const forwarded = JSON.stringify(firstList.params.messages);
    expect(forwarded).toContain("https://q1.qlogo.cn/g?b=qq&s=100&nk=43");
    expect(forwarded).toContain("合成群名片");
    expect(forwarded).toContain("禁言剩余时间");
    expect(forwarded).toContain("禁言到期时间");
    expect(forwarded).not.toContain("已过期");

    send(oneBotMessage("#解除全部禁言", 54, 82));
    await groupReplyWith("没有解除群禁言的权限");
    const unmuteMany = oneBotMessage("#解除全部禁言", 52, 82);
    send(unmuteMany);
    const unmuteReply = await groupReplyWith("已解除 1 人的禁言");
    expect(JSON.stringify(unmuteReply.params.message)).toContain("1 人的解禁被协议端拒绝");
    send(unmuteMany);
    await webhook("message_receive", milkyTitle("#获取禁言列表"));
    expect(JSON.stringify((await milkyReply(25)).params.message)).toContain("禁言列表");
    expect(oneBotMuted().filter(({ group_id }) => group_id === 82)).toEqual([
      { group_id: 82, user_id: 43, duration: 0 },
      { group_id: 82, user_id: 44, duration: 0 },
    ]);
    expect(oneBotCalls.filter(({ action }) => action === "get_group_shut_list").map(({ params }) => params)).toEqual([
      { group_id: 82 }, { group_id: 82 },
    ]);

    send(oneBotMessage("#查看从未发言过的人", operator, 84));
    const oneBotActivity = await waitUntil(() => oneBotCalls.find(({ action, params }) =>
      action === "send_group_forward_msg" && params.group_id === 84), "OneBot 未转发群活跃情况。");
    const display = JSON.stringify(oneBotActivity.params.messages);
    expect(display).toContain("从未发言夹具");
    expect(display).toContain("https://q1.qlogo.cn/g?b=qq&s=100&nk=42");
    expect(display).not.toContain("已有活动夹具");
    send(oneBotMessage("#查看从未发言的人", 54, 84));
    send(oneBotMessage("#查看从未发言过的人第1页", operator, 85));
    await webhook("message_receive", { ...milkyTitle("#查看从未发言的人"), peer_id: 84,
      group_member: { group_id: 84, user_id: operator, role: "admin" } });
    const milkyActivity = await waitUntil(() => milkyCalls.find(({ action, params }) =>
      action === "send_group_message" && params.group_id === 84 && JSON.stringify(params.message).includes("从未发言夹具")),
    "Milky 未转发群活跃情况。");
    expect(JSON.stringify(milkyActivity.params.message)).not.toContain("已有活动夹具");
    expect(oneBotCalls.filter(({ action }) => action === "send_group_forward_msg")).toHaveLength(2);
    expect(oneBotCalls.filter(({ action, params }) => action === "get_group_member_list" && params.group_id === 84)
      .every(({ params }) => params.no_cache === true)).toBe(true);

    send(oneBotMessage("助理#清理从未发言的人", operator, 86));
    await groupReplyWith("请在 120 秒内发送");
    send(oneBotMessage("确认清理", operator, 84));
    send(oneBotMessage("确认清理", 54, 86));
    cleanupRosterChanged = true;
    const confirmation = oneBotMessage("#确认清理", operator, 86);
    send(confirmation);
    const cleanup = await waitUntil(() => oneBotCalls.find(({ action, params }) =>
      action === "send_group_forward_msg" && params.group_id === 86), "OneBot 未转发已确认的清理回执。");
    expect(JSON.stringify(cleanup.params.messages)).toContain("62");
    send(confirmation);
    await Bun.sleep(60);
    expect(oneBotCalls.filter(({ action, params }) => action === "set_group_kick" && params.group_id === 86)
      .map(({ params }) => params)).toEqual([{ group_id: 86, user_id: 62, reject_add_request: false }]);

    send(oneBotMessage("#查看潜水排行榜二", 54, 84));
    const inactive = await waitUntil(() => oneBotCalls.find(({ action, params }) => action === "send_group_forward_msg" &&
      params.group_id === 84 && JSON.stringify(params.messages).includes("排行榜")), "普通群员未收到 OneBot 排行。");
    expect(JSON.stringify(inactive.params.messages)).toContain("https://q1.qlogo.cn/g?b=qq&s=100&nk=99");
    expect(JSON.stringify(inactive.params.messages)).not.toContain("已有活动夹具");
    await webhook("message_receive", { ...milkyTitle("#获取最近的入群记录1", 54), peer_id: 84,
      group_member: { group_id: 84, user_id: 54, role: "member" } });
    const newest = await waitUntil(() => milkyCalls.find(({ action, params }) => action === "send_group_message" &&
      params.group_id === 84 && JSON.stringify(params.message).includes("已有活动夹具")), "普通群员未收到 Milky 新入群记录。");
    expect(JSON.stringify(newest.params.message)).toContain("最后发言时间");
    expect(JSON.stringify(newest.params.message)).not.toContain("从未发言夹具");

    send(oneBotMessage("#查看2天未发言的人", operator, 84));
    const oldEnough = await waitUntil(() => oneBotCalls.find(({ action, params }) => action === "send_group_forward_msg" &&
      params.group_id === 84 && JSON.stringify(params.messages).includes("已有活动夹具")), "OneBot 未回复旧按时长查询。");
    expect(JSON.stringify(oldEnough.params.messages)).toContain("从未发言夹具");
    expect(JSON.stringify(oldEnough.params.messages)).toContain("最后发言时间");
    await webhook("message_receive", { ...milkyTitle("#获取二天没发言的人"), peer_id: 84,
      group_member: { group_id: 84, user_id: operator, role: "admin" } });
    const timedMilky = await waitUntil(() => milkyCalls.find(({ action, params }) => action === "send_group_message" &&
      params.group_id === 84 && JSON.stringify(params.message).includes("从未发言夹具") &&
      JSON.stringify(params.message).includes("已有活动夹具")), "Milky 未回复旧按时长查询。");
    expect(JSON.stringify(timedMilky.params.message)).toContain("最后发言时间");

    const quote = (id: number) => ({ type: "reply", data: { id: String(id) } });
    const essence = oneBotMessage([quote(103), text("#加精")], operator, 82);
    send(essence);
    await groupReplyWith("已加精。");
    send(essence);
    send(oneBotMessage([quote(103), text("#移精")], operator, 82));
    await groupReplyWith("已移精。");
    send(oneBotMessage([quote(104), text("#设精")], operator, 82));
    await groupReplyWith("请引用本群要加精的消息。");
    expect(oneBotCalls.filter(({ action }) => action === "set_essence_msg" || action === "delete_essence_msg")).toMatchObject([
      { action: "set_essence_msg", params: { message_id: 103 } }, { action: "delete_essence_msg", params: { message_id: 103 } },
    ]);

    const milkyEssence = (msg: string) => {
      const source = milkyTitle(msg);
      return { ...source, segments: [{ type: "reply", data: { message_seq: 402 } }, ...source.segments] };
    };
    const milkyHistoricReplies = milkyCalls.filter(({ action }) => action === "send_group_message").length;
    await webhook("message_receive", milkyEssence("设精"));
    expect(JSON.stringify((await milkyReply(milkyHistoricReplies + 1)).params.message)).toContain("已加精。");
    const unknownEssence = milkyEssence("#移精");
    await webhook("message_receive", unknownEssence);
    expect(JSON.stringify((await milkyReply(milkyHistoricReplies + 2)).params.message)).toContain("未确认");
    await webhook("message_receive", unknownEssence);
    expect(milkyCalls.filter(({ action }) => action === "set_group_essence_message").map(({ params }) => params)).toEqual([
      { group_id: 79, message_seq: 402, is_set: true }, { group_id: 79, message_seq: 402, is_set: false },
    ]);

    const muteSelf = oneBotMessage("#我要自闭", 54, 82);
    send(muteSelf);
    await groupReplyWith("那我就不手下留情了");
    send(muteSelf);
    send(oneBotMessage("#我要禅定二分钟", 52, 82));
    await groupReplyWith("别自闭啦");
    updateRole({ group_id: 79, user_id: 53 }, true);
    const protectedSelf = oneBotReplies().length;
    send(oneBotMessage("#我要自闭五秒", 53, 79));
    expect(JSON.stringify((await oneBotReply(protectedSelf + 1)).params.message)).toContain("别自闭啦");
    expect(oneBotMuted().filter(({ group_id, duration }) => (group_id === 82 || group_id === 79) && duration === 300))
      .toEqual([{ group_id: 82, user_id: 54, duration: 300 }]);

    updateRole({ group_id: 79, user_id: 56 }, true);
    const selfReplies = milkyCalls.filter(({ action }) => action === "send_group_message").length;
    await webhook("message_receive", milkyTitle("我要禅定二分钟", 56));
    expect(JSON.stringify((await milkyReply(selfReplies + 1)).params.message)).toContain("那我就不手下留情了");
    const unknownSelf = milkyTitle("#我要自闭15秒", 44);
    await webhook("message_receive", unknownSelf);
    expect(JSON.stringify((await milkyReply(selfReplies + 2)).params.message)).toContain("未确认");
    await webhook("message_receive", unknownSelf);
    expect(milkyCalls.filter(({ action, params }) => action === "set_group_member_mute" && params.group_id === 79 &&
      (params.duration === 120 || params.duration === 15)).map(({ params }) => params)).toEqual([
      { group_id: 79, user_id: 56, duration: 120 }, { group_id: 79, user_id: 44, duration: 15 },
    ]);

    const all = { type: "at", data: { qq: "all" } };
    const embeddedImage = { type: "image", data: { file: "synthetic-image-file", url: noticeImageUrl } };
    const noticeSource = oneBotMessage([quote(103), at(oneBotId), text("#发通知 合成通知"), all, embeddedImage, at(42)], 51, 82);
    send(noticeSource);
    const broadcast = await groupReplyWith("合成通知");
    expect(broadcast.params.message).toMatchObject([
      all, text("合成通知"), { type: "image", data: { file: `base64://${noticeImageBase64}` } }, at(42),
    ]);
    send(noticeSource);
    const callsBeforeRejectedNotice = oneBotReplies().length;
    send(oneBotMessage([text("#发通知 路径不是 QQ 媒体"), { type: "image", data: { file: "/tmp/private-notice.jpg" } }], 51, 82));
    const rejectedNotice = await oneBotReply(callsBeforeRejectedNotice + 1);
    expect(JSON.stringify(rejectedNotice.params.message)).not.toContain("private-notice.jpg");
    expect(oneBotReplies().filter(({ params }) => JSON.stringify(params.message).includes("合成通知"))).toHaveLength(1);

    const noticeReplyCount = milkyCalls.filter(({ action }) => action === "send_group_message").length;
    const unknownNotice = { ...milkyTitle("#发通知 合成未知通知"), segments: [
      text("#发通知 合成未知通知"), { type: "mention_all", data: {} }, { type: "face", data: { face_id: "14" } },
    ] };
    await webhook("message_receive", unknownNotice);
    const milkyNoticeBody = await milkyReply(noticeReplyCount + 1);
    expect(milkyNoticeBody.params.message).toMatchObject([
      { type: "mention_all" }, text("合成未知通知"), { type: "face", data: { face_id: "14" } },
    ]);
    expect(JSON.stringify((await milkyReply(noticeReplyCount + 2)).params.message)).toContain("未确认");
    await webhook("message_receive", unknownNotice);
    expect(milkyCalls.filter(({ action, params }) => action === "send_group_message" &&
      JSON.stringify(params.message).includes("合成未知通知"))).toHaveLength(1);

    const priorGroupAdmin = await readFile(legacyList, "utf8");
    await writeFile(legacyList, priorGroupAdmin + "groupAddNotice:\n  openGroup: [79] # 合成旧开关\n  msg: 合成入群提醒\n");
    send(oneBotMessage("#开启加群通知", 51, 82));
    await groupReplyWith("已开启「82」的加群申请通知");
    const oneBotJoin = (flag: string, user_id: number, comment: string) => ({
      post_type: "request", request_type: "group", sub_type: "add", self_id: oneBotId, group_id: 82, user_id, flag,
      nickname: "合成申请人", comment,
    });
    const added = oneBotJoin("910001", 70, "合成入群附言");
    client.send(JSON.stringify(added));
    const joinedNotice = await groupReplyWith("合成入群提醒");
    expect(joinedNotice.params.group_id).toBe(82);
    expect(JSON.stringify(joinedNotice.params.message)).toContain("昵称：合成申请人");
    expect(JSON.stringify(joinedNotice.params.message)).toContain("nk=70");
    expect(JSON.stringify(joinedNotice.params.message)).toContain("合成入群附言");
    expect(JSON.stringify(joinedNotice.params.message)).not.toContain(added.flag);
    await waitUntil(() => oneBotReplies().find(({ params }) => params.message_type === "private" &&
      params.user_id === 52 && JSON.stringify(params.message).includes("合成入群附言")), "原机器人主人未收到私聊审核。");
    client.send(JSON.stringify(added));
    const originalReceipt = [...oneBotJoinReceipts][0]!;
    send(oneBotMessage([quote(originalReceipt), text("#同意")], 54, 82));
    await groupReplyWith("当前无法核实并处理这条加群申请");
    expect(originalJoinChecked).toBe(false);
    const quotedJoin = (groupId: number) => ({ ...oneBotMessage([quote(originalReceipt), text("#同意")], operator, groupId),
      raw_message: `[CQ:reply,id=${originalReceipt}]#同意` });
    send(quotedJoin(84));
    const originalDecision = quotedJoin(82);
    send(originalDecision);
    send(originalDecision);
    await groupReplyWith("已同意合成申请人(70)的加群申请");
    send(oneBotMessage([quote(originalReceipt), text("拒绝")], operator, 82));
    await groupReplyWith("找不到原消息了，手动拒绝");
    client.send(JSON.stringify(oneBotJoin("910003", 73, "合成风险申请")));
    const riskReceipt = await waitUntil(() => oneBotJoinReceipts.size === 2 ? [...oneBotJoinReceipts][1] : undefined,
      "OneBot 风险申请未收到群内通知。");
    await waitUntil(() => oneBotReplies().find(({ params }) => params.message_type === "private" &&
      params.user_id === 52 && JSON.stringify(params.message).includes("合成风险申请")), "风险申请未通知原主人。");
    send(oneBotMessage([quote(riskReceipt), text("#同意")], operator, 82));
    await groupReplyWith("该账号为风险账号请手动处理");
    expect(oneBotCalls.filter(({ action, params }) => action === "set_group_add_request" &&
      ["910001", "910002", "910003"].includes(String(params.flag))).map(({ params }) => params)).toEqual([
      { flag: "910001", sub_type: "add", approve: true, reason: "" },
    ]);
    expect((await webhook("group_invited_join_request", { group_id: 79, initiator_id: 72,
      target_user_id: 74, notification_seq: 901 })).status).toBe(200);
    const invitedNotice = await waitUntil(() => milkyCalls.find(({ action, params }) => action === "send_group_message" &&
      params.group_id === 79 && JSON.stringify(params.message).includes("邀请人：72")), "原群未收到第三方代邀的入群提醒。");
    expect(JSON.stringify(invitedNotice.params.message)).toContain("nk=74");
    const milkyDecision = milkyTitle("#拒绝");
    await webhook("message_receive", { ...milkyDecision, segments: [
      { type: "reply", data: { message_seq: milkyJoinReceipt } }, ...milkyDecision.segments,
    ] });
    await waitUntil(() => milkyCalls.find(({ action, params }) => action === "send_group_message" &&
      params.group_id === 79 && /已拒绝.*74/u.test(JSON.stringify(params.message))), "Milky 引用拒绝未确认。");
    expect(milkyCalls.filter(({ action, params }) => action === "reject_group_request" && params.notification_seq === 901)
      .map(({ params }) => params)).toEqual([
      { group_id: 79, notification_seq: 901, notification_type: "invited_join_request", is_filtered: false },
    ]);

    send(oneBotMessage("#关闭加群通知", 51, 82));
    await groupReplyWith("已关闭「82」的加群申请通知");
    client.send(JSON.stringify(oneBotJoin("after-disabled", 71, "再次合成申请")));
    await waitUntil(() => oneBotReplies().find(({ params }) => params.message_type === "private" &&
      params.user_id === 52 && JSON.stringify(params.message).includes("再次合成申请")), "关闭群通知影响了原主人审核。");
    expect(oneBotReplies().filter(({ params }) => params.group_id === 82 &&
      JSON.stringify(params.message).includes("合成入群提醒"))).toHaveLength(2);
    const savedGroupAdmin = await readFile(legacyList, "utf8");
    expect(savedGroupAdmin).toStartWith(priorGroupAdmin);
    expect(savedGroupAdmin).toContain("# 合成旧开关");
    expect((Bun.YAML.parse(savedGroupAdmin) as { groupAddNotice: unknown }).groupAddNotice)
      .toEqual({ openGroup: [79], msg: "合成入群提醒" });

    send(oneBotMessage("#查公告", 54, 82));
    const announcement = await groupReplyWith("1、合成 OneBot 公告 & 中文");
    expect(JSON.stringify(announcement.params.message)).toContain("2、（无文字）");
    expect(JSON.stringify(announcement.params.message)).not.toContain("仅新成员的合成公告");
    expect(JSON.stringify(announcement.params.message)).not.toContain("opaque");
    oneBotGatewayName = "Mock Other OneBot";
    send(oneBotMessage("#查群公告", 54, 82));
    await groupReplyWith("当前无法获取本群的 QQ 群公告");
    oneBotGatewayName = "NapCat.Onebot";
    send(oneBotMessage("#查群公告", 55, 87));

    const announcementReply = (content: string) => waitUntil(() => milkyCalls.find(({ action, params }) =>
      action === "send_group_message" && JSON.stringify(params.message).includes(content)), `Milky 未回复：${content}`);
    await webhook("message_receive", milkyTitle("#查群公告", 54));
    await announcementReply("1、合成 Milky 公告 👩‍👩‍👧‍👧");
    const emptyAnnouncement = milkyTitle("#查公告", 54);
    await webhook("message_receive", { ...emptyAnnouncement, peer_id: 84, group_member: { ...emptyAnnouncement.group_member, group_id: 84 } });
    await announcementReply("本群暂无群公告");
    wrongMilkyAnnouncementGroup = true;
    await webhook("message_receive", milkyTitle("#查群公告", 55));
    await announcementReply("当前无法获取本群的 QQ 群公告");
    await webhook("message_receive", milkyTitle("#查公告", 45));
    expect(milkyCalls.filter(({ action }) => action === "get_group_announcements").map(({ params }) => params))
      .toEqual([{ group_id: 79 }, { group_id: 84 }, { group_id: 79 }]);
    expect(oneBotCalls.filter(({ action }) => action === "_get_group_notice").map(({ params }) => params))
      .toEqual([{ group_id: "82" }]);

    send(oneBotMessage([text("#发群公告 首行合成公告\n第二行 #发公告"), embeddedImage,
      { type: "image", data: { file: "file:///tmp/other-image.png" } }], operator, 82));
    const writtenAnnouncement = await waitUntil(() => oneBotCalls.find(({ action }) => action === "_send_group_notice"),
      "OneBot 未发送原生公告请求。");
    expect(writtenAnnouncement.params).toEqual({ group_id: "82", content: "首行合成公告\n第二行 #发公告",
      image: `base64://${noticeImageBase64}`, pinned: 0, type: 1, is_show_edit_card: 1, tip_window_type: 1, confirm_required: 1 });
    send(oneBotMessage([text("#发公告合成坏图"), { type: "image", data: { file: "file:///tmp/invalid-image.png" } }], operator, 82));
    await groupReplyWith("无法使用原消息的公告图片");
    send(oneBotMessage("#发群公告无权发出", 54, 82));
    await groupReplyWith("当前无法发布 QQ 群公告");
    expect(oneBotCalls.filter(({ action }) => action === "_send_group_notice")).toHaveLength(1);
    expect(oneBotReplies().some(({ params }) => JSON.stringify(params.message).includes("首行合成公告"))).toBe(false);

    const groupPublication = milkyTitle("#发群公告合成 Milky 公告");
    await webhook("message_receive", { ...groupPublication, segments: [...groupPublication.segments,
      { type: "image", data: { temp_url: noticeImageUrl } },
    ] });
    await waitUntil(() => milkyCalls.find(({ action }) => action === "send_group_announcement"), "Milky 未发送原生公告请求。");
    const uncertainPublication = milkyTitle("#发公告模拟未知公告");
    await webhook("message_receive", uncertainPublication);
    await announcementReply("群公告发布结果未确认");
    await webhook("message_receive", uncertainPublication);
    expect(milkyCalls.filter(({ action }) => action === "send_group_announcement").map(({ params }) => params)).toEqual([
      { group_id: 79, content: "合成 Milky 公告", image_uri: `base64://${noticeImageBase64}` },
      { group_id: 79, content: "模拟未知公告" },
    ]);

    send(oneBotMessage("#删公告2", operator, 82));
    await groupReplyWith("已删除「（无文字，可能仅含图片）」");
    const unresolvedDeletion = oneBotMessage("#删群公告1", operator, 82);
    send(unresolvedDeletion);
    await groupReplyWith("删除结果未确认");
    send(unresolvedDeletion);
    send(oneBotMessage("#删公告2", 54, 82));
    send(oneBotMessage("#删公告99", operator, 82));
    await groupReplyWith("找不到该序号");
    expect(oneBotCalls.filter(({ action }) => action === "_del_group_notice").map(({ params }) => params)).toEqual([
      { group_id: "82", notice_id: "opaque-image" }, { group_id: "82", notice_id: "opaque-onebot" },
    ]);

    wrongMilkyAnnouncementGroup = false;
    await webhook("message_receive", milkyTitle("#删群公告01"));
    await announcementReply("已删除「合成 Milky 公告 👩‍👩‍👧‍👧」");
    expect(milkyCalls.filter(({ action }) => action === "delete_group_announcement").map(({ params }) => params))
      .toEqual([{ group_id: 79, announcement_id: "opaque-milky" }]);

    const imageRule = (separator: string) => ({
      [`{image${separator}${imageDigest.toUpperCase()}}`]: { matchType: 1, penaltyType: 3 },
    });
    await writeFile(join(legacyRules, "82.json"), JSON.stringify({ bannedWords: imageRule(":") }));
    const milkyRulesFile = join(root, "data/group/banned-words/79.json");
    const milkyRules = JSON.parse(await readFile(milkyRulesFile, "utf8"));
    await writeFile(milkyRulesFile, JSON.stringify({ ...milkyRules, bannedWords: { ...milkyRules.bannedWords, ...imageRule("_") } }));
    const rawDigest = `{image:${imageDigest.toUpperCase()}}`;
    const forgedMarker = oneBotMessage(rawDigest, 54, 82);
    send(forgedMarker);
    const oneBotImage = oneBotMessage([embeddedImage], 54, 82);
    send(oneBotImage);
    await groupReplyWith("触发违禁词：[图片]");
    send(oneBotImage);
    expect(oneBotCalls.filter(({ action, params }) => action === "delete_msg" &&
      (params.message_id === forgedMarker.message_id || params.message_id === oneBotImage.message_id)).map(({ params }) => params))
      .toEqual([{ message_id: oneBotImage.message_id }]);

    const imageEvent = (resource_id: string) => ({ ...milkyTitle("", 54), segments: [{ type: "image", data: { resource_id } }] });
    const missingImage = imageEvent("missing-picture");
    await webhook("message_receive", missingImage);
    await waitUntil(() => milkyCalls.find(({ action, params }) => action === "get_resource_temp_url" && params.resource_id === "missing-picture"),
      "Milky 未尝试查询原图片资源。");
    const matchedImage = imageEvent("matched-picture");
    await webhook("message_receive", matchedImage);
    await announcementReply("触发违禁词：[图片]");
    await webhook("message_receive", matchedImage);
    expect(milkyCalls.filter(({ action, params }) => action === "recall_group_message" &&
      (params.message_seq === missingImage.message_seq || params.message_seq === matchedImage.message_seq)).map(({ params }) => params))
      .toEqual([{ group_id: 79, message_seq: matchedImage.message_seq }]);
    expect(milkyCalls.filter(({ action, params }) => action === "get_resource_temp_url" && params.resource_id === "matched-picture"))
      .toHaveLength(1);

    const milkyLookup = milkyTitle("#查看违禁词", 54);
    await webhook("message_receive", { ...milkyLookup, segments: [...milkyLookup.segments,
      { type: "image", data: { resource_id: "matched-picture" } },
    ] });
    const imageRuleReply = await announcementReply("匹配模式：精确");
    expect(JSON.stringify(imageRuleReply.params.message)).toContain("屏蔽词：");
    expect(JSON.stringify(imageRuleReply.params.message)).toContain("[图片]");
    const milkyUnauthorizedDelete = milkyTitle("#删除违禁词", 54);
    const beforeDeniedImageReads = milkyCalls.filter(({ action }) => action === "get_resource_temp_url").length;
    const beforeDeniedReplies = milkyCalls.filter(({ action }) => action === "send_group_message").length;
    await webhook("message_receive", { ...milkyUnauthorizedDelete, segments: [...milkyUnauthorizedDelete.segments,
      { type: "image", data: { resource_id: "matched-picture" } },
    ] });
    await milkyReply(beforeDeniedReplies + 1);
    expect(milkyCalls.filter(({ action }) => action === "get_resource_temp_url")).toHaveLength(beforeDeniedImageReads);

    send(oneBotMessage([text("#删除违禁词"), embeddedImage], operator, 82));
    await groupReplyWith("已删除违禁词");
    send(oneBotMessage([text("#新增精确撤违禁词"), embeddedImage], operator, 82));
    await groupReplyWith("已添加违禁词");
    const editedRules = JSON.parse(await readFile(join(root, "data/group/banned-words/82.json"), "utf8"));
    expect(editedRules.bannedWords[rawDigest]).toMatchObject({ matchType: 1, penaltyType: 3, addedBy: operator });

    const mixedCaption = `图前  ${rawDigest}{face:14}图后`;
    const mixedRule = { matchType: 1, penaltyType: 3 };
    await writeFile(join(legacyRules, "86.json"), JSON.stringify({ bannedWords: { [mixedCaption]: mixedRule } }));
    const handwrittenMixed = oneBotMessage(`助理 ${mixedCaption}`, 54, 86);
    const realMixed = oneBotMessage([text("助理 图前  "), embeddedImage, { type: "face", data: { id: "14" } }, text("图后")], 54, 86);
    send(handwrittenMixed);
    send(realMixed);
    await waitUntil(() => oneBotCalls.find(({ action, params }) => action === "delete_msg" && params.message_id === realMixed.message_id),
      "OneBot 图文违禁词未定位到真实原消息。");
    expect(oneBotCalls.some(({ action, params }) => action === "delete_msg" && params.message_id === handwrittenMixed.message_id)).toBe(false);

    const currentRules = JSON.parse(await readFile(milkyRulesFile, "utf8"));
    const twoImages = `{image_${imageDigest}}间隔${rawDigest}`;
    const substring = `边缘${rawDigest}保留`;
    await writeFile(milkyRulesFile, JSON.stringify({ ...currentRules, bannedWords: {
      ...currentRules.bannedWords, [twoImages]: mixedRule, [substring]: { matchType: 2, penaltyType: 3 },
    } }));
    const mixedMedia = (first: string) => ({ ...milkyTitle("", 54), segments: [
      { type: "image", data: { resource_id: first } }, text("间隔"), { type: "image", data: { resource_id: "matched-picture" } },
    ] });
    const invalidMixed = mixedMedia("missing-picture");
    const validMixed = mixedMedia("matched-picture");
    await webhook("message_receive", invalidMixed);
    await webhook("message_receive", validMixed);
    await waitUntil(() => milkyCalls.find(({ action, params }) => action === "recall_group_message" && params.message_seq === validMixed.message_seq),
      "Milky 同文不同原图的正确消息被遗漏。");
    expect(milkyCalls.some(({ action, params }) => action === "recall_group_message" && params.message_seq === invalidMixed.message_seq)).toBe(false);

    const substringMedia = { ...milkyTitle("", 54), segments: [
      text("前缀边缘"), { type: "image", data: { resource_id: "matched-picture" } }, text("保留尾部"),
    ] };
    await webhook("message_receive", substringMedia);
    await waitUntil(() => milkyCalls.find(({ action, params }) => action === "recall_group_message" && params.message_seq === substringMedia.message_seq),
      "Milky 未命中收到的原图与前后文本子串。");

    await writeFile(legacyList, savedGroupAdmin + "VoteBan: true\nVoteKick: true\noutTime: 1\nminNum: 2\nBanTime: 35\nveto: true\nvoteAdmin: false\n");
    send(oneBotMessage("#发起投票禁言55", 54, 82));
    await groupReplyWith("的禁言投票已发起");
    send(oneBotMessage("#支持投票55", 56, 82));
    await waitUntil(() => oneBotMuted().find(({ group_id, user_id, duration }) => group_id === 82 && user_id === 55 && duration === 35),
      "OneBot 普通成员发起的多数票未执行。");
    await groupReplyWith("投票结束");

    await webhook("message_receive", milkyTitle("#投票踢人60", 54));
    await announcementReply("的踢出投票已发起");
    const wrongGroupBallot = milkyTitle("#支持投票60", operator);
    await webhook("message_receive", { ...wrongGroupBallot, peer_id: 84, group_member: { ...wrongGroupBallot.group_member, group_id: 84 } });
    await webhook("message_receive", milkyTitle("#支持投票60", operator));
    const enactedVote = await waitUntil(() => milkyCalls.find(({ action, params }) =>
      action === "kick_group_member" && params.user_id === 60), "Milky 群管理员一票终决未执行。");
    expect(enactedVote.params).toEqual({ group_id: 79, user_id: 60, reject_add_request: false });
    await announcementReply("管理员介入");

    const votingConfig = await readFile(legacyList, "utf8");
    await writeFile(legacyList, votingConfig + "groupVerify:\n  openGroup: [79, 82]\n  DelayTime: 0\n  time: 2\n  times: 2\n" +
      "  range: {min: 10, max: 12}\n  mode: 精确\n  SuccessMsgs: {0: 合成入群验证成功}\n");
    const joinedAt = nowSeconds();
    memberJoinTimes.set("82:72", joinedAt);
    client.send(JSON.stringify({ post_type: "notice", notice_type: "group_increase", sub_type: "approve", time: joinedAt,
      self_id: oneBotId, group_id: 82, user_id: 72, operator_id: operator }));
    const prompt = await groupReplyWith("的运算结果");
    const expression = /「(\d+) ([+-]) (\d+)」/u.exec(JSON.stringify(prompt.params.message));
    expect(expression).not.toBeNull();
    const [, left, operation, right] = expression!;
    const solution = String(operation === "+" ? Number(left) + Number(right) : Number(left) - Number(right));
    const incorrectVerification = { ...oneBotMessage("9999", 72, 82), raw_message: "9999" };
    send(incorrectVerification);
    await groupReplyWith("你还有「1」次机会");
    expect(oneBotCalls.some(({ action, params }) => action === "delete_msg" && params.message_id === incorrectVerification.message_id)).toBe(true);
    send({ ...oneBotMessage(solution, 72, 82), raw_message: solution });
    await groupReplyWith("合成入群验证成功");

    const milkyJoin = (user_id: number, invitor_id?: number) => webhook("group_member_increase", { group_id: 79, user_id, invitor_id });
    const promptTo = (id: number) => waitUntil(() => milkyCalls.find(({ action, params }) =>
      action === "send_group_message" && JSON.stringify(params.message).includes(`"user_id":${id}`) &&
      JSON.stringify(params.message).includes("欢迎！")), `Milky 没有向 ${id} 发出原群验证题。`);
    memberJoinTimes.set("79:73", nowSeconds());
    memberJoinTimes.set("79:75", nowSeconds());
    await milkyJoin(74, operator);
    await milkyJoin(73);
    await milkyJoin(75);
    await Promise.all([promptTo(73), promptTo(75)]);
    memberJoinTimes.set("79:73", memberJoinTimes.get("79:73")! + 1);
    await announcementReply("验证超时，已移出群聊，请重新申请");
    expect(milkyCalls.filter(({ action, params }) => action === "kick_group_member" &&
      [73, 74, 75].includes(Number(params.user_id))).map(({ params }) => params)).toEqual([{ group_id: 79, user_id: 75 }]);
    expect(milkyCalls.some(({ action, params }) => action === "send_group_message" &&
      JSON.stringify(params.message).includes('"user_id":74') && JSON.stringify(params.message).includes("欢迎！"))).toBe(false);

    const originalVerificationConfig = await readFile(legacyList, "utf8");
    await webhook("message_receive", milkyTitle("#切换验证模式", 54));
    await announcementReply("仅当前机器人主人可以设置入群验证模式和时限");
    expect(await readFile(legacyList, "utf8")).toBe(originalVerificationConfig);
    updateRole({ group_id: 79, user_id: operator }, false);
    updateRole({ group_id: 79, user_id: milkyId }, false);
    await webhook("message_receive", milkyTitle("#切换验证模式", operator));
    await announcementReply("已切换验证模式为模糊验证");
    await webhook("message_receive", milkyTitle("#设置验证超时时间7秒", operator));
    await announcementReply("已将验证超时时间设置为7秒");
    expect(await readFile(legacyList, "utf8")).toBe(originalVerificationConfig.replace("\n  mode: 精确\n", "\n  mode: 模糊\n")
      .replace("\n  time: 2\n", "\n  time: 7\n"));

    updateRole({ group_id: 79, user_id: operator }, true);
    updateRole({ group_id: 79, user_id: milkyId }, true);
    const manualVerification = milkyTitle("#重新验证", operator);
    await webhook("message_receive", { ...manualVerification, segments: [...manualVerification.segments,
      { type: "mention", data: { user_id: 59 } },
    ] });
    const manualPrompt = await promptTo(59);
    const manualExpression = /「(\d+) ([+-]) (\d+)」/u.exec(JSON.stringify(manualPrompt.params.message));
    expect(manualExpression).not.toBeNull();
    const [, manualLeft, manualOp, manualRight] = manualExpression!;
    const manualAnswer = manualOp === "+" ? Number(manualLeft) + Number(manualRight) : Number(manualLeft) - Number(manualRight);
    const successes = milkyCalls.filter(({ action, params }) => action === "send_group_message" &&
      JSON.stringify(params.message).includes("合成入群验证成功")).length;
    await webhook("message_receive", milkyTitle(`答案 ${manualAnswer}`, 59));
    await waitUntil(() => milkyCalls.filter(({ action, params }) => action === "send_group_message" &&
      JSON.stringify(params.message).includes("合成入群验证成功")).at(successes), "Milky 管理员附真实 @ 发出的重验未通过。");

    batchRoster = true;
    memberJoinTimes.set("79:42", 1_700_000_000);
    memberLastSentTimes.set("79:42", 1_700_000_000);
    memberJoinTimes.set("79:77", 1_700_000_003);
    memberLastSentTimes.set("79:77", 1_700_000_004);
    await webhook("message_receive", milkyTitle("#重新验证从未发言的人", operator));
    await promptTo(42);
    await waitUntil(() => milkyCalls.find(({ action, params }) => action === "get_group_member_info" && params.user_id === 77),
      "Milky 批量重验没有按原间隔复查下一位实际成员。");
    await announcementReply("批量验证结束，已确认向 1 人发送题目");
    expect(milkyCalls.some(({ action, params }) => action === "send_group_message" &&
      JSON.stringify(params.message).includes('"user_id":77') && JSON.stringify(params.message).includes("欢迎！"))).toBe(false);

    const oneBotPrivate = (message: string, user_id = 52) => ({ post_type: "message", message_type: "private", sub_type: "friend",
      message_id: ++sequence, self_id: oneBotId, user_id, message, raw_message: message });
    const ownerReplyWith = (value: string) => waitUntil(() => oneBotReplies().find(({ params }) =>
      params.message_type === "private" && params.user_id === 52 && JSON.stringify(params.message).includes(value)),
      `OneBot 主人私聊未收到 ${value}`);
    client.send(JSON.stringify(oneBotPrivate("#禁言 88 55 二分钟")));
    await ownerReplyWith("合成私聊名片");
    expect(oneBotMuted().filter(({ group_id }) => group_id === 88)).toEqual([{ group_id: 88, user_id: 55, duration: 120 }]);
    expect(oneBotCalls.some(({ action, params }) => action === "get_group_member_info" && params.group_id === 88 && params.user_id === 52)).toBe(false);
    client.send(JSON.stringify(oneBotPrivate("#禁言 87 55 60秒")));
    await ownerReplyWith("无法");
    expect(oneBotMuted().filter(({ group_id }) => group_id === 87)).toHaveLength(0);

    const milkyPrivate = (message: string, sender_id = operator) => ({ message_scene: "friend", sender_id, peer_id: sender_id,
      message_seq: ++sequence, segments: [text(message)] });
    const milkyOwnerReply = (userId: number, value: string) => waitUntil(() => milkyCalls.find(({ action, params }) =>
      action === "send_private_message" && params.user_id === userId && JSON.stringify(params.message).includes(value)),
      `Milky 私聊未收到 ${value}`);
    await webhook("message_receive", milkyPrivate("#禁言 79 68 60秒", 52));
    await milkyOwnerReply(52, "私聊功能已禁用");
    expect(milkyCalls.some(({ action, params }) => action === "set_group_member_mute" && params.user_id === 68)).toBe(false);
    updateRole({ group_id: 79, user_id: operator }, false);
    await webhook("message_receive", milkyPrivate("#解禁 79 51"));
    await milkyOwnerReply(operator, "解除禁言");
    expect(milkyCalls.some(({ action, params }) => action === "set_group_member_mute" && params.group_id === 79 &&
      params.user_id === operator && params.duration === 0)).toBe(true);
    const uncertainPrivateMute = milkyPrivate("#禁言 79 44 14秒");
    await webhook("message_receive", uncertainPrivateMute);
    await milkyOwnerReply(operator, "结果未确认");
    await webhook("message_receive", uncertainPrivateMute);
    expect(milkyCalls.filter(({ action, params }) => action === "set_group_member_mute" && params.group_id === 79 &&
      params.user_id === 44 && params.duration === 14)).toHaveLength(1);
    client.send(JSON.stringify(oneBotPrivate("#全体禁言88")));
    await ownerReplyWith("合成 OneBot 88(88)」开启全体禁言");
    expect(oneBotCalls.filter(({ action, params }) => action === "set_group_whole_ban" && params.group_id === 88).map(({ params }) => params))
      .toEqual([{ group_id: 88, enable: true }]);
    await webhook("message_receive", milkyPrivate("#全体解禁88"));
    await milkyOwnerReply(operator, "合成 Milky 88(88)」解除全体禁言");
    expect(milkyCalls.filter(({ action, params }) => action === "set_group_whole_mute" && params.group_id === 88).map(({ params }) => params))
      .toEqual([{ group_id: 88, is_mute: false }]);
    client.send(JSON.stringify(oneBotPrivate("#踢 88 59")));
    await ownerReplyWith("已将「59」踢出群聊（群 88）");
    expect(oneBotCalls.filter(({ action, params }) => action === "set_group_kick" && params.group_id === 88).map(({ params }) => params))
      .toEqual([{ group_id: 88, user_id: 59, reject_add_request: false }]);
    await webhook("message_receive", milkyPrivate("#踢 88 52"));
    await milkyOwnerReply(operator, "52 受群");
    await webhook("message_receive", milkyPrivate("#踢 88 67"));
    await milkyOwnerReply(operator, "已将「67」踢出群聊（群 88）");
    expect(milkyCalls.filter(({ action, params }) => action === "kick_group_member" && params.group_id === 88).map(({ params }) => params))
      .toEqual([{ group_id: 88, user_id: 67, reject_add_request: false }]);

    const invitationCalls = () => oneBotCalls.filter(({ action }) => action === "get_group_system_msg").length;
    const beforeInvitations = invitationCalls();
    send(oneBotMessage("#查看群邀请", 52, 82));
    client.send(JSON.stringify(oneBotPrivate("#查看群邀请", operator)));
    client.send(JSON.stringify({ ...oneBotPrivate("#查看群邀请"), sub_type: "group" }));
    client.send(JSON.stringify(oneBotPrivate("#查看全部群邀请")));
    const invitations = await waitUntil(() => oneBotCalls.find(({ action, params }) => action === "send_private_forward_msg" &&
      params.user_id === 52 && JSON.stringify(params.messages).includes("合成邀请目标")), "待处理的群邀请未送达原机器人主人私聊。");
    const shownInvitations = JSON.stringify(invitations.params.messages);
    expect(shownInvitations).toContain("合成邀请者");
    expect(shownInvitations).toContain("91");
    expect(shownInvitations).not.toContain("已经处理的邀请");
    expect(shownInvitations).not.toContain("状态未核验的邀请");
    expect(shownInvitations).not.toContain("合成待审附言");
    expect(shownInvitations).not.toContain("921001");
    expect(invitationCalls()).toBe(beforeInvitations + 1);

    exposeGroupInvitation = false;
    client.send(JSON.stringify(oneBotPrivate("#查看群邀请")));
    await ownerReplyWith("本次查询范围内未发现待处理的群邀请，未能核验完整列表");
    expect(invitationCalls()).toBe(beforeInvitations + 2);
    await webhook("message_receive", milkyPrivate("#查看群邀请"));
    await milkyOwnerReply(operator, "本次查询范围内未发现待处理的群邀请，未能核验完整列表");

    const incomingFriend = { post_type: "request", request_type: "friend", sub_type: "add", self_id: oneBotId,
      user_id: 95, flag: "onebot_fixture_friend_only", comment: "当前连接所见好友附言", time: 1_704_038_405 };
    client.send(JSON.stringify(incomingFriend));
    client.send(JSON.stringify(incomingFriend));
    client.send(JSON.stringify({ ...incomingFriend, self_id: milkyId, comment: "越账号伪造好友附言" }));
    const friendNotice = await ownerReplyWith("添加好友申请");
    const shownFriendNotice = JSON.stringify(friendNotice.params.message);
    expect(shownFriendNotice).toContain("当前连接所见好友附言");
    expect(shownFriendNotice).toContain("#查看好友申请");
    expect(shownFriendNotice).not.toContain(incomingFriend.flag);
    client.send(JSON.stringify(oneBotPrivate("#查看好友申请")));
    const oneBotFriendList = await waitUntil(() => oneBotCalls.find(({ action, params }) => action === "send_private_forward_msg" &&
      params.user_id === 52 && JSON.stringify(params.messages).includes("当前连接所见好友附言")), "OneBot 好友申请未送达机器人主人。");
    const shownOneBotFriends = JSON.stringify(oneBotFriendList.params.messages);
    expect(shownOneBotFriends).toContain("本次查到 1 条待处理好友申请");
    expect(shownOneBotFriends).toContain("2024-01-01 00:00:05");
    expect(shownOneBotFriends).not.toContain("越账号伪造好友附言");
    expect(shownOneBotFriends).not.toContain(incomingFriend.flag);
    expect(oneBotReplies().filter(({ params }) => JSON.stringify(params.message).includes("添加好友申请")).map(({ params }) => params.user_id)).toEqual([52]);

    await webhook("message_receive", milkyPrivate("#查看好友申请", 52));
    await webhook("message_receive", milkyTitle("#查看好友申请", operator));
    await webhook("message_receive", milkyPrivate("#查看全部好友申请"));
    const shownMilkyFriends = JSON.stringify((await milkyOwnerReply(operator, "风险好友附言")).params.message);
    expect(shownMilkyFriends).toContain("普通申请");
    expect(shownMilkyFriends).toContain("合成搜索");
    expect(shownMilkyFriends).toContain("常规好友附言");
    expect(shownMilkyFriends).not.toContain("另一个账号的好友申请");
    expect(shownMilkyFriends).not.toContain("已处理的好友审批");
    expect(shownMilkyFriends).not.toContain("milky_fixture");
    expect(milkyCalls.filter(({ action }) => action === "get_friend_requests").map(({ params }) => params)).toEqual([
      { limit: 50, is_filtered: false }, { limit: 50, is_filtered: true },
    ]);

    const priorOneBotDecisions = oneBotCalls.filter(({ action }) => action === "set_group_add_request").length;
    send(oneBotMessage("#查看加群申请", 54, 82));
    const joinList = await waitUntil(() => oneBotCalls.find(({ action, params }) => action === "send_group_forward_msg" &&
      JSON.stringify(params.messages).includes("合成待审附言")), "OneBot 待审列表没有保留群内申请附言。");
    const shownOneBot = JSON.stringify(joinList.params.messages);
    expect(shownOneBot).toContain("仍在等待");
    expect(shownOneBot).toContain("风险");
    expect(shownOneBot).not.toContain("隔壁 OneBot 群附言");
    expect(shownOneBot).not.toContain("910002");
    expect(oneBotCalls.filter(({ action }) => action === "set_group_add_request")).toHaveLength(priorOneBotDecisions);

    pendingJoinListing = true;
    await webhook("message_receive", milkyTitle("查看入群申请", 54));
    const milkyJoinList = await announcementReply("合成第二页申请");
    const shownMilky = JSON.stringify(milkyJoinList.params.message);
    expect(shownMilky).toContain("QQ：78");
    expect(shownMilky).toContain("风险");
    expect(shownMilky).not.toContain("隔壁群附言");
    expect(shownMilky).not.toContain("QQ：74");
    const emptyJoinList = milkyTitle("#查看群申请", 54);
    await webhook("message_receive", { ...emptyJoinList, peer_id: 84, group_member: { ...emptyJoinList.group_member, group_id: 84 } });
    await announcementReply("暂无加群申请");

    send(oneBotMessage("#同意加群申请70", operator, 82));
    await groupReplyWith("请引用原加群通知或在 QQ 中处理");
    expect(oneBotCalls.filter(({ action }) => action === "set_group_add_request")).toHaveLength(priorOneBotDecisions);
    await webhook("message_receive", milkyTitle("#同意加群申请77", operator));
    await announcementReply("多条待处理");
    await webhook("message_receive", milkyTitle("#拒绝入群申请73", operator));
    await announcementReply("风险账号");
    const directDecision = milkyTitle("#同意加群申请75", operator);
    await webhook("message_receive", directDecision);
    await waitUntil(() => milkyCalls.find(({ action, params }) => action === "send_group_message" &&
      /已同意.*75.*加群申请/u.test(JSON.stringify(params.message))), "Milky 未明确同意指定 QQ 的唯一待审申请。");
    await webhook("message_receive", directDecision);
    await webhook("message_receive", milkyTitle("#拒绝入群申请75", operator));
    await announcementReply("加群申请处理结果未确认");
    expect(milkyCalls.filter(({ action, params }) => (action === "accept_group_request" || action === "reject_group_request") &&
      [887, 888, 889, 903, 991].includes(Number(params.notification_seq))).map(({ action, params }) => ({ action, params }))).toEqual([
      { action: "accept_group_request", params: { group_id: 79, notification_seq: 889, notification_type: "join_request", is_filtered: false } },
    ]);
    const batchDecision = milkyTitle("#拒绝全部加群申请", operator);
    await webhook("message_receive", batchDecision);
    const reviewedBatch = await announcementReply("本次共核对 5 条加群申请");
    const outcomes = JSON.stringify(reviewedBatch.params.message);
    expect(outcomes).toContain("已拒绝：3 条");
    expect(outcomes).toContain("风险：1 条");
    expect(outcomes).toContain("结果未知：1 条");
    await webhook("message_receive", batchDecision);
    expect(milkyCalls.filter(({ action, params }) => action === "reject_group_request" &&
      [887, 888, 889, 903, 991].includes(Number(params.notification_seq))).map(({ params }) => params)).toEqual([
      { group_id: 79, notification_seq: 903, notification_type: "invited_join_request", is_filtered: false },
      { group_id: 79, notification_seq: 888, notification_type: "join_request", is_filtered: false },
      { group_id: 79, notification_seq: 887, notification_type: "join_request", is_filtered: false },
    ]);

    client.send(JSON.stringify(oneBotPrivate("#查看全部请求")));
    const privateOverview = await waitUntil(() => oneBotCalls.find(({ action, params }) => action === "send_private_forward_msg" &&
      params.user_id === 52 && JSON.stringify(params.messages).includes("以下为暂未处理的请求")), "主人私聊未收到请求总览。");
    const privateRows = JSON.stringify(privateOverview.params.messages);
    expect(privateRows).toContain("好友申请：本次查到 1 条");
    expect(privateRows).toContain("群邀请：本次查询范围内未发现");
    expect(privateRows).toContain("单向好友：未核实");
    expect(privateRows).not.toContain("当前群申请");

    const accountListReads = milkyCalls.filter(({ action }) => action === "get_friend_requests").length;
    await webhook("message_receive", milkyTitle("#查看全部请求", operator));
    const groupRows = JSON.stringify((await announcementReply("当前群申请：5 条")).params.message);
    expect(groupRows).toContain("#查看加群申请");
    expect(groupRows).not.toContain("好友申请");
    expect(groupRows).not.toContain("群邀请");
    expect(milkyCalls.filter(({ action }) => action === "get_friend_requests")).toHaveLength(accountListReads);

    milkyFriendReviewFixture = true;
    client.send(JSON.stringify(oneBotPrivate("#同意好友申请95")));
    await ownerReplyWith("当前无法按 QQ 核实并处理这条好友申请");
    expect(oneBotCalls.filter(({ action }) => action === "set_friend_add_request")).toHaveLength(0);
    await webhook("message_receive", milkyPrivate("#拒绝好友申请94"));
    await milkyOwnerReply(operator, "风险账号请在 QQ 中手动处理");
    await webhook("message_receive", milkyPrivate("#同意好友申请97"));
    await milkyOwnerReply(operator, "这个 QQ 有多条待处理的好友申请");
    await webhook("message_receive", milkyPrivate("#同意好友申请98"));
    await milkyOwnerReply(operator, "当前无法按 QQ 核实并处理这条好友申请");
    await webhook("message_receive", milkyPrivate("#同意好友申请93"));
    await milkyOwnerReply(operator, "已同意 93 的好友申请");
    const staleFriendReview = milkyPrivate("#拒绝好友申请96");
    await webhook("message_receive", staleFriendReview);
    await milkyOwnerReply(operator, "协议端已受理拒绝 96");
    await webhook("message_receive", staleFriendReview);
    const unknownFriendReview = milkyPrivate("#同意好友申请95");
    await webhook("message_receive", unknownFriendReview);
    await milkyOwnerReply(operator, "好友申请处理结果未确认");
    const replyCount = () => milkyCalls.filter(({ action, params }) => action === "send_private_message" &&
      JSON.stringify(params.message).includes("好友申请处理结果未确认")).length;
    const unknownCount = replyCount();
    await webhook("message_receive", milkyPrivate("#拒绝好友申请95"));
    await waitUntil(() => replyCount() === unknownCount + 1 || undefined, "未知好友审核重复时未得到核对提示。");
    expect(milkyCalls.filter(({ action }) => action === "accept_friend_request" || action === "reject_friend_request")).toEqual([
      { action: "accept_friend_request", params: { initiator_uid: "milky_fixture_sender", is_filtered: false } },
      { action: "reject_friend_request", params: { initiator_uid: "milky_fixture_stale", is_filtered: false } },
      { action: "accept_friend_request", params: { initiator_uid: "milky_fixture_unknown", is_filtered: false } },
    ]);

    const privateText = "合成 OneBot 纯文本 [CQ:at,qq=all]\n第二行";
    const nativeOwnerReply = oneBotPrivate(`#回复42 ${privateText}`);
    client.send(JSON.stringify({ ...nativeOwnerReply, message: [text(nativeOwnerReply.raw_message)] }));
    const delivery = await waitUntil(() => oneBotReplies().find(({ params }) => params.user_id === 42 &&
      JSON.stringify(params.message).includes("合成 OneBot 纯文本")), "当前好友未收到 OneBot 主人的文字回复。");
    expect(delivery.params).toEqual({ user_id: 42, message_type: "private", message: [text(privateText)], auto_escape: true });
    await ownerReplyWith("已把消息发给它了哦");
    client.send(JSON.stringify(oneBotPrivate("#回复 43 不能向同名另一账号的好友送出")));
    await ownerReplyWith("好友列表查无此人");
    expect(oneBotReplies().some(({ params }) => params.user_id === 43 && JSON.stringify(params.message).includes("不能向同名"))).toBe(false);

    await webhook("message_receive", milkyPrivate("回复 43 合成 Milky 文字", operator));
    const milkyDelivery = await milkyOwnerReply(43, "合成 Milky 文字");
    expect(milkyDelivery.params.message).toEqual([text("合成 Milky 文字")]);
    await milkyOwnerReply(operator, "已把消息发给它了哦");
    await webhook("message_receive", milkyPrivate("#回复 42 不能用到 OneBot 好友"));
    await milkyOwnerReply(operator, "好友列表查无此人");
    const unknownOwnerReply = milkyPrivate("#回复43 合成 Milky 未知回复");
    await webhook("message_receive", unknownOwnerReply);
    await milkyOwnerReply(operator, "好友消息发送结果未确认");
    await webhook("message_receive", unknownOwnerReply);
    expect(milkyCalls.filter(({ action, params }) => action === "send_private_message" && params.user_id === 43 &&
      JSON.stringify(params.message).includes("合成 Milky 未知回复"))).toHaveLength(1);

    const richOneBotReply = oneBotPrivate("#回复42 图前");
    client.send(JSON.stringify({ ...richOneBotReply, message: [text(richOneBotReply.raw_message), embeddedImage,
      { type: "face", data: { id: "14" } }, text("\n图后")],
    }));
    const richOneBotDelivery = await waitUntil(() => oneBotReplies().find(({ params }) => params.user_id === 42 &&
      JSON.stringify(params.message).includes("图后")), "OneBot 好友回复未发送原图与表情。");
    expect(richOneBotDelivery.params.message).toEqual([text("图前"), { type: "image", data: { file: `base64://${noticeImageBase64}` } },
      { type: "face", data: { id: "14" } }, text("\n图后")]);

    const brokenReply = oneBotPrivate("#回复42 不能只发这段");
    client.send(JSON.stringify({ ...brokenReply, message: [text(brokenReply.raw_message),
      { type: "image", data: { file: "/tmp/untrusted-private-reply.png" } }],
    }));
    await ownerReplyWith("整条消息未发送");
    expect(oneBotReplies().some(({ params }) => params.user_id === 42 && JSON.stringify(params.message).includes("不能只发这段"))).toBe(false);

    const richMilkyReply = milkyPrivate("回复43");
    await webhook("message_receive", { ...richMilkyReply, segments: [...richMilkyReply.segments,
      { type: "face", data: { face_id: "14", is_large: true } }, { type: "image", data: { resource_id: "matched-picture" } },
      text("原媒体后的文字"),
    ] });
    const richMilkyDelivery = await milkyOwnerReply(43, "原媒体后的文字");
    expect(richMilkyDelivery.params.message).toEqual([{ type: "face", data: { face_id: "14", is_large: true } },
      { type: "image", data: { uri: `base64://${noticeImageBase64}`, sub_type: "normal" } }, text("原媒体后的文字")]);

    await writeFile(join(legacyDirectory, "notice.yaml"), 'default: { privateMessage: false }\n"bot:99": { privateMessage: true }\n"bot:100": { privateMessage: true }\n');
    const oneBotFriendText = { ...oneBotPrivate("给当前账号的好友留言", 42), sender: { nickname: "合成好友昵称" } };
    client.send(JSON.stringify(oneBotFriendText));
    client.send(JSON.stringify(oneBotFriendText));
    const forwardedFriend = await ownerReplyWith("给当前账号的好友留言");
    const forwardedText = JSON.stringify(forwardedFriend.params.message);
    expect(forwardedText).toContain("[消息(99) - 好友消息]");
    expect(forwardedText).toContain("合成好友昵称");
    expect(forwardedText).toContain("可发送：回复 42 <内容>");
    expect(forwardedText).toContain("引用该消息：回复 <内容>");
    client.send(JSON.stringify(oneBotPrivate("再次给当前账号的好友留言", 42)));
    const secondFriend = await ownerReplyWith("再次给当前账号的好友留言");
    expect(JSON.stringify(secondFriend.params.message)).not.toContain("可发送：回复");
    expect(oneBotReplies().filter(({ params }) => params.user_id === 52 &&
      JSON.stringify(params.message).includes("[消息(99) - 好友消息]"))).toHaveLength(2);

    client.send(JSON.stringify(oneBotPrivate("stoken=synthetic-secret-for-scope-test", 42)));
    client.send(JSON.stringify({ ...oneBotPrivate("合成临时会话勿转发", 42), sub_type: "group" }));
    await webhook("message_receive", milkyPrivate("给 Milky 账号的好友留言", 42));
    const opposite = await milkyOwnerReply(operator, "给 Milky 账号的好友留言");
    const oppositeText = JSON.stringify(opposite.params.message);
    expect(oppositeText).toContain("[消息(100) - 好友消息]");
    expect(oppositeText).toContain("可发送：回复 42 <内容>");
    expect(oneBotReplies().some(({ params }) => params.user_id === 52 &&
      /synthetic-secret-for-scope-test|合成临时会话勿转发|Milky 账号的好友留言/u.test(JSON.stringify(params.message)))).toBe(false);
    expect(milkyCalls.some(({ action, params }) => action === "send_private_message" && params.user_id === 52 &&
      JSON.stringify(params.message).includes("给 Milky 账号的好友留言"))).toBe(false);

    const oneBotReceipt = oneBotCalls.indexOf(forwardedFriend) + 1;
    const quoteFriend = (content: string) => ({ ...oneBotPrivate(content), message: [quote(oneBotReceipt), text(content)] });
    oneBotChangedNotices.add(oneBotReceipt);
    client.send(JSON.stringify(quoteFriend("#回复 同序号但更改正文不应发送")));
    await waitUntil(() => oneBotCalls.find(({ action, params }) => action === "get_friend_msg_history" && params.message_seq === oneBotReceipt),
      "OneBot 未以原收件人查找好友历史。");
    oneBotChangedNotices.delete(oneBotReceipt);
    client.send(JSON.stringify(quoteFriend("#回复 43 仅为真正好友正文")));
    const quotedOneBot = await waitUntil(() => oneBotReplies().find(({ params }) => params.user_id === 42 &&
      JSON.stringify(params.message).includes("43 仅为真正好友正文")), "原 OneBot 好友未收到引用回复。");
    expect(quotedOneBot.params.message).toEqual([text("43 仅为真正好友正文")]);
    expect(oneBotCalls.filter(({ action }) => action === "get_friend_msg_history").map(({ params }) => params)).toEqual([
      { user_id: 52, message_seq: oneBotReceipt, count: 10, disable_get_url: true, parse_mult_msg: false },
      { user_id: 52, message_seq: oneBotReceipt, count: 10, disable_get_url: true, parse_mult_msg: false },
    ]);
    expect(oneBotReplies().some(({ params }) => params.user_id === 42 && JSON.stringify(params.message).includes("同序号但更改正文不应发送"))).toBe(false);

    await webhook("message_receive", milkyPrivate("实际 Milky 好友的第二条留言", 43));
    const milkyForward = await milkyOwnerReply(operator, "实际 Milky 好友的第二条留言");
    const milkyReceipt = milkyCalls.indexOf(milkyForward) + 1;
    const milkyQuote = milkyPrivate("回复 42 开头仍是原好友的正文");
    await webhook("message_receive", { ...milkyQuote, segments: [{ type: "reply", data: { message_seq: milkyReceipt } }, ...milkyQuote.segments] });
    const quotedMilky = await milkyOwnerReply(43, "开头仍是原好友的正文");
    expect(quotedMilky.params.message).toEqual([text("42 开头仍是原好友的正文")]);

    client.send(JSON.stringify({ ...oneBotPrivate("", 42), message: [embeddedImage] }));
    const pureImageNotice = await waitUntil(() => oneBotReplies().find(({ params }) => params.user_id === 52 &&
      JSON.stringify(params.message).includes("[消息(99) - 好友消息]") && JSON.stringify(params.message).includes(noticeImageBase64)),
      "主人没有收到 OneBot 好友原图通知。");
    expect(JSON.stringify(pureImageNotice.params.message)).toContain(`base64://${noticeImageBase64}`);

    const renderSource = milkyPrivate("合成原文在前", 43);
    await webhook("message_receive", { ...renderSource, segments: [...renderSource.segments,
      { type: "face", data: { face_id: "14", is_large: true } }, { type: "image", data: { resource_id: "matched-picture" } }, text("合成原文在后"),
    ] });
    const richNotice = await milkyOwnerReply(operator, "合成原文在后");
    expect((richNotice.params.message as readonly unknown[]).slice(-4)).toEqual([
      text("合成原文在前"), { type: "face", data: { face_id: "14", is_large: true } },
      { type: "image", data: { uri: `base64://${noticeImageBase64}`, sub_type: "normal" } }, text("合成原文在后"),
    ]);
    const richReceipt = milkyCalls.indexOf(richNotice) + 1;
    const richQuote = milkyPrivate("#回复 混排来源仍可准确绑定");
    await webhook("message_receive", { ...richQuote, segments: [{ type: "reply", data: { message_seq: richReceipt } }, ...richQuote.segments] });
    await milkyOwnerReply(43, "混排来源仍可准确绑定");

    includeNoticeOwnersInFriendList = true;
    await writeFile(join(legacyDirectory, "notice.yaml"), 'default: { grouptemporaryMessage: true }\n"bot:100:88": { grouptemporaryMessage: false }\n');
    const temporaryOneBot = { ...oneBotPrivate("真实临时 OneBot 文本", 42), sub_type: "group", group_id: 86 };
    client.send(JSON.stringify(temporaryOneBot));
    client.send(JSON.stringify(temporaryOneBot));
    const reportedNotice = await ownerReplyWith("真实临时 OneBot 文本");
    const reportedText = JSON.stringify(reportedNotice.params.message);
    expect(reportedText).toContain("[消息(99) - 群临时消息]");
    expect(reportedText).toContain("来源群号：未核实（协议报告 86）");
    expect(reportedText).not.toContain("加为好友");
    client.send(JSON.stringify({ ...oneBotPrivate("固定假群号不显示", 42), sub_type: "group", group_id: 284840486 }));
    const fallbackTempNotice = JSON.stringify((await ownerReplyWith("固定假群号不显示")).params.message);
    expect(fallbackTempNotice).toContain("来源群号：未核实");
    expect(fallbackTempNotice).not.toContain("284840486");
    expect(oneBotReplies().filter(({ params }) => params.user_id === 52 &&
      JSON.stringify(params.message).includes("真实临时 OneBot 文本"))).toHaveLength(1);

    const temporaryMilky = (content: string, groupId: number) => ({ ...milkyPrivate(content, 43), message_scene: "temp",
      group: { group_id: groupId, group_name: "只是合成群" },
    });
    await webhook("message_receive", temporaryMilky("此来源群禁用通知", 88));
    await webhook("message_receive", temporaryMilky("authkey=should-not-forward-temp", 79));
    await webhook("message_receive", { ...temporaryMilky("不匹配的对端勿转发", 79), peer_id: 55 });
    await webhook("message_receive", temporaryMilky("真实 Milky 临时会话文本", 79));
    const temporaryDelivery = await milkyOwnerReply(operator, "真实 Milky 临时会话文本");
    const temporaryText = JSON.stringify(temporaryDelivery.params.message);
    expect(temporaryText).toContain("[消息(100) - 群临时消息]");
    expect(temporaryText).toContain("来源群号：79");
    expect(temporaryText).not.toContain("回复 <内容>");
    const tempSequence = milkyCalls.indexOf(temporaryDelivery) + 1;
    const unrelatedTempQuote = milkyPrivate("#回复 临时通知不作为好友回信来源");
    await webhook("message_receive", { ...unrelatedTempQuote,
      segments: [{ type: "reply", data: { message_seq: tempSequence } }, ...unrelatedTempQuote.segments] });
    await webhook("message_receive", milkyPrivate("#回复 43 最终正常好友回执"));
    await milkyOwnerReply(43, "最终正常好友回执");
    expect(milkyCalls.some(({ action, params }) => action === "send_private_message" &&
      /此来源群禁用通知|should-not-forward-temp|不匹配的对端勿转发|临时通知不作为好友回信来源/u.test(JSON.stringify(params.message)))).toBe(false);

    includeNewFriendProfile = true;
    await writeFile(join(legacyDirectory, "notice.yaml"), 'default: { friendNumberChange: false }\n"bot:99": { friendNumberChange: true }\n');
    const newFriend = { post_type: "notice", notice_type: "friend_add", self_id: oneBotId, user_id: 46, time: 1_700_000_000 };
    client.send(JSON.stringify(newFriend));
    client.send(JSON.stringify(newFriend));
    client.send(JSON.stringify({ ...newFriend, self_id: milkyId, user_id: 48 }));
    const relationshipNotice = await ownerReplyWith("合成新增好友昵称");
    expect(JSON.stringify(relationshipNotice.params.message)).toContain("[通知(99) - 新增好友]");
    expect(JSON.stringify(relationshipNotice.params.message)).toContain("好友账号：46");
    client.send(JSON.stringify({ ...newFriend, user_id: 47 }));
    const missingNickname = JSON.stringify((await ownerReplyWith("好友账号：47")).params.message);
    expect(missingNickname).toContain("好友昵称：未知");
    client.send(JSON.stringify({ ...newFriend, notice_type: "friend_decrease", user_id: 46 }));
    expect(oneBotReplies().filter(({ params }) => params.user_id === 52 &&
      JSON.stringify(params.message).includes("合成新增好友昵称"))).toHaveLength(1);
    expect(oneBotReplies().some(({ params }) => params.user_id === 52 &&
      /好友账号：48|好友减少/u.test(JSON.stringify(params.message)))).toBe(false);

    await writeFile(join(legacyDirectory, "notice.yaml"), 'default: { privateMessage: true }\n');
    const oneBotPoke = { post_type: "notice", notice_type: "notify", sub_type: "poke", self_id: oneBotId,
      target_id: oneBotId, user_id: 42, operator_id: 42, time: 1_700_000_010,
    };
    client.send(JSON.stringify(oneBotPoke));
    client.send(JSON.stringify(oneBotPoke));
    client.send(JSON.stringify({ ...oneBotPoke, user_id: 47, operator_id: 47 }));
    const pokeNotice = JSON.stringify((await ownerReplyWith("[消息(99) - 戳一戳]")).params.message);
    expect(pokeNotice).toContain("来源账号：42");
    expect(pokeNotice).not.toContain("回复");
    await webhook("friend_nudge", { user_id: 42, is_self_send: true, is_self_receive: false });
    await webhook("friend_nudge", { user_id: 43, is_self_send: false, is_self_receive: true });
    const milkyPoke = JSON.stringify((await milkyOwnerReply(operator, "[消息(100) - 戳一戳]")).params.message);
    expect(milkyPoke).toContain("来源账号：43");
    expect(oneBotReplies().filter(({ params }) => params.user_id === 52 && JSON.stringify(params.message).includes("[消息(99) - 戳一戳]")))
      .toHaveLength(1);
    expect(milkyCalls.filter(({ action }) => action === "send_friend_nudge")).toHaveLength(0);

    await writeFile(join(legacyDirectory, "notice.yaml"), 'default: { PrivateRecall: true, msgSaveDeltime: 600 }\n');
    const recalledOneBot = oneBotPrivate("只在 OneBot 原好友撤回后给主人看", 42);
    const oneBotRecall = { post_type: "notice", notice_type: "friend_recall", self_id: oneBotId, user_id: 42,
      message_id: recalledOneBot.message_id, time: 1_700_000_011,
    };
    client.send(JSON.stringify(recalledOneBot));
    client.send(JSON.stringify({ ...oneBotRecall, user_id: 43 }));
    client.send(JSON.stringify(oneBotRecall));
    client.send(JSON.stringify(oneBotRecall));
    const oneBotRecallNotice = JSON.stringify((await ownerReplyWith("只在 OneBot 原好友撤回后给主人看")).params.message);
    expect(oneBotRecallNotice).toContain("[消息(99) - 好友撤回消息]");
    expect(oneBotRecallNotice).toContain("好友账号：42");
    expect(oneBotRecallNotice).toContain("撤回时间：");
    const secretRecall = oneBotPrivate("cookie_token=synthetic-recalled-secret-never-forward", 42);
    client.send(JSON.stringify(secretRecall));
    client.send(JSON.stringify({ ...oneBotRecall, message_id: secretRecall.message_id }));

    const recalledMilky = milkyPrivate("只在 Milky 原好友撤回后给主人看", 43);
    await webhook("message_receive", recalledMilky);
    const milkyRecall = { message_scene: "friend", peer_id: 43, sender_id: 43, operator_id: 43, message_seq: recalledMilky.message_seq };
    await webhook("message_recall", { ...milkyRecall, peer_id: 44 });
    await webhook("message_recall", { ...milkyRecall, operator_id: milkyId });
    await webhook("message_recall", milkyRecall);
    await webhook("message_recall", milkyRecall);
    const milkyRecallNotice = JSON.stringify((await milkyOwnerReply(operator, "只在 Milky 原好友撤回后给主人看")).params.message);
    expect(milkyRecallNotice).toContain("[消息(100) - 好友撤回消息]");
    expect(milkyRecallNotice).toContain("好友账号：43");
    expect(oneBotReplies().filter(({ params }) => params.user_id === 52 && JSON.stringify(params.message).includes("好友撤回消息")))
      .toHaveLength(1);
    expect(milkyCalls.filter(({ action, params }) => action === "send_private_message" && params.user_id === operator &&
      JSON.stringify(params.message).includes("好友撤回消息"))).toHaveLength(1);
    expect(oneBotReplies().some(({ params }) => JSON.stringify(params.message).includes("synthetic-recalled-secret-never-forward"))).toBe(false);

    await writeFile(join(legacyDirectory, "notice.yaml"), 'default: { groupRecall: true, msgSaveDeltime: 600 }\n');
    const recalledGroupOneBot = oneBotMessage("合成 OneBot 原群正文", 42, 82);
    const oneBotGroupRecall = { post_type: "notice", notice_type: "group_recall", self_id: oneBotId, user_id: 42,
      operator_id: operator, group_id: 82, message_id: recalledGroupOneBot.message_id, time: 1_700_000_022,
    };
    send(recalledGroupOneBot);
    await Bun.sleep(35);
    client.send(JSON.stringify({ ...oneBotGroupRecall, group_id: 84 }));
    client.send(JSON.stringify({ ...oneBotGroupRecall, operator_id: oneBotId }));
    client.send(JSON.stringify(oneBotGroupRecall));
    const oneBotGroupRecallSummary = JSON.stringify((await ownerReplyWith("群聊管理撤回")).params.message);
    expect(oneBotGroupRecallSummary).toContain("撤回群名：合成 OneBot 82");
    expect(oneBotGroupRecallSummary).toContain("被撤回人");
    const oneBotRecalledForward = await waitUntil(() => oneBotCalls.find(({ action, params }) => action === "send_private_forward_msg" &&
      params.user_id === 52 && JSON.stringify(params.messages).includes("合成 OneBot 原群正文")), "OneBot 群撤回未向主人合并转发原文。");
    expect(oneBotRecalledForward.params.messages).toMatchObject([{ type: "node", data: { uin: "42", content: [text("合成 OneBot 原群正文")] } }]);

    const recalledGroupMilky = milkyTitle("合成 Milky 原群正文", 54);
    await webhook("message_receive", recalledGroupMilky);
    const milkyGroupRecall = { message_scene: "group", peer_id: 79, sender_id: 54, operator_id: 54, message_seq: recalledGroupMilky.message_seq };
    await webhook("message_recall", { ...milkyGroupRecall, operator_id: 0 });
    await webhook("message_recall", milkyGroupRecall);
    await webhook("message_recall", milkyGroupRecall);
    const milkyGroupRecallSummary = JSON.stringify((await milkyOwnerReply(operator, "[通知(100) - 群聊撤回]")).params.message);
    expect(milkyGroupRecallSummary).toContain("撤回群号：79");
    expect(milkyGroupRecallSummary).not.toContain("撤回管理");
    const milkyRecalledForward = await milkyOwnerReply(operator, "合成 Milky 原群正文");
    expect(milkyRecalledForward.params.message).toMatchObject([{ type: "forward", data: { messages: [
      { user_id: 54, segments: [text("合成 Milky 原群正文")] },
    ] } }]);
    send(recalledGroupOneBot);
    client.send(JSON.stringify(oneBotGroupRecall));
    await webhook("message_receive", recalledGroupMilky);
    await webhook("message_recall", milkyGroupRecall);
    await Bun.sleep(100);
    expect(oneBotCalls.filter(({ action, params }) => action === "send_private_forward_msg" &&
      params.user_id === 52 && JSON.stringify(params.messages).includes("合成 OneBot 原群正文"))).toHaveLength(1);
    expect(milkyCalls.filter(({ action, params }) => action === "send_private_message" && params.user_id === operator &&
      JSON.stringify(params.message).includes("合成 Milky 原群正文"))).toHaveLength(1);

    const noticeFile = join(legacyDirectory, "notice.yaml");
    const originalSettings = "# 原通知设置\ndefault: { groupRecall: true, msgSaveDeltime: 600 } # 保留\n";
    await writeFile(noticeFile, originalSettings);
    client.send(JSON.stringify(oneBotPrivate("#椰奶通知设置好友消息开启")));
    await ownerReplyWith("当前会话没有修改此通知设置的权限");
    expect(await readFile(noticeFile, "utf8")).toBe(originalSettings);

    client.send(JSON.stringify(oneBotPrivate("#椰奶通知设置好友消息bot单独开启")));
    const oneBotSettings = await ownerReplyWith("好友消息：开启");
    expect(JSON.stringify(oneBotSettings.params.message)).toContain("已保存通知设置");
    expect(await readFile(noticeFile, "utf8")).toContain(originalSettings);

    await webhook("message_receive", milkyPrivate("#椰奶通知设置"));
    const milkySettings = await milkyOwnerReply(operator, "好友消息：关闭");
    expect(JSON.stringify(milkySettings.params.message)).toContain("删除缓存时间：600 秒");
    await webhook("message_receive", milkyTitle("#椰奶通知设置群撤回bot群单独关闭", operator));
    await waitUntil(() => milkyCalls.find(({ action, params }) => action === "send_group_message" && params.group_id === 79 &&
      JSON.stringify(params.message).includes("群撤回：关闭")), "Milky 当前群未回读自己的通知覆盖。");
    const savedSettings = await readFile(noticeFile, "utf8");
    expect(Bun.YAML.parse(savedSettings)).toMatchObject({ default: { groupRecall: true }, "bot:99": { privateMessage: true },
      "bot:100:79": { groupRecall: false } });
    const previousSettingsReplies = oneBotReplies().filter(({ params }) => params.group_id === 89).length;
    send(oneBotMessage("#椰奶通知设置", 52, 89));
    await Bun.sleep(100);
    expect(oneBotReplies().filter(({ params }) => params.group_id === 89)).toHaveLength(previousSettingsReplies);
    expect(await readFile(noticeFile, "utf8")).toBe(savedSettings);

    await writeFile(noticeFile, 'default: { groupMemberNumberChange: true }\n"bot:100:91": { groupMemberNumberChange: false }\n');
    const oneBotMemberJoin = { post_type: "notice", notice_type: "group_increase", sub_type: "invite", self_id: oneBotId,
      group_id: 90, user_id: 66, operator_id: 67, time: 1_700_000_023, member: { nickname: "原加入昵称", card: "原加入名片" } };
    client.send(JSON.stringify(oneBotMemberJoin));
    client.send(JSON.stringify(oneBotMemberJoin));
    const ownerJoin = (await ownerReplyWith("新成员加入")).params.message;
    expect(JSON.stringify(ownerJoin)).toContain("成员：原加入昵称（66）");
    expect(JSON.stringify(ownerJoin)).toContain("名片：原加入名片");
    expect(JSON.stringify(ownerJoin)).toContain("邀请人：67");
    expect(typeof ownerJoin).toBe("string");
    const welcome = await waitUntil(() => oneBotReplies().find(({ params }) => params.group_id === 90 &&
      JSON.stringify(params.message).includes("欢迎加入")), "OneBot 旧群欢迎未发回原群。");
    expect(welcome.params.user_id).toBeUndefined();
    client.send(JSON.stringify({ ...oneBotMemberJoin, notice_type: "group_decrease", sub_type: "disband", group_id: 92, time: 1_700_000_024 }));

    await webhook("group_member_decrease", { group_id: 90, user_id: 68 });
    const ownerDeparture = (await milkyOwnerReply(operator, "⚪ 成员离开")).params.message;
    expect(JSON.stringify(ownerDeparture)).toContain("群号：90");
    expect(JSON.stringify(ownerDeparture)).toContain("成员：68");
    expect(JSON.stringify(ownerDeparture)).not.toContain("操作人");
    await webhook("group_member_increase", { group_id: 91, user_id: 69 });
    await waitUntil(() => milkyCalls.find(({ action, params }) => action === "send_group_message" && params.group_id === 91 &&
      JSON.stringify(params.message).includes("欢迎加入")), "关闭主人通知的群仍应发送原群欢迎。");
    await Bun.sleep(100);
    expect(oneBotReplies().filter(({ params }) => params.user_id === 52 && JSON.stringify(params.message).includes("新成员加入"))).toHaveLength(1);
    expect(oneBotReplies().some(({ params }) => params.user_id === 52 && JSON.stringify(params.message).includes("群号：92"))).toBe(false);
    expect(milkyCalls.some(({ action, params }) => action === "send_private_message" &&
      JSON.stringify(params.message).includes("群号：91"))).toBe(false);

    await writeFile(noticeFile, 'default: { groupAdminChange: true }\n"bot:100:91": { groupAdminChange: false }\n');
    const oneBotAdmin = { post_type: "notice", notice_type: "group_admin", sub_type: "set", self_id: oneBotId,
      group_id: 90, user_id: 66, operator_id: 67, time: 1_700_000_025 };
    client.send(JSON.stringify({ ...oneBotAdmin, self_id: 101 }));
    client.send(JSON.stringify({ ...oneBotAdmin, sub_type: "anything" }));
    client.send(JSON.stringify(oneBotAdmin));
    client.send(JSON.stringify(oneBotAdmin));
    const adminGranted = JSON.stringify((await ownerReplyWith("新增群管理员")).params.message);
    expect(adminGranted).toContain("被操作账号：66");
    expect(adminGranted).toContain("被操作群号：90");
    expect(adminGranted).not.toContain("操作人");
    expect(adminGranted).toContain("https://p.qlogo.cn/gh/90/90/100");
    await webhook("group_admin_change", { group_id: 90, user_id: milkyId, operator_id: 69, is_set: false });
    const adminRevoked = JSON.stringify((await milkyOwnerReply(operator, "机器人被取消管理")).params.message);
    expect(adminRevoked).toContain("被操作群号：90");
    expect(adminRevoked).not.toContain("被操作账号");
    expect(adminRevoked).not.toContain("操作人");
    await webhook("group_admin_change", { group_id: 91, user_id: 71, is_set: true });
    await webhook("group_admin_change", { group_id: 92, user_id: 72, is_set: "true" });
    await Bun.sleep(100);
    expect(oneBotReplies().filter(({ params }) => params.user_id === 52 && JSON.stringify(params.message).includes("新增群管理员"))).toHaveLength(1);
    expect(milkyCalls.some(({ action, params }) => action === "send_private_message" &&
      /被操作群号：[\d]+/u.test(JSON.stringify(params.message)) && !JSON.stringify(params.message).includes("被操作群号：90"))).toBe(false);

    await writeFile(noticeFile, 'default: { botBeenBanned: true }\n"bot:100:91": { botBeenBanned: false }\n');
    const oneBotBan = { post_type: "notice", notice_type: "group_ban", sub_type: "ban", self_id: oneBotId,
      group_id: 90, user_id: oneBotId, operator_id: 67, time: 1_700_000_026, duration: 3665 };
    for (const event of [
      { ...oneBotBan, duration: 0 }, { ...oneBotBan, user_id: 0, duration: -1 }, { ...oneBotBan, operator_id: 0 },
      { ...oneBotBan, user_id: 68 }, oneBotBan, oneBotBan,
    ]) client.send(JSON.stringify(event));
    const botBan = JSON.stringify((await ownerReplyWith("机器人被禁言")).params.message);
    expect(botBan).toContain("禁言人账号：67");
    expect(botBan).toContain("禁言群号：90");
    expect(botBan).toContain("禁言时长：01小时01分05秒");
    await webhook("group_mute", { group_id: 90, user_id: milkyId, operator_id: 69, duration: 0 });
    const botUnmute = JSON.stringify((await milkyOwnerReply(operator, "机器人被解除禁言")).params.message);
    expect(botUnmute).toContain("处理人账号：69");
    expect(botUnmute).toContain("处理群号：90");
    await webhook("group_mute", { group_id: 91, user_id: milkyId, operator_id: 69, duration: 30 });
    await webhook("group_whole_mute_change", { group_id: 90, operator_id: 69, is_mute: true });
    await Bun.sleep(100);
    expect(oneBotReplies().filter(({ params }) => params.user_id === 52 && JSON.stringify(params.message).includes("机器人被禁言"))).toHaveLength(1);
    expect(milkyCalls.filter(({ action, params }) => action === "send_private_message" && params.user_id === operator &&
      JSON.stringify(params.message).includes("机器人被禁言"))).toHaveLength(0);
  } finally {
    socket?.close();
    host?.kill();
    await host?.exited;
    milky.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 14_000);
