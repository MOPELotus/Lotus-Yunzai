import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { fileURLToPath } from "node:url";
import type { Game } from "@lotus-yunzai/account";
import { createRoleJsonArchive, type AcquireRoleArchiveLock } from "@lotus-yunzai/storage";

const games = ["gs", "sr", "zzz"] as const;
const codes = { 原神: "gs", 星铁: "sr", 绝区零: "zzz" } as const;
const labels = { gs: $t("lib.public-role-references.text_d1597c51ed"), sr: $t("lib.public-role-references.text_a2927891f0"), zzz: $t("lib.public-role-references.text_b1110352c9") } as const;
const providers = { gs: "Enka", sr: "Mihomo", zzz: "Enka" } as const;
const prompts = { gs: "#", sr: "*", zzz: "%" } as const;
const command = /^#(原神|星铁|绝区零)?(登记(?:公开)?uid|公开uid列表|切换公开uid|删除公开uid|查询公开uid|(?:删除|解绑)uid)(.*)$/iu;
const selector = /^[1-9]\d?$/u;
const uidPattern = /^[1-9]\d{7,9}$/u;
export const publicRoleReferenceLimit = 99;
export const publicRoleReferencePath = "data/public-role-references";
export const publicRoleReferenceFeatures = [$t("lib.public-role-references.text_3616cdccba"), "account", "@lotus-yunzai/account"] as const;

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
export type PublicRoleReferenceCatalogue = Readonly<Record<Game, References>>;
const empty: References = { uid: "", data: [] };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function decode(value: unknown): PublicRoleReferenceCatalogue {
  if (value === null) return { gs: empty, sr: empty, zzz: empty };
  const document = record(value);
  if (!document || document.version !== 1) throw new TypeError($t("lib.public-role-references.text_8eaed42866"));
  const forGame = (game: Game): References => {
    const refs = record(document[game]);
    if (!refs || typeof refs.uid !== "string" || !Array.isArray(refs.data) || refs.data.length > publicRoleReferenceLimit ||
        refs.data.some((value: unknown) => typeof value !== "string" || !uidPattern.test(value)) ||
        new Set(refs.data).size !== refs.data.length || (refs.data.length ? !refs.data.includes(refs.uid) : refs.uid !== "")) {
      throw new TypeError($t("lib.public-role-references.text_7e556be76f"));
    }
    return { uid: refs.uid, data: refs.data as string[] };
  };
  return { gs: forGame("gs"), sr: forGame("sr"), zzz: forGame("zzz") };
}

export function createPublicRoleReferenceTarget() {
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
    if (!region) throw new TypeError($t("lib.public-role-references.text_cbee29b381"));
    return async (signal: AbortSignal) => (await provider.read({ uid, region }, signal)).rows.length;
  }
  return target;
}

export function createPublicRoleReferences(lockFile: AcquireRoleArchiveLock, directory = fileURLToPath(
  new URL("../" + publicRoleReferencePath + "/", import.meta.url)), publicTarget = createPublicRoleReferenceTarget()) {
  const archive = createRoleJsonArchive(directory, lockFile, {
    subject: $t("lib.public-role-references.text_644d7384cc"), lockSuffix: "public-role-reference", maxBytes: 8192, rejectNull: true,
  });
  const catalogue = (qq: string) => archive.read(qq, "1").then(decode);
  return Object.assign(async ({ game, action, value }: Command, { user, signal, isCurrent }: Scope) => {
    const active = () => !signal.aborted && isCurrent();
    const verify = async () => {
      if (!active()) throw new DOMException($t("lib.public-role-references.text_9cdd5bf3de"), "AbortError");
    };
    if (!active()) return;
    const prefix = prompts[game];
    const label = labels[game];
    const usage = $t("lib.public-role-references.text_a1bf286e85", { "prefix": prefix, "value2": prefix });
    if (action === "删除uid" || action === "解绑uid") {
      return $t("lib.public-role-references.text_b758fa50aa", { "prefix": prefix, "value2": prefix });
    }
    const register = action === "登记uid" || action === "登记公开uid";
    const list = action === "公开uid列表";
    const query = action === "查询公开uid";
    if (register && !uidPattern.test(value)) return usage;
    if ((list && value) || (!list && !register && !(query && !value) && !selector.test(value))) {
      return $t("lib.public-role-references.text_998a1527f9", { "prefix": prefix, "value2": prefix, "value3": prefix, "value4": prefix });
    }
    const qq = String(user);
    const read = () => catalogue(qq);
    const index = value ? Number(value) - 1 : undefined;
    try {
      if (list) {
        const entries = await read();
        await verify();
        const lines = [$t("lib.public-role-references.text_644d7384cc")];
        for (const item of games) {
          const { uid, data } = entries[item];
          lines.push(labels[item]);
          if (!data.length) lines.push($t("lib.public-role-references.text_fef982cd13"));
          for (const [position, entry] of data.entries()) lines.push(`  ${position + 1}. ${entry}${entry === uid ? $t("lib.public-role-references.text_58d8cd20d2") : ""}`);
        }
        return [...lines, $t("lib.public-role-references.text_4b12c9c2af")].join("\n");
      }
      if (query) {
        const records = (await read())[game];
        const select = (refs: References) => index === undefined ? refs.uid : refs.data[index];
        const uid = select(records);
        if (!uid) return $t("lib.public-role-references.text_229622d3e9", { "label": label, "prefix": prefix });
        const fetchPublic = await publicTarget(game, uid);
        await verify();
        if (select((await read())[game]) !== uid) return $t("lib.public-role-references.text_a96821320c");
        await verify();
        const count = await fetchPublic(signal);
        if (select((await read())[game]) !== uid) return $t("lib.public-role-references.text_a96821320c");
        await verify();
        return $t("lib.public-role-references.text_c253f4dc3d", { "label": label, "uid": uid, "value3": providers[game], "count": count });
      }
      if (register) {
        try { await publicTarget(game, value); }
        catch { return $t("lib.public-role-references.text_48a04a997f", { "label": label }); }
      }
      return await archive.update({ qq, uid: "1" }, verify, current => {
        const entries = decode(current);
        const currentGame = entries[game];
        const uid = register ? value : currentGame.data[index!];
        if (!uid) return { result: $t("lib.public-role-references.text_693ed1dd49", { "label": label, "prefix": prefix }) };
        if (register && !currentGame.data.includes(uid) && currentGame.data.length >= publicRoleReferenceLimit) return { result: $t("lib.public-role-references.text_9e31d97f64") };
        const remove = action === "删除公开uid";
        const data = remove ? currentGame.data.filter(entry => entry !== uid)
          : register && !currentGame.data.includes(uid) ? [...currentGame.data, uid] : currentGame.data;
        const next = { uid: remove ? (currentGame.uid === uid ? data[0] ?? "" : currentGame.uid) : uid, data };
        const result = remove ? $t("lib.public-role-references.text_7402c44582", { "label": label, "uid": uid })
          : $t("lib.public-role-references.text_e0f8fc8d3f", { "label": label, "uid": uid, "prefix": prefix });
        if (currentGame.uid === next.uid && currentGame.data === next.data) return { result };
        return { document: { version: 1, ...entries, [game]: next }, result };
      });
    } catch {
      if (active()) return query ? $t("lib.public-role-references.text_3db61e2041", { "label": label })
        : $t("lib.public-role-references.text_a303578e81");
    }
  }, { catalogue });
}
