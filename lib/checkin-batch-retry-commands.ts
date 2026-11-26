import { createTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
import type { createProfileStore } from "../packages/account/index.ts";
import type { CommandModule } from "./commands.ts";
import type { MessageReply } from "./messages.ts";
import { isCheckinCommandOwner } from "./command-permissions.ts";
import { checkinScheduleClock } from "./checkin-schedule-plan.ts";

interface Options {
  profiles: Pick<ReturnType<typeof createProfileStore>, "listCheckinProfiles" | "checkinSettings">;
  signal: AbortSignal;
  completedToday: (qq: string, profileId: number) => Promise<boolean>;
  run: (qq: string, id: number, input: {
    signal: AbortSignal;
    verifySession: () => Promise<void>;
    notify?: (message: string) => unknown;
  }) => Promise<{
    status: "busy" | "complete";
    ok?: boolean;
    reply?: MessageReply;
    revision?: string;
  }>;
  deliver: (qq: string, id: number, reply: MessageReply, revision: string) => Promise<unknown>;
  now?: () => number;
}

const $t = createTranslator("core", messageCatalog.messages);
const prefix = "lib.checkin-batch-retry-commands.";

export function checkinBatchRetryCommands(options: Options): CommandModule {
  let running = false;
  const now = options.now ?? Date.now;
  return {
    name: "checkin-batch-retry",
    commands: {},
    async fallback(_message, context) {
      if (context.normalizedMessage !== "#全部补签" || options.signal.aborted) return;
      if (!isCheckinCommandOwner(context)) {
        return $t(`${prefix}denied`);
      }
      if (running) return $t(`${prefix}busy`);
      running = true;
      const counts = { total: 0, success: 0, failed: 0, skipped: 0, busy: 0, notifyFailed: 0 };
      let outcome: "summary" | "empty" | "interrupted" | "failed" = "summary";
      try {
        const signal = AbortSignal.any([
          options.signal,
          ...(context.privateCredentialSignal ? [context.privateCredentialSignal] : []),
        ]);
        const date = checkinScheduleClock(now()).date;
        const verify = async (): Promise<void> => {
          if (signal.aborted || checkinScheduleClock(now()).date !== date ||
              !isCheckinCommandOwner(context)) {
            throw new DOMException("", "AbortError");
          }
        };
        try {
          await verify();
          try { await context.reply($t(`${prefix}started`)); } catch {}
          await verify();
          const profiles = await options.profiles.listCheckinProfiles();
          await verify();
          const seen = new Set<string>();
          for (const { qq, profileId } of profiles) {
            await verify();
            const key = JSON.stringify([qq, profileId]);
            if (seen.has(key)) continue;
            seen.add(key);
            let notificationFailed = false;
            try {
              const settings = await options.profiles.checkinSettings(qq, profileId);
              await verify();
              if (!settings.enabled) continue;
              counts.total++;
              const completed = await options.completedToday(qq, profileId);
              await verify();
              if (completed) { counts.skipped++; continue; }
              const verifySession = async (): Promise<void> => {
                await verify();
                const latest = await options.profiles.checkinSettings(qq, profileId);
                await verify();
                if (!latest.enabled) throw new Error();
              };
              await verifySession();
              const result = await options.run(qq, profileId, {
                signal,
                verifySession,
                notify: async (message) => {
                  try {
                    await verifySession();
                    const latest = await options.profiles.checkinSettings(qq, profileId);
                    await verify();
                    if (!latest.enabled || latest.revision === undefined) throw new Error();
                    await options.deliver(qq, profileId, message, latest.revision);
                  } catch {
                    await verify();
                    notificationFailed = true;
                  }
                },
              });
              if (result.status === "busy") { counts.busy++; await verify(); continue; }
              if (result.ok) counts.success++; else counts.failed++;
              await verify();
              if (result.reply && result.revision !== undefined) {
                try {
                  await verify();
                  await options.deliver(qq, profileId, result.reply, result.revision);
                } catch {
                  await verify();
                  notificationFailed = true;
                }
              }
            } catch {
              await verify();
              counts.failed++;
            } finally {
              if (notificationFailed) counts.notifyFailed++;
            }
          }
          await verify();
          if (counts.total === 0 && counts.failed === 0) outcome = "empty";
        } catch {
          try { await verify(); outcome = "failed"; }
          catch { outcome = "interrupted"; }
        }
        return $t(`${prefix}${outcome}`, counts);
      } finally {
        running = false;
      }
    },
  };
}
