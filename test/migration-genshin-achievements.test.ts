import { expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createProfileStore } from "@lotus-yunzai/account";
import { lockFile } from "../lib/file-lock.ts";
import { createAchievementCommand } from "../plugins/genshin/achievement-command.ts";
import type { AchievementCard } from "../plugins/genshin/achievement-card.ts";
import { migrateInstallation } from "../scripts/migrate.ts";

async function put(root: string, path: string, contents: string) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents, { mode: 0o600 });
}

const firstUid = "100000002";
const secondUid = "100000003";
const refactor = "plugins/Lotus-ReFactor";
const legacyPlugin = "plugins/Lotus-Plugin";
const display = { normalizedMessage: "#成就目录", self_id: 99, user_id: 42, message_type: "private", reply() {} } as const;

function profile(qq: string, uid: string, account: string) {
  return Bun.YAML.stringify({ version: 1, user: { qq }, profile: { id: 1 }, enabled: true,
    account: { cookie: `account_id=${account};cookie_token=fixture;ltuid=${account};ltoken=fixture`,
      stuid: account, ltuid: account, stoken: "fixture", stoken_cookie: `stuid=${account};stoken=fixture`,
      game_roles: { gs: [{ uid, region: "cn_gf01", game_biz: "hk4e_cn" }] }, current_uid: { gs: uid } },
  });
}

function progress(uid: string, id: number) {
  return JSON.stringify({ version: 1, uid, updatedAt: "2024-01-05T00:00:00.000Z",
    done: { [id]: { id, date: "2024/01/05", status: 2, source: "cocogoat" } } });
}

async function prepareCatalog(root: string) {
  const pageId = "achievement/achievement";
  await put(root, "data/atlas/data/map.json", JSON.stringify({ games: { gi: { locales: { zh: { pages: {
    [pageId]: { version: "1", recordCount: 1, records: { "6": { id: "6", path: "items/sample.json", name: "尘世巡游" } } },
  } } } } } }));
  await put(root, "data/atlas/data/items/sample.json", JSON.stringify({
    meta: { gameId: "gi", pageId, recordId: "6", version: "1" },
    content: { list: { id: 6, name: "尘世巡游", list: [10, 11, 12].map(id => ({
      id, name: `独立成就 ${id}`, desc: "完成条件", reward: { item_count: 5 },
    })) } },
  }));
}

test.skipIf(!Bun.which("git"))("实际迁移后原神成就读本人已归档旧进度，写入当前档案，重跑和异常不覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-achievement-migration-"));
  const source = join(root, "old");
  const target = join(root, "new");
  const control = new AbortController();
  try {
    const oldFirst = `${refactor}/data/achievements/${firstUid}.json`;
    const oldSecond = `${legacyPlugin}/data/achievements/${secondUid}.json`;
    const first = progress(firstUid, 10), second = progress(secondUid, 11);
    await put(source, `${refactor}/package.json`, '{"name":"lotus-refactor"}');
    await put(source, `${legacyPlugin}/package.json`, '{"name":"lotus-plugin"}');
    await put(source, `${refactor}/data/users/42.yaml`, profile("42", firstUid, "920000001"));
    await put(source, `${legacyPlugin}/data/users/43.yaml`, profile("43", secondUid, "920000002"));
    await put(source, oldFirst, first);
    await put(source, oldSecond, second);
    await put(target, "package.json", '{"name":"lotus-yunzai"}');
    await put(target, "plugins/.fixture", "fixture");
    for (const args of [["init", "-q"], ["add", "package.json", "plugins/.fixture"],
      ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: target }).exitCode).toBe(0);
    }

    expect(await migrateInstallation(source, target)).toMatchObject({ status: "published", archiveCount: 2 });
    const archivedFirst = join(target, "backup", oldFirst);
    const archivedSecond = join(target, "backup", oldSecond);
    const currentFirst = join(target, "data/achievements/42", `${firstUid}.json`);
    const currentSecond = join(target, "data/achievements/43", `${secondUid}.json`);
    expect(await Bun.file(join(target, oldFirst)).exists()).toBe(false);
    expect(await Bun.file(join(target, oldSecond)).exists()).toBe(false);
    expect(await readFile(archivedFirst, "utf8")).toBe(first);
    expect(await readFile(archivedSecond, "utf8")).toBe(second);
    await prepareCatalog(target);
    const cards: AchievementCard[] = [];
    const command = createAchievementCommand(createProfileStore(join(target, "data/users")), lockFile, control.signal, {
      installationRoot: pathToFileURL(target + "/"),
      async render(card) {
        cards.push(card);
        return { png: Buffer.from("fixture"), engine: {} as never };
      },
    });

    expect(await command.main(display)).toMatchObject({ type: "image" });
    expect(cards.at(-1)).toMatchObject({ subtitle: `UID ${firstUid}`, badge: "1/3" });
    expect(await command.main({ ...display, user_id: 43 })).toMatchObject({ type: "image" });
    expect(cards.at(-1)).toMatchObject({ subtitle: `UID ${secondUid}`, badge: "1/3" });
    expect(await command.main({ ...display, user_id: 44 })).toContain("请先登录");
    expect(await command.main({ ...display, isDelegated: true })).toContain("本人 QQ");
    expect(await Bun.file(currentFirst).exists()).toBe(false);

    const newProgress = JSON.stringify({ uid: firstUid, info: { export_app: "cocogoat" }, list: [{ id: 12, status: 3 }] });
    expect(await command.main({ ...display, normalizedMessage: `#成就导入 ${secondUid} ${newProgress}` })).toContain("UID");
    expect(await Bun.file(currentSecond).exists()).toBe(false);
    expect(await command.main({ ...display, normalizedMessage: `#成就导入 ${newProgress}` })).toMatchObject({ type: "image" });
    expect(cards.at(-1)?.badge).toBe("+1");
    const current = await readFile(currentFirst, "utf8");
    expect(JSON.parse(current)).toMatchObject({ uid: firstUid, done: {
      "10": { id: 10, date: "2024/01/05", status: 2 }, "12": { id: 12, status: 3 },
    } });
    expect(await readFile(archivedFirst, "utf8")).toBe(first);
    expect(await readFile(join(source, oldFirst), "utf8")).toBe(first);
    expect(await migrateInstallation(source, target)).toMatchObject({ status: "already-published", archiveCount: 2 });
    expect(await readFile(currentFirst, "utf8")).toBe(current);

    await writeFile(archivedFirst, "旧文件损坏");
    expect(await command.main(display)).toMatchObject({ type: "image" });
    expect(cards.at(-1)?.badge).toBe("2/3");
    await writeFile(archivedSecond, progress(firstUid, 10));
    expect(await command.main({ ...display, user_id: 43 })).toContain("UID");
    await rm(archivedSecond);

    const outside = join(root, "outside.json");
    await writeFile(outside, second);
    await symlink(outside, archivedSecond);
    expect(await command.main({ ...display, user_id: 43 })).toContain("无链接");
    await rm(archivedSecond);
    await link(outside, archivedSecond);
    expect(await command.main({ ...display, user_id: 43 })).toContain("无链接");
    expect(await Bun.file(currentSecond).exists()).toBe(false);
    expect(await readFile(outside, "utf8")).toBe(second);
    await rm(archivedSecond);
    await rmdir(dirname(archivedSecond));
    await put(root, `outside-tree/${secondUid}.json`, second);
    await symlink(join(root, "outside-tree"), dirname(archivedSecond), "dir");
    expect(await command.main({ ...display, user_id: 43 })).toContain("无链接");
    expect(await Bun.file(currentSecond).exists()).toBe(false);
  } finally {
    control.abort();
    await rm(root, { recursive: true, force: true });
  }
});
