import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { closeStorage, connectStorage, storage } from "@lotus-yunzai/storage";
import { accountCommands } from "./lib/account-commands.ts";
import { startOneBot } from "./lib/adapters/onebot.ts";
import { OneBotGroups } from "./lib/adapters/onebot-groups.ts";
import { readAutoQuit } from "./lib/auto-quit.ts";
import { normalizeGameCommand } from "./lib/command-prefix.ts";
import { CommandRegistry, type CommandContext } from "./lib/commands.ts";
import { readLocalConfig } from "./lib/config.ts";
import { createDispatchPower, formatElapsed } from "./lib/dispatch-power.ts";
import { scheduleDispatchPower } from "./lib/dispatch-power-schedule.ts";
import { readFriendRequests } from "./lib/friend-requests.ts";
import { readGroupDispatch } from "./lib/group-dispatch.ts";
import { readGroupInvitations } from "./lib/group-invitations.ts";
import { createKeywords } from "./lib/keywords.ts";
import { createKeywordStore } from "./lib/keyword-store.ts";
import { createLogCommand, isLogCommand } from "./lib/log-command.ts";
import { createManagedHandoff } from "./lib/managed-handoff.ts";
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
import { createProcessReceipts, type ProcessReceipt } from "./lib/process-receipts.ts";
import { canRestartHost, readRestartPausedAt, restartHost } from "./lib/process-restart.ts";
import { scheduleProcessRestart } from "./lib/process-restart-schedule.ts";
import { attachRuntimeLog } from "./lib/runtime-log-writer.ts";
import { readRuntimeLogs } from "./lib/runtime-logs.ts";
import { readRuntimeVersion } from "./lib/runtime-version.ts";
import { httpStatus, readServerSettings } from "./lib/server.ts";
import { createUpdateCommand, isUpdateCommand } from "./lib/update-command.ts";
import { readUpdateHistory } from "./lib/update-history.ts";
import { createUpdateLogCommand, isUpdateLogCommand } from "./lib/update-log-command.ts";

declare global {
  var redis: Awaited<ReturnType<typeof connectStorage>> | undefined;
}

const commands = new CommandRegistry();
const terminalOutput = console.log.bind(console);
const keywordFeatureNames = ["添加消息", "group", "@lotus-yunzai/group"];
const processFeatureNames = ["进程管理", "system", systemModuleName];
const updateFeatureNames = ["更新", "system", systemModuleName];

if (import.meta.main) {
  const handoff = createManagedHandoff();
  const legacy = new LegacyPlugins(() => handoff.accepting);
  const groups = new OneBotGroups();
  const pending = new Set<Promise<void>>();
  const pendingCounts = new Set<Promise<void>>();
  const shutdown = Promise.withResolvers<void>();
  const lifecycle = new AbortController();
  const restartPausedAt = readRestartPausedAt();
  const dispatchPower = createDispatchPower(Date.now, handoff.pausedAt ?? restartPausedAt);
  let plugins: PluginLoadReport | undefined;
  let stopPowerSchedule: (() => Promise<void>) | undefined;
  let stopRestartSchedule: (() => Promise<void>) | undefined;
  let stopping = false;
  let consoleInput: ReturnType<typeof createInterface> | undefined;
  const servers: Pick<ReturnType<typeof startOneBot>, "stop">[] = [];
  const root = new URL("./", import.meta.url);
  const processReceipts = createProcessReceipts(root);
  type ProcessAction = {
    readonly kind: "stop" | "restart";
    readonly at: number;
    readonly targets: readonly ProcessReceipt["target"][];
    readonly pausedAt?: number;
  };
  let processAction: ProcessAction | undefined;
  let masterPermissions: Awaited<ReturnType<typeof readMasterPermissions>>;
  let privateAccess: Awaited<ReturnType<typeof readPrivateAccess>>;
  let autoFriend: Awaited<ReturnType<typeof readFriendRequests>>;
  let groupDispatch: Awaited<ReturnType<typeof readGroupDispatch>>;
  let reviewInvitation: Awaited<ReturnType<typeof readGroupInvitations>>;
  let autoQuit: Awaited<ReturnType<typeof readAutoQuit>>;
  let masterEnrollment: ReturnType<typeof createMasterEnrollment>;
  let keywords: ReturnType<typeof createKeywords>;
  let counts: ReturnType<typeof createMessageCounts>;
  let runtimeLog: Awaited<ReturnType<typeof attachRuntimeLog>> | undefined;
  const logCommand = createLogCommand(async (kind, query) => {
    await runtimeLog?.flush();
    return readRuntimeLogs(root, kind, query);
  });
  const updateLogCommand = createUpdateLogCommand((requested) =>
    plugins ? readUpdateHistory(root, plugins.directories, requested) : Promise.resolve(undefined));
  const updateCommand = createUpdateCommand((event, requested, quiet, report, all) => {
    const target = sessionTarget(event);
    if (!target || !plugins) return false;
    const directories = [...plugins.directories].map(([name, metadata]) => ({ name, ...metadata }));
    return handoff.update({ requested, ...(all ? { all: true } : {}), quiet, target, directories }, report);
  });

  function stop(code: number) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    lifecycle.abort();
    handoff.cancelUpdate();
    void stopPowerSchedule?.();
    void stopRestartSchedule?.();
    void legacy.stopTasks();
    legacy.stopContexts();
    consoleInput?.close();
    shutdown.resolve();
  }
  const stopOnDisconnect = handoff.onDisconnect(() => stop(143));

  async function sendProcessMessage(target: ProcessReceipt["target"], message: string): Promise<boolean> {
    try {
      if (target.type === "terminal") {
        terminalOutput(message);
        return true;
      }
      if (target.type === "private") return await groups.sendPrivate(target.botId, target.id, message);
      if (target.type === "masters") {
        const outcomes = await Promise.allSettled(masterPermissions.masterIds(target.botId)
          .filter((user) => user !== target.botId)
          .map((user) => groups.sendPrivate(target.botId, user, message)));
        return outcomes.every((result) => result.status === "fulfilled" && result.value);
      }
      await groups.sendGroup(target.botId, target.id, message);
      return true;
    } catch {
      return false;
    }
  }

  async function deliverProcessReceipt(botId?: number, update = false) {
    try {
      const receipt = await processReceipts.take(botId, update);
      if (!receipt) return;
      const elapsed = formatElapsed(Date.now() - receipt.at);
      let reply: string;
      if (receipt.kind === "update") {
        if (receipt.result === "rolled-back") reply = "更新失败，已恢复旧版本。";
        else if (receipt.repositories !== undefined) {
          reply = `更新成功，本次更新 ${receipt.repositories} 个仓库，宿主提交 ${receipt.revision.slice(0, 12)}`;
        } else {
          reply = `更新成功，提交 ${receipt.revision.slice(0, 12)}`;
        }
      } else {
        reply = receipt.kind === "restart" ? `重启成功，用时${elapsed}` : `开机成功，距离上次停止${elapsed}`;
      }
      if (!await sendProcessMessage(receipt.target, reply)) console.warn("[进程管理] 未确认进程操作回执。");
    } catch {
      console.warn("[进程管理] 无法读取进程操作回执。");
    }
  }

  function queueProcessReceipt(botId?: number) {
    if (stopping) return;
    const delivery = Promise.all([deliverProcessReceipt(botId), deliverProcessReceipt(botId, true)]).then(() => undefined);
    pending.add(delivery);
    void delivery.then(() => pending.delete(delivery));
  }

  function sessionTarget(event: MessageEvent): Exclude<ProcessReceipt["target"], { type: "masters" }> | undefined {
    const type = event.message_type;
    if (type === "terminal") return { type };
    const id = type === "group" ? event.group_id : event.user_id;
    const botId = event.self_id;
    if (event.boundAccount === true && botId && id) return { type, botId, id };
  }

  async function controlProcess(event: MessageEvent, kind: ProcessAction["kind"]) {
    if (!event.isMaster) {
      await event.reply("暂无权限，只有主人才能操作");
      return;
    }
    const target = sessionTarget(event);
    if (!target) return;
    if (processAction) return;
    if (kind === "restart" && !handoff.managed && !canRestartHost()) {
      await event.reply("当前运行环境不支持进程内重启。");
      return;
    }

    await startProcessAction(kind, [target]);
  }

  async function startProcessAction(kind: ProcessAction["kind"], targets: readonly ProcessReceipt["target"][]) {
    if (stopping || processAction) return;
    const pausedAt = dispatchPower.pausedAt;
    processAction = { kind, at: Date.now(), targets: pausedAt === undefined ? targets : [], pausedAt };
    if (pausedAt === undefined) {
      const elapsed = formatElapsed(process.uptime() * 1000);
      const operation = kind === "restart" ? "重启" : "停止";
      const online = new Set(groups.onlineBots());
      const outcomes = await Promise.all(targets
        .filter((target) => target.type !== "masters" || online.has(target.botId))
        .map((target) => sendProcessMessage(target, `开始${operation}，本次运行时长${elapsed}`)));
      if (outcomes.includes(false)) console.warn("[进程管理] 未确认进程操作开始通知。");
    }
    const currentPause = dispatchPower.pausedAt;
    if (kind === "restart" && currentPause !== pausedAt) {
      processAction = { ...processAction, targets: currentPause === undefined ? targets : [], pausedAt: currentPause };
    }
    stop(0);
  }

  async function dispatch(event: BotEvent) {
    if (stopping || !handoff.accepting) return;
    if (event.post_type !== "message" || event.message_type !== "terminal") {
      recordCount("receive", event, event.post_type === "message" ? event.message : undefined);
    }
    if (!groupDispatch.admit(event)) return;
    if (dispatchPower.paused && event.post_type !== "message") return;
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
    if (dispatchPower.paused) {
      if (allowNew && event.msg === "#开机" && allowed(["开机", "system", systemModuleName])) {
        await dispatchPower.handle(event);
      }
      return;
    }
    if (allowNew && event.msg === "#关机" && allowed(processFeatureNames)) {
      if (event.isMaster) await dispatchPower.handle(event);
      else await event.reply("暂无权限，只有主人才能操作");
      return;
    }
    if (allowNew && /^#(?:重启|停机|停止)$/u.test(event.msg) && allowed(processFeatureNames)) {
      await controlProcess(event, event.msg === "#重启" ? "restart" : "stop");
      return;
    }
    if (matchesMasterEnrollment(event.msg)) {
      if (allowNew && allowed(["设置主人", "system", "@lotus-yunzai/system"])) await masterEnrollment(event);
      return;
    }
    if (await privateAccess.blocked(event)) return;
    if (await legacy.dispatchContext(event, allowed)) return;
    const useKeywords = allowed(keywordFeatureNames);
    if ((useKeywords && await keywords.continue(event)) || !allowNew) return;

    const command = normalizeGameCommand(event);
    if (isUpdateLogCommand(command.msg)) {
      if (allowed(updateFeatureNames)) await updateLogCommand(command);
      return;
    }
    if (isUpdateCommand(command.msg)) {
      if (allowed(updateFeatureNames)) await updateCommand(command);
      return;
    }
    if (isLogCommand(command.msg)) {
      if (allowed(["发送日志", "system", "@lotus-yunzai/system"])) await logCommand(command);
      return;
    }
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
  if (handoff.managed) {
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
  } else {
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
  }
  try {
    const [network, permissions, canRefresh, access, friendRequests, routing, invitations, botConfig, runtimeVersion] = await Promise.all([
      readServerSettings(root, Bun.env), readMasterPermissions(root), readAccountRefreshPermission(root),
      readPrivateAccess(root, async (userId) =>
        !globalThis.redis || await globalThis.redis.set(`Yz:disablePrivate:${userId}`, "1", { EX: 10, NX: true }) === "OK"),
      readFriendRequests(root),
      readGroupDispatch(root),
      readGroupInvitations(root),
      readLocalConfig(root, "bot"),
      readRuntimeVersion(root),
    ]);
    masterPermissions = permissions;
    privateAccess = access;
    try {
      runtimeLog = await attachRuntimeLog(root, botConfig);
    } catch {
      console.warn("[日志] 无法启用本地日志写入。");
    }
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
      runtimeVersion,
      runtimeDiagnostics(context: CommandContext) {
        if (!context.isMaster) return { accounts: [], plugins: [] };
        const accounts = groups.onlineAccounts();
        return {
          accounts: context.message_type === "terminal" ? accounts : accounts.filter(({ id }) => id === context.self_id),
          plugins: plugins?.timings ?? [],
        };
      },
    }));
    if (!stopping) {
      if (!commands.hasModule(systemModuleName)) {
        throw new Error("系统模块未加载，请先运行 bun scripts/bootstrap.ts。");
      }
      const { hostname, http, oneBot, panelToken } = network;
      const statusRoute = http && httpStatus(http.auth, runtimeVersion);
      const likes = panelGroupSettings(plugins.directories);
      const guoba = panelGuobaRoutes(plugins.directories);
      const extensions = panelToken === undefined ? undefined : panelExtensionRoutes(plugins.directories);
      const panel = panelToken === undefined ? undefined : panelApi(panelToken, plugins.records,
        (path) => path === "/panel/api/settings/group/likes" ? likes : guoba(path) ?? extensions?.api(path), runtimeVersion);
      const assets = panel && panelAssets(fileURLToPath(new URL("panel/dist", root)));
      const fetch = statusRoute && (async (request: Request) => stopping || !handoff.accepting
        ? new Response(null, { status: 503 })
        : await panel?.(request) ?? await extensions?.assets(request) ?? await assets?.(request) ?? statusRoute(request));
      const shared = http !== undefined && oneBot !== undefined && http.port === oneBot.port;
      if (oneBot) {
        const server = startOneBot(dispatch, {
          hostname, ...oneBot, groups, isMaster: permissions.isMaster, masterIds: permissions.masterIds,
          accepting: () => !stopping && handoff.accepting,
          onBind: queueProcessReceipt,
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
      await handoff.ready(runtimeVersion.revision, lifecycle.signal, [...plugins.directories.keys()]);
      stopPowerSchedule = scheduleDispatchPower(botConfig, async (paused) => {
        if (stopping) return;
        const reply = dispatchPower.setPaused(paused);
        if (reply === undefined) return;
        console.log(`[进程管理] ${reply}`);
        const notifications = await Promise.all(groups.onlineBots()
          .map((botId) => sendProcessMessage({ type: "masters", botId }, reply)));
        if (notifications.includes(false)) {
          console.warn("[进程管理] 部分主人未收到定时开关机通知。");
        }
      });
      if (handoff.managed || canRestartHost()) {
        stopRestartSchedule = scheduleProcessRestart(botConfig, () => {
          const targets: ProcessReceipt["target"][] = permissions.botIds().map((botId) => ({ type: "masters", botId }));
          if (permissions.terminal) targets.push({ type: "terminal" });
          return startProcessAction("restart", targets);
        });
      } else if (botConfig.restart_time || botConfig.restart_cron) {
        console.warn("[进程管理] 当前运行环境不支持定时重启。");
      }
      console.log("Lotus-Yunzai 已启动。输入 #状态 查询运行状态。");
      queueProcessReceipt();

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

            terminalOutput(text);
            return true;
          },
        }).catch(() => {
          console.error("处理终端指令失败。");
        });
        await Promise.race([handling, waiting.promise]);
      }
      if (servers.length) await shutdown.promise;
    }
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    stopping = true;
    lifecycle.abort();
    handoff.cancelUpdate();
    try {
      consoleInput?.close();
      legacy.stopContexts();
      await Promise.allSettled([...pending, stopPowerSchedule?.(), stopRestartSchedule?.()]);
      await plugins?.dispose();
    } finally {
      try {
        await Promise.all(servers.map((server) => server.stop(true)));
      } finally {
        try {
          await legacy.dispose();
        } finally {
          try {
            await Promise.allSettled(pendingCounts);
            globalThis.redis = undefined;
            try {
              await Promise.all([closeStorage(), stopStaticRenderer()]);
            } finally {
              await runtimeLog?.close();
            }
          } finally {
            process.off("SIGINT", interrupt);
            process.off("SIGTERM", terminate);
            stopOnDisconnect();
          }
        }
      }
    }
  }
  if (processAction && process.exitCode === 0) {
    const { kind, at, targets, pausedAt } = processAction;
    const saved = await Promise.allSettled(targets.map((target) => processReceipts.save({ kind, at, target })));
    if (saved.some((result) => result.status === "rejected")) {
      console.warn("[进程管理] 无法保存进程操作回执。");
    }
    if (kind === "restart") {
      try {
        if (handoff.managed) {
          if (!handoff.restart(pausedAt)) throw new Error("托管宿主未接受重启。");
        } else {
          restartHost(pausedAt);
        }
      } catch {
        await Promise.allSettled(targets.map((target, index) => {
          if (saved[index]?.status === "fulfilled") {
            return processReceipts.discard(target.type === "terminal" ? undefined : target.botId);
          }
        }));
        console.error("[进程管理] 无法重新启动宿主。");
        process.exitCode = 1;
      }
    }
  }
}
