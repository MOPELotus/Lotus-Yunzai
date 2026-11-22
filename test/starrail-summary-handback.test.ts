import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { starRailGachaPools } from "../packages/hoyo-client/starrail-gacha.ts";
import { parseStarRailSummary, prepareStarRailSummaryHandback } from "../lib/starrail-summary-handback.ts";

const identity = { qq: "42", uid: "512345678", region: "prod_qd_cn" } as const;
const pool = "GachaType_AvatarUp";
const time = "2026-11-21 04:04:04";
const first = { id: "1735853810000001901", uuid: "one", item: { item_id: 1001 }, got_item: null, is_up: true, gacha_count: 18 };
const modern = { id: "1735853810000001902", uuid: "two", item: { item_id: 1002 }, got_item: null, time, gacha_count: 19 };
const rewritten = { id: modern.id, uuid: modern.uuid, item: modern.item, got_item: null, is_up: false, gacha_count: 19 };
const oldAdded = { id: "1735853810000001903", uuid: "three", item: { item_id: 1003 }, got_item: null, is_up: false, gacha_count: 20 };

function summary(rows: readonly unknown[], total: number, updatedAt = "2026-11-21T04:05:00.000Z") {
  return {
    ...identity, version: 1, source: "mihoyo_star_rail_gacha_miniapp", profileId: 2, updatedAt,
    brief: { version_id: "1.0", items: [] },
    pools: Object.fromEntries(Object.entries(starRailGachaPools).map(([type, name]) => [type, {
      name, cards: type === pool ? [{ gacha_id: "1500", total_count: total, up_count: 0 }] : [],
      cardCounters: type === pool ? { "1500": total } : {}, totalDraws: type === pool ? total : 0,
      pity: 0, fiveStars: type === pool ? rows : [],
    }])),
  };
}

const seed = summary([first], 20, "2026-11-21T04:04:00.000Z");
const handedBack = summary([modern, first], 21);
const continued = summary([oldAdded, rewritten, first], 22, "2026-11-21T04:06:00.000Z");

test("official summaries hand back unchanged and restore newer old statistics with modern metadata", () => {
  expect(prepareStarRailSummaryHandback(seed, handedBack, identity, "to-old")).toEqual({
    counts: { retained: 1, added: 1, restoredTimes: 0, restoredUnknownUp: 0 }, document: undefined,
  });
  expect(prepareStarRailSummaryHandback(handedBack, handedBack, identity, "to-modern").document).toBeUndefined();
  const result = prepareStarRailSummaryHandback(handedBack, continued, identity, "to-modern");
  expect(result.counts).toEqual({ retained: 2, added: 1, restoredTimes: 1, restoredUnknownUp: 1 });
  expect(result.document).toEqual({ ...continued, pools: {
    ...continued.pools, [pool]: { ...continued.pools[pool], fiveStars: [oldAdded, modern, first] },
  } });
  expect(continued.pools[pool]?.fiveStars[1]).toEqual(rewritten);
});

test("official summary transfer rejects branches, downgraded totals, aliases, credentials and incompatible identities", () => {
  for (const later of [
    summary([oldAdded, first], 22),
    summary([oldAdded, rewritten, first], 20),
    summary([oldAdded, { ...rewritten, time: "2025-01-01 08:00:00" }, first], 22),
    summary([oldAdded, { ...rewritten, is_up: true }, first], 22),
    summary([oldAdded, { ...rewritten, uuid: first.uuid }, first], 22),
    summary([oldAdded, { ...rewritten, id: oldAdded.id }, first], 22),
    { ...continued, profileId: 3 }, { ...continued, region: "prod_gf_cn" }, { ...continued, version: 4 },
  ]) {
    expect(() => prepareStarRailSummaryHandback(handedBack, later, identity, "to-modern")).toThrow();
  }
  expect(() => parseStarRailSummary(Buffer.from('{"nested":{"cookie_token":"fixture-private"}}'))).toThrow("格式、档案或区服无效");
});

test("offline CLI exports only a content-addressed independent file and preserves both frozen inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-sr-summary-"));
  try {
    const before = join(root, "before"), after = join(root, "after"), output = join(root, "output");
    const names = [before, after].map(path => join(path, identity.qq, `${identity.uid}.json`));
    const bytes = [handedBack, continued].map(value => JSON.stringify(value) + "\r\n");
    await Promise.all([mkdir(output), ...names.map(path => mkdir(dirname(path), { recursive: true }))]);
    await Promise.all(names.map((path, index) => writeFile(path, bytes[index]!)));
    const run = async (command: readonly string[]) => {
      const child = Bun.spawn([process.execPath, "--no-env-file", "scripts/prepare-legacy-star-rail-summary.ts", ...command], {
        stdout: "pipe", stderr: "pipe", stdin: "ignore",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    };
    const args = [before, after, identity.qq, identity.uid, identity.region];
    expect((await run(["to-modern", ...args])).code).toBe(0);
    expect(await readdir(output)).toEqual([]);
    const result = await run(["to-modern", "--export", output, ...args]);
    expect(result.code).toBe(0);
    const wrote = JSON.parse(result.stdout);
    expect(wrote.written).toBe(true);
    expect(wrote.path).toBe(join(output, `starrail-summary-${wrote.outputSHA256}.json`));
    expect((await lstat(wrote.path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(wrote.path, "utf8")).pools[pool].fiveStars).toEqual([oldAdded, modern, first]);
    expect(JSON.parse((await run(["to-modern", "--export", output, ...args])).stdout).written).toBe(false);
    expect((await run(["to-modern", "--export", root, ...args])).code).toBe(1);
    expect(await Promise.all(names.map(path => readFile(path, "utf8")))).toEqual(bytes);
    const replacement = join(root, "aliased");
    await mkdir(join(replacement, identity.qq), { recursive: true });
    await symlink(names[1]!, join(replacement, identity.qq, `${identity.uid}.json`));
    expect((await run(["to-modern", before, replacement, identity.qq, identity.uid, identity.region])).code).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
