import type { PublicRoleReferenceCatalogue } from "./public-role-references.ts";
import { gameRegionDisplayName, MAX_PROFILE_ID, ProfileError, type createProfileStore, type Game, type GameRole } from "@lotus-yunzai/account";

const command = /^#(原神|星铁|绝区零)?(?:我的)?uid([0-9]{1,3})?(?:[ \t]+档案[ \t]*([1-9][0-9]{0,2}))?$/iu;
const gameCodes = { 原神: "gs", 星铁: "sr", 绝区零: "zzz" } as const;
const gameLabels = { gs: "原神", sr: "星铁", zzz: "绝区零" } as const;
const games = ["gs", "sr", "zzz"] as const;
const maxSlot = 99;
export const ownRoleSelectionFeatures = ["[account] 本人角色", "account", "@lotus-yunzai/account"] as const;

export function matchOwnRoleSelection(message: string) {
  const match = command.exec(message.trim());
  if (!match) return;
  const game = gameCodes[match[1] as keyof typeof gameCodes] ?? "gs";
  return { game, slot: match[2] === undefined ? undefined : Number(match[2]), profileId: Number(match[3] ?? 1) };
}

type Selection = NonNullable<ReturnType<typeof matchOwnRoleSelection>>;
type Scope = { readonly user: number; readonly signal: AbortSignal; readonly isCurrent: () => boolean };
type Roles = Pick<ReturnType<typeof createProfileStore>, "roleCatalog" | "selectCatalogRole">;

function displayRole(game: Game, role: GameRole) {
  const name = role.nickname.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 40);
  const region = gameRegionDisplayName(game, role.region, role.regionName);
  return [role.uid, name, region, role.level && `Lv.${role.level}`].filter(Boolean).join(" · ");
}

export async function selectOwnRole(profiles: Roles, { game, slot, profileId }: Selection, { user, signal, isCurrent }: Scope, readPublic?: (qq: string) => Promise<PublicRoleReferenceCatalogue>) {
  if (!isCurrent() || signal.aborted) return;
  if (profileId > MAX_PROFILE_ID) return `档案编号须在 1 到 ${MAX_PROFILE_ID} 之间。`;
  if (slot !== undefined && (slot < 1 || slot > maxSlot)) return `角色序号须在 1 到 ${maxSlot} 之间。`;
  const qq = String(user);
  try {
    const publicRoles = slot === undefined ? await readPublic?.(qq).catch(() => undefined) : undefined;
    const hasReferences = publicRoles && Object.values(publicRoles).some(entry => entry.data.length);
    const profile = await profiles.roleCatalog(qq, profileId).catch((error: unknown) => {
      if (hasReferences && profileId === 1 && error instanceof ProfileError && error.code === "missing") return;
      throw error;
    });
    if (!isCurrent() || signal.aborted) return;
    if (slot !== undefined && profile) {
      const { catalog, revision } = profile;
      const role = catalog[game][slot - 1];
      const label = gameLabels[game];
      if (!role) return `档案 ${profileId} 没有第 ${slot} 个${label}角色。请发送 #UID${profileId === 1 ? "" : ` 档案${profileId}`} 查看。`;
      await profiles.selectCatalogRole(qq, profileId, game, role.uid, revision, signal, isCurrent);
      if (isCurrent() && !signal.aborted) return `档案 ${profileId} · ${label}当前角色已选为 ${displayRole(game, role)}。`;
      return;
    }

    const lines = [profile ? `本人游戏角色 · 档案 ${profileId}` : "本人公开 UID 引用"];
    for (const item of games) {
      const roles = profile?.catalog[item] ?? [];
      const selected = roles.find(role => role.uid === profile?.active[item]) ?? roles.find(role => role.chosen) ?? roles[0];
      lines.push(gameLabels[item]);
      if (!roles.length) lines.push("  暂无已同步角色");
      for (const [index, role] of roles.slice(0, maxSlot).entries()) {
        const reference = publicRoles?.[item].data.indexOf(role.uid) ?? -1;
        const marker = reference >= 0
          ? `（${publicRoles?.[item].uid === role.uid ? "公开当前" : "另有公开引用"} ${reference + 1}）` : "";
        lines.push(`  ${index + 1}. ${displayRole(item, role)}${role === selected ? "（当前）" : ""}${marker}`);
      }
      const references = publicRoles?.[item];
      const listedUids = new Set(roles.slice(0, maxSlot).map(role => role.uid));
      const uniqueReferences = references?.data.flatMap((uid, index) => listedUids.has(uid) ? [] :
        [`  公开 ${index + 1}. ${uid}${uid === references.uid ? "（公开当前）" : ""}`]);
      if (uniqueReferences?.length) lines.push("  独立公开引用", ...uniqueReferences);
    }
    if (hasReferences) lines.push("公开引用独立编号。查询或切换请用 #、* 或 % 加 查询公开UID2、切换公开UID2。");
    const suffix = profileId === 1 ? "" : ` 档案${profileId}`;
    if (profile) lines.push(`切换请发送 #UID2${suffix}、*UID2${suffix} 或 %UID2${suffix}，数字为角色序号。`);
    return lines.join("\n");
  } catch (error) {
    if (!isCurrent() || signal.aborted) return;
    if (error instanceof ProfileError) {
      if (error.code === "missing") return `未找到本人档案 ${profileId}。可发送 #登录列表 查看。`;
      if (error.code === "changed") return "档案在操作期间已更新，请重新发送 #UID 查看后再选择。";
    }
    return "暂时无法读取或切换本人角色，请确认档案后重试。";
  }
}
