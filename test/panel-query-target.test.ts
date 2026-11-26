import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProfileStore } from "../packages/account/index.ts";
import { createProfileHoyoClient } from "../packages/hoyo-client/index.ts";
import { panelQueryUser } from "../lib/panel-query-target.ts";
import { lockFile } from "../lib/file-lock.ts";
import { createGenshinPanelQuery } from "../plugins/genshin/panel/panel.ts";
import { createZzzPanelCommands, zzzPanelCommand } from "../plugins/zzz/panel-command.ts";
import { createModule as createStarRailModule } from "../plugins/starrail/index.ts";

test("验证@他人查询面板时的账号隔离及防止写入他人档案", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-panel-target-"));
  const previous = Bun.env.LOTUS_PROFILE_DIR;
  Bun.env.LOTUS_PROFILE_DIR = root;
  const controller = new AbortController();
  const userContext = { message_type: "group", self_id: 99, user_id: 42,
    message: [{ type: "at", qq: 99 }, { type: "at", qq: "43" }] };
  try {
    expect(panelQueryUser(userContext)).toBe(43);
    expect(panelQueryUser({ ...userContext, message_type: "private" })).toBe(42);
    expect(panelQueryUser({ ...userContext, message: [{ type: "at", qq: "all" }, { type: "at", qq: "1e3" }] })).toBe(42);
    for (const qq of [42, 43]) await writeFile(join(root, `${qq}.yaml`), [
      "version: 1", `user: {qq: ${qq}}`, "profile: {id: 1}", "account:",
      `  current_uid: {gs: '1000000${qq}', sr: '1000000${qq}', zzz: '100000${qq}'}`,
    ].join("\n"));
    const before = await readFile(join(root, "43.yaml"), "utf8");
    const profiles = createProfileStore(root);
    const client = createProfileHoyoClient(profiles, async () => { throw Error("external request"); });
    const gs = createGenshinPanelQuery(profiles, client, lockFile, controller.signal, {
      archiveDirectory: join(root, "gs"), legacyDirectory: root,
      theme: async () => ({ characters: {}, artifacts: new Map(), artifactSets: new Map(), async picture() { return; } }),
    });
    const zzz = createZzzPanelCommands(profiles, client, lockFile, controller.signal);
    const sr = createStarRailModule({ signal: controller.signal, lockFile });
    for (const [input, owner, target, run] of [
      ["#面板", "100000042", "100000043", (context: any) => gs("#面板", context)],
      ["*面板", "100000042", "100000043", (context: any) => sr.fallback!("*面板", { ...context, normalizedMessage: "*面板" })],
      ["%面板", "10000042", "10000043", (context: any) => zzz(zzzPanelCommand("%面板")!, { ...context, reply() {} })],
    ] as const) {
      const reply = await run(userContext);
      expect(typeof reply).toBe("string");
      expect(String(reply)).toContain(target);
      expect(String(reply)).not.toContain(owner);
      const own = await run({ ...userContext, message: [] });
      expect(String(own)).toContain(owner);
      const missing = await run({ ...userContext, message: [{ type: "at", qq: 44 }] });
      expect(String(missing)).not.toContain(owner);
      expect(String(missing)).not.toContain(target);
    }
    expect(await readFile(join(root, "43.yaml"), "utf8")).toBe(before);
  } finally {
    controller.abort();
    if (previous === undefined) delete Bun.env.LOTUS_PROFILE_DIR; else Bun.env.LOTUS_PROFILE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
