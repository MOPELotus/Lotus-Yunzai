import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { stageLegacyStarRailWarpSettings } from "../lib/migration-starrail-warp-settings.ts";
import { rejectionReason } from "../lib/plugins/policy.ts";
import { createWarpSettingsStore, readWarpAllowance } from "../plugins/starrail/simulation/settings.ts";

test("migration imports effective legacy tickets, explicit zero and global recall without reviving inert group flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-legacy-star-rail-warp-"));
  const archive = join(root, "archive"), stage = join(root, "next");
  const legacy = join(archive, "flower-plugin/GachaMOD/StarRail");
  const flower = [{ path: "plugins/flower-plugin", kind: "directory", identity: "flower-plugin", status: "archive",
    reason: rejectionReason(["flower-plugin"], [])! }] as const;
  try {
    await mkdir(join(legacy, "def"), { recursive: true });
    await mkdir(join(legacy, "config"));
    await mkdir(stage);
    await writeFile(join(legacy, "def/coin.yaml"), "default: {pink: 100, blue: 10}\n77: {pink: 10, blue: 5}\n");
    await writeFile(join(legacy, "config/coin.yaml"),
      "default: {pink: 0, blue: 20, exclusive: 200}\n78: {blue: 0, normal: 910}\n");
    await writeFile(join(legacy, "config/gacha.yaml"), "delMsg: 0\n78: {delMsg: 19}\n");
    expect(await stageLegacyStarRailWarpSettings(archive, stage, flower)).toEqual({ active: true, deferred: false });
    const saved = await createWarpSettingsStore(lockFile, join(stage, "data/starrail/simulation")).read();
    expect(readWarpAllowance(saved)).toEqual({ special: 0, regular: 20, recallSeconds: 0 });
    expect(readWarpAllowance(saved, "77")).toEqual({ special: 10, regular: 5, recallSeconds: 0 });
    expect(readWarpAllowance(saved, "78")).toEqual({ special: 0, regular: 0, recallSeconds: 0 });
    await writeFile(join(legacy, "config/coin.yaml"), "default: {pink: -1}\n");
    expect(await stageLegacyStarRailWarpSettings(archive, stage, flower)).toEqual({ active: false, deferred: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
