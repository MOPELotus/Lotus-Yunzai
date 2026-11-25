import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createProfileStore, loadOfficialArtwork, MAX_PROFILE_ID, ProfileError, profileGames, type Game } from "@lotus-yunzai/account";
import { createProfileHoyoClient, DailyNoteRequestError, HoyoRequestError, type DailyNoteSnapshot } from "@lotus-yunzai/hoyo-client";
import type { DailyNoteCardItem, DailyNoteCardModel } from "@lotus-yunzai/skia/daily-note";
import type { CommandModule } from "./commands.ts";
import type { MessageReply } from "./messages.ts";

const matches = [
  [/^#?(?:多|全|全部)(?:体力|树脂|查询体力|便笺|便签)([1-9]\d{0,2})?$/u, profileGames],
  [/^#?(?:原神)?(?:体力|树脂|查询体力|便笺|便签)([1-9]\d{0,2})?$/u, ["gs"]],
  [/^(?:\*|#*星铁)(?:体力|树脂|查询体力|开拓力|便笺|便签|note|每日)([1-9]\d{0,2})?$/iu, ["sr"]],
  [/^(?:(?:#*|\/)(?:zzz|绝区零|绝区)(?:zzz|绝区零)?|#?[%％](?:zzz|绝区零|绝区)?)(?:体力|树脂|查询体力|note|每日|便笺|便签)([1-9]\d{0,2})?$/iu, ["zzz"]],
] as const;
const names = { gs: $t("lib.daily-note.text_d1597c51ed"), sr: $t("lib.daily-note.text_a2927891f0"), zzz: $t("lib.daily-note.text_b1110352c9") } as const;
const resources = { gs: $t("lib.daily-note.text_098c865928"), sr: $t("lib.daily-note.text_de78a76579"), zzz: $t("lib.daily-note.text_1c69b1aa72") } as const;
const videoStates = {
  doing: $t("lib.daily-note.text_c1c9424c3d"), done: $t("lib.daily-note.text_9510beecf1"), ready: $t("lib.daily-note.text_50d3675594"), idle: $t("lib.daily-note.text_73ca44399b"), unknown: $t("lib.daily-note.text_cdea037991"),
} as const;
const sectionsPerPage = 6;
const signLabels = { signed: $t("lib.daily-note.text_21c05833ab"), unsigned: $t("lib.daily-note.text_ef572bb5fe"), unavailable: $t("lib.daily-note.text_228cd0b0f2") } as const;
const expeditionDuration = 20 * 60 * 60;

function expeditionTime(seconds: number | undefined) {
  if (seconds === undefined) return $t("lib.daily-note.text_e1d6b2be41");
  if (seconds === 0) return $t("lib.daily-note.text_f28461bb49");
  return $t("lib.daily-note.text_12b4b2d0b1", { "value1": String(Math.floor(seconds / 3600)).padStart(2, "0"), "value2": String(Math.floor(seconds % 3600 / 60)).padStart(2, "0") });
}

function parseCommand(message: string) {
  for (const [pattern, games] of matches) {
    const match = pattern.exec(message);
    if (match) return { games, profileId: match[1] ? Number(match[1]) : undefined };
  }
}

const pair = ({ current, max }: { current?: number; max?: number }) => `${current ?? "-"}/${max ?? "-"}`;

function duration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  return $t("lib.daily-note.text_5fff9845c1", { "value1": hours ? $t("lib.daily-note.text_a00ae0db12", { "hours": hours }) : "", "minutes": minutes });
}

function noteCardItem(snapshot: DailyNoteSnapshot): DailyNoteCardItem {
  const { game, uid, stamina, homeCoin, expeditions, transformer, videoStore, scratchCardDone } = snapshot;
  type Detail = NonNullable<DailyNoteCardItem["details"]>[number];
  const details: Detail[] = [];
  function add(label: string, value: string | number | undefined, icon?: Detail["icon"]) {
    if (value !== undefined) details.push({ label, value: String(value), ...(icon && { icon }) });
  }
  function expedition(label: string, next: string, icon?: Detail["icon"]) {
    if (!expeditions) return;
    if (expeditions.current !== undefined || expeditions.max !== undefined) add(label, pair(expeditions), icon);
    if (expeditions.remainingSeconds !== undefined) {
      add(next, expeditions.remainingSeconds === 0 ? $t("lib.daily-note.text_53401dbc03") : $t("lib.daily-note.text_44cbcece5b", { "value1": duration(expeditions.remainingSeconds) }), icon);
    }
  }
  let data: DailyNoteCardItem["data"];
  switch (game) {
    case "gs":
      data = { current_resin: stamina.current, max_resin: stamina.max,
        ...(homeCoin ? { current_home_coin: homeCoin.current, max_home_coin: homeCoin.max } : {}) };
      add($t("lib.daily-note.text_929626b4c5"), snapshot.commissionRewardReceived === undefined ? undefined
        : snapshot.commissionRewardReceived ? $t("lib.daily-note.text_583d60e457") : $t("lib.daily-note.text_62a2fe8017"), "委托");
      expedition($t("lib.daily-note.text_408cb0f68f"), $t("lib.daily-note.text_16d867b195"), "派遣");
      if (snapshot.weeklyDiscount) add($t("lib.daily-note.text_fc9b09c792"), pair(snapshot.weeklyDiscount), "周本");
      if (transformer) {
        const seconds = transformer.remainingSeconds;
        const days = seconds === undefined ? 0 : Math.floor(seconds / 86400);
        const remainder = seconds === undefined ? 0 : seconds % 86400;
        const remaining = [days ? $t("lib.daily-note.text_63c4ff4f1e", { "days": days }) : "", remainder ? duration(remainder) : ""].join("");
        add($t("lib.daily-note.text_d574cc1893"), transformer.ready ? $t("lib.daily-note.text_4d99c976be") : remaining || $t("lib.daily-note.text_ba6403d228"), "参量质变仪");
      }
      break;
    case "sr":
      data = { current_stamina: stamina.current, max_stamina: stamina.max };
      expedition($t("lib.daily-note.text_45b39ce2cd"), $t("lib.daily-note.text_925175c189"));
      if (snapshot.training) add($t("lib.daily-note.text_f547490015"), pair(snapshot.training));
      if (snapshot.rogue) add($t("lib.daily-note.text_bd6e3d593f"), pair(snapshot.rogue));
      if (snapshot.echoOfWar) add($t("lib.daily-note.text_7c15b2c295"), pair(snapshot.echoOfWar));
      add($t("lib.daily-note.text_17e5df0c13"), snapshot.reserveStamina);
      break;
    case "zzz":
      data = { energy: { progress: stamina } };
      if (snapshot.vitality) add($t("lib.daily-note.text_6d00f421df"), pair(snapshot.vitality));
      add($t("lib.daily-note.text_f45df772d1"), snapshot.videoStoreText ?? (videoStore ? videoStates[videoStore] : undefined));
      if (scratchCardDone !== undefined) add($t("lib.daily-note.text_69dc2b2152"), scratchCardDone ? $t("lib.daily-note.text_f28461bb49") : $t("lib.daily-note.text_6707de42c2"));
      break;
  }
  const recovery = stamina.current >= stamina.max ? $t("lib.daily-note.text_d31241ffe9")
    : snapshot.recoveryText ?? (stamina.recoverySeconds ? $t("lib.daily-note.text_37f5f900c0", { "value1": duration(stamina.recoverySeconds) }) : undefined);
  const detail = [
    `${resources[game]} ${pair(stamina)}`, homeCoin && $t("lib.daily-note.text_b4e38336fe", { "value1": pair(homeCoin) }), recovery,
  ].filter(Boolean).join(" · ");
  const checkin = snapshot.starRailCheckin && signLabels[snapshot.starRailCheckin];
  const entries = expeditions?.entries?.map(({ name, remainingSeconds, avatars }) => ({
    name, remaining: expeditionTime(remainingSeconds), avatars,
    progress: remainingSeconds === undefined ? undefined : Math.max(0, 1 - remainingSeconds / expeditionDuration),
  }));
  return { game, gameName: names[game], uid, ok: true, data, detail, recovery, details, checkin,
    ...(snapshot.starRailCheckin && { checkinStatus: snapshot.starRailCheckin }),
    expeditions: game === "sr" && (entries?.length || (expeditions?.current ?? 0) > 0) ? entries ?? [] : undefined };
}

function failure(error: unknown): string {
  if (error instanceof ProfileError) {
    if (error.code === "missing") return $t("lib.daily-note.text_d4aa366013");
    if (error.code === "login-required") return $t("lib.daily-note.text_ec1c922d00");
  }
  if (error instanceof DailyNoteRequestError) return error.message;
  if (error instanceof HoyoRequestError && (error.code === "refresh" || error.code === "invalid-input")) return error.message;
  return $t("lib.daily-note.text_a4c75f09fd");
}

function pagesOf(groups: DailyNoteCardModel["groups"]): DailyNoteCardModel[] {
  const rows = groups.flatMap(({ name, items }) => items.map((item) => ({ name, item })));
  const generatedAt = new Date().toLocaleString("sv-SE", { hour12: false });
  const pages: DailyNoteCardModel[] = [];
  for (let start = 0; start < rows.length; start += sectionsPerPage) {
    const page = new Map<string, DailyNoteCardItem[]>();
    for (const { name, item } of rows.slice(start, start + sectionsPerPage)) {
      const items = page.get(name) ?? [];
      items.push(item);
      page.set(name, items);
    }
    pages.push({ generatedAt, groups: [...page].map(([name, items]) => ({ name, items })) });
  }
  return pages;
}

function textReply(groups: DailyNoteCardModel["groups"]) {
  return groups.flatMap(({ name, items }) => items.map((item) => {
    const title = [name, item.gameName, item.uid && `UID ${item.uid}`].filter(Boolean).join(" · ");
    const details = [item.ok ? item.detail : item.error,
      ...(item.details ?? []).map(({ label, value }) => `${label} ${value}`),
      item.checkin && $t("lib.daily-note.text_86cb4427a0", { "checkin": item.checkin }),
      ...(item.expeditions?.map(({ name, remaining, progress }) =>
        `${name} · ${remaining}${progress === undefined ? "" : ` · ${Math.round(progress * 100)}%`}`) ?? []),
      item.expeditions?.length === 0 && $t("lib.daily-note.text_30fe63cf43")];
    return [title, ...details.filter(Boolean)].join("\n");
  })).join("\n\n");
}

export function dailyNoteCommands(directory: string | undefined, signal: AbortSignal,
  transport: Parameters<typeof createProfileHoyoClient>[1] = fetch): CommandModule {
  const profiles = createProfileStore(directory);
  const client = createProfileHoyoClient(profiles, transport);
  return {
    name: "@lotus-yunzai/daily-note",
    commands: {},
    async fallback(_message, context) {
      const command = parseCommand(context.normalizedMessage);
      if (!command || signal.aborted) return;
      const { profileId, games } = command;
      if (profileId !== undefined && profileId > MAX_PROFILE_ID) return;
      const { user_id } = context;
      if (!user_id || !Number.isSafeInteger(user_id) || user_id < 1) return $t("lib.daily-note.text_6de6dd8244");
      const privateSession = context.message_type === "private" && !context.isDelegated
        ? context.privateCredentialSignal : undefined;
      const session = context.isDelegated ? context.delegationSignal : context.message_type === "group"
        ? context.groupActivitySignal : privateSession;
      const active = session ? AbortSignal.any([signal, session]) : signal;
      if (active.aborted) return [];
      const qq = String(user_id);
      await context.reply(profileId
        ? $t("lib.daily-note.text_090231938a", { "profileId": profileId })
        : $t("lib.daily-note.text_be5ceef54e"));
      if (active.aborted) return [];
      const ids = profileId ? [profileId] : await profiles.listIds(qq).catch(() => undefined);
      if (active.aborted) return [];
      if (!ids) return $t("lib.daily-note.text_2327128c50");
      if (!ids.length) return $t("lib.daily-note.text_11d48323b3");

      const groups: DailyNoteCardModel["groups"][number][] = [];
      const verifyDelivery: (() => Promise<void>)[] = [];
      const changed = $t("lib.daily-note.text_ab45f18d43");
      for (const id of ids) {
        if (active.aborted) return [];
        const items: DailyNoteCardItem[] = [];
        try {
          const { sources: saved, verifyReadOnly } = await profiles.requestContextsForRead(qq, id, games);
          const sources = saved.filter(({ game, role }) => game !== "zzz" ||
            (role.gameBiz !== "nap_global" && !/^[1-9]\d{9}$/u.test(role.uid)));
          let revision = sources[0]?.revision;
          const results = await client.fetchDailyNotes(sources, {
            signal: active,
            verifyReadOnly,
            includeStarRailCheckin: true,
            onCredentialRefresh(refreshed) { revision = refreshed.revision; },
          });
          if (active.aborted) return [];
          if (revision && results.some(result => result.status === "fulfilled")) {
            verifyDelivery.push(verifyReadOnly ?? (async () => {
              if ((await profiles.checkinSettings(qq, id)).revision !== revision) {
                throw new HoyoRequestError("profile-changed", changed);
              }
            }));
          }
          for (const game of games) {
            const start = items.length;
            sources.forEach((source, index) => {
              if (source.game !== game) return;
              const result = results[index]!;
              items.push(result.status === "fulfilled" ? noteCardItem(result.value)
                : { game, gameName: names[game], uid: source.role.uid, ok: false, error: failure(result.reason) });
            });
            if (game === "zzz") {
              const international = await profiles.internationalRoleContext(qq, id, "zzz");
              if (international && (/^[1-9]\d{9}$/u.test(international.selectedUid) ||
                  (!international.selectedUid && items.length === start))) {
                if (!privateSession) {
                  items.push({ game, gameName: names[game], ok: false, error: $t("lib.daily-note.text_8957c6806f") });
                } else {
                  const verifyProfile = async () => {
                    active.throwIfAborted();
                    const latest = await profiles.internationalRoleContext(qq, id, "zzz").catch(() => undefined);
                    if (latest?.revision !== international.revision) throw new HoyoRequestError("profile-changed", changed);
                  };
                  try {
                    const note = await client.fetchHoYoLabZzzDailyNote(international, { signal: active, verifyProfile });
                    items.push(noteCardItem(note));
                    verifyDelivery.push(verifyProfile);
                  } catch (error) {
                    await verifyProfile();
                    items.push({ game, gameName: names[game], ok: false, error: failure(error) });
                  }
                }
              } else if (items.length === start && saved.some(source => source.game === game)) {
                items.push({ game, gameName: names[game], ok: false, error: $t("lib.daily-note.text_e61dbcdecd") });
              }
            }
            if (items.length === start) items.push({ game, gameName: names[game], ok: false, error: $t("lib.daily-note.text_058b19d469") });
          }
        } catch (error) {
          if (active.aborted) return [];
          if ((error instanceof HoyoRequestError && error.code === "profile-changed") ||
              (error instanceof ProfileError && error.code === "changed")) {
            return changed;
          }
          items.push({ ok: false, error: failure(error) });
        }
        groups.push({ name: $t("lib.daily-note.text_4fc83a9017", { "id": id }), items });
      }

      const renderer = await import("@lotus-yunzai/skia/daily-note").catch(() => undefined);
      for (const page of pagesOf(groups)) {
        if (active.aborted) return [];
        let reply: MessageReply;
        try {
          const avatarArtwork = renderer && await loadOfficialArtwork(page.groups.flatMap(({ items }) =>
            items.flatMap(({ expeditions }) => expeditions?.flatMap(({ avatars }) => avatars) ?? [])), { signal: active });
          const image = await renderer?.renderDailyNoteCard(page, { resourceDirectory: Bun.env.LOTUS_DAILY_NOTE_RESOURCES || undefined,
            avatarArtwork, signal: active, inlineImageByteLimit: context.inlineImageByteLimit });
          reply = image ? { type: "image", file: image.png } : textReply(page.groups);
        } catch {
          reply = textReply(page.groups);
        }
        try {
          await Promise.all(verifyDelivery.map(verify => verify()));
        } catch {
          return active.aborted ? [] : changed;
        }
        if (active.aborted) return [];
        if (await context.reply(reply) === false) break;
      }
      return [];
    },
  };
}
