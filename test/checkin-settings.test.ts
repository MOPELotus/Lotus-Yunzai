import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "../packages/account/index.ts";

const qq = "100001";
const fixture = {
  version: 1, enabled: false,
  user: { qq }, profile: { id: 2, name: "另一个档案", notify: { fallback_groups: ["123"] } },
  account: { cookie: "cookie_token=fixture", stoken_cookie: "stoken=fixture", ltoken: "fixture" },
  schedule: { mode: "fixed", fixed_time: "08:00" },
  games: { cn: { genshin: { checkin: false, black_list: ["100000001"] } } },
  extra: { retained: true },
};

async function withProfile(
  run: (store: ReturnType<typeof createProfileStore>, path: string, root: string) => Promise<void>,
  document: unknown = fixture,
) {
  const root = await mkdtemp(join(tmpdir(), "lotus-checkin-settings-"));
  const path = join(root, `${qq}-2.yaml`);
  try {
    await writeFile(path, Bun.YAML.stringify(document));
    await run(createProfileStore(root), path, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("只设置指定档案顶层开关，保留配置，重复操作沿用原 revision", async () => {
  await withProfile(async (store, path, root) => {
    const otherPath = join(root, `${qq}.yaml`);
    const other = Bun.YAML.stringify({ ...fixture, profile: { id: 1 }, enabled: true });
    await writeFile(otherPath, other);
    const state = await store.checkinSettings(qq, 2);
    expect(state).toMatchObject({ enabled: false, loggedIn: true });

    const enabled = await store.setCheckinEnabled(qq, 2, state.revision, true);
    expect(enabled).toEqual({ enabled: true, changed: true, revision: expect.any(String) });
    expect(enabled.revision).not.toBe(state.revision);
    const saved = await readFile(path, "utf8");
    expect(Bun.YAML.parse(saved)).toEqual({ ...fixture, enabled: true });
    expect(await store.setCheckinEnabled(qq, 2, enabled.revision, true))
      .toEqual({ enabled: true, changed: false, revision: enabled.revision });
    expect(await readFile(path, "utf8")).toBe(saved);
    await expect(store.setCheckinEnabled(qq, 2, state.revision, true)).rejects.toMatchObject({ code: "changed" });

    expect(await store.setCheckinEnabled(qq, 2, enabled.revision, false))
      .toMatchObject({ enabled: false, changed: true });
    expect(Bun.YAML.parse(await readFile(path, "utf8"))).toEqual(fixture);
    expect(await readFile(otherPath, "utf8")).toBe(other);
  });
});

test("拒绝开启未登录档案和创建缺失档案，已注册档案退出登录后仍可取消", async () => {
  await withProfile(async (store, path, root) => {
    const state = await store.checkinSettings(qq, 2);
    expect(state).toMatchObject({ enabled: true, loggedIn: false });
    const original = await readFile(path, "utf8");
    await expect(store.setCheckinEnabled(qq, 2, state.revision, true)).rejects.toMatchObject({ code: "login-required" });
    expect(await readFile(path, "utf8")).toBe(original);

    await expect(store.setCheckinEnabled(qq, 3, state.revision, true)).rejects.toMatchObject({ code: "missing" });
    await expect(createProfileStore(join(root, "missing")).setCheckinEnabled(qq, 2, state.revision, false))
      .rejects.toMatchObject({ code: "missing" });
    expect(await readdir(root)).toEqual([`${qq}-2.yaml`]);

    expect(await store.setCheckinEnabled(qq, 2, state.revision, false))
      .toMatchObject({ enabled: false, changed: true });
  }, { ...fixture, enabled: true, account: { cookie: "cookie_token=fixture" } });
});

test("自动签到开关与 Cookie/角色写入共享 revision 锁，冲突后重读保存可保全两种更新", async () => {
  await withProfile(async (store, path, root) => {
    const secondStore = createProfileStore(root);
    const { revision } = await store.checkinSettings(qq, 2);
    const refreshed = { cookie: "cookie_token=updated", ltoken: "updated" };
    const result = await Promise.allSettled([
      store.setCheckinEnabled(qq, 2, revision, true),
      secondStore.saveRefreshedCredentials(qq, 2, revision, refreshed),
    ]);
    expect(result.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const afterRace = await store.checkinSettings(qq, 2);
    if (result[0].status === "rejected") {
      expect(result[0].reason).toMatchObject({ code: "changed" });
      await store.setCheckinEnabled(qq, 2, afterRace.revision, true);
    }
    if (result[1].status === "rejected") {
      expect(result[1].reason).toMatchObject({ code: "changed" });
      await secondStore.saveRefreshedCredentials(qq, 2, afterRace.revision, refreshed);
    }

    const { revision: roleRevision } = await store.checkinSettings(qq, 2);
    await secondStore.saveRoles(qq, 2, roleRevision, {
      gs: [{ uid: "100000001", region: "cn_gf01", gameBiz: "hk4e_cn", chosen: true, nickname: "合成角色" }],
      sr: [], zzz: [],
    });
    await expect(store.setCheckinEnabled(qq, 2, roleRevision, false)).rejects.toMatchObject({ code: "changed" });
    const latest = await store.checkinSettings(qq, 2);
    expect(latest.enabled).toBe(true);
    await store.setCheckinEnabled(qq, 2, latest.revision, false);
    expect(Bun.YAML.parse(await readFile(path, "utf8"))).toMatchObject({
      enabled: false,
      account: { ...refreshed, game_roles: { gs: [{ uid: "100000001" }] }, current_uid: { gs: "100000001" } },
    });
  });
});

test("签到计划只读取同路径身份的实际档案及其非敏感设置", async () => {
  await withProfile(async (store, path, root) => {
    await writeFile(join(root, `${qq}.yaml`), Bun.YAML.stringify({
      ...fixture, enabled: true, profile: { id: 1, name: "fixture-private" },
      schedule: { mode: "fixed", fixed_time: "4:30", allow_random: false },
    }));
    await writeFile(join(root, "100008.yaml"), Bun.YAML.stringify(fixture));
    await writeFile(join(root, `${qq}-1.yaml`), Bun.YAML.stringify(fixture));
    await symlink(path, join(root, "100009-2.yaml"));
    expect(await store.listCheckinProfiles()).toEqual([
      { qq, profileId: 1, enabled: true, loggedIn: true, name: "",
        schedule: { mode: "fixed", fixedTime: "04:30", allowRandom: false } },
      { qq, profileId: 2, enabled: false, loggedIn: true, name: "另一个档案",
        schedule: { mode: "fixed", fixedTime: "08:00", allowRandom: true } },
    ]);
    expect(await store.listIds(qq)).toEqual([1, 2]);
    expect(await createProfileStore(join(root, "missing")).listCheckinProfiles()).toEqual([]);
  });
});
