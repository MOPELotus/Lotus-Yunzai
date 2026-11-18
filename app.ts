import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { closeStorage, connectStorage, storage } from "@lotus-yunzai/storage";
import { accountCommands } from "./lib/account-commands.ts";
import { startOneBot } from "./lib/adapters/onebot.ts";
import { OneBotGroups } from "./lib/adapters/onebot-groups.ts";
import { readAutoQuit } from "./lib/auto-quit.ts";
import { normalizeGameCommand } from "./lib/command-prefix.ts";
import { CommandRegistry } from "./lib/commands.ts";
import { readLocalConfig } from "./lib/config.ts";
import { readFriendRequests } from "./lib/friend-requests.ts";
import { readGroupDispatch } from "./lib/group-dispatch.ts";
import { readGroupInvitations } from "./lib/group-invitations.ts";
import { createKeywords } from "./lib/keywords.ts";
import { createKeywordStore } from "./lib/keyword-store.ts";
import { createMasterEnrollment, matchesMasterEnrollment } from "./lib/master-enrollment.ts";
import { createMessageCounts } from "./lib/message-counts.ts";
import { createMessageStatistics } from "./lib/message-statistics.ts";
import type { BotEvent, GroupRequest, MessageEvent } from "./lib/messages.ts";
import { panelApi, panelAssets } from "./lib/panel.ts";
import { panelExtensionRoutes } from "./lib/panel-extension-routes.ts";
import { panelGroupSettings } from "./lib/panel-group.ts";
import { panelGuobaRoutes } from "./lib/panel-guoba-routes.ts";
import { LegacyPlugins } from "./lib/plugins/legacy.ts";
import { loadPlugins, systemModuleName, type PluginLoadReport } from "./lib/plugins/loader.ts";
import { stopStaticRenderer } from "./lib/renderer/shotium.ts";
import { readAccountRefreshPermission, readMasterPermissions } from "./lib/permissions.ts";
import { readPrivateAccess } from "./lib/private-access.ts";
import { httpStatus, readServerSettings } from "./lib/server.ts";

declare global {
  var redis: Awaited<ReturnType<typeof connectStorage>> | undefined;
}

const commands = new CommandRegistry();
const keywordFeatureNames = ["添加消息", "group", "@lotus-yunzai/group"];

if (import.meta.main) {
  const legacy = new LegacyPlugins();
  const groups = new OneBotGroups();
  const pending = new Set<Promise<void>>();
  const pendingCounts = new Set<Promise<void>>();
  const shutdown = Promise.withResolvers<void>();
  const lifecycle = new AbortController();
  let plugins: PluginLoadReport | undefined;
  let stopping = false;
  let consoleInput: ReturnType<typeof createInterface> | undefined;
  const servers: Pick<ReturnType<typeof startOneBot>, "stop">[] = [];
  const root = new URL("./", import.meta.url);
  let privateAccess: Awaited<ReturnType<typeof readPrivateAccess>>;
  let autoFriend: Awaited<ReturnType<typeof readFriendRequests>>;
  let groupDispatch: Awaited<ReturnType<typeof readGroupDispatch>>;
  let reviewInvitation: Awaited<ReturnType<typeof readGroupInvitations>>;
  let autoQuit: Awaited<ReturnType<typeof readAutoQuit>>;
  let masterEnrollment: ReturnType<typeof createMasterEnrollment>;
  let keywords: ReturnType<typeof createKeywords>;
  let counts: ReturnType<typeof createMessageCounts>;

  function stop(code: number) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    lifecycle.abort();
    void legacy.stopTasks();
    legacy.stopContexts();
    consoleInput?.close();
    shutdown.resolve();
  }

  async function dispatch(event: BotEvent) {
    if (stopping) return;
    if (event.post_type !== "message" || event.message_type !== "terminal") {
      recordCount("receive", event, event.post_type === "message" ? event.message : undefined);
    }
    if (!groupDispatch.admit(event)) return;
    const handling = handleEvent(event);
    pending.add(handling);
    try {
      await handling;
    } finally {
      pending.delete(handling);
    }
  }

  function recordCount(direction: "receive" | "send", identity: { self_id?: number; user_id?: number; group_id?: number }, message?: unknown) {
    if (!counts.available()) return;
    const write = counts.record(direction, identity, message).catch(() => {});
    pendingCounts.add(write);
    void write.then(() => pendingCounts.delete(write));
  }

  async function handleEvent(event: BotEvent) {
    if (event.post_type === "message") return dispatchMessage(event);
    if (event.post_type === "notice" && event.notice_type === "friend" && await privateAccess.blockedPoke(event)) return;
    const allowed = (names: readonly string[]) => groupDispatch.allows(event, names);
    if (event.post_type === "request" && event.request_type === "group" && event.sub_type === "invite") {
      await dispatchGroupInvitation(event, allowed);
      return;
    }
    if (event.post_type === "request" && event.request_type === "friend") {
      let reviewed = false;
      const consumed = await legacy.dispatch({
        ...event,
        approve(approve?: boolean, remark?: string) {
          reviewed = true;
          return event.approve(approve, remark);
        },
      }, allowed);
      if (!reviewed && !consumed && allowed(["autoFriend"])) await autoFriend(event, lifecycle.signal);
      return;
    }
    const consumed = await legacy.dispatch(event, allowed);
    if (!consumed && event.post_type === "notice" && event.notice_type === "group" &&
        event.sub_type === "increase" && event.self_id === event.user_id && allowed(["notice"]) &&
        await autoQuit(event, lifecycle.signal)) {
      console.log(`[自动退群] 已退出群 ${event.group_id}。`);
    }
  }

  async function dispatchGroupInvitation(event: GroupRequest, allowed: (names: readonly string[]) => boolean) {
    let reviewed = false;
    let reviewManually: (() => Promise<void>) | undefined;
    const consumed = await legacy.dispatch({
      ...event,
      approve(approve?: boolean, reason?: string) {
        reviewed = true;
        return event.approve(approve, reason);
      },
      deferManualReview(review: () => Promise<void>) {
        reviewManually = review;
      },
    }, allowed);
    if (reviewed || consumed || lifecycle.signal.aborted) return;

    const result = allowed(["invite"]) ? await reviewInvitation(event, lifecycle.signal) : "skip";
    if (result === "skip" || result === "rejected") {
      if (!lifecycle.signal.aborted) await reviewManually?.();
    } else if (result === "confirmed") {
      const group = event.group_name?.trim() || event.group_id;
      await event.replyToApplicant?.(`已同意加群：${group}`);
    } else if (result === "unknown") {
      const delivered = await event.notifyMasters(`群 ${event.group_id} 的邀请审批结果未确认，请先在 QQ 核对。`);
      if (delivered === 0) console.warn("[群邀请] 自动审批结果未确认，未能通知主人。");
    }
  }

  async function dispatchMessage(incoming: MessageEvent) {
    const { event, allowNew } = groupDispatch.prepare(incoming);
    const allowed = (names: readonly string[]) => groupDispatch.allows(event, names);
    if (matchesMasterEnrollment(event.msg)) {
      if (allowNew && allowed(["设置主人", "system", "@lotus-yunzai/system"])) await masterEnrollment(event);
      return;
    }
    if (await privateAccess.blocked(event)) return;
    if (await legacy.dispatchContext(event, allowed)) return;
    const useKeywords = allowed(keywordFeatureNames);
    if ((useKeywords && await keywords.continue(event)) || !allowNew) return;

    const command = normalizeGameCommand(event);
    const reply = await commands.dispatch(command.msg, command, allowed);
    if (reply !== undefined) {
      event.reply(reply);
      return;
    }
    if (await legacy.dispatch(command, allowed)) return;

    if (command.isMaster && command.recallReply && /^#?撤回$/u.test(command.msg) &&
        allowed(["回复撤回", "system", "@lotus-yunzai/system"])) {
      const results = await command.recallReply();
      const confirmed = results.filter((result) => result === "confirmed").length;
      if (!results.length) await command.reply("没有可撤回的消息。");
      else if (results.includes("unknown")) await command.reply(`已撤回 ${confirmed} 条，其余撤回结果未确认。`);
      else if (confirmed < results.length) await command.reply(`已撤回 ${confirmed} 条，其余消息未能撤回。`);
      return;
    }
    if (useKeywords) await keywords.dispatch(event);
  }

  const interrupt = () => stop(130);
  const terminate = () => stop(143);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    const [network, permissions, canRefresh, access, friendRequests, routing, invitations, botConfig] = await Promise.all([
      readServerSettings(root, Bun.env), readMasterPermissions(root), readAccountRefreshPermission(root),
      readPrivateAccess(root, async (userId) =>
        !globalThis.redis || await globalThis.redis.set(`Yz:disablePrivate:${userId}`, "1", { EX: 10, NX: true }) === "OK"),
      readFriendRequests(root),
      readGroupDispatch(root),
      readGroupInvitations(root),
      readLocalConfig(root, "bot"),
    ]);
    privateAccess = access;
    autoFriend = friendRequests;
    groupDispatch = routing;
    keywords = createKeywords(createKeywordStore(root), routing.keywordSettings, undefined, {
      async read(actor) {
        if (!globalThis.redis) return;
        const id = Number(await storage("keywords").get(`recent:${actor}`));
        if (Number.isSafeInteger(id) && id > 0) return id;
      },
      async write(actor, id) {
        if (globalThis.redis) await storage("keywords").set(`recent:${actor}`, String(id), 2_592_000);
      },
    });
    reviewInvitation = invitations;
    autoQuit = await readAutoQuit(root, permissions.masterIds, permissions.legacyMasterIds);
    masterEnrollment = createMasterEnrollment({
      isMaster: permissions.isMaster, masterIds: permissions.masterIds,
      isTerminalMaster: () => permissions.terminal, grant: permissions.grant,
    });
    const valkeyUrl = Bun.env.LOTUS_VALKEY_URL;
    const segmentCounts = botConfig.msg_type_count;
    counts = createMessageCounts(() => globalThis.redis, segmentCounts === true || segmentCounts === 1 || segmentCounts === "1");
    if (valkeyUrl !== undefined) {
      globalThis.redis = await connectStorage(valkeyUrl);
      console.log("[存储] Valkey 已连接。");
    }
    commands.registerModule(accountCommands(Bun.env.LOTUS_PROFILE_DIR || undefined, canRefresh));
    plugins = await loadPlugins(fileURLToPath(new URL("plugins", root)), commands, legacy, Object.freeze({
      groups: groups.transport(), signal: lifecycle.signal,
      messageStatistics: createMessageStatistics(counts),
    }));
    if (!stopping) {
      if (!commands.hasModule(systemModuleName)) {
        throw new Error("系统模块未加载，请先运行 bun scripts/bootstrap.ts。");
      }
      const { hostname, http, oneBot, panelToken } = network;
      const statusRoute = http && httpStatus(http.auth);
      const likes = panelGroupSettings(plugins.directories);
      const guoba = panelGuobaRoutes(plugins.directories);
      const extensions = panelToken === undefined ? undefined : panelExtensionRoutes(plugins.directories);
      const panel = panelToken === undefined ? undefined : panelApi(panelToken, plugins.records,
        (path) => path === "/panel/api/settings/group/likes" ? likes : guoba(path) ?? extensions?.api(path));
      const assets = panel && panelAssets(fileURLToPath(new URL("panel/dist", root)));
      const fetch = statusRoute && (async (request: Request) => stopping
        ? new Response(null, { status: 503 })
        : await panel?.(request) ?? await extensions?.assets(request) ?? await assets?.(request) ?? statusRoute(request));
      const shared = http !== undefined && oneBot !== undefined && http.port === oneBot.port;
      if (oneBot) {
        const server = startOneBot(dispatch, {
          hostname, ...oneBot, groups, isMaster: permissions.isMaster, masterIds: permissions.masterIds,
          onSent: valkeyUrl === undefined ? undefined : (identity, message) => recordCount("send", identity, message),
          http: shared ? fetch : undefined,
        });
        servers.push(server);
        console.log(`OneBot 11 正在监听 ${server.url.origin.replace(/^http/u, "ws")}/OneBotv11`);
        if (shared) console.log(`HTTP 正在监听 ${server.url.origin}/status`);
      }
      if (http && !shared && fetch) {
        const server = Bun.serve({ hostname, port: http.port, fetch });
        servers.push(server);
        console.log(`HTTP 正在监听 ${server.url.origin}/status`);
      }
      console.log("Lotus-Yunzai 已启动。输入 #状态 查询运行状态。");

      consoleInput = createInterface({ input: process.stdin, crlfDelay: Infinity });
      for await (const message of consoleInput) {
        if (stopping) break;
        const waiting = Promise.withResolvers<void>();
        const handling = dispatch({
          msg: message.trim(),
          raw_message: message,
          message,
          post_type: "message",
          message_type: "terminal",
          isGroup: false,
          isPrivate: false,
          isMaster: permissions.terminal,
          onAwaitInput: waiting.resolve,
          reply(text) {
            if (typeof text !== "string") return false;

            console.log(text);
            return true;
          },
        }).catch(() => {
          console.error("处理终端指令失败。");
        });
        await Promise.race([handling, waiting.promise]);
      }
      if (servers.length) await shutdown.promise;
    }
  } finally {
    stopping = true;
    lifecycle.abort();
    try {
      consoleInput?.close();
      legacy.stopContexts();
      await Promise.allSettled(pending);
      await plugins?.dispose();
    } finally {
      try {
        await Promise.all(servers.map((server) => server.stop(true)));
      } finally {
        try {
          await legacy.dispose();
        } finally {
          process.off("SIGINT", interrupt);
          process.off("SIGTERM", terminate);
          await Promise.allSettled(pendingCounts);
          globalThis.redis = undefined;
          await Promise.all([closeStorage(), stopStaticRenderer()]);
        }
      }
    }
  }
}
