import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkinScheduleClock, generateCheckinSchedulePlan } from "../lib/checkin-schedule-plan.ts";
import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("旧删除签到按真实两协议停用本人所有档案并保留关键词、登录和签到回执", async () => {
  const clock = checkinScheduleClock();
  const group = { message_type: "group", sub_type: "normal", group_id: 77, sender: { user_id: 42, role: "admin" } };
  const keyword = "data/messageJson/77.json";
  const keywords = { "签到": [[{ type: "text", text: "unrelated fixture" }]], other: [[{ type: "text", text: "keep fixture" }]] };
  const documents = [
    { qq: "42", id: 1, enabled: true }, { qq: "42", id: 2, enabled: true }, { qq: "42", id: 3, enabled: false },
    { qq: "43", id: 1, enabled: true }, { qq: "43", id: 2, enabled: true }, { qq: "44", id: 1, enabled: true },
  ].map(({ qq, id, enabled }) => ({
    qq, id, file: "profiles/" + qq + (id === 1 ? "" : "-" + id) + ".yaml",
    data: { user: { qq }, profile: { id, notify: { enable: false, fallback_groups: [77] } }, enabled,
      account: { cookie: "account_id=123;cookie_token=fixture", stuid: "123", stoken: "fixture-stoken", game_roles: { gs: [] } },
      auto_redeem: { enable: true, games: ["gs"] }, cloud_games: { cn: { genshin: { enable: false } } },
      mihoyobbs: { enable: true, tasks: { checkin: true } },
      games: { cn: { enable: true, genshin: { checkin: true } } },
    },
  }));
  const preload = [
    'Bun.env.LOTUS_PROFILE_DIR = process.cwd() + "/profiles";',
    'const originalFetch = globalThis.fetch;',
    'globalThis.fetch = Object.assign((input, init) => {',
    '  const url = new URL(input instanceof Request ? input.url : input);',
    '  if (url.hostname !== "127.0.0.1") throw new Error("offline fixture");',
    '  return originalFetch(input, init);',
    '}, originalFetch);',
  ].join("\n");

  await withDualGatewayFixture("checkin-unregistration-offline", 'master: ["99:91", "100:92"]\n', async gateways => {
    const store = createCheckinScheduleStore(join(gateways.root, "data/schedules"));
    const before = (await store.read(clock.tomorrow))!.entries;
    const finished = before.find(entry => entry.qq === "42" && entry.profileId === 2)!;
    expect(finished.done).toBe(true);
    const uncertain = (await store.read(clock.date))!.entries.find(entry => entry.qq === "42" && entry.profileId === 2)!;
    expect(uncertain).toMatchObject({ done: false, gameWritesUnknown: true, communityWrites: { "6": "unconfirmed" } });

    gateways.sendOneBot("#删除签到", group);
    const first = await gateways.onebot.next("send_msg");
    expect(first.params).toMatchObject({ message_type: "group", group_id: 77,
      message: expect.stringContaining("已关闭 2 个档案的自动签到") });
    first.respond({ message_id: 19 });
    expect(JSON.parse(await readFile(join(gateways.root, keyword), "utf8"))).toEqual(keywords);
    const own = (await store.read(clock.tomorrow))!.entries.filter(entry => entry.qq === "42");
    expect(own).toEqual([finished]);
    expect((await store.read(clock.date))!.entries.filter(entry => entry.qq === "42")).toEqual([uncertain]);
    expect((await store.read(clock.tomorrow))!.entries.filter(entry => entry.qq !== "42"))
      .toEqual(before.filter(entry => entry.qq !== "42"));

    expect((await gateways.sendMilky("#删除签到")).status).toBe(200);
    const second = await gateways.milky.next("send_private_message");
    expect(JSON.stringify(second.params)).toContain("已关闭 2 个档案的自动签到");
    expect(JSON.stringify(second.params)).not.toContain("fixture");
    second.respond({ message_seq: 20 });
    expect((await store.read(clock.tomorrow))!.entries.map(entry => [entry.qq, entry.profileId])).toEqual([["42", 2], ["44", 1]]);
    for (const doc of documents) {
      const raw = await readFile(join(gateways.root, doc.file), "utf8");
      if (doc.qq === "44" || doc.id === 3) expect(raw).toBe(Bun.YAML.stringify(doc.data));
      expect(Bun.YAML.parse(raw)).toEqual({ ...doc.data, enabled: doc.qq === "44" });
    }

    await Bun.sleep(1050);
    expect((await gateways.sendMilky("#删除签到")).status).toBe(200);
    const repeated = await gateways.milky.next("send_private_message");
    expect(JSON.stringify(repeated.params)).toContain("未注册自动签到");
    repeated.respond({ message_seq: 21 });

    gateways.sendOneBot("#删除签到", { ...group, group_id: 79, user_id: 44, sender: { user_id: 44, role: "admin" } });
    await Bun.sleep(180);
    expect(gateways.onebot.calls).toEqual([]);
    expect(JSON.parse(await readFile(join(gateways.root, "data/messageJson/79.json"), "utf8"))).toEqual(keywords);
    expect(await readFile(join(gateways.root, documents[5]!.file), "utf8")).toBe(Bun.YAML.stringify(documents[5]!.data));

    gateways.sendOneBot("#删除 签到", group);
    const keywordDelete = await gateways.onebot.next("send_msg");
    expect(keywordDelete.params).toMatchObject({ message_type: "group", group_id: 77, message: "删除成功：签到" });
    keywordDelete.respond({ message_id: 22 });
    expect(JSON.parse(await readFile(join(gateways.root, keyword), "utf8"))).toEqual({ other: keywords.other });
  }, 2000, preload, async root => {
    await mkdir(join(root, "profiles"), { recursive: true });
    for (const doc of documents) await writeFile(join(root, doc.file), Bun.YAML.stringify(doc.data));
    await mkdir(join(root, "data/messageJson"), { recursive: true });
    await writeFile(join(root, keyword), JSON.stringify(keywords));
    await writeFile(join(root, "data/messageJson/79.json"), JSON.stringify(keywords));
    await writeFile(join(root, "config/group.yaml"), Bun.YAML.stringify({
      default: { groupCD: 0, singleCD: 0, addLimit: 0 },
      79: { disable: ["删除签到"] },
    }));
    await writeFile(join(root, "config/global.yaml"), "scheduler: {enable: true, fixed_time: '04:30', run_due_cron: '0 0 0 1 1 *', catch_up_cron: '0 0 0 1 1 *', plan_generate_cron: '0 0 0 1 1 *'}\n");
    const plan = generateCheckinSchedulePlan({ date: clock.tomorrow,
      profiles: documents.map(doc => ({ qq: doc.qq, profileId: doc.id, enabled: doc.data.enabled })) });
    const entries = plan.entries.map(entry => entry.qq === "42" && entry.profileId === 2
      ? { ...entry, done: true, stage: "checkin" as const, doneAt: clock.iso, ok: true } : entry);
    const store = createCheckinScheduleStore(join(root, "data/schedules"));
    await store.update(clock.tomorrow, () => ({ plan: { ...plan, entries }, result: undefined }));
    const today = generateCheckinSchedulePlan({ date: clock.date,
      profiles: documents.map(doc => ({ qq: doc.qq, profileId: doc.id, enabled: doc.data.enabled })) });
    const currentEntries = today.entries.map(entry => entry.qq === "42" && entry.profileId === 2
      ? { ...entry, gameWritesUnknown: true as const, communityWrites: { "6": "unconfirmed" as const } } : entry);
    await store.update(clock.date, () => ({ plan: { ...today, entries: currentEntries }, result: undefined }));
  });
});
