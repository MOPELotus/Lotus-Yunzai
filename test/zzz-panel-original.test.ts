import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zzzPanelCommand } from "../plugins/zzz/panel-command.ts";
import { createZzzPanelOriginalLedger, loadZzzPanelOriginal, readZzzPanelOriginal } from "../plugins/zzz/panel-original.ts";

const group = { message_type: "group", self_id: 99, group_id: 77, user_id: 42 } as const;
const binding = { profileId: 2, uid: "12345678", region: "prod_gf_cn" };
const original = { path: "images/panel/琉音/本地原画.png", sha256: "a".repeat(64) };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQIW2P8/x8AAwMCAO+a2e8AAAAASUVORK5CYII=", "base64");

test("沿用引用面板的原图指令，未加游戏前缀或附带 UID 的文本不进入", () => {
  expect(zzzPanelCommand("%原图")).toEqual({ kind: "original" });
  expect(zzzPanelCommand("#ZZZ原图")).toEqual({ kind: "original" });
  for (const command of ["原图", "#原图", "%原图2", "%原图 https://example.invalid/file"]) {
    expect(zzzPanelCommand(command)).toBeUndefined();
  }
});

test("仅用真实回执绑定原图，按机器人、协议、会话、本人和三小时 TTL 查找", async () => {
  const data = new Map<string, string>();
  const ttl: number[] = [];
  const storage = {
    async get(key: string) { return data.get(key); },
    async set(key: string, value: string, seconds: number) { data.set(key, value); ttl.push(seconds); },
  };
  let now = 100;
  const signal = new AbortController();
  const ledger = createZzzPanelOriginalLedger(storage, signal.signal, () => now);
  expect(await ledger.find(group, "-12")).toBeUndefined();
  await ledger.delivered(group, -12, binding, original);
  expect(ttl).toEqual([10_800]);
  expect(await ledger.find(group, "-12")).toMatchObject({ ...binding, original });
  for (const context of [
    { ...group, group_id: 78 }, { ...group, user_id: 43 }, { ...group, self_id: 100 },
    { ...group, adapter: "milky" }, { ...group, message_type: "private" }, { ...group, isDelegated: true },
  ]) expect(await ledger.find(context, "-12")).toBeUndefined();
  const milky = { ...group, adapter: "milky" };
  await ledger.delivered(milky, 0, binding, original);
  expect(await ledger.find(milky, "0")).toMatchObject({ ...binding, original });
  const restarted = createZzzPanelOriginalLedger(storage, signal.signal, () => now);
  expect(await restarted.find(group, -12)).toMatchObject({ ...binding, original });
  now += 10_800_000;
  expect(await restarted.find(group, -12)).toBeUndefined();
  signal.abort();
  expect(await ledger.find(milky, 0)).toBeUndefined();
});

test("只接受经过解码的本地图中立绘，保留原字节并拒绝替换、外逃路径和方形头像", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-zzz-original-test-"));
  try {
    const resources = join(root, "resources");
    const file = join(resources, original.path);
    await mkdir(join(resources, "images", "panel", "琉音"), { recursive: true });
    await mkdir(join(resources, "images", "square_avatar"));
    await writeFile(file, png);
    const valid = await loadZzzPanelOriginal(resources, [original.path]);
    expect(valid?.image.width).toBe(1);
    expect(await readZzzPanelOriginal(resources, valid!.original)).toEqual(png);
    await writeFile(file, Buffer.from("changed source"));
    expect(await readZzzPanelOriginal(resources, valid!.original)).toBeUndefined();
    expect(await loadZzzPanelOriginal(resources, [original.path])).toBeUndefined();
    const outside = join(root, "private.png");
    await writeFile(outside, png);
    await symlink(outside, join(resources, "images", "panel", "琉音", "逃逸.png"));
    expect(await loadZzzPanelOriginal(resources, ["images/panel/琉音/逃逸.png"])).toBeUndefined();
    expect(await readZzzPanelOriginal(resources, { ...original, path: "../private.png" })).toBeUndefined();
    const square = "images/square_avatar/role_square_avatar_1151.png";
    await writeFile(join(resources, square), png);
    expect(await loadZzzPanelOriginal(resources, [square])).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
