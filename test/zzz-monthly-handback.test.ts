import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareZzzMonthlyHandback } from "../plugins/zzz/monthly-handback.ts";
import { publishLegacyJsonExport } from "../scripts/legacy-gacha-output.ts";

const who = { qq: "42", uid: "12345678", region: "prod_gf_cn" };
const monthly = (month: string, count: number) => ({
  uid: who.uid, region: who.region, data_month: month,
  month_data: { list: [{ data_type: "PolychromesData", count }],
    income_components: [{ action: "event_rewards", num: count, percent: "80.00" }] },
});
const modern = (record: ReturnType<typeof monthly>) => ({ version: 1, ...who, months: [{ fetchedAt: 1, record }] });
const month = "202601";

async function fixture(run: (where: { managed: string; legacy: string; output: string; archive: string; snapshot: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "zzz-monthly-handback-"));
  try {
    const managed = join(root, "managed"), legacy = join(root, "legacy"), output = join(root, "out");
    const archive = join(managed, who.qq, who.uid + ".json");
    const snapshot = join(legacy, "data/ZZZ-Plugin/monthly", who.uid + ".json");
    await Promise.all([mkdir(dirname(archive), { recursive: true }), mkdir(dirname(snapshot), { recursive: true }), mkdir(output)]);
    return await run({ managed, legacy, output, archive, snapshot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("离线月报导出兼容旧年月数组，保留旧元数据并只向独立目录原子发布", async () => {
  await fixture(async ({ managed, legacy, output, archive, snapshot }) => {
    const overlapping = monthly(month, 25);
    const oldRow = { ...overlapping, uid: Number(who.uid), current_month: month, optional_month: [month, "202512"],
      additional: { exact: 1.25, label: "未重写字段" },
      month_data: { list: [{ data_type: "PolychromesData", data_name: "菲林", count: 25 }],
        income_components: [{ action: "event_rewards", num: 25, percent: 80 }] } };
    const old = JSON.stringify([oldRow, monthly("202512", 40)]);
    const current = JSON.stringify({ ...modern(overlapping), months: [
      { fetchedAt: 4, record: monthly("202602", 30) },
      { fetchedAt: 3, record: { ...overlapping, month_data: { ...overlapping.month_data, list: [
        ...overlapping.month_data.list, { data_type: "MatserTapeData", count: 0 },
      ] } } },
    ] });
    await writeFile(snapshot, old);
    await writeFile(archive, current);
    const { content, counts } = await prepareZzzMonthlyHandback({ managed, legacy, ...who });
    expect(counts).toEqual({ modern: 2, legacy: 2, total: 3 });
    expect(await readdir(output)).toEqual([]);
    expect(JSON.parse(content.toString())).toEqual([monthly("202512", 40),
      { ...oldRow, month_data: { ...oldRow.month_data, list: [...oldRow.month_data.list, { data_type: "MatserTapeData", count: 0 }] } },
      monthly("202602", 30)]);
    const [one, two] = await Promise.all([
      publishLegacyJsonExport(output, "zzz-monthly", content),
      publishLegacyJsonExport(output, "zzz-monthly", content),
    ]);
    expect(one.path).toBe(two.path);
    expect([one.written, two.written].filter(Boolean)).toHaveLength(1);
    expect(await readdir(output)).toHaveLength(1);
    expect(await readFile(one.path)).toEqual(content);
    expect(await readFile(snapshot, "utf8")).toBe(old);
    expect(await readFile(archive, "utf8")).toBe(current);
  });
});

test("离线月报遇同月真冲突、缺旧数组、归属不符和长数字时拒绝导出", async () => {
  await fixture(async ({ managed, legacy, output, archive, snapshot }) => {
    const input = { managed, legacy, ...who };
    await writeFile(archive, JSON.stringify(modern(monthly(month, 25))));
    await writeFile(snapshot, JSON.stringify([monthly(month, 26)]));
    await expect(prepareZzzMonthlyHandback(input)).rejects.toThrow("不一致的重叠值");
    await writeFile(snapshot, JSON.stringify([{ ...monthly(month, 25), month_data: undefined }]));
    await expect(prepareZzzMonthlyHandback(input)).rejects.toThrow("格式无效");
    await writeFile(snapshot, JSON.stringify([{ ...monthly(month, 25), region: "prod_qd_cn" }]));
    await expect(prepareZzzMonthlyHandback(input)).rejects.toThrow("UID 或区服");
    await writeFile(snapshot, JSON.stringify([monthly(month, 25)]).replace('"data_month"', '"unknown":900719925474099101,"data_month"'));
    await expect(prepareZzzMonthlyHandback(input)).rejects.toThrow("无法无损导出的数字");
    await writeFile(snapshot, JSON.stringify([monthly(month, 25)]));
    await writeFile(archive, JSON.stringify({ ...modern(monthly(month, 25)), qq: "43" }));
    await expect(prepareZzzMonthlyHandback(input)).rejects.toThrow("归属");
    expect(await readdir(output)).toEqual([]);
  });
});
