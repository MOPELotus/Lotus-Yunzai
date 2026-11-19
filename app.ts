import { createInterface } from "node:readline";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createProfileStore } from "@lotus-yunzai/account";
import { bbsCheckinForums, isZzzGachaLinkMessage, type BbsCheckinForum } from "@lotus-yunzai/hoyo-client";
import { closeStorage, connectStorage, storage } from "@lotus-yunzai/storage";
import { accountCommands } from "./lib/account-commands.ts";
import { cloudProfileCommands, isCloudTokenInput } from "./lib/cloud-profile-commands.ts";
import { createCheckinAudit } from "./lib/checkin-audit.ts";
import { checkinAuditCommands } from "./lib/checkin-audit-commands.ts";
import { notifyCheckin, type CheckinNotifyTransport } from "./lib/checkin-notify.ts";
import { checkinPlanCommands, checkinPlanNotice, checkinScheduleSettingCommands } from "./lib/checkin-plan-commands.ts";
import { checkinProfileCommands } from "./lib/checkin-profile-commands.ts";
import { checkinRosterCommands } from "./lib/checkin-roster-commands.ts";
import { checkinGroupRegistrationCommands } from "./lib/checkin-group-registration-commands.ts";
import { checkinBatchRefreshCommands } from "./lib/checkin-batch-refresh-commands.ts";
import { checkinRegistrationCommands } from "./lib/checkin-registration-commands.ts";
import { createCheckinScheduleRuntime } from "./lib/checkin-schedule-runtime.ts";
import { createCheckinScheduleStore } from "./lib/checkin-schedule-store.ts";
import { checkinScheduleClock, type CheckinScheduleConfig } from "./lib/checkin-schedule-plan.ts";
import { gameCheckinCommands } from "./lib/game-checkin-commands.ts";
import { redeemCodeCommands } from "./lib/redeem-code-commands.ts";
import { readMilkySettings } from "./lib/adapters/milky-config.ts";
import { createMilkyGroupReviews } from "./lib/adapters/milky-group-reviews.ts";
import type { MilkySession, MilkyTransportOptions } from "./lib/adapters/milky-session.ts";
import { createMilkyWebhook } from "./lib/adapters/milky-webhook.ts";
import { createMilkyWs } from "./lib/adapters/milky-ws.ts";
import { startOneBot } from "./lib/adapters/onebot.ts";
import { OneBotGroups } from "./lib/adapters/onebot-groups.ts";
import { readAutoQuit } from "./lib/auto-quit.ts";
import { normalizeGameCommand } from "./lib/command-prefix.ts";
import { isMilkyOwnerSession } from "./lib/command-permissions.ts";
import { CommandRegistry, sendCommandReply, type CommandContext } from "./lib/commands.ts";
import { readLocalConfig } from "./lib/config.ts";
import { dailyNoteCommands } from "./lib/daily-note.ts";
import { deviceCommands, isDeviceBindingInput } from "./lib/device-commands.ts";
import { createDispatchPower, formatElapsed, isProcessMaster } from "./lib/dispatch-power.ts";
import { scheduleDispatchPower } from "./lib/dispatch-power-schedule.ts";
import { createFileToUrl, listenerFileBase } from "./lib/file-to-url.ts";
import { lockFile } from "./lib/file-lock.ts";
import { readFriendRequests } from "./lib/friend-requests.ts";
import { createGachaBatch } from "./lib/gacha-batch.ts";
import { hoyoLabProfileCommands, isHoYoLabCookieInput } from "./lib/hoyolab-profile-commands.ts";
import { readGroupDispatch } from "./lib/group-dispatch.ts";
import { readGroupInvitations } from "./lib/group-invitations.ts";
import { createKeywords } from "./lib/keywords.ts";
import { createKeywordStore } from "./lib/keyword-store.ts";
import { createLogCommand, isLogCommand } from "./lib/log-command.ts";
import { createManagedHandoff } from "./lib/managed-handoff.ts";
import { installRejection, readInstallCatalog } from "./lib/install-catalog.ts";
import { createInstallCommand, hasValidInstallTarget, isInstallCommand, parseInstallName } from "./lib/install-command.ts";
import { isTerminalManagedUpdateProgress, managedUpdateScheduledBotLimit, type ManagedUpdateProgress } from "./lib/managed-update-protocol.ts";
import { createMasterEnrollment, matchesMasterEnrollment } from "./lib/master-enrollment.ts";
import { createMessageCounts } from "./lib/message-counts.ts";
import { createMessageStatistics } from "./lib/message-statistics.ts";
import type { BotEvent, GroupRequest, MessageEvent, MessageReply } from "./lib/messages.ts";
import { notifyOnlineMasters, onlineNoticeSeconds } from "./lib/online-notice.ts";
import { panelApi, panelAssets } from "./lib/panel.ts";
import { panelExtensionRoutes } from "./lib/panel-extension-routes.ts";
import { panelGroupSettings } from "./lib/panel-group.ts";
import { panelGuobaRoutes } from "./lib/panel-guoba-routes.ts";
import { isPassportLoginInput, passportLoginCommands } from "./lib/passport-login.ts";
import { createPluginLoadingReporter, parsePluginLoadMilliseconds, pluginProbeTokenEnvironment } from "./lib/plugin-load-progress.ts";
import { LegacyPlugins } from "./lib/plugins/legacy.ts";
import { loadPlugins, systemModuleName, type PluginLoadReport } from "./lib/plugins/loader.ts";
import { stopStaticRenderer } from "./lib/renderer/shotium.ts";
import { readAccountRefreshPermission, readAccountScopePermission, readMasterPermissions } from "./lib/permissions.ts";
import { readPrivateAccess, zzzLinkEntry } from "./lib/private-access.ts";
import { createProcessReceipts, type ProcessReceipt } from "./lib/process-receipts.ts";
import { createPublicFiles } from "./lib/public-files.ts";
import { createMediaDelivery, sendSessionMedia, type MediaDelivery } from "./lib/media-delivery.ts";
import { createMiyousheOverview } from "./lib/miyoushe-overview.ts";
import { createMiyousheWeb } from "./lib/miyoushe-web.ts";
import { canRestartHost, readRestartPausedAt, restartHost } from "./lib/process-restart.ts";
import { scheduleProcessRestart } from "./lib/process-restart-schedule.ts";
import { attachRuntimeLog } from "./lib/runtime-log-writer.ts";
import { readRuntimeLogs } from "./lib/runtime-logs.ts";
import { readRuntimeVersion } from "./lib/runtime-version.ts";
import { createServerRedirect } from "./lib/server-redirect.ts";
import { httpStatus, readServerSettings } from "./lib/server.ts";
import { createTerminalReply } from "./lib/terminal-reply.ts";
import { createUpdateCommand, describeUpdateProgress, hasValidUpdateTarget, isUpdateCommand } from "./lib/update-command.ts";
import { readUpdateHistory } from "./lib/update-history.ts";
import { createUpdateLogCommand, isUpdateLogCommand } from "./lib/update-log-command.ts";
import { scheduleUpdates } from "./lib/update-schedule.ts";
import { readStorageConnection } from "./lib/valkey-config.ts";

declare global {
  var redis: Awaited<ReturnType<typeof connectStorage>> | undefined;
}

const commands = new CommandRegistry();
const terminalOutput = console.log.bind(console);
const keywordFeatureNames = ["添加消息", "group", "@lotus-yunzai/group"];
const processFeatureNames = ["进程管理", "system", systemModuleName];
const updateFeatureNames = ["更新", "system", systemModuleName];
const installFeatureNames = ["安装插件", "system", systemModuleName];
const recallFeatureNames = ["回复撤回", "system", systemModuleName];

function isRecallCommand(event: MessageEvent): event is MessageEvent & Required<Pick<MessageEvent, "recallReply">> {
  return isProcessMaster(event) && event.recallReply !== undefined && /^#?撤回$/u.test(event.msg);
}

if (import.meta.main) {
  const probingUpdate = process.env[pluginProbeTokenEnvironment] !== undefined;
  const reportLoading = createPluginLoadingReporter();
  const handoff = createManagedHandoff();
  const legacy = new LegacyPlugins(() => handoff.accepting);
  const publicFiles = createPublicFiles();
  let fileBase: URL | undefined;
  const groups = new OneBotGroups();
  const pending = new Set<Promise<void>>();
  const boundDeliveries = new Map<string, Promise<void>>();
  const pendingCounts = new Set<Promise<void>>();
  const shutdown = Promise.withResolvers<void>();
  const lifecycle = new AbortController();
  const gachaBatch = createGachaBatch({
    listIds: createProfileStore(Bun.env.LOTUS_PROFILE_DIR || undefined).listIds,
    signal: lifecycle.signal,
  });
  const restartPausedAt = readRestartPausedAt();
  const dispatchPower = createDispatchPower(Date.now, handoff.pausedAt ?? restartPausedAt);
  let plugins: PluginLoadReport | undefined;
  let stopPowerSchedule: (() => Promise<void>) | undefined;
  let stopRestartSchedule: (() => Promise<void>) | undefined;
  let stopUpdateSchedule: (() => Promise<void>) | undefined;
  let stopMilky: (() => Promise<void>) | undefined;
  let checkinRuntime: ReturnType<typeof createCheckinScheduleRuntime> | undefined;
  let manualCaptcha: ReturnType<typeof import("./lib/captcha/manual-relay.ts").createManualCaptchaRelay> | undefined;
  let miyousheWeb: ReturnType<typeof createMiyousheWeb> | undefined;
  let milkyOnline: { id: number; startedAt: number; signal: AbortSignal; send: MilkySession["send"];
    checkinNotify?: CheckinNotifyTransport } | undefined;
  let stopping = false;
  let consoleInput: ReturnType<typeof createInterface> | undefined;
  const servers: Pick<ReturnType<typeof startOneBot>, "stop">[] = [];
  const root = new URL("./", import.meta.url);
  const mediaDelivery = createMediaDelivery(fileURLToPath(new URL("data", root)), () => stopping ? undefined : fileBase);
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
  let onlineCooldown: number | undefined;
  let onlineVersion: string | undefined;
  let runtimeLog: Awaited<ReturnType<typeof attachRuntimeLog>> | undefined;
  const logCommand = createLogCommand(async (kind, query) => {
    await runtimeLog?.flush();
    return readRuntimeLogs(root, kind, query);
  });
  const updateLogCommand = createUpdateLogCommand((requested) =>
    plugins ? readUpdateHistory(root, plugins.directories, requested) : Promise.resolve(undefined));
  const updateCommand = createUpdateCommand(async (event, requested, quiet, report, all, force) => {
    const target = sessionTarget(event);
    if (!target || !plugins) return false;
    if (await reportOldMilkySupervisor(event)) return true;
    return handoff.update({
      requested, ...(all ? { all: true } : {}), ...(force ? { force: true } : {}), quiet, target,
      directories: updateDirectories(),
    }, report);
  });
  const installCommand = createInstallCommand({
    async list() {
      const catalog = await readInstallCatalog(root);
      const occupied = new Set(await readdir(new URL("plugins/", root)));
      return catalog.list.flatMap(({ name, approved }) => {
        const target = approved ? catalog.resolve(name) : undefined;
        return target && !occupied.has(target.directory) && !installRejection(target.url, target.directory, target.name) ? [name] : [];
      });
    },
    async install(event, name, report) {
      const target = sessionTarget(event);
      if (!target || !plugins) return false;
      const catalog = await readInstallCatalog(root);
      const approved = catalog.resolve(name);
      const legacy = catalog.list.find((entry) => parseInstallName(entry.name) === name);
      const rejection = approved ? installRejection(approved.url, approved.directory, approved.name) :
        legacy && installRejection(legacy.url, legacy.name);
      if (rejection) {
        await event.reply(rejection);
        return true;
      }
      if (!approved) {
        report("unavailable");
        return true;
      }
      if (await reportOldMilkySupervisor(event)) return true;
      return handoff.update({ install: name, quiet: false, target, directories: updateDirectories() }, (status) => {
        if (status === "current") report("exists");
        else if (status !== "dirty" && status !== "ahead" && status !== "diverged") report(status);
        else report("failed");
      });
    },
  });

  async function reportOldMilkySupervisor(event: MessageEvent): Promise<boolean> {
    if (event.adapter !== "milky" || !handoff.managed || handoff.supportsAdapterReceipts) return false;
    await event.reply("当前托管器版本不支持 Milky 更新或安装。请在终端重启 bun scripts/run-managed.ts 后重试。");
    return true;
  }

  function updateDirectories() {
    return [...plugins?.directories ?? []].map(([name, metadata]) => ({ name, ...metadata }));
  }

  async function requestScheduledUpdate() {
    if (stopping || !plugins) return;
    const signal = lifecycle.signal;
    const targets = processOwnerTargets(masterPermissions.botIds().slice(0, managedUpdateScheduledBotLimit));
    const botIds = targets.filter((target) => target.adapter === undefined).map((target) => target.botId);
    const milkyBotIds = targets.filter((target) => target.adapter === "milky").map((target) => target.botId);
    const terminal = masterPermissions.terminal;
    const progress = Promise.withResolvers<ManagedUpdateProgress | undefined>();
    const abort = () => progress.resolve(undefined);
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (!handoff.update({
        all: true, quiet: true,
        target: { type: "scheduled", botIds, terminal, ...(milkyBotIds.length ? { milkyBotIds } : {}) },
        directories: updateDirectories(),
      }, (status) => { if (isTerminalManagedUpdateProgress(status)) progress.resolve(status); })) {
        progress.resolve("unavailable");
      }
      const result = await progress.promise;
      if (!result || result === "current" || result === "switching" || signal.aborted) return;
      const reply = `定时更新未完成。${describeUpdateProgress(result)}`;
      if (terminal) terminalOutput(reply);
      else console.warn(`[更新] ${reply}`);
      await Promise.all(targets.map((target) => sendProcessMessage(target, reply)));
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  function stop(code: number) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    handoff.reportPower(dispatchPower.pausedAt);
    lifecycle.abort();
    handoff.cancelUpdate();
    void stopPowerSchedule?.();
    void stopRestartSchedule?.();
    void stopUpdateSchedule?.();
    void legacy.stopTasks();
    legacy.stopContexts();
    consoleInput?.close();
    shutdown.resolve();
  }
  const stopOnDisconnect = handoff.onDisconnect(() => stop(143));

  async function sendProcessMessage(target: ProcessReceipt["target"], message: string, signal?: AbortSignal): Promise<boolean> {
    try {
      if (signal?.aborted) return false;
      if (target.type === "terminal") {
        terminalOutput(message);
        return true;
      }
      if (target.adapter === "milky") {
        const online = milkyOnline;
        if (!online || online.id !== target.botId || online.signal.aborted || (signal && signal !== online.signal)) return false;
        if (target.type === "masters") {
          const outcomes = await Promise.allSettled(masterPermissions.masterIds(target.botId)
            .filter((user_id) => user_id !== target.botId)
            .map((user_id) => online.send({ user_id }, message)));
          return outcomes.every((outcome) => outcome.status === "fulfilled" && outcome.value);
        }
        return await online.send(target.type === "private" ? { user_id: target.id } : { group_id: target.id }, message);
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

  async function deliverProcessReceipt(botId?: number, update: boolean | "install" = false, adapter?: "milky", signal?: AbortSignal) {
    try {
      if (signal?.aborted) return;
      const take = update === "install" ? processReceipts.takeInstall : update ? processReceipts.takeUpdate : processReceipts.take;
      const receipt = await take(botId, adapter);
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
        if (receipt.result === "updated" && receipt.preserved) reply += "。原工作区已保留，位置见宿主日志。";
      } else if (receipt.kind === "install") {
        reply = receipt.result === "rolled-back" ? `安装 ${receipt.name} 失败，已恢复旧版本。` :
          `安装 ${receipt.name} 成功，提交 ${receipt.revision.slice(0, 12)}。`;
      } else {
        reply = receipt.kind === "restart" ? `重启成功，用时${elapsed}` : `开机成功，距离上次停止${elapsed}`;
      }
      if (!await sendProcessMessage(receipt.target, reply, signal)) console.warn("[进程管理] 未确认进程操作回执。");
    } catch {
      console.warn("[进程管理] 无法读取进程操作回执。");
    }
  }

  function queueStartupMessages(botId?: number, adapter?: "milky", signal?: AbortSignal) {
    if (stopping) return;
    const key = botId === undefined ? undefined : `${adapter ?? "onebot"}:${botId}`;
    const previous = key === undefined ? undefined : boundDeliveries.get(key);
    const delivery = (previous ?? Promise.resolve()).then(async () => {
      if (stopping || signal?.aborted) return;
      await Promise.all([
        deliverProcessReceipt(botId, false, adapter, signal),
        deliverProcessReceipt(botId, true, adapter, signal),
        deliverProcessReceipt(botId, "install", adapter, signal),
      ]);
      if (botId === undefined) return;
      await notifyOnlineMasters(botId, onlineCooldown, {
        signal: signal ?? lifecycle.signal,
        version: onlineVersion,
        masterIds: (id) => masterPermissions.masterIds(id),
        async claim(id, seconds) {
          const redis = globalThis.redis;
          return redis?.isReady === true && await redis.set(`Yz:loginMsg:${id}`, "1", { NX: true, EX: seconds }) === "OK";
        },
        send: (botId, id, message) => sendProcessMessage({ type: "private", botId, id, adapter }, message, signal),
      });
    });
    if (key !== undefined) boundDeliveries.set(key, delivery);
    pending.add(delivery);
    const finished = () => {
      pending.delete(delivery);
      if (key !== undefined && boundDeliveries.get(key) === delivery) boundDeliveries.delete(key);
    };
    void delivery.then(finished, finished);
  }

  function sessionTarget(event: MessageEvent): Exclude<ProcessReceipt["target"], { type: "masters" }> | undefined {
    const type = event.message_type;
    if (type === "terminal") return { type };
    const id = type === "group" ? event.group_id : event.user_id;
    const botId = event.self_id;
    if (event.adapter === "milky") {
      if (isMilkyOwnerSession(event) && botId && id) return { type, botId, id, adapter: "milky" };
      return;
    }
    if (event.boundAccount === true && botId && id) return { type, botId, id };
  }

  type OwnerTarget = Extract<ProcessReceipt["target"], { type: "masters" }>;

  function onlineMilkyBotId() {
    return milkyOnline?.signal.aborted === false ? milkyOnline.id : undefined;
  }

  function processOwnerTargets(botIds?: readonly number[]): OwnerTarget[] {
    const oneBot = new Set(groups.onlineBots());
    const milky = onlineMilkyBotId();
    const milkyOnly = milky !== undefined && !oneBot.has(milky) ? milky : undefined;
    const recipients = botIds ?? (milkyOnly === undefined ? [...oneBot] : [...oneBot, milkyOnly]);
    return recipients.map((botId) => botId === milkyOnly
      ? { type: "masters", botId, adapter: "milky" }
      : { type: "masters", botId });
  }

  async function controlProcess(event: MessageEvent, kind: ProcessAction["kind"]) {
    if (!isProcessMaster(event)) {
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
      const milky = onlineMilkyBotId();
      const outcomes = await Promise.all(targets
        .filter((target) => target.type !== "masters" ||
          (target.adapter === "milky" ? target.botId === milky : online.has(target.botId)))
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
      if (isProcessMaster(event)) await dispatchPower.handle(event);
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
    if (privateAccess.disabled && event.message_type === "private" && isMilkyOwnerSession(event)) {
      if (hasValidUpdateTarget(event.msg)) {
        if (allowNew && allowed(updateFeatureNames)) await updateCommand(event);
        return;
      }
      if (hasValidInstallTarget(event.msg)) {
        if (allowNew && allowed(installFeatureNames)) await installCommand(event);
        return;
      }
    }
    const milkyPrivate = event.adapter === "milky" && event.message_type === "private";
    const milkyDiagnostics = milkyPrivate && (event.msg === "#诊断" || event.msg === "#状态") &&
      isMilkyOwnerSession(event) && onlineMilkyBotId() === event.self_id;
    const originalMessage = [event.msg, event.raw_message];
    const protectedModule = originalMessage.some(isCloudTokenInput) ? "@lotus-yunzai/cloud-profile"
      : originalMessage.some(isHoYoLabCookieInput) ? "@lotus-yunzai/hoyolab-profile" : isPassportLoginInput(event.msg) ? "@lotus-yunzai/passport-login"
      : isDeviceBindingInput(event.msg) ? "@lotus-yunzai/device" : undefined;
    if (protectedModule) {
      if (allowNew) {
        const reply = await commands.dispatchFallback(event, (names) => names[0] === protectedModule && allowed(names),
          (userId) => event.self_id !== undefined && masterPermissions.isMaster(event.self_id, userId));
        if (reply !== undefined) await sendCommandReply(event, reply);
      }
      return;
    }
    const tuningLink = isZzzGachaLinkMessage(event.msg);
    const tuningLinkEntry = zzzLinkEntry.test(event.msg);
    if (tuningLink || tuningLinkEntry || (event.isPrivate && event.msg.trim() === "取消")) {
      // Give credential-bearing links only to the native handler, before V3 contexts and other fallbacks.
      if (allowNew && (event.isPrivate || tuningLinkEntry)) {
        const reply = await commands.dispatchFallback(event, (names) => names[0] === "@lotus-yunzai/zzz" && allowed(names),
          (userId) => event.self_id !== undefined && masterPermissions.isMaster(event.self_id, userId),
          tuningLinkEntry ? event.msg.replace(zzzLinkEntry, "#绝区零$1") : event.msg);
        if (reply !== undefined) {
          await sendCommandReply(event, reply);
          return;
        }
      }
      if (tuningLink || tuningLinkEntry) return;
    }
    if (event.isPrivate && event.msg.trim() === "取消") {
      const reply = await commands.dispatchFallback(event, (names) => names[0] === "@lotus-yunzai/device" && allowed(names),
        (userId) => event.self_id !== undefined && masterPermissions.isMaster(event.self_id, userId));
      if (reply !== undefined) {
        await sendCommandReply(event, reply);
        return;
      }
    }
    if (await privateAccess.blocked(event)) return;
    if (event.attachmentOnly || (!allowNew && event.attachment && !event.msg)) {
      if (event.attachment) {
        const { self_id } = event;
        const reply = await commands.dispatchFallback(event, allowed, (userId) =>
          self_id !== undefined && masterPermissions.isMaster(self_id, userId));
        if (reply !== undefined) await sendCommandReply(event, reply);
      }
      return;
    }
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
    const context: CommandContext = milkyDiagnostics ? { ...command, runtimeDiagnosticsScope: "milky" } : command;
    const reply = await commands.dispatch(command.msg, context, allowed);
    if (reply !== undefined) {
      await sendCommandReply(event, reply);
      return;
    }
    const { self_id } = event;
    const isBotMaster = (userId: number) => self_id !== undefined && masterPermissions.isMaster(self_id, userId);
    const redeemReply = await commands.dispatchFallback(event,
      (names) => names[0] === "@lotus-yunzai/redeem-codes" && allowed(names), isBotMaster, command.msg);
    if (redeemReply !== undefined) {
      await sendCommandReply(event, redeemReply);
      return;
    }
    const sendMedia = command[sendSessionMedia];
    if (sendMedia) Object.defineProperty(command, "deliverMedia", {
      value: (file: MediaDelivery) => mediaDelivery.deliver(file, sendMedia),
    });
    if (await legacy.dispatch(command, allowed)) return;

    if (isInstallCommand(command.msg)) {
      if (allowed(installFeatureNames)) await installCommand(command);
      return;
    }

    if (isRecallCommand(command) && allowed(recallFeatureNames)) {
      const results = await command.recallReply();
      if (results === undefined) return;
      const confirmed = results.filter((result) => result === "confirmed").length;
      if (!results.length) await command.reply("没有可撤回的消息。");
      else if (results.includes("unknown")) await command.reply(`已撤回 ${confirmed} 条，其余撤回结果未确认。`);
      else if (confirmed < results.length) await command.reply(`已撤回 ${confirmed} 条，其余消息未能撤回。`);
      return;
    }
    const fallback = await commands.dispatchFallback(event,
      (names) => names[0] !== "@lotus-yunzai/redeem-codes" && allowed(names), isBotMaster, command.msg);
    if (fallback !== undefined) {
      await sendCommandReply(event, fallback);
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
    const [network, permissions, canRefresh, canRegisterCheckin, canRegisterGroup, canGenerate, canRunDue, globalConfig, access, friendRequests, routing, invitations, botConfig,
      runtimeVersion, milky] = await Promise.all([
      readServerSettings(root, Bun.env), readMasterPermissions(root), readAccountRefreshPermission(root),
      readAccountScopePermission(root, "checkin.register"), readAccountScopePermission(root, "checkin.group_register"),
      readAccountScopePermission(root, "scheduler.generate"),
      readAccountScopePermission(root, "scheduler.run_due"), readLocalConfig(root, "global"),
      readPrivateAccess(root, async (userId) =>
        !globalThis.redis || await globalThis.redis.set(`Yz:disablePrivate:${userId}`, "1", { EX: 10, NX: true }) === "OK"),
      readFriendRequests(root),
      readGroupDispatch(root),
      readGroupInvitations(root),
      readLocalConfig(root, "bot"),
      readRuntimeVersion(root),
      probingUpdate ? undefined : readMilkySettings(root).catch(() => {
        console.warn("[Milky] 无法读取有效的适配器配置。");
        return undefined;
      }),
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
    const valkey = probingUpdate ? undefined : await readStorageConnection(root, Bun.env.LOTUS_VALKEY_URL);
    const segmentCounts = botConfig.msg_type_count;
    onlineCooldown = onlineNoticeSeconds(botConfig.online_msg_exp);
    onlineVersion = runtimeVersion.version;
    counts = createMessageCounts(() => globalThis.redis, segmentCounts === true || segmentCounts === 1 || segmentCounts === "1");
    if (valkey !== undefined) {
      globalThis.redis = await connectStorage(valkey);
      console.log("[存储] Valkey 已连接。");
    }
    const accounts = accountCommands(Bun.env.LOTUS_PROFILE_DIR || undefined, canRefresh, undefined, async (...args) => {
      const { renderStatusCard } = await import("@lotus-yunzai/skia/status-card");
      if (args[0] === "登录列表") {
        const themeDirectory = Bun.env.LOTUS_ATLAS_THEME_DIR?.trim() || fileURLToPath(new URL("./data/atlas/theme/", root));
        if (!await Bun.file(`${themeDirectory}/bg/bg-hydro.webp`).exists()) throw new Error("登录列表原版背景不可用。");
        return renderStatusCard(...args, { themeDirectory });
      }
      return renderStatusCard(...args);
    });
    commands.registerModule(accounts);
    const viewProfile = (id: number, { message_type, self_id, user_id, group_id, isMaster }: CommandContext) =>
      accounts.commands[`#配置${id === 1 ? "" : id}`]!("", { message_type, self_id, user_id, group_id, isMaster });
    commands.registerModule(deviceCommands(Bun.env.LOTUS_PROFILE_DIR || undefined, lifecycle.signal,
      viewProfile), "[Lotus-Plugin] Device");
    commands.registerModule(dailyNoteCommands(Bun.env.LOTUS_PROFILE_DIR || undefined, lifecycle.signal), "[Lotus-Plugin] Daily Note");
    commands.registerModule(redeemCodeCommands({ historyFile: fileURLToPath(new URL("data/redeemCodes/activities.json", root)) }),
      "[Lotus-Plugin] Redeem Codes");
    const checkinAudit = createCheckinAudit(fileURLToPath(new URL("data/audit/checkin.jsonl", root)));
    const profileDirectory = Bun.env.LOTUS_PROFILE_DIR || undefined;
    const checkinProfiles = createProfileStore(profileDirectory);
    if (!probingUpdate) {
      const plans = createCheckinScheduleStore(fileURLToPath(new URL("data/schedules/", root)));
      const scheduler = globalConfig.scheduler as CheckinScheduleConfig | undefined;
      miyousheWeb = createMiyousheWeb({
        origin: () => fileBase, signal: lifecycle.signal, loginIdentity: checkinProfiles.loginIdentity,
        databasePath: fileURLToPath(new URL("data/miyoushe/sessions.sqlite", root)),
        assetDirectory: fileURLToPath(new URL("web/miyoushe/", root)),
        overview: createMiyousheOverview({ profileDirectory, readTodaySchedule: plans.read, scheduleEnabled: scheduler?.enable !== false }),
      });
      commands.registerModule(miyousheWeb.commands, "[Lotus-Plugin] Coin Shop");
    }
    commands.registerModule(hoyoLabProfileCommands(profileDirectory, lifecycle.signal, { viewProfile }), "[Lotus-Plugin] Profile Settings");
    commands.registerModule(cloudProfileCommands({
      signal: lifecycle.signal, viewProfile, readProfile: checkinProfiles.checkinSettings, setEnabled: checkinProfiles.setCloudGameEnabled,
      saveToken: checkinProfiles.saveCloudToken,
    }), "[Lotus-Plugin] Profile Settings");
    const gameCheckin = gameCheckinCommands(profileDirectory, lifecycle.signal,
      { manualRelay: () => manualCaptcha, audit: checkinAudit });
    commands.registerModule(gameCheckin, "[Lotus-Plugin] Checkin");
    commands.registerModule(checkinAuditCommands(checkinAudit, lifecycle.signal), "[Lotus-Plugin] Checkin Admin");
    if (!probingUpdate) {
      commands.registerModule(checkinRosterCommands({
        profiles: checkinProfiles,
        listMembers: ({ listCheckinGroupMembers }) => listCheckinGroupMembers?.() ?? Promise.resolve(undefined),
        signal: lifecycle.signal,
      }), "[Lotus-Plugin] Checkin Admin");
      commands.registerModule(checkinBatchRefreshCommands({ profiles: checkinProfiles, signal: lifecycle.signal }),
        "[Lotus-Plugin] Checkin Admin");
      const config = globalConfig.scheduler;
      if (config === undefined || (config !== null && typeof config === "object" && !Array.isArray(config) &&
          (!Object.hasOwn(config, "enable") || typeof (config as CheckinScheduleConfig).enable === "boolean"))) {
        async function deliverCheckin(qq: string, profileId: number, reply: MessageReply, revision: string, verifyPlan?: () => Promise<boolean>) {
          const current = await checkinProfiles.checkinSettings(qq, profileId).catch(() => undefined);
          if (!current?.enabled || current.revision !== revision || lifecycle.signal.aborted ||
              (verifyPlan && !await verifyPlan())) return { status: "skipped" as const };
          const transports = [...groups.checkinNotifications()];
          if (milkyOnline?.checkinNotify && !milkyOnline.signal.aborted) transports.push(milkyOnline.checkinNotify);
          return notifyCheckin({
            userId: Number(qq), settings: current.notify, reply, transports, signal: lifecycle.signal,
            async verifySend() {
              const latest = await checkinProfiles.checkinSettings(qq, profileId).catch(() => undefined);
              return latest?.enabled === true && latest.revision === revision && (!verifyPlan || await verifyPlan());
            },
          });
        }
        const runtime = createCheckinScheduleRuntime({
          store: createCheckinScheduleStore(fileURLToPath(new URL("data/schedules/", root))),
          config: (config ?? {}) as CheckinScheduleConfig,
          listProfiles: checkinProfiles.listCheckinProfiles,
          signal: lifecycle.signal,
          runProfile: (entry, scope) => gameCheckin.runScheduled(entry.qq, entry.profileId, scope),
          async onComplete(entry, result, attempt) {
            if (!result.reply || !result.revision || lifecycle.signal.aborted) return;
            const forumNames = (ids: readonly string[]) => ids.map(id => Object.hasOwn(bbsCheckinForums, id)
              ? bbsCheckinForums[id as BbsCheckinForum] : `分区 ${id}`).join("、");
            const lines: string[] = [];
            if (attempt) lines.push(`社区签到补跑第 ${attempt.number} 次（Profile ${entry.profileId}）`,
              `本轮分区：${forumNames(attempt.forums)}。游戏签到以首轮为准。`);
            if (entry.communityRetry?.verifiedUnsent) {
              const time = checkinScheduleClock(Date.parse(entry.communityRetry.nextAt)).iso.slice(11, 16);
              lines.push(`预计 ${time} 补跑社区：${forumNames(entry.communityRetry.forums)}。`);
            } else if (attempt && !entry.ok) lines.push("今日社区补跑已结束，请核对签到结果。");
            const reply: MessageReply = lines.length
              ? [`${lines.join("\n")}\n`, ...(Array.isArray(result.reply) ? result.reply : [result.reply])] : result.reply;
            await deliverCheckin(entry.qq, entry.profileId, reply, result.revision);
          },
          async onNotice(entry, date, late, isCurrent) {
            const current = await checkinProfiles.checkinSettings(entry.qq, entry.profileId).catch(() => undefined);
            if (!current?.enabled || !current.notify.enabled || lifecycle.signal.aborted) return { status: "skipped" };
            const reply = await checkinPlanNotice(entry, date, current.displayName, late, lifecycle.signal);
            if (!reply) return { status: "skipped" };
            return deliverCheckin(entry.qq, entry.profileId, reply, current.revision, isCurrent);
          },
        });
        checkinRuntime = runtime;
        commands.registerModule(checkinRegistrationCommands(profileDirectory, lifecycle.signal, {
          canRegister: canRegisterCheckin, addRegisteredProfile: runtime.addRegisteredProfile,
          viewProfile,
        }), "[Lotus-Plugin] Profile Settings");
        commands.registerModule(checkinGroupRegistrationCommands({
          profiles: checkinProfiles, signal: lifecycle.signal, canRegister: canRegisterGroup,
          async addRegisteredProfile(qq, profileId, revision) {
            const current = await checkinProfiles.checkinSettings(qq, profileId);
            if (lifecycle.signal.aborted) return;
            if (current.revision !== revision) throw new Error("签到档案已变更。");
            await runtime.addRegisteredProfile({ qq, profileId, name: current.displayName, enabled: current.enabled, schedule: current.schedule });
          },
        }), "[Lotus-Plugin] Profile Settings");
        commands.registerModule(checkinProfileCommands(profileDirectory, lifecycle.signal, {
          reconcilePlans: runtime.reconcileExistingPlans,
          viewProfile,
        }), "[Lotus-Plugin] Profile Settings");
        commands.registerModule(checkinPlanCommands(checkinProfiles, runtime, lifecycle.signal,
          { canGenerate, canRunDue }), "[Lotus-Plugin] Scheduler");
        commands.registerModule(checkinScheduleSettingCommands(root, runtime, lifecycle.signal), "[Lotus-Plugin] Scheduler");
      } else {
        console.warn("[签到计划] 全局 scheduler 配置无效。");
      }
    }
    commands.registerModule(passportLoginCommands(Bun.env.LOTUS_PROFILE_DIR || undefined, lifecycle.signal), "[Lotus-Plugin] Login");
    commands.registerModule({
      name: "@lotus-yunzai/gacha-batch", commands: {}, fallback: gachaBatch.fallback,
    }, "[Lotus-Plugin] Gacha Log");
    const { hostname, oneBot, https, panelToken } = network;
    const milkyOptions: MilkyTransportOptions = {
      signal: lifecycle.signal,
      dispatch,
      onSent: (event, message) => recordCount("send", event, message),
      masterIds: permissions.masterIds,
      onOnline: (id, signal, send, checkinNotify) => {
        milkyOnline = { id, startedAt: performance.now(), signal, send, checkinNotify };
        queueStartupMessages(id, "milky", signal);
      },
      isMaster: permissions.isMaster,
      groupReviews: milky && createMilkyGroupReviews(),
    };
    const milkyWebhook = milky?.connection === "webhook" ? createMilkyWebhook(milky, milkyOptions) : undefined;
    const milkyWs = milky?.connection === "ws" ? createMilkyWs(milky, milkyOptions) : undefined;
    const milkyTransport = milkyWebhook ?? milkyWs;
    if (milky?.connection === "webhook") legacy.httpRoutes.reserve(milky.webhookPath);
    stopMilky = milkyTransport?.stop;
    const http = network.http ?? (milkyWebhook && !https ? { port: 2536, auth: new Headers() } : undefined);
    if (network.manualCaptchaUrl && !probingUpdate) {
      if (!http && !https) {
        console.warn("[人工验证] 请先配置公共 HTTP 或 HTTPS 监听。");
      } else {
        try {
          const { createManualCaptchaRelay } = await import("./lib/captcha/manual-relay.ts");
          manualCaptcha = createManualCaptchaRelay({ publicUrl: network.manualCaptchaUrl });
        } catch {
          console.warn("[人工验证] 公开地址无效或 GT-Manual 未初始化，验证页暂不可用。");
        }
      }
    }
    // Plugins may create file links during initialization. Keep the bound listeners guarded until routes are ready.
    let publicRoutes: ((request: Request, auth: Headers) => Promise<Response | undefined>) | undefined;
    const acceptingPublic = () => !stopping && handoff.accepting && publicRoutes !== undefined;
    const listenerMessages: string[] = [];
    function httpHandler(auth: Headers) {
      const statusRoute = httpStatus(auth, runtimeVersion);
      return async (request: Request) => {
        if (stopping || !handoff.accepting || !publicRoutes) return new Response(null, { status: 503 });
        return await publicRoutes(request, auth) ?? statusRoute(request);
      };
    }
    function listenOneBot(port: number, auth: Headers, fetch?: ReturnType<typeof httpHandler>, tls?: Bun.TLSOptions) {
      const server = startOneBot(dispatch, {
        hostname, port, auth, groups, isMaster: permissions.isMaster, masterIds: permissions.masterIds,
        prewarmGroupMembers: botConfig.cache_group_member === undefined || Boolean(botConfig.cache_group_member),
        accepting: acceptingPublic,
        onBind: queueStartupMessages,
        onSent: valkey === undefined ? undefined : (identity, message) => recordCount("send", identity, message),
        http: fetch,
        tls,
      });
      servers.push(server);
      listenerMessages.push(`OneBot 11 正在监听 ${server.url.origin.replace(/^http/u, "ws")}/OneBotv11`);
      return server;
    }
    function listenHttp(port: number, fetch: ReturnType<typeof httpHandler>, tls?: Bun.TLSOptions) {
      const server = Bun.serve({ hostname, port, fetch, tls });
      servers.push(server);
      return server;
    }
    const shared = http !== undefined && oneBot !== undefined && http.port === oneBot.port;
    const socketServer = oneBot && listenOneBot(oneBot.port, oneBot.auth, shared ? httpHandler(http.auth) : undefined);
    if (http) {
      const server = shared && socketServer ? socketServer : listenHttp(http.port, httpHandler(http.auth));
      fileBase = network.publicUrl ?? listenerFileBase(server.url.hostname, server.port);
      listenerMessages.push(`HTTP 正在监听 ${server.url.origin}/status`);
    }
    if (network.httpsError && !probingUpdate) console.warn("[HTTPS] server.https 配置无效，已跳过 HTTPS。");
    if (https && !probingUpdate) {
      try {
        const [key, cert] = await Promise.all([readFile(https.key), readFile(https.cert)]);
        if (!stopping) {
          const tls = { key, cert };
          const fetch = httpHandler(https.auth);
          const server = https.oneBotAuth
            ? listenOneBot(https.port, https.oneBotAuth, fetch, tls)
            : listenHttp(https.port, fetch, tls);
          fileBase = https.publicUrl ?? fileBase ?? network.publicUrl ?? listenerFileBase(server.url.hostname, server.port, "https");
          listenerMessages.push(`HTTPS 正在监听 ${server.url.origin}/status`);
        }
      } catch {
        if (!stopping) console.warn("[HTTPS] 无法读取证书或启动监听，已跳过 HTTPS。");
      }
    }
    lifecycle.signal.throwIfAborted();
    const fileToUrl = createFileToUrl(publicFiles, botConfig, () => stopping ? undefined : fileBase);
    Object.assign(globalThis, { Bot: Object.freeze({ fileToUrl, express: legacy.httpRoutes.express }) });
    const loadTimeout = parsePluginLoadMilliseconds(botConfig.plugin_load_timeout);
    if (loadTimeout === undefined) console.warn("[插件] bot.yaml 的 plugin_load_timeout 无效，使用默认 60 秒。");
    plugins = await loadPlugins(fileURLToPath(new URL("plugins", root)), commands, legacy, Object.freeze({
      groups: groups.transport(), signal: lifecycle.signal, fileToUrl, lockFile,
      messageStatistics: createMessageStatistics(counts),
      runtimeVersion,
      runtimeDiagnostics(context: CommandContext) {
        const online = milkyOnline;
        const terminal = context.message_type === "terminal";
        const milkyDiagnostics = context.runtimeDiagnosticsScope === "milky";
        if (!context.isMaster && !milkyDiagnostics) return { accounts: [], plugins: [] };
        const milkyAccount = (terminal || milkyDiagnostics) && online && !online.signal.aborted ? {
          id: online.id, adapter: "milky" as const,
          seconds: Math.max(0, Math.floor((performance.now() - online.startedAt) / 1_000)),
        } : undefined;
        if (milkyDiagnostics) {
          const { message_type, self_id, user_id } = context;
          if (message_type !== "private" || !milkyAccount || self_id !== milkyAccount.id || user_id === undefined ||
              !permissions.isMaster(self_id, user_id)) return;
          return { accounts: [milkyAccount], plugins: plugins?.timings ?? [] };
        }
        const accounts = groups.onlineAccounts();
        return {
          accounts: milkyAccount ? [...accounts, milkyAccount] : terminal ? accounts : accounts.filter(({ id }) => id === context.self_id),
          plugins: plugins?.timings ?? [],
        };
      },
    }), { loadTimeout, reportLoading, fileWatch: botConfig.file_watch !== false && !probingUpdate, registerGacha: gachaBatch.register });
    if (!stopping) {
      if (!commands.hasModule(systemModuleName)) {
        throw new Error("系统模块未加载，请先运行 bun scripts/bootstrap.ts。");
      }
      const fallback = createServerRedirect(network.redirect);
      const likes = panelGroupSettings(plugins.directories);
      const guoba = panelGuobaRoutes(plugins.directories);
      const extensions = panelToken === undefined ? undefined : panelExtensionRoutes(plugins.directories);
      const panel = panelToken === undefined ? undefined : panelApi(panelToken, plugins.records,
        (path) => path === "/panel/api/settings/group/likes" ? likes : guoba(path) ?? extensions?.api(path), runtimeVersion);
      const assets = panel && panelAssets(fileURLToPath(new URL("panel/dist", root)));
      publicRoutes = async (request, auth) =>
        await manualCaptcha?.handlePublic(request) ?? publicFiles.handle(request) ?? mediaDelivery.handle(request) ?? await miyousheWeb?.handle(request) ??
        await panel?.(request) ?? await extensions?.assets(request) ?? await assets?.(request) ??
        await milkyWebhook?.handle(request, auth) ?? await legacy.httpRoutes.handle(request, auth, acceptingPublic) ?? fallback?.(request);
      for (const message of listenerMessages) console.log(message);
      await handoff.ready(runtimeVersion.revision, lifecycle.signal, [...plugins.directories.keys()]);
      milkyTransport?.start();
      checkinRuntime?.start();
      plugins.startWatching();
      stopPowerSchedule = scheduleDispatchPower(botConfig, async (paused) => {
        if (stopping) return;
        const reply = dispatchPower.setPaused(paused);
        if (reply === undefined) return;
        console.log(`[进程管理] ${reply}`);
        const notifications = await Promise.all(processOwnerTargets().map((target) => sendProcessMessage(target, reply)));
        if (notifications.includes(false)) {
          console.warn("[进程管理] 部分主人未收到定时开关机通知。");
        }
      });
      if (handoff.managed || canRestartHost()) {
        stopRestartSchedule = scheduleProcessRestart(botConfig, () => {
          const targets: ProcessReceipt["target"][] = processOwnerTargets(permissions.botIds());
          if (permissions.terminal) targets.push({ type: "terminal" });
          return startProcessAction("restart", targets);
        });
      } else if (botConfig.restart_time || botConfig.restart_cron) {
        console.warn("[进程管理] 当前运行环境不支持定时重启。");
      }
      if (handoff.managed) stopUpdateSchedule = scheduleUpdates(botConfig, requestScheduledUpdate);
      else if (botConfig.update_time || botConfig.update_cron) {
        console.warn("[更新] 定时更新需要通过 bun scripts/run-managed.ts 启动宿主。");
      }
      console.log("Lotus-Yunzai 已启动。输入 #状态 查询运行状态。");
      queueStartupMessages();

      const terminalReply = createTerminalReply(fileToUrl, terminalOutput);
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
          reply: terminalReply,
        }).catch(() => {
          console.error("处理终端指令失败。");
        });
        await Promise.race([handling, waiting.promise]);
      }
      if (servers.length || milkyTransport) await shutdown.promise;
    }
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    stopping = true;
    manualCaptcha?.close();
    publicFiles.close();
    lifecycle.abort();
    handoff.cancelUpdate();
    try {
      consoleInput?.close();
      legacy.stopContexts();
      await Promise.allSettled([...pending, stopPowerSchedule?.(), stopRestartSchedule?.(), stopUpdateSchedule?.(),
        stopMilky?.(), checkinRuntime?.stop()]);
      miyousheWeb?.close();
      await mediaDelivery.close();
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
            handoff.reportPower(dispatchPower.pausedAt);
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
            return target.type === "terminal" ? processReceipts.discard() : processReceipts.discard(target.botId, target.adapter);
          }
        }));
        console.error("[进程管理] 无法重新启动宿主。");
        process.exitCode = 1;
      }
    }
  }
}
