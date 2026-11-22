import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkinHandbackVersions, prepareLegacyCheckinSchedule } from "../lib/checkin-schedule-handback.ts";
import { isCheckinScheduleDate, parseCheckinSchedulePlan } from "../lib/checkin-schedule-plan.ts";
import { move, syncDirectory, writeJournal } from "../lib/filesystem-transaction.ts";
import { parseWriteStateJson, prepareLegacyRedeemWriteState, prepareLegacyShopWriteState } from "../lib/legacy-write-state.ts";
import { readMigrationSourceFile } from "../lib/migration-files.ts";
import { containsPath } from "./legacy-gacha-output.ts";

const maximumFile = 4 * 1024 * 1024;
const maximumTotal = 128 * 1024 * 1024;
const redeem = "data/redeemCodes/auto.json";
const shop = "data/coinShop/plans.json";

async function directory(path: string, optional = false) {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (!optional || error.code !== "ENOENT") throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory() || await realpath(path) !== path) throw new Error("交还须使用不含目录链接的实体副本。");
  return path;
}

async function dates(root: string) {
  const path = await directory(join(root, "data", "schedules"), true);
  if (!path) return [];
  const names = await readdir(path);
  return names.filter(name => name.endsWith(".json") && isCheckinScheduleDate(name.slice(0, -5))).map(name => name.slice(0, -5));
}

function hash(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

const args = process.argv.slice(2);
const exporting = args[0] === "--export";
const [out, modernInput, oldInput, version] = exporting ? args.slice(1) : [undefined, ...args];
const target = checkinHandbackVersions.find(candidate => candidate === version);
if (!modernInput || !oldInput || !target || args.length !== (exporting ? 5 : 3) ||
    [out, modernInput, oldInput].some(path => path?.startsWith("--"))) {
  console.error("用法：bun scripts/prepare-legacy-write-state.ts [--export <独立导出目录>] <新版安装副本> <旧荷花插件副本> <e28c6df|5aa3a70>");
  process.exitCode = 2;
} else {
  try {
    const [modern, old, parent] = await Promise.all([realpath(modernInput), realpath(oldInput), out ? realpath(out) : undefined]);
    const roots = parent ? [modern, old, parent] : [modern, old];
    if (roots.some((left, index) => roots.some((right, other) => other !== index && containsPath(left, right)))) {
      throw new Error("新旧副本和导出目录须彼此独立。");
    }
    await Promise.all(roots.map(root => directory(root)));
    await Promise.all([modern, old].flatMap(root => ["data", "data/coinShop", "data/redeemCodes"]
      .map(path => directory(join(root, path), true))));
    const schedules = [...new Set((await Promise.all([dates(modern), dates(old)])).flat())].sort();
    const inventory: { root: string; file: string; sha256: string | null }[] = [];
    const output = new Map<string, object>();
    const manifest: Record<string, { modern: string | null; legacy: string | null; output: string }> = {};
    let readBytes = 0;

    async function read(root: string, file: string) {
      const source = await readMigrationSourceFile(root, join(root, file), maximumFile);
      readBytes += source?.bytes.byteLength ?? 0;
      if (readBytes > maximumTotal) throw new Error("交还副本超过单批读取上限。");
      const sha256 = source ? hash(source.bytes) : null;
      inventory.push({ root, file, sha256 });
      return { sha256, state: source ? parseWriteStateJson(source.bytes) : undefined };
    }

    async function prepare<T extends { data: object }>(file: string, transform: (modern: unknown, legacy: unknown) => T | Promise<T>) {
      const [candidate, previous] = await Promise.all([read(modern, file), read(old, file)]);
      if (!candidate.sha256 && !previous.sha256) return;
      const { data, ...counts } = await transform(candidate.state, previous.state);
      const serialized = JSON.stringify(data);
      if (Buffer.byteLength(serialized) > maximumFile) throw new Error("交还输出超过目标账本大小上限。");
      output.set(file, data);
      manifest[file] = { modern: candidate.sha256, legacy: previous.sha256, output: hash(serialized) };
      return counts;
    }

    const redeemReport = await prepare(redeem, prepareLegacyRedeemWriteState);
    const shopReport = await prepare(shop, prepareLegacyShopWriteState);
    const checkinReports = [];
    const now = Date.now();
    for (const date of schedules) {
      const report = await prepare(`data/schedules/${date}.json`, async (current, legacy) => {
        const previous = legacy === undefined ? undefined : parseCheckinSchedulePlan(legacy);
        const source = current === undefined ? previous! : parseCheckinSchedulePlan(current);
        if (source.date !== date || (previous && previous.date !== date)) throw new Error("签到计划日期与文件名不一致。");
        const { plan, counts } = await prepareLegacyCheckinSchedule(source, previous, target, { now });
        return { data: plan, ...counts };
      });
      if (report) checkinReports.push({ date, ...report });
    }
    const result = { version: 1, target, files: manifest };
    let written: string | undefined;
    if (parent && output.size) {
      const stage = await mkdtemp(join(parent, ".legacy-write-state-"));
      try {
        const directories = new Set<string>();
        for (const [file, value] of output) {
          const containing = dirname(join(stage, file));
          if (!directories.has(containing)) {
            await mkdir(containing, { recursive: true, mode: 0o700 });
            directories.add(containing);
          }
          await writeJournal(join(stage, file), value, true);
        }
        for (const { root, file, sha256 } of inventory) {
          const source = await readMigrationSourceFile(root, join(root, file), maximumFile);
          if ((source ? hash(source.bytes) : null) !== sha256) throw new Error("交还副本在导出期间发生变化。");
        }
        const checkedDates = [...new Set((await Promise.all([dates(modern), dates(old)])).flat())].sort();
        if (checkedDates.join() !== schedules.join()) throw new Error("签到计划在导出期间发生变化。");
        await syncDirectory(join(stage, "data"));
        await writeJournal(join(stage, "manifest.json"), result, true);
        written = join(parent, "legacy-write-state-" + randomUUID());
        await move(stage, written);
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    }
    console.log(JSON.stringify({ mode: exporting ? "export" : "dry-run", ...result,
      redeem: redeemReport, shop: shopReport, schedules: checkinReports, path: written }));
  } catch (error) {
    console.error(error instanceof Error && !(error instanceof SyntaxError) && !("code" in error)
      ? error.message : "无法核验交还副本或写入独立目录。");
    process.exitCode = 1;
  }
}
