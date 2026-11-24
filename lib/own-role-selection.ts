import type { PublicRoleReferenceCatalogue } from "./public-role-references.ts";
import { gameRegionDisplayName, MAX_PROFILE_ID, ProfileError, type createProfileStore, type Game, type GameRole } from "@lotus-yunzai/account";
import type { createOwnRoleLegacyArtwork } from "./own-role-legacy-artwork.ts";
import type { createGameProfileDefaults } from "./game-profile-defaults.ts";
import { segment } from "./messages.ts";
import type { ProfileCardRole } from "@lotus-yunzai/skia/profile";

const command = /^#(原神|星铁|绝区零)?(?:我的)?uid([0-9]{1,3})?(?:[ \t]+档案[ \t]*([1-9][0-9]{0,2}))?$/iu;
const directUidCommand = /^#(?:(?:设置|切换)(原神|星铁|崩铁|绝区零|绝)|绑定(绝区零|绝))(?:uid|UID)(?:([1-9]\d{0,2})?\s+)?([1-9]\d{7,9})$/u;
const gameCodes = { 原神: "gs", 星铁: "sr", 崩铁: "sr", 绝区零: "zzz", 绝: "zzz" } as const;
const gameLabels = { gs: "原神", sr: "星铁", zzz: "绝区零" } as const;
const prefixes = { gs: "#", sr: "*", zzz: "%" } as const;
const games = ["gs", "sr", "zzz"] as const;
const maxSlot = 99;
export const ownRoleSelectionFeatures = ["[account] 本人角色", "account", "@lotus-yunzai/account"] as const;

type Selection = { readonly game: Game; readonly slot?: number; readonly profileId?: number; readonly uid?: string };

export function matchOwnRoleSelection(message: string): Selection | undefined {
  const match = command.exec(message.trim());
  if (match) {
    const game = gameCodes[match[1] as keyof typeof gameCodes] ?? "gs";
    return { game, slot: match[2] === undefined ? undefined : Number(match[2]), profileId: match[3] === undefined ? undefined : Number(match[3]) };
  }
  const direct = directUidCommand.exec(message.trim());
  if (!direct) return;
  const label = (direct[1] ?? direct[2]) as keyof typeof gameCodes;
  return { game: gameCodes[label], profileId: Number(direct[3] ?? 1), uid: direct[4]! };
}

type Scope = { readonly user: number; readonly signal: AbortSignal; readonly isCurrent: () => boolean };
type Roles = Pick<ReturnType<typeof createProfileStore>, "listIds" | "roleCatalog" | "selectCatalogRole" | "requestContext">;
type Catalog = Awaited<ReturnType<Roles["roleCatalog"]>>;
type Catalogs = ReadonlyMap<number, Catalog>;

function roleInfo(game: Game, role: GameRole) {
  const name = role.nickname.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 40);
  return [name, gameRegionDisplayName(game, role.region, role.regionName), role.level && `Lv.${role.level}`].filter(Boolean).join(" · ");
}

function collectRoles(profiles: Catalogs, game: Game) {
  const rows = new Map<string, { profileId: number; role: GameRole; revision: string; activeIn: number[] }>();
  for (const [profileId, profile] of profiles) {
    const roles = profile.catalog[game];
    const active = roles.find(role => role.uid === profile.active[game]) ?? roles.find(role => role.chosen) ?? roles[0];
    for (const role of roles) {
      let row = rows.get(role.uid);
      if (!row) {
        row = { profileId, role, revision: profile.revision, activeIn: [] };
        rows.set(role.uid, row);
      }
      if (role.uid === active?.uid) row.activeIn.push(profileId);
    }
  }
  return [...rows.values()].slice(0, maxSlot);
}

export async function selectOwnRole(profiles: Roles, { game, slot, profileId, uid }: Selection, scope: Scope,
  readPublic?: (qq: string) => Promise<PublicRoleReferenceCatalogue>, defaults?: ReturnType<typeof createGameProfileDefaults>,
  legacyArtwork?: ReturnType<typeof createOwnRoleLegacyArtwork>) {
  const { user, signal, isCurrent } = scope;
  if (!isCurrent() || signal.aborted) return;
  if (profileId !== undefined && profileId > MAX_PROFILE_ID) return `档案编号须在 1 到 ${MAX_PROFILE_ID} 之间。`;
  if (slot !== undefined && (slot < 1 || slot > maxSlot)) return `角色序号须在 1 到 ${maxSlot} 之间。`;
  const qq = String(user);
  try {
    const ids = profileId === undefined ? await profiles.listIds(qq) : [profileId];
    const publicRoles = await readPublic?.(qq).catch(() => undefined);
    const hasReferences = publicRoles && Object.values(publicRoles).some(entry => entry.data.length);
    const catalogs = new Map<number, Catalog>();
    for (const id of ids) {
      if (!isCurrent() || signal.aborted) return;
      try {
        catalogs.set(id, await profiles.roleCatalog(qq, id));
      } catch (error) {
        if (!(error instanceof ProfileError && error.code === "missing" && profileId === undefined)) throw error;
      }
    }
    if (!isCurrent() || signal.aborted) return;
    if (!catalogs.size && slot !== undefined) return "未找到本人档案。可发送 #登录列表 查看。";
    if (!catalogs.size && !hasReferences) return "没有本人游戏角色。可发送 #登录列表 查看或 #扫码登录。";

    const all = { gs: collectRoles(catalogs, "gs"), sr: collectRoles(catalogs, "sr"), zzz: collectRoles(catalogs, "zzz") };
    const suffix = profileId === undefined ? "" : ` 档案${profileId}`;
    let confirmation: string | undefined;
    if (slot !== undefined || (uid !== undefined && profileId !== undefined)) {
      const label = gameLabels[game];
      const selected = slot === undefined ? await profiles.requestContext(qq, profileId!, game, uid) : all[game][slot - 1];
      if (!selected) return `${profileId === undefined ? "本人" : `档案 ${profileId}`}没有第 ${slot} 个${label}角色。请发送 #UID${suffix} 查看。`;
      const { role, revision, profileId: id } = selected;
      if (uid !== undefined && catalogs.get(id)?.revision !== revision) throw new ProfileError("changed", "档案已变更。");
      if (!isCurrent() || signal.aborted) return;
      const saved = await profiles.selectCatalogRole(qq, id, game, role.uid, revision, signal, isCurrent);
      if (!isCurrent() || signal.aborted) return;
      for (const row of all[game]) row.activeIn = row.activeIn.filter(value => value !== id);
      const item = all[game].find(row => row.role.uid === role.uid);
      if (item) {
        item.activeIn.push(id);
        item.activeIn.sort((a, b) => a - b);
      }
      confirmation = `档案 ${id} · ${label}当前角色已选为 ${[role.uid, roleInfo(game, role)].filter(Boolean).join(" · ")}。`;
      if (profileId === undefined && defaults) {
        const selected = await defaults.select(game, id, role.uid, saved.revision, scope).catch(() => false);
        if (!isCurrent() || signal.aborted) return;
        confirmation += selected ? `\n${label}默认档案为 ${id}。` : `\n未能保存${label}默认档案，请核对本档登录后重试。`;
      }
    }

    const activeDefaults = catalogs.size ? await defaults?.read(qq) : undefined;
    if (!isCurrent() || signal.aborted) return;
    const title = catalogs.size ? "本人游戏角色" : "本人公开 UID 引用";
    const subtitle = catalogs.size ? (profileId === undefined ? "全部档案" : `档案 ${profileId}`) : undefined;
    const lines = [[title, subtitle].filter(Boolean).join(" · ")];
    const cardGroups = [];
    for (const key of games) {
      const roles = all[key];
      const references = publicRoles?.[key];
      const label = gameLabels[key];
      const gameDefault = activeDefaults?.[key] ?? 1;
      const defaultLabel = profileId === undefined && roles.length ? (catalogs.get(gameDefault)?.catalog[key].length
        ? ` · 默认档案 ${gameDefault}` : " · 未选默认档案") : "";
      lines.push(label + defaultLabel);
      if (!roles.length) lines.push("  暂无已同步角色");
      const rows: (ProfileCardRole & { readonly avatar?: string; readonly profile?: number })[] = [];
      for (const [index, { profileId: source, role, activeIn }] of roles.entries()) {
        const reference = references?.data.indexOf(role.uid) ?? -1;
        const marker = reference >= 0 ? `（${references?.uid === role.uid ? "公开当前" : "另有公开引用"} ${reference + 1}）` : "";
        const current = activeIn.length ? (profileId === undefined ? `（档案 ${activeIn.join("、")} 当前）` : "（当前）") : "";
        const origin = profileId === undefined ? `档案 ${source}` : "";
        const detail = roleInfo(key, role);
        lines.push(`  ${index + 1}. ${[role.uid, detail, origin].filter(Boolean).join(" · ")}${current}${marker}`);
        const cardOrigin = profileId === undefined && activeIn.includes(source) ? `档案 ${activeIn.join("、")} 当前` :
          [origin, current].filter(Boolean).join(" ");
        rows.push({ uid: role.uid, name: [cardOrigin, detail, marker].filter(Boolean).join(" · "), active: !!activeIn.length,
          slot: String(index + 1), badge: "档案角色", avatar: role.avatar, profile: source });
      }
      const listedUids = new Set(roles.map(({ role }) => role.uid));
      const uniqueReferences = references?.data.flatMap((uid, index) => {
        if (listedUids.has(uid)) return [];
        const active = uid === references.uid;
        rows.push({ uid, name: active ? "公开当前" : "独立公开引用", active, slot: `公${index + 1}`, badge: "公开绑定" });
        return [`  公开 ${index + 1}. ${uid}${active ? "（公开当前）" : ""}`];
      });
      if (uniqueReferences?.length) lines.push("  独立公开引用", ...uniqueReferences);
      cardGroups.push({ label: `${prefixes[key]}${label}${defaultLabel}`, command: `${prefixes[key]}UID1${suffix}`,
        game: key, rows });
    }
    const instructions = [];
    if (catalogs.size) instructions.push(`切换角色请用 #UID2${suffix}、*UID2${suffix} 或 %UID2${suffix}。`);
    if (profileId === undefined && catalogs.size > 1) instructions.push("查询指定档案时可在指令末尾加 档案N。");
    if (hasReferences) instructions.push("公开引用独立编号。查询或切换请用 #、* 或 % 加 查询公开UID2、切换公开UID2。");
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
          prepared.push({ ...row, avatar: old?.image ? undefined : avatar, ...old });
        }
        return { ...group, rows: prepared };
      }));
      if (!isCurrent() || signal.aborted) return;
      const artwork = await loadProfileRoleArtwork(groups.flatMap(({ rows }) => rows.map(row => row.avatar)), { signal });
      if (!isCurrent() || signal.aborted) return;
      const { png } = await renderProfileCard({ title, subtitle, warnings: instructions, roleGroups: groups.map(({ rows, ...group }) => ({
        ...group, rows: rows.map(({ avatar, ...row }) => ({ ...row, image: row.image ?? (avatar ? artwork.get(avatar) : undefined) })),
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
      if (error.code === "missing") return `未找到本人档案 ${profileId}。可发送 #登录列表 查看。`;
      if (error.code === "changed") return "档案在操作期间已更新，请重新发送 #UID 查看后再选择。";
      if (error.code === "login-required" && uid !== undefined) return `档案 ${profileId} 尚未登录，请先扫码登录。`;
      if (error.code === "role-missing" && uid !== undefined) {
        return `档案 ${profileId} 没有此${gameLabels[game]}角色。可发送 ${prefixes[game]}UID 档案${profileId} 查看。`;
      }
    }
    return "暂时无法读取或切换本人角色，请确认档案后重试。";
  }
}
