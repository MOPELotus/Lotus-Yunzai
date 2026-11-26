import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gameCheckinCommands } from "../lib/game-checkin-commands.ts";
import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";
import type { MessageFallbackContext } from "../lib/commands.ts";

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-checkin-all-"));
  try {
    for (const [qq, id, loggedIn] of [["42", 1, true], ["42", 2, true], ["42", 3, false], ["43", 1, true]] as const) {
      await writeFile(join(directory, `${qq}${id === 1 ? "" : `-${id}`}.yaml`), Bun.YAML.stringify({
        version: 1, user: { qq }, profile: { id }, enabled: false,
        account: loggedIn ? { cookie: "cookie_token=fixture", stoken: "fixture" } : {},
      }));
    }
    await run(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
function context(reply: MessageFallbackContext["reply"], user = 42): MessageFallbackContext {
  return { normalizedMessage: "#全部签到", user_id: user, self_id: 99, message_type: "group",
    isMaster: false, isBotMaster: () => false, reply };
}

test("personal batch only visits own logged-in profiles, including unregistered profiles, and continues after one failure", async () => {
  await fixture(async directory => {
    const calls: string[] = [], replies: unknown[] = [];
    const commands = gameCheckinCommands(directory, new AbortController().signal, {
      scheduleStore: createCheckinScheduleStore(join(directory, "schedules")),
      async prepareDevice(qq, id) { calls.push(`${qq}/${id}`); throw new Error("fixture private failure"); },
    });
    expect(await commands.fallback!("#全部签到", context(message => { replies.push(message); return true; }))).toBeUndefined();
    expect(calls).toEqual(["42/1", "42/2"]);
    expect(replies).toHaveLength(2);
    expect(JSON.stringify(replies)).not.toContain("private failure");
  });
});

test("batch rejects overlapping work and releases its slot after abort", async () => {
  await fixture(async directory => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const controller = new AbortController();let calls = 0;
    const commands = gameCheckinCommands(directory, controller.signal, {
      scheduleStore: createCheckinScheduleStore(join(directory, "schedules")),
      async prepareDevice() { calls++; entered.resolve(); await release.promise; throw new Error(); },
    });
    const ctx = context(() => true);
    const first = commands.fallback!("#全部签到", ctx);
    await entered.promise;
    expect(await commands.fallback!("#全部签到", ctx)).toBeString();
    expect(calls).toBe(1);
    controller.abort();release.resolve();await first;
    expect(calls).toBe(1);
  });
});

test("empty account produces a login hint and unrelated commands stay unhandled", async () => {
  await fixture(async directory => {
    const commands = gameCheckinCommands(directory, new AbortController().signal);
    expect(await commands.fallback!("#全部签到", context(() => true, 44))).toContain("#登录列表");
    const ctx = { ...context(() => true), normalizedMessage: "#其它指令", user_id: undefined };
    expect(await commands.fallback!(ctx.normalizedMessage, ctx)).toBeUndefined();
  });
});
