import { fileURLToPath } from "node:url";
import type { Game } from "@lotus-yunzai/account";
import { createRoleJsonArchive, type AcquireRoleArchiveLock } from "@lotus-yunzai/storage";

const games = ["gs", "sr", "zzz"] as const;
const codes = { 原神: "gs", 星铁: "sr", 绝区零: "zzz" } as const;
const labels = { gs: "原神", sr: "星铁", zzz: "绝区零" } as const;
const providers = { gs: "Enka", sr: "Mihomo", zzz: "Enka" } as const;
const prompts = { gs: "#", sr: "*", zzz: "%" } as const;
const command = /^#(原神|星铁|绝区零)?(登记(?:公开)?uid|公开uid列表|切换公开uid|删除公开uid|查询公开uid|(?:删除|解绑)uid)(.*)$/iu;
const selector = /^[1-9]\d?$/u;
const uidPattern = /^[1-9]\d{7,9}$/u;
const roleLimit = 99;
export const publicRoleReferenceFeatures = ["[account] 公开角色引用", "account", "@lotus-yunzai/account"] as const;

export function matchPublicRoleReferenceCommand(input: string) {
  const match = command.exec(input.trim());
  if (!match) return;
  const game: Game = codes[match[1] as keyof typeof codes] ?? "gs";
  const action = match[2]!.toLowerCase();
  const value = match[3]!.trim();
  if ((action === "删除uid" || action === "解绑uid") && !/^[+\s]*[0-9]{0,2}$/u.test(value)) return;
  return { game, action, value };
}

type Command = NonNullable<ReturnType<typeof matchPublicRoleReferenceCommand>>;
type Scope = { readonly user: number; readonly signal: AbortSignal; readonly isCurrent: () => boolean };
type References = { readonly uid: string; readonly data: readonly string[] };
type Catalogue = Readonly<Record<Game, References>>;
const empty: References = { uid: "", data: [] };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function decode(value: unknown): Catalogue {
  if (value === null) return { gs: empty, sr: empty, zzz: empty };
  const document = record(value);
  if (!document || document.version !== 1) throw new TypeError("公开 UID 引用格式不正确。");
  const forGame = (game: Game): References => {
    const refs = record(document[game]);
    if (!refs || typeof refs.uid !== "string" || !Array.isArray(refs.data) || refs.data.length > roleLimit ||
        refs.data.some((value: unknown) => typeof value !== "string" || !uidPattern.test(value)) ||
        new Set(refs.data).size !== refs.data.length || (refs.data.length ? !refs.data.includes(refs.uid) : refs.uid !== "")) {
      throw new TypeError("公开 UID 引用列表无效。");
    }
    return { uid: refs.uid, data: refs.data as string[] };
  };
  return { gs: forGame("gs"), sr: forGame("sr"), zzz: forGame("zzz") };
}

function createPublicReaders() {
  let genshin: Promise<Awaited<ReturnType<typeof bindGenshin>>> | undefined;
  let zzz: Promise<Awaited<ReturnType<typeof bindZzz>>> | undefined;
  async function bindGenshin() {
    const { createGenshinShowcaseClient, genshinShowcaseTarget } = await import("../plugins/genshin/panel/showcase-client.ts");
    return { read: createGenshinShowcaseClient(), target: genshinShowcaseTarget };
  }
  async function bindZzz() {
    const [{ createZzzShowcaseClient }, { zzzPanelRegion }] = await Promise.all([
      import("../plugins/zzz/enka-showcase.ts"), import("../plugins/zzz/panel-storage.ts"),
    ]);
    return { read: createZzzShowcaseClient(), region: zzzPanelRegion };
  }
  async function target(game: Game, uid: string) {
    const role = { uid, region: "", gameBiz: "" };
    if (game === "gs") {
      const provider = await (genshin ??= bindGenshin());
      const selection = provider.target(role, "2");
      return async (signal: AbortSignal) => {
        const { raw } = await provider.read(selection, signal);
        return Array.isArray(raw.avatarInfoList) ? raw.avatarInfoList.length : 0;
      };
    }
    if (game === "sr") {
      const { fetchStarRailShowcase, showcaseTarget } = await import("../plugins/starrail/panel-showcase.ts");
      const selection = showcaseTarget(role, "2");
      return async (signal: AbortSignal) => (await fetchStarRailShowcase(selection, signal)).avatars.length;
    }
    const provider = await (zzz ??= bindZzz());
    const region = provider.region(uid, "", "");
    if (!region) throw new TypeError("绝区零 UID 或区服无效。");
    return async (signal: AbortSignal) => (await provider.read({ uid, region }, signal)).rows.length;
  }
  return target;
}

export function createPublicRoleReferences(lockFile: AcquireRoleArchiveLock, directory = fileURLToPath(
  new URL("../data/public-role-references/", import.meta.url)), publicTarget = createPublicReaders()) {
  const archive = createRoleJsonArchive(directory, lockFile, {
    subject: "本人公开 UID 引用", lockSuffix: "public-role-reference", maxBytes: 8192, rejectNull: true,
  });
  return async ({ game, action, value }: Command, { user, signal, isCurrent }: Scope) => {
    const active = () => !signal.aborted && isCurrent();
    const verify = async () => {
      if (!active()) throw new DOMException("公开 UID 操作授权已失效。", "AbortError");
    };
    if (!active()) return;
    const prefix = prompts[game];
    const label = labels[game];
    const usage = `用法 ${prefix}登记公开UID <游戏 UID>，${prefix}公开UID列表 查看。`;
    if (action === "删除uid" || action === "解绑uid") {
      return `请用 ${prefix}公开UID列表 核对公开引用号码，再用 ${prefix}删除公开UID2 删除。登录档案角色请在对应档案处理。`;
    }
    const register = action === "登记uid" || action === "登记公开uid";
    const list = action === "公开uid列表";
    const query = action === "查询公开uid";
    if (register && !uidPattern.test(value)) return usage;
    if ((list && value) || (!list && !register && !(query && !value) && !selector.test(value))) {
      return `请发送 ${prefix}公开UID列表 查看，可用 ${prefix}切换公开UID2、${prefix}查询公开UID2 或 ${prefix}删除公开UID2。`;
    }
    const qq = String(user);
    const read = () => archive.read(qq, "1").then(decode);
    const index = value ? Number(value) - 1 : undefined;
    try {
      if (list) {
        const entries = await read();
        await verify();
        const lines = ["本人公开 UID 引用"];
        for (const item of games) {
          const { uid, data } = entries[item];
          lines.push(labels[item]);
          if (!data.length) lines.push("  暂无公开 UID");
          for (const [position, entry] of data.entries()) lines.push(`  ${position + 1}. ${entry}${entry === uid ? "（当前）" : ""}`);
        }
        return [...lines, "公开 UID 用于查询公开展板。登记无需登录，不提供账号授权。"].join("\n");
      }
      if (query) {
        const records = (await read())[game];
        const select = (refs: References) => index === undefined ? refs.uid : refs.data[index];
        const uid = select(records);
        if (!uid) return `没有对应的${label}公开 UID。可发送 ${prefix}公开UID列表 查看。`;
        const fetchPublic = await publicTarget(game, uid);
        await verify();
        if (select((await read())[game]) !== uid) return "公开 UID 引用已变化，请重新查询。";
        await verify();
        const count = await fetchPublic(signal);
        if (select((await read())[game]) !== uid) return "公开 UID 引用已变化，请重新查询。";
        await verify();
        return `${label} UID ${uid} · ${providers[game]} 公开展板可见 ${count} 个角色。`;
      }
      if (register) {
        try { await publicTarget(game, value); }
        catch { return `${label}公开 UID 的格式或区服无效。`; }
      }
      return await archive.update({ qq, uid: "1" }, verify, current => {
        const entries = decode(current);
        const currentGame = entries[game];
        const uid = register ? value : currentGame.data[index!];
        if (!uid) return { result: `没有这个${label}公开 UID 序号。请用 ${prefix}公开UID列表 查看。` };
        if (register && !currentGame.data.includes(uid) && currentGame.data.length >= roleLimit) return { result: "公开 UID 列表已满，请先删除一个引用。" };
        const remove = action === "删除公开uid";
        const data = remove ? currentGame.data.filter(entry => entry !== uid)
          : register && !currentGame.data.includes(uid) ? [...currentGame.data, uid] : currentGame.data;
        const next = { uid: remove ? (currentGame.uid === uid ? data[0] ?? "" : currentGame.uid) : uid, data };
        const result = remove ? `已删除${label}公开 UID 引用 ${uid}。`
          : `${label}当前公开 UID 为 ${uid}。可用 ${prefix}查询公开UID 查询。`;
        if (currentGame.uid === next.uid && currentGame.data === next.data) return { result };
        return { document: { version: 1, ...entries, [game]: next }, result };
      });
    } catch {
      if (active()) return query ? `${label}公开展板暂时无法查询，请确认游戏内公开设置后重试。`
        : "暂时无法读取或保存本人公开 UID 引用。";
    }
  };
}
