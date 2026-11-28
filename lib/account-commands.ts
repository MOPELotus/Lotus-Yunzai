import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { isDeepStrictEqual } from "node:util";
import { createProfileStore, gameRegionDisplayName, MAX_PROFILE_ID, ProfileError, profileGames, type Game } from "@lotus-yunzai/account";
import { createProfileHoyoClient } from "@lotus-yunzai/hoyo-client";
import { nativeImageRasterScale } from "@lotus-yunzai/skia";
import type { CommandContext, CommandHandler, CommandModule } from "./commands.ts";
import { segment } from "./messages.ts";

type RenderRefreshCard = (title: string, lead: string, contents: readonly string[], at: Date) =>
  Promise<{ readonly png: Uint8Array }>;

const roleLabels = { gs: $t("lib.account-commands.text_d1597c51ed"), sr: $t("lib.account-commands.text_a2927891f0"), zzz: $t("lib.account-commands.text_b1110352c9") } as const;
const checkinItems = [
  [$t("lib.account-commands.text_d1597c51ed"), "genshin", 2], [$t("lib.account-commands.text_7deeae4b7e"), "honkai2", 3], [$t("lib.account-commands.text_6d3d8653d7"), "honkai3rd", 1],
  [$t("lib.account-commands.text_a6e4fbed57"), "tears_of_themis", 4], [$t("lib.account-commands.text_102f77a733"), "", 5], [$t("lib.account-commands.text_a2927891f0"), "honkai_sr", 6],
  [$t("lib.account-commands.text_b1110352c9"), "zzz", 8], [$t("lib.account-commands.text_467c7ad0b9"), "hna", 9], [$t("lib.account-commands.text_6f70b509e8"), "", 10],
] as const;
const switchState = (enabled: boolean) => enabled ? $t("lib.account-commands.text_8da97ddda9") : $t("lib.account-commands.text_3fd47edce4");
const refreshAliases = ["自动签到", "c", "ck", "Cookie"];
const clearVerbs = ["清除", "删除"];
const clearNouns = ["登录", "扫码登录", "cookie", "Cookie"];
const loginMutation = new RegExp(`^(?:#刷新(?:cookie|${refreshAliases.join("|")})|` +
  `#(?:${clearVerbs.join("|")})(?:${clearNouns.join("|")}))(?:[1-9]\\d{0,2})?(?:\\s|$)`, "u");

export function isAccountLoginMutation(command: string) { return loginMutation.test(command); }

const removalGames = { 原神: "gs", 星铁: "sr", 绝区零: "zzz" } as const;

export function matchGameLoginRemoval(message: string): Game | undefined {
  if (/^#删除(?:Cookie|cookie)$/u.test(message)) return;
  const match = /^#?(原神|星铁|绝区零)?删除c(?:oo)?k(?:ie)?$/iu.exec(message);
  if (match) return removalGames[match[1] as keyof typeof removalGames] ?? "gs";
}

export async function removeSelectedGameLogin(profiles: Pick<ReturnType<typeof createProfileStore>,
  "listIds" | "requestSelectedContext" | "clearLogin">, game: Game,
{ user, signal, isCurrent }: { readonly user: number; readonly signal: AbortSignal; readonly isCurrent: () => boolean }) {
  const qq = String(user);
  const active = () => !signal.aborted && isCurrent();
  async function matchingProfiles() {
    const matches: { id: number; revision: string }[] = [];
    for (const id of await profiles.listIds(qq)) {
      if (!active()) throw new DOMException($t("lib.account-commands.text_bd244511e6"), "AbortError");
      try {
        const { revision } = await profiles.requestSelectedContext(qq, id, game);
        matches.push({ id, revision });
      } catch (error) {
        if (!(error instanceof ProfileError) || !["missing", "login-required", "role-missing"].includes(error.code)) throw error;
      }
    }
    return matches;
  }

  if (!active()) return;
  try {
    const matches = await matchingProfiles();
    if (!active()) return;
    if (matches.length === 0) return $t("lib.account-commands.text_aeabd1a18d", { "value1": roleLabels[game] });
    if (matches.length > 1) {
      return $t("lib.account-commands.text_9dd53d894a", { "value1": roleLabels[game], "value2": matches.map(({ id }) => id).join("、") });
    }
    const { id, revision } = matches[0]!;
    await profiles.clearLogin(qq, id, {
      revision, signal, canCommit: active,
      async verify() {
        const latest = await matchingProfiles();
        if (latest.length !== 1 || latest[0]?.id !== id || latest[0]?.revision !== revision) {
          throw new ProfileError("changed", $t("lib.account-commands.text_0a28e4d3b9"));
        }
      },
    });
    if (active()) return $t("lib.account-commands.text_3e0f1b7442", { "id": id });
  } catch (error) {
    if (!active()) return;
    if (error instanceof ProfileError && error.code === "changed") return $t("lib.account-commands.text_3b65f7e015");
    return $t("lib.account-commands.text_724f85b665");
  }
}

export function accountCommands(
  directory: string | undefined,
  canRefresh: (context: CommandContext) => boolean,
  makeClient = createProfileHoyoClient,
  renderRefreshCard?: RenderRefreshCard,
): CommandModule {
  const profiles = createProfileStore(directory);
  const client = makeClient(profiles);

  function refresh(profileId?: number): CommandHandler {
    return async (argument, context) => {
      if (argument) return $t("lib.account-commands.text_81a73575f3");
      if (context.user_id === undefined) return $t("lib.account-commands.text_5c65a9c72f");
      if (!canRefresh(context)) return $t("lib.account-commands.text_16e39e5f0f");

      const qq = String(context.user_id);
      const ids = profileId === undefined ? await profiles.listIds(qq) : [profileId];
      if (!ids.length) return $t("lib.account-commands.text_a08de24fa5");
      const title = $t("lib.account-commands.text_793c7f24fb");
      const outcomes: { id: number; message: string }[] = [];
      let refreshed = 0;
      for (const id of ids) {
        try {
          const { rolesSynced } = await client.refreshProfile(await profiles.accountContext(qq, id));
          refreshed++;
          outcomes.push({ id, message: rolesSynced ? $t("lib.account-commands.text_83913e71fc") : $t("lib.account-commands.text_d5c4322221") });
        } catch {
          outcomes.push({ id, message: $t("lib.account-commands.text_dcf389fa33") });
        }
      }
      if (renderRefreshCard) {
        const message = profileId === undefined
          ? (refreshed === ids.length
            ? $t("lib.account-commands.text_8f957c8686")
            : $t("lib.account-commands.text_9477637c5d", { "refreshed": refreshed, "length": ids.length }))
          : (refreshed ? $t("lib.account-commands.text_971af2fbe9", { "profileId": profileId }) : $t("lib.account-commands.text_074a95a269", { "profileId": profileId }));
        try {
          const contents = outcomes.map(({ id, message }) => $t("lib.account-commands.text_77102dc310", { "id": id, "message": message }));
          const { png } = await renderRefreshCard(title, `QQ ${qq}\n${message}`, contents, new Date());
          if (png.byteLength) return segment.image(png);
        } catch {
          // The refresh results stay available if the optional card cannot be drawn.
        }
      }
      return [title, ...outcomes.map(({ id, message }) => $t("lib.account-commands.text_987ae72631", { "id": id, "message": message }))].join("\n");
    };
  }

  function sync(id: number): CommandHandler {
    return async (argument, context) => {
      if (argument) return $t("lib.account-commands.text_6bc530d707");
      if (context.user_id === undefined) return $t("lib.account-commands.text_41980a91d3");

      try {
        const profile = await profiles.accountContext(String(context.user_id), id);
        const roles = await client.syncRoles(profile, canRefresh(context));
        return $t("lib.account-commands.text_e623664c82", { "id": id, "length": roles.gs.length, "value3": roles.sr.length, "value4": roles.zzz.length });
      } catch {
        return $t("lib.account-commands.text_7b5c090f79", { "id": id });
      }
    };
  }

  function clear(id: number): CommandHandler {
    return async (argument, context) => {
      if (argument) return $t("lib.account-commands.text_b605222a05");
      if (context.user_id === undefined) return $t("lib.account-commands.text_ed7488ebef");

      try {
        await profiles.clearLogin(String(context.user_id), id);
        return $t("lib.account-commands.text_3db385c0e4", { "id": id });
      } catch {
        return $t("lib.account-commands.text_e959863834", { "id": id });
      }
    };
  }

  function describe(id: number): CommandHandler {
    return async (argument, context) => {
      if (argument) return $t("lib.account-commands.text_c92ad69cc2");
      if (!context.user_id || !Number.isSafeInteger(context.user_id) || context.user_id < 1) {
        return $t("lib.account-commands.text_2bc06036cf");
      }
      const signal = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal;
      if (signal?.aborted) return [];
      const qq = String(context.user_id);
      const profile = await profiles.describe(qq, id).catch(() => undefined);
      if (signal?.aborted) return [];
      if (!profile?.loggedIn) return $t("lib.account-commands.text_5c992b438d", { "id": id });
      const mode = !profile.enabled ? $t("lib.account-commands.text_46e152919d") : profile.schedule.mode === "fixed" ? profile.schedule.fixedTime || $t("lib.account-commands.text_d4b3f49cd2")
        : profile.schedule.mode === "random" ? $t("lib.account-commands.text_75ca4f9214") : $t("lib.account-commands.text_bba7ef6ba2");
      const device = profile.deviceBound ? profile.device.name || $t("lib.account-commands.text_f70c0007f3") : profile.device.generated
        ? [$t("lib.account-commands.text_27eec3434a", { "value1": profile.device.name || "Lotus-Yunzai" }), !profile.device.hasFingerprint && $t("lib.account-commands.text_f3e18fd945")].filter(Boolean).join(" · ")
        : $t("lib.account-commands.text_e026c6693d");
      const settings: { label: string; value: string }[] = checkinItems.map(([label, game, forum]) => ({
        label, value: $t("lib.account-commands.text_06f550ea02", { "value1": game ? switchState(profile.gameCheckin[game] === true) : $t("lib.account-commands.text_484d556139"), "value2": switchState(profile.communityCheckin.includes(forum)) }),
      }));
      if (profile.international.enabled) settings.push({
        label: $t("lib.account-commands.text_970d688dd6"), value: `${profile.international.language} · ${profile.international.hasCookie ? $t("lib.account-commands.text_1bd91a7d0c") : $t("lib.account-commands.text_6a1be012c9")}`,
      });
      if (profile.cloud.length) settings.push({
        label: $t("lib.account-commands.text_0e1f644c82"), value: profile.cloud.map(({ game, hasToken }) =>
          `${game === "genshin" ? $t("lib.account-commands.text_8d17468984") : $t("lib.account-commands.text_6e50693925")}${hasToken ? "" : $t("lib.account-commands.text_bd98ac6357")}`).join(" / "),
      });
      const roleGroups = profileGames.map((game) => ({
        label: roleLabels[game],
        rows: profile.roles[game].map((role) => ({
          uid: role.uid,
          name: role.nickname || gameRegionDisplayName(game, role.region, role.regionName),
          level: role.level, active: role.uid === profile.activeRoles[game],
          avatar: role.avatar,
        })),
      }));
      if (profile.international.hasCookie) {
        for (const game of profileGames) {
          const rows = profile.international.roles[game];
          if (profile.domesticLoggedIn && rows.length) roleGroups.push({
            label: $t("lib.account-international.internationalGroup", { game: roleLabels[game] }),
            rows: rows.map(role => ({ uid: role.uid, name: role.nickname || gameRegionDisplayName(game, role.region, role.regionName),
              level: role.level, active: role.uid === profile.international.activeRoles[game], avatar: role.avatar })),
          });
          else if (!profile.domesticLoggedIn) {
            const group = roleGroups[profileGames.indexOf(game)];
            if (group) group.label = $t("lib.account-international.internationalGroup", { game: roleLabels[game] });
          }
        }
      }
      const account = [
        { label: $t("lib.account-commands.text_2f0a2b5a01"), value: profile.passport },
        { label: "Cookie", value: profile.hasCookie ? $t("lib.account-commands.text_1bd91a7d0c") : $t("lib.account-commands.text_6a1be012c9") },
        { label: "SToken", value: profile.hasStoken ? $t("lib.account-commands.text_1bd91a7d0c") : $t("lib.account-commands.text_6a1be012c9") },
        { label: $t("lib.account-commands.text_6c07bb6fd4"), value: device },
      ];
      const title = profile.nickname || `QQ ${qq}`;
      const subtitle = $t("lib.account-commands.text_89406be5fa", { "id": id, "value2": profile.name || "default" });
      const summary = $t("lib.account-commands.text_59c4758bd2", { "mode": mode, "value2": switchState(profile.notifications) });
      const warnings = [
        ...(profile.rolesPending ? [$t("lib.account-commands.text_27c634819b")] : []),
        ...(profile.domesticLoggedIn && !profile.device.hasFingerprint ? [$t("lib.account-commands.text_b177a3598a")] : []),
      ];
      let image: Uint8Array | undefined;
      try {
        const { renderProfileCard } = await import("@lotus-yunzai/skia/profile");
        const { loadProfileRoleArtwork } = await import("./profile-role-artwork.ts");
        const artwork = await loadProfileRoleArtwork(roleGroups.flatMap(({ rows }) => rows.map(({ avatar }) => avatar)), { signal });
        if (signal?.aborted) return [];
        const model = {
          title, subtitle, summary, account, settings, warnings,
          roleGroups: roleGroups.map(({ label, rows }) => ({
            label, rows: rows.map(({ avatar, ...row }) => ({ ...row, ...(avatar ? { image: artwork.get(avatar) } : {}) })),
          })),
          generatedAt: new Date().toLocaleString("sv-SE", { hour12: false }),
        };
        const scale = nativeImageRasterScale();
        const limit = context.inlineImageByteLimit ?? Infinity;
        const resourceDirectory = Bun.env.LOTUS_PASSPORT_QR_RESOURCES || undefined;
        let card = await renderProfileCard(model, { resourceDirectory, scale });
        if (signal?.aborted) return [];
        if (card.png.byteLength > limit && scale === 4 && !card.reducedScaleReason) {
          card = await renderProfileCard(model, { resourceDirectory, scale: 2 });
        }
        if (card.png.byteLength && card.png.byteLength <= limit) image = card.png;
      } catch {
        // Settings stay readable if the original resources are absent.
      }
      if (signal?.aborted) return [];
      const current = await profiles.describe(qq, id).catch(() => undefined);
      if (signal?.aborted) return [];
      if (!isDeepStrictEqual(profile, current)) {
        return $t("lib.account-commands.text_aa7d7e8267", { "value1": id === 1 ? "" : id });
      }
      if (image) return segment.image(image);
      return [title, subtitle, summary, ...account.map(({ label, value }) => `${label} · ${value}`),
        ...roleGroups.map(({ label, rows }) => `${label} · ${rows.map(({ uid, active }) => `${uid}${active ? $t("lib.account-commands.text_58d8cd20d2") : ""}`).join("、") || $t("lib.account-commands.text_9a964fbc3d")}`),
        ...settings.map(({ label, value }) => `${label} · ${value}`), ...warnings].join("\n");
    };
  }

  const accountActions: Record<string, CommandHandler> = { "#刷新cookie": refresh() };
  const aliases: Record<string, string> = { "#账号列表": "#登录列表" };
  for (const verb of ["刷新", "重置"]) {
    for (const suffix of ["统计", "ck", "Ck", "CK"]) aliases[`#${verb}用户${suffix}`] = `#${verb}用户缓存`;
  }
  for (let id = 0; id <= MAX_PROFILE_ID; id++) {
    const suffix = id === 0 ? "" : String(id);
    const command = `#刷新cookie${suffix}`;
    if (id > 0) accountActions[command] = refresh(id);
    const syncCommand = `#同步角色${suffix}`;
    accountActions[syncCommand] = sync(id || 1);
    for (const alias of ["UID", "uid"]) aliases[`#同步${alias}${suffix}`] = syncCommand;
    const clearCommand = `#清除登录${suffix}`;
    accountActions[clearCommand] = clear(id || 1);
    for (const verb of clearVerbs) {
      for (const noun of clearNouns) {
        const alias = `#${verb}${noun}${suffix}`;
        if (alias !== clearCommand) aliases[alias] = clearCommand;
      }
    }
    for (const alias of refreshAliases) aliases[`#刷新${alias}${suffix}`] = command;
    const cardCommand = `#配置${suffix}`;
    accountActions[cardCommand] = describe(id || 1);
    for (const prefix of ["", "原神", "星铁", "绝区零", "zzz", "ZZZ"]) aliases[`#${prefix}设备信息${suffix}`] = cardCommand;
    for (const label of ["资料", "资料卡", "我的配置"]) {
      aliases[`#${label}${suffix}`] = cardCommand;
    }
  }

  function userInventory(action: "查看" | "刷新" | "重置", command: string): CommandHandler {
    return async (argument, context) => {
      if (!context.isMaster || context.isDelegated) return $t("lib.account-commands.text_e52600e94c");
      if (argument) return $t("lib.account-commands.text_3e19d96793", { "command": command });
      const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal;
      if (context.message_type !== "terminal" && connection?.aborted !== false) return $t("lib.account-commands.text_0459e9382e");
      if (action === "重置") return $t("lib.account-commands.text_0559412a4e");
      try {
        const { users, profiles: total, domestic, international, legacyProfiles, unreadable } = await profiles.credentialInventory();
        if (connection?.aborted) return [];
        return [action === "刷新" && $t("lib.account-commands.text_5dde10bcf5"), $t("lib.account-commands.text_b5c3728574"), $t("lib.account-commands.text_197366a759", { "users": users, "total": total }),
          $t("lib.account-commands.text_bb01438bbb", { "domestic": domestic, "international": international }),
          $t("lib.account-commands.text_4546e9f71c", { "legacyProfiles": legacyProfiles, "unreadable": unreadable })].filter(Boolean).join("\n");
      } catch {
        return connection?.aborted ? [] : $t("lib.account-commands.text_64969eb803");
      }
    };
  }

  return {
    name: "@lotus-yunzai/account",
    aliases,
    commands: {
      ...accountActions,
      "#用户统计": userInventory("查看", "#用户统计"),
      "#刷新用户缓存": userInventory("刷新", "#刷新用户缓存"),
      "#重置用户缓存": userInventory("重置", "#重置用户缓存"),
      async "#登录列表"(argument: string, context: CommandContext) {
        if (argument) return $t("lib.account-commands.text_690c0778e9");
        if (context.user_id === undefined) return $t("lib.account-commands.text_986404ab01");

        const qq = String(context.user_id);
        const ids = await profiles.listIds(qq);
        const items: string[] = [];
        const lines = [$t("lib.account-commands.text_0686f985ae")];
        for (const id of ids) {
          try {
            const profile = await profiles.describe(qq, id);
            const status = profile.loggedIn ? $t("lib.account-commands.text_0a01eee1cd") : profile.legacyCookie ? $t("lib.account-commands.text_ccb647d7de") : $t("lib.account-commands.text_c1f6583730");
            const selected = $t("lib.account-commands.text_0c0b590627", { "value1": profile.activeRoles.gs || "-", "value2": profile.activeRoles.sr || "-", "value3": profile.activeRoles.zzz || "-" });
            items.push($t("lib.account-commands.text_265d0900d6", { "id": id, "status": status, "selected": selected }));
            lines.push($t("lib.account-commands.text_f5c8c4f5dc", { "id": id, "status": status }));
            if (profile.international.hasCookie) {
              const selectedOs = profile.international.activeRoles;
              const international = $t("lib.account-international.internationalRoles", {
                gs: selectedOs.gs || "-", sr: selectedOs.sr || "-", zzz: selectedOs.zzz || "-",
              });
              items[items.length - 1] += `\n${international}`;
              lines.push(international);
            }
          } catch (error) {
            if (!(error instanceof ProfileError)) throw error;
            items.push($t("lib.account-commands.text_a236b4e001", { "id": id }));
            lines.push($t("lib.account-commands.text_3c8b2f265d", { "id": id }));
          }
        }
        if (renderRefreshCard) {
          const lead = `QQ ${qq}
${ids.length ? $t("lib.account-commands.text_9d36c8e2b8") : $t("lib.account-commands.text_09b138a3f1")}`;
          try {
            const { png } = await renderRefreshCard($t("lib.account-commands.text_0686f985ae"), lead, items, new Date());
            if (png.byteLength) return segment.image(png);
          } catch {
            // Keep the same list available as text.
          }
        }
        return ids.length ? lines.join("\n") : $t("lib.account-commands.text_a08de24fa5");
      },
    },
  };
}
