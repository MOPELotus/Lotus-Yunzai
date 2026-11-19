import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore, type ProfileCheckinSettingsChange } from "../packages/account/index.ts";

const qq = "100001";
const profileId = 2;
const fixture = {
  version: 1, enabled: true,
  user: { qq },
  profile: { id: profileId, name: "测试档案", notify: { enable: true, prefer: "private", fallback_groups: ["500", 600], channel_extra: "保留" } },
  schedule: { mode: "fixed", fixed_time: "07:30", allow_random: false, window_extra: "保留" },
  games: {
    cn: { enable: true, ua_mode: "device", genshin: { checkin: false, black_list: ["100000001"] }, honkai2: { checkin: true, extra: "保留" } },
    os: { enable: true, cookie: "合成海外", genshin: { checkin: true } },
  },
  mihoyobbs: { enable: true, tasks: { checkin: true } },
  cloud_games: { cn: { genshin: { enable: true, token: "合成云" } } },
  account: { cookie: "cookie_token=fixture", stoken: "fixture", current_uid: { gs: "100000001" }, game_roles: { gs: ["100000001"] } },
};

async function withProfile(
  run: (store: ReturnType<typeof createProfileStore>, path: string, directory: string) => Promise<void>,
  value: unknown = fixture,
) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-profile-checkin-settings-"));
  const path = join(directory, `${qq}-${profileId}.yaml`);
  try {
    await writeFile(path, Bun.YAML.stringify(value));
    await run(createProfileStore(directory), path, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function changeProfile(store: ReturnType<typeof createProfileStore>, change: ProfileCheckinSettingsChange) {
  const { revision } = await store.checkinSettings(qq, profileId);
  return store.setProfileCheckinSettings(qq, profileId, revision, change);
}

test("个人游戏或全部游戏配置仅修改旧国服字段，保留黑名单、总开关和其他服务", async () => {
  await withProfile(async (store, path) => {
    const { revision } = await store.checkinSettings(qq, profileId);
    expect(await changeProfile(store, { type: "game", game: "gs", enabled: false })).toEqual({ changed: false, revision });
    await changeProfile(store, { type: "game", game: "sr", enabled: false });
    const explicit = (await store.checkinSettings(qq, profileId)).games;
    expect(explicit.honkai_sr?.enabled).toBe(false);
    expect(explicit.honkai2?.enabled).toBe(true);
    expect(explicit.zzz?.enabled).toBe(true);

    await changeProfile(store, { type: "all-games", enabled: false });
    const expected = {
      ...fixture, games: { ...fixture.games, cn: {
        ...fixture.games.cn, honkai2: { checkin: false, extra: "保留" },
        honkai_sr: { checkin: false }, zzz: { checkin: false },
      } },
    };
    expect(Bun.YAML.parse(await readFile(path, "utf8"))).toEqual(expected);
    await changeProfile(store, { type: "all-games", enabled: true });
    expect(Bun.YAML.parse(await readFile(path, "utf8"))).toEqual({
      ...expected, games: { ...expected.games, cn: {
        ...expected.games.cn, genshin: { checkin: true, black_list: ["100000001"] },
        honkai2: { checkin: true, extra: "保留" }, honkai_sr: { checkin: true }, zzz: { checkin: true },
      } },
    });
  });
});

test("通知偏好保留原群，明确绑定只留当前群，各项通知设置与时间相互独立", async () => {
  await withProfile(async (store, path) => {
    await changeProfile(store, { type: "notify-enabled", enabled: false });
    await changeProfile(store, { type: "notify-preference", prefer: "group" });
    expect((await store.checkinSettings(qq, profileId)).notify)
      .toEqual({ enabled: false, prefer: "group", fallbackGroups: [500, 600] });
    await changeProfile(store, { type: "notify-preference", prefer: "group", groupId: 700 });
    expect((await store.checkinSettings(qq, profileId)).notify.fallbackGroups).toEqual([700]);
    await changeProfile(store, { type: "bind-notify-group", groupId: 800 });
    await changeProfile(store, { type: "notify-preference", prefer: "private" });
    await changeProfile(store, { type: "schedule", mode: "fixed", time: "9:05" });
    expect((await store.checkinSettings(qq, profileId)).schedule)
      .toEqual({ mode: "fixed", fixedTime: "09:05", allowRandom: false });
    await changeProfile(store, { type: "schedule", mode: "random" });
    expect((await store.checkinSettings(qq, profileId)).schedule)
      .toEqual({ mode: "random", fixedTime: undefined, allowRandom: false });
    await changeProfile(store, { type: "schedule", mode: "inherit" });
    expect(Bun.YAML.parse(await readFile(path, "utf8"))).toEqual({
      ...fixture,
      profile: { ...fixture.profile, notify: { enable: false, prefer: "private", fallback_groups: ["800"], channel_extra: "保留" } },
      schedule: { ...fixture.schedule, mode: "inherit", fixed_time: "" },
    });
  });
});

test("拒绝溢出号码、非法时间、缺失档案及过期 revision，已刷新 Cookie 不被写回", async () => {
  await withProfile(async (store, path, directory) => {
    const { revision } = await store.checkinSettings(qq, profileId);
    for (const change of [
      { type: "bind-notify-group", groupId: 2 ** 53 },
      { type: "notify-preference", prefer: "group", groupId: 0 },
      { type: "schedule", mode: "fixed", time: "24:00" },
    ] satisfies readonly ProfileCheckinSettingsChange[]) {
      await expect(store.setProfileCheckinSettings(qq, profileId, revision, change)).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(store.setProfileCheckinSettings(qq, 1, revision, { type: "all-games", enabled: false }))
      .rejects.toMatchObject({ code: "missing" });
    expect(await readdir(directory)).toEqual([`${qq}-${profileId}.yaml`]);
    expect((await store.checkinSettings(qq, profileId)).revision).toBe(revision);

    const refreshed = { cookie: "cookie_token=updated", ltoken: "updated" };
    await createProfileStore(directory).saveRefreshedCredentials(qq, profileId, revision, refreshed);
    await expect(store.setProfileCheckinSettings(qq, profileId, revision, { type: "notify-enabled", enabled: false }))
      .rejects.toMatchObject({ code: "changed" });
    await changeProfile(store, { type: "notify-enabled", enabled: false });
    expect(Bun.YAML.parse(await readFile(path, "utf8"))).toMatchObject({
      account: { ...fixture.account, ...refreshed }, profile: { notify: { enable: false } },
    });
  });
});

test("个人档案设置与旧版一样要求已登录", async () => {
  await withProfile(async (store, path) => {
    const before = await readFile(path, "utf8");
    await expect(changeProfile(store, { type: "notify-enabled", enabled: false })).rejects.toMatchObject({ code: "login-required" });
    expect(await readFile(path, "utf8")).toBe(before);
  }, { ...fixture, account: { cookie: "cookie_token=fixture" } });
});
