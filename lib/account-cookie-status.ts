import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createProfileStore } from "@lotus-yunzai/account";
import { createProfileHoyoClient } from "@lotus-yunzai/hoyo-client";

export const accountCookieStatusFeatures = [$t("lib.account-cookie-status.text_10978d99f7"), "account", "@lotus-yunzai/account"] as const;
const command = /^#\s*(?:检查(?:我的)?c(?:oo)?k(?:ie)?(?:状态)?|c(?:oo)?k(?:ie)?(?:状态)?|我的c(?:oo)?k(?:ie)?状态)$/iu;

export function matchesAccountCookieStatus(message: string) {
  return command.test(message.trim());
}

const statusLabels = {
  "not-logged-in": $t("lib.account-cookie-status.text_c1f6583730"),
  valid: $t("lib.account-cookie-status.text_776cb09f85"),
  "read-only": $t("lib.account-cookie-status.text_feb913547e"),
  recovered: $t("lib.account-cookie-status.text_65c24ea3a3"),
  expired: $t("lib.account-cookie-status.text_41738ba766"),
  unknown: $t("lib.account-cookie-status.text_792e0fc1a4"),
} as const;

export function createAccountCookieStatus(profiles: ReturnType<typeof createProfileStore>,
  client = createProfileHoyoClient(profiles)) {
  return async ({ user, signal, isCurrent }: {
    readonly user: number;
    readonly signal: AbortSignal;
    readonly isCurrent: () => boolean;
  }) => {
    const active = () => !signal.aborted && isCurrent();
    const qq = String(user);
    if (!active()) return;
    const ids = await profiles.listIds(qq).catch(() => undefined);
    if (!active()) return;
    if (!ids) return $t("lib.account-cookie-status.text_0e7147c6b4");
    if (!ids.length) return $t("lib.account-cookie-status.text_a601f3257b");

    const results: { id: number; status: keyof typeof statusLabels; revision?: string }[] = [];
    for (const id of ids) {
      if (!active()) return;
      try {
        const { kind, context } = await profiles.cookieCheckContext(qq, id);
        if (!active()) return;
        if (kind === "not-logged-in" || kind === "unverifiable") {
          results.push({ id, status: kind === "unverifiable" ? "unknown" : kind, revision: context.revision });
          continue;
        }
        const verifyReadOnly = kind === "read-only" ? async () => {
          const current = await profiles.cookieCheckContext(qq, id);
          if (!active() || current.context.revision !== context.revision) throw new DOMException($t("lib.account-cookie-status.text_001fe58ae6"), "AbortError");
        } : undefined;
        const { state, revision } = await client.checkLoginCookie(context, { signal, verifyReadOnly });
        results.push({ id, status: state === "valid" && kind === "read-only" ? kind : state, revision });
      } catch {
        if (!active()) return;
        results.push({ id, status: "unknown" });
      }
    }

    const lines = await Promise.all(results.map(async ({ id, status, revision }) => {
      const current = revision && await profiles.cookieCheckContext(qq, id).catch(() => undefined);
      return $t("lib.account-cookie-status.text_89406be5fa", { "id": id, "value2": statusLabels[(current && current.context.revision === revision) ? status : "unknown"] });
    }));
    if (active()) return [$t("lib.account-cookie-status.text_7d7db0f135"), ...lines, $t("lib.account-cookie-status.text_a36beaa8a8")].join("\n");
  };
}
