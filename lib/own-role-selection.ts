import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { gameCommandProfileId, gameRegionDisplayName, MAX_PROFILE_ID, ProfileError, type createProfileStore, type Game, type GameRole } from "@lotus-yunzai/account";
import type { createOwnRoleLegacyArtwork } from "./own-role-legacy-artwork.ts";
import { segment } from "./messages.ts";
import type { ProfileCardRole } from "@lotus-yunzai/skia/profile";

const command = /^#(原神|星铁|绝区零)?(?:(?:我的)?uid([0-9]{1,3})?|角色列表)(?:[ \t　]+档案[ \t　]*([1-9][0-9]{0,2}))?$/iu;
const choose = /^#(原神|星铁|绝区零)?切换角色[ \t　]*([0-9]{1,10})(?:[ \t　]+档案[ \t　]*([1-9][0-9]{0,2}))?$/u;
const gameCodes = { 原神: "gs", 星铁: "sr", 绝区零: "zzz" } as const;
const gameLabelKeys = { gs: "lib.own-role-selection.text_d1597c51ed", sr: "lib.own-role-selection.text_a2927891f0", zzz: "lib.own-role-selection.text_b1110352c9" } as const;
const gameLabel = (game: Game) => $t(gameLabelKeys[game]);
const prefixes = { gs: "#", sr: "*", zzz: "%" } as const;
const games = ["gs", "sr", "zzz"] as const;
const maxSlot = 99;
export const ownRoleSelectionFeatures = [$t("lib.own-role-selection.text_04f9bd14ca"), "account", "@lotus-yunzai/account"] as const;

type Selection = { readonly game: Game; readonly slot?: number; readonly profileId?: number; readonly uid?: string };

export function matchOwnRoleSelection(message: string): Selection | undefined {
  const input = message.trim();
  const match = command.exec(input);
  if (match) return { game: gameCodes[match[1] as keyof typeof gameCodes] ?? "gs",
    slot: match[2] === undefined ? undefined : Number(match[2]), profileId: match[3] === undefined ? undefined : Number(match[3]) };
  const choice = choose.exec(input);
  if (!choice) return;
  const target = choice[2]!;
  if (target.length > 3 && !/^[1-9]\d{7,9}$/u.test(target)) return;
  return { game: gameCodes[choice[1] as keyof typeof gameCodes] ?? "gs",
    profileId: choice[3] === undefined ? undefined : Number(choice[3]),
    ...(target.length <= 3 ? { slot: Number(target) } : { uid: target }) };
}

type Scope = { readonly user: number; readonly signal: AbortSignal; readonly isCurrent: () => boolean };
type Roles = Pick<ReturnType<typeof createProfileStore>, "roleCatalog" | "selectCatalogRole" | "requestContext">;
function roleInfo(game: Game, role: GameRole) {
  const name = role.nickname.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 40);
  return [name, gameRegionDisplayName(game, role.region, role.regionName), role.level && `Lv.${role.level}`].filter(Boolean).join(" · ");
}

export async function selectOwnRole(profiles: Roles, { game, slot, profileId: explicit, uid }: Selection, scope: Scope,
  legacyArtwork?: ReturnType<typeof createOwnRoleLegacyArtwork>) {
  const { user, signal, isCurrent } = scope;
  const profileId = gameCommandProfileId(game, explicit);
  if (!isCurrent() || signal.aborted) return;
  if (!Number.isSafeInteger(profileId) || profileId < 1 || profileId > MAX_PROFILE_ID) return $t("lib.own-role-selection.text_b4ba5fed47", { "MAX_PROFILE_ID": MAX_PROFILE_ID });
  if (slot !== undefined && (slot < 1 || slot > maxSlot)) return $t("lib.own-role-selection.text_849b66fea4", { "maxSlot": maxSlot });
  const qq = String(user);
  try {
    const catalogue = await profiles.roleCatalog(qq, profileId);
    if (!isCurrent() || signal.aborted) return;
    const suffix = $t("lib.own-role-selection.text_31a2142f9f", { "profileId": profileId });
    let confirmation: string | undefined;
    if (slot !== undefined || uid !== undefined) {
      const role = uid === undefined ? catalogue.catalog[game][slot! - 1] : catalogue.catalog[game].find(role => role.uid === uid);
      if (!role) return uid === undefined
        ? $t("lib.own-role-selection.text_e7571f382e", { "value1": $t("lib.own-role-selection.text_3f6fdc79bb", { "profileId": profileId }), "slot": slot, "label": gameLabel(game), "suffix": suffix })
        : $t("lib.own-role-selection.text_384d21e4ee", { "profileId": profileId, "value2": gameLabel(game), "value3": prefixes[game], "value4": profileId });
      const source = await profiles.requestContext(qq, profileId, game, role.uid);
      if (!isCurrent() || signal.aborted) return;
      if (source.revision !== catalogue.revision) throw new ProfileError("changed", $t("lib.own-role-selection.text_8a1edc5158"));
      await profiles.selectCatalogRole(qq, profileId, game, role.uid, source.revision, signal, isCurrent);
      if (!isCurrent() || signal.aborted) return;
      catalogue.active[game] = role.uid;
      confirmation = $t("lib.own-role-selection.text_34fe465cfa", { "id": profileId, "label": gameLabel(game), "value3": [role.uid, roleInfo(game, role)].filter(Boolean).join(" · ") });
    }
    const title = $t("lib.own-role-selection.text_b844714f31");
    const subtitle = $t("lib.own-role-selection.text_3f6fdc79bb", { "profileId": profileId });
    const lines = [[title, subtitle].join(" · ")];
    const cardGroups = [];
    for (const key of games) {
      const roles = catalogue.catalog[key].slice(0, maxSlot);
      const active = roles.find(role => role.uid === catalogue.active[key]) ?? roles.find(role => role.chosen) ?? roles[0];
      lines.push(gameLabel(key));
      if (!roles.length) lines.push($t("lib.own-role-selection.text_48101791af"));
      const rows: (ProfileCardRole & { readonly avatar?: string; readonly profile?: number })[] = [];
      for (const [index, role] of roles.entries()) {
        const selected = role.uid === active?.uid;
        const marker = selected ? $t("lib.own-role-selection.text_58d8cd20d2") : "";
        const detail = roleInfo(key, role);
        lines.push(`  ${index + 1}. ${[role.uid, detail].filter(Boolean).join(" · ")}${marker}`);
        rows.push({ uid: role.uid, name: [detail, marker].filter(Boolean).join(" · "), active: selected,
          slot: String(index + 1), badge: $t("lib.own-role-selection.text_63927b798f"), avatar: role.avatar, profile: profileId });
      }
      cardGroups.push({ label: `${prefixes[key]}${gameLabel(key)}`, command: `${prefixes[key]}切换角色 1${suffix}`, game: key, rows });
    }
    const instructions = [$t("lib.own-role-selection.instructions", { "prefix": prefixes[game], "profileId": profileId })];
    const fallback = [confirmation, ...lines, ...instructions].filter(Boolean).join("\n");
    try {
      const [{ loadProfileRoleArtwork }, { openProfileCardTheme, renderProfileCard }] = await Promise.all([
        import("./profile-role-artwork.ts"), import("@lotus-yunzai/skia/profile"),
      ]);
      const options = { resourceDirectory: Bun.env.LOTUS_PASSPORT_QR_RESOURCES || undefined };
      await openProfileCardTheme(options.resourceDirectory);
      const groups = await Promise.all(cardGroups.map(async ({ rows, ...group }) => {
        const prepared = [];
        for (const { avatar, profile, ...row } of rows) {
          if (!isCurrent() || signal.aborted) break;
          const old = profile !== undefined && row.uid !== undefined
            ? await legacyArtwork?.(qq, profile, group.game, String(row.uid), signal) : undefined;
          prepared.push({ ...row, avatar: group.game === "gs" || !old?.image ? avatar : undefined, ...old });
        }
        return { ...group, rows: prepared };
      }));
      if (!isCurrent() || signal.aborted) return;
      const artwork = await loadProfileRoleArtwork(groups.flatMap(({ rows }) => rows.map(row => row.avatar)), { signal });
      if (!isCurrent() || signal.aborted) return;
      const { png } = await renderProfileCard({ title, subtitle, warnings: instructions, roleGroups: groups.map(({ rows, ...group }) => ({
        ...group, rows: rows.map(({ avatar, ...row }) => {
          const official = avatar ? artwork.get(avatar) : undefined;
          return group.game === "gs" && official
            ? { ...row, image: official, fallbackImage: row.image }
            : { ...row, image: row.image ?? official };
        }),
      })), uidList: true }, options);
      if (!isCurrent() || signal.aborted) return;
      if (png.byteLength) return [segment.image(png), [confirmation, ...instructions].filter(Boolean).join("\n")];
    } catch {
      // 文本保留事务结果和角色序号。
    }
    if (!isCurrent() || signal.aborted) return;
    return fallback;
  } catch (error) {
    if (!isCurrent() || signal.aborted) return;
    if (error instanceof ProfileError) {
      if (error.code === "missing") return $t("lib.own-role-selection.text_21d26e1170", { "profileId": profileId });
      if (error.code === "changed") return $t("lib.own-role-selection.text_f19cfb39b5");
      if (error.code === "login-required") return $t("lib.own-role-selection.text_01e4cf1b34", { "profileId": profileId });
      if (error.code === "role-missing") {
        return $t("lib.own-role-selection.text_384d21e4ee", { "profileId": profileId, "value2": gameLabel(game), "value3": prefixes[game], "value4": profileId });
      }
    }
    return $t("lib.own-role-selection.text_403f8b8e2c");
  }
}
