import { createTranslator } from "../packages/i18n/index.ts";
import catalog from "../i18n/zh-CN.json";
import type { Game } from "@lotus-yunzai/account";
import { createPublicRoleReferenceTarget } from "./public-role-references.ts";

const $t = createTranslator("core", catalog.messages);
const names = { 原神: "gs", 星铁: "sr", 绝区零: "zzz" } as const;
const labelKeys = { gs: "lib.public-role-references.text_d1597c51ed", sr: "lib.public-role-references.text_a2927891f0", zzz: "lib.public-role-references.text_b1110352c9" } as const;
const providers = { gs: "Enka", sr: "Mihomo", zzz: "Enka" } as const;
const prefixes = { gs: "#", sr: "*", zzz: "%" } as const;
const prefix = "(?:#(?:(原神|星铁|绝区零))?|([*＊%％]))";
const temporaryQuery = new RegExp(`^${prefix}查询公开UID(.*)$`, "iu");
const oldReference = new RegExp(`^${prefix}(?:登记(?:公开)?UID|公开UID列表|切换公开UID|删除公开UID|(?:删除|解绑)UID)(?:[\\s\\S]*)$`, "iu");
const oldBinding = new RegExp(`^${prefix}(?:绑定|设置|切换|验证|取消验证)(?:原神|星铁|崩铁|绝区零|绝)?UID(?:[\\s\\S]*)$`, "iu");
const uidPattern = /^[1-9]\d{7,9}$/u;

/** Old persistent UID selection never creates another account binding. */
export function matchRetiredUidCommand(input: string): boolean {
  const command = input.trim();
  return oldReference.test(command) || oldBinding.test(command);
}

export function retiredUidMessage(): string {
  return $t("lib.uid-commands.retired");
}

export interface PublicUidQuery { readonly game: Game; readonly uid?: string }

/** An explicit UID is required; old list indices and empty input are usage requests. */
export function matchPublicUidQuery(input: string): PublicUidQuery | undefined {
  const match = temporaryQuery.exec(input.trim());
  if (!match) return;
  const game = match[1] ? names[match[1] as keyof typeof names] : match[2] === "*" || match[2] === "＊" ? "sr"
    : match[2] === "%" || match[2] === "％" ? "zzz" : "gs";
  const value = match[3]!.trim();
  return { game, uid: uidPattern.test(value) ? value : undefined };
}

type Scope = { readonly user: number; readonly signal: AbortSignal; readonly isCurrent: () => boolean };
export function createPublicUidQuery(target = createPublicRoleReferenceTarget()) {
  return async (command: PublicUidQuery, scope: Scope): Promise<string | undefined> => {
    const active = () => !scope.signal.aborted && scope.isCurrent() && Number.isSafeInteger(scope.user) && scope.user > 0;
    if (!active()) return;
    const { game, uid } = command;
    if (!uid || !uidPattern.test(uid)) return $t("lib.uid-commands.public-usage", { prefix: prefixes[game] });
    try {
      const request = await target(game, uid);
      if (!active()) return;
      const count = await request(scope.signal);
      if (!active()) return;
      return $t("lib.uid-commands.public-result", { game: $t(labelKeys[game]), uid, provider: providers[game], count });
    } catch {
      if (active()) return $t("lib.uid-commands.public-failure", { game: $t(labelKeys[game]) });
    }
  };
}
