import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProfileStore } from "@lotus-yunzai/account";
import { createProfileHoyoClient } from "@lotus-yunzai/hoyo-client";
import { closeStorage, connectStorage } from "@lotus-yunzai/storage";
import { renderZzzChallengeStatus, zzzChallengeReminderCommand } from "../plugins/zzz/challenge-reminder.ts";
import { challengeReminderTime, createZzzChallengeReminderStore } from "../plugins/zzz/challenge-reminder-store.ts";

const uid = "623456789", region = "prod_qd_cn";
const date = { year: 2026, month: 11, day: 27, hour: 4, minute: 0, second: 0 };
const response = (data: unknown) => Response.json({ retcode: 0, data });
const expired = () => Response.json({ retcode: -100 });
const oldUsers = "ZZZ:REMIND:USER_CONFIGS";
const valkey = Bun.which("valkey-server");

test("保留挑战提醒命令和时间格式；手动状态可显式选择本人档", () => {
  expect(zzzChallengeReminderCommand("%启用全局挑战提醒")).toEqual({ kind: "enable", global: true, enabled: true });
  expect(zzzChallengeReminderCommand("/zzz设置全局式舆阈值 6")).toEqual({ kind: "threshold", field: "abyssCheckLevel", global: true, value: 6 });
  expect(zzzChallengeReminderCommand("%个人提醒状态")).toEqual({ kind: "settings", global: false });
  expect(zzzChallengeReminderCommand("#绝区零查询挑战状态2")).toEqual({ kind: "status", profileId: 2 });
  expect(challengeReminderTime("每周天08时00分")).toEqual({ time: "每周天8时" });
  expect(challengeReminderTime("每日23时50分")).toEqual({ time: "每日23时50分" });
  expect(challengeReminderTime("每日24时")).toHaveProperty("error");
  expect(challengeReminderTime("每周一20时45分")).toHaveProperty("error");
  expect(challengeReminderTime("每日20时试试")).toHaveProperty("error");
});

test("手动状态同所选档、同区服、现期两项目，只对真实过期续一次", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzz-challenge-status-"));
  const slot = join(root, "42-2.yaml");
  const original = [`user: { qq: "42" }`, "profile: { id: 2 }", "account:",
    '  cookie: "cookie_token=fixture-old; account_id=43"', '  stoken: "fixture-stoken"', '  stuid: "43"',
    `  game_roles: { zzz: [{ uid: "${uid}", region: ${region}, game_biz: nap_cn }] }`,
    `  current_uid: { zzz: "${uid}" }`, 'device: { id: "fixture-device", fp: "fixture-fp" }',
  ].join("\n");
  const profiles = createProfileStore(root);
  try {
    for (const mode of ["success", "repeat-expired", "swapped"] as const) {
      await writeFile(slot, original, { mode: 0o600 });
      const calls: string[] = [];
      const client = createProfileHoyoClient(profiles, async (url, init) => {
        if (url.pathname.endsWith("getLTokenBySToken")) {
          calls.push("ltoken");
          return response({ uid: "43", ltoken: "fixture-new" });
        }
        if (url.pathname.endsWith("getCookieAccountInfoBySToken")) {
          calls.push("cookie");
          return response({ uid: "43", cookie_token: "fixture-new" });
        }
        expect(url.host).toBe("api-takumi-record.mihoyo.com");
        expect(url.searchParams.get("role_id") ?? url.searchParams.get("uid")).toBe(uid);
        expect(url.searchParams.get("server") ?? url.searchParams.get("region")).toBe(region);
        expect(url.searchParams.get("schedule_type")).toBe("1");
        const headers = new Headers(init.headers);
        expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
        const fresh = headers.get("cookie")!.includes("fixture-new");
        const action = url.pathname.split("/").at(-1);
        calls.push(action + (fresh ? ":new" : ":old"));
        if (!fresh || mode === "repeat-expired") return expired();
        if (action === "hadal_info_v2") return response({
          hadal_ver: "v2", hadal_info_v2: {
            brief: { rating: "S+" }, fourth_layer_detail: { rating: "S" },
            hadal_begin_time: { ...date, day: 13 }, hadal_end_time: date,
          },
        });
        if (mode === "swapped") await writeFile(slot, original.replace(`current_uid: { zzz: "${uid}" }`, 'current_uid: { zzz: "67345678" }'));
        return response({ has_data: true, total_star: 0, start_time: { ...date, day: 13 }, end_time: date });
      });
      const source = await profiles.requestSelectedContext("42", 2, "zzz");
      if (mode === "swapped") {
        await expect(client.fetchZzzChallengeStatus(source)).rejects.toMatchObject({ code: "profile-changed" });
      } else {
        const record = await client.fetchZzzChallengeStatus(source);
        if (mode === "success") {
          const text = renderZzzChallengeStatus(record, { abyssCheckLevel: 6, deadlyStars: 6 }, Date.parse("2026-11-26T11:00:00Z"));
          expect(text).toContain("式舆防卫战S评级: 5/5 ✓\n第五层评价: S+ ✓");
          expect(text).toContain("危局强袭战星数: 0/9");
          expect(text).toContain("统计周期：2026/11/13 - 2026/11/27\n刷新剩余: 0天9小时");
        } else {
          expect(record.shiyu.status).toBe("rejected");
          expect(record.deadly.status).toBe("rejected");
        }
      }
      expect(calls).toEqual(["hadal_info_v2:old", "ltoken", "cookie", "hadal_info_v2:new", "hadal_mem_detail_v2:new"]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!valkey)("从旧配置读回同一用户，设置并发互不覆盖，原 Redis 与 YAML 保持一致", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzz-remind-storage-"));
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  const password = crypto.randomUUID();
  const server = Bun.spawn([valkey!, "--bind", "127.0.0.1", "--port", String(port), "--requirepass", password,
    "--save", "", "--appendonly", "no", "--dir", root], { stdout: "pipe", stderr: "ignore" });
  let redis: Awaited<ReturnType<typeof connectStorage>>;
  try {
    const reader = server.stdout.getReader();
    let output = "";
    while (!output.includes("Ready to accept connections")) {
      const chunk = await reader.read();
      if (chunk.done) throw Error("隔离 Valkey 初始化失败。");
      output += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    redis = await connectStorage(`redis://:${password}@127.0.0.1:${port}`);
    const file = join(root, "legacy-remind.yaml");
    const bytes = "enable: true\nabyssCheckLevel: 6\ndeadlyStars: 2\nglobalRemindTime: 每周一20时30分\n";
    await writeFile(file, bytes);
    const old = JSON.stringify({ enable: true, abyssCheckLevel: 0, deadlyStars: 6, remindTime: "每日18时", ignored: "旧字段" });
    await redis.hSet(oldUsers, "42", old);
    const store = createZzzChallengeReminderStore(redis, file);
    expect(await store.global()).toEqual({ enable: true, abyssCheckLevel: 6, deadlyStars: 2, remindTime: "每周一20时30分" });
    expect(await store.user("43")).toBeUndefined();
    expect(await store.user("42")).toMatchObject({ enable: true, abyssCheckLevel: 0, deadlyStars: 6 });
    await Promise.all([
      store.updateUser("42", user => ({ ...user, deadlyStars: 9 })),
      store.updateUser("42", user => ({ ...user, remindTime: undefined })),
      store.updateUser("42", user => ({ ...user, enable: false })),
      store.updateGlobal("deadlyStars", 0),
      store.updateGlobal("enable", false),
    ]);
    expect(await store.user("42")).toMatchObject({ enable: false, abyssCheckLevel: 0, deadlyStars: 9, remindTime: undefined });
    expect(await store.global()).toEqual({ enable: false, abyssCheckLevel: 6, deadlyStars: 0, remindTime: "每周一20时30分" });
    expect(await redis.hGet(oldUsers, "42")).toBe(old);
    expect(await readFile(file, "utf8")).toBe(bytes);
  } finally {
    if (redis!) await closeStorage();
    server.kill();
    await server.exited;
    await rm(root, { recursive: true, force: true });
  }
});
