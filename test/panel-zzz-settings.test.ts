import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { panelZzzSettings } from "../lib/panel-zzz-settings.ts";
import { readRankConfig } from "../plugins/zzz/challenge-rank-store.ts";
import { parseZzzPanelConfig, readZzzPanelConfigDocument } from "../plugins/zzz/panel-command.ts";
import { zzzPanelIntervalCommand } from "../plugins/zzz/panel-interval-command.ts";

const api = "http://127.0.0.1/panel/api/settings/games/zzz-rank";
const rankEnv = "LOTUS_ZZZ_RANK_CONFIG";
const panelEnv = "LOTUS_ZZZ_PANEL_CONFIG";

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete Bun.env[name];
  else Bun.env[name] = value;
}

function save(values: object, previous: object) {
  return new Request(api, { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ values, previous }) });
}

test("面板热修改绝区零挑战榜与角色面板榜共用名单、份数及当前总开关", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-zzz-rank-"));
  const root = pathToFileURL(directory + "/");
  const config = join(directory, "rank.yaml");
  const rank = Bun.env[rankEnv], redis = globalThis.redis;
  let switchValue: string | null = "1", revision: string | null = null;
  try {
    await writeFile(config, "# 用户说明\nallow_group: false\nwhite_list: [77]\nblack_list: [80]\nmax_display: 6\nextra: retain\n");
    Bun.env[rankEnv] = config;
    globalThis.redis = {
      async mGet() { return [switchValue, revision]; },
    } as unknown as typeof globalThis.redis;
    const panel = panelZzzSettings(root);
    const read = async () => await (await panel(new Request(api), () => true)).json();
    const { fields, values } = await read();
    expect(fields.map((field: { key: string }) => field.key)).toEqual(["allow_group", "white_list", "black_list", "max_display"]);
    expect(values).toEqual({ allow_group: true, white_list: ["77"], black_list: ["80"], max_display: 6 });
    expect(await readRankConfig("80")).toEqual({ allowed: false, maximum: 6 });
    const next = { ...values, allow_group: false, white_list: ["79", "79"], max_display: 12 };
    expect((await panel(save({ ...next, max_display: 16 }, values), () => true)).status).toBe(400);
    expect((await panel(save({ ...next, white_list: ["bad"] }, values), () => true)).status).toBe(400);
    expect((await panel(save({ ...next, secret: "unrelated" }, values), () => true)).status).toBe(400);
    expect((await panel(save(next, values), () => false)).status).toBe(401);
    let checks = 0;
    expect((await panel(save(next, values), () => ++checks === 1)).status).toBe(401);
    expect((await read()).values).toEqual(values);
    const result = await panel(save(next, values), () => true);
    expect(result.status).toBe(200);
    expect((await result.json()).values).toEqual({ ...next, white_list: ["79"] });
    expect(await readRankConfig("77")).toEqual({ allowed: false, maximum: 12 });
    expect(await readRankConfig("79")).toEqual({ allowed: true, maximum: 12 });
    const after = await readFile(config, "utf8");
    expect(after).toContain("# 用户说明");
    expect(Bun.YAML.parse(after)).toMatchObject({ extra: "retain", black_list: [80] });
    expect((await panel(save(next, values), () => true)).status).toBe(409);
    expect(await readFile(config, "utf8")).toBe(after);

    revision = crypto.randomUUID();
    expect((await read()).values.allow_group).toBe(true);
    expect(await readRankConfig("77")).toEqual({ allowed: true, maximum: 12 });
    expect(await readRankConfig("80")).toEqual({ allowed: false, maximum: 12 });
    switchValue = "0";
    expect(await readRankConfig("79")).toEqual({ allowed: true, maximum: 12 });
  } finally {
    restore(rankEnv, rank);
    globalThis.redis = redis;
    await rm(directory, { recursive: true, force: true });
  }
});

test("绝区零面板更新间隔与热读共用字段，旧资源目录回退保持", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-zzz-refresh-"));
  const root = pathToFileURL(directory + "/");
  const previous = Bun.env[panelEnv], legacy = Bun.env.LOTUS_ZZZ_LEGACY_RESOURCES_DIR;
  try {
    const resources = join(directory, "old", "resources");
    const config = join(directory, "old", "config");
    await mkdir(resources, { recursive: true });
    await mkdir(config);
    const inherited = join(config, "panel.yaml");
    const yaml = "# 历史设置\ninterval: 170\nroleInterval: 1400\nfeature: retained\n";
    await writeFile(inherited, yaml);
    delete Bun.env[panelEnv];
    Bun.env.LOTUS_ZZZ_LEGACY_RESOURCES_DIR = resources;
    const panel = panelZzzSettings(root, "panel");
    const initial = await (await panel(new Request(api), () => true)).json();
    expect(initial.values).toEqual({ interval: 170, roleInterval: 1400 });
    const next = { ...initial.values, interval: 20 };
    expect((await panel(save({ ...next, roleInterval: -1 }, initial.values), () => true)).status).toBe(400);
    expect((await panel(save(next, initial.values), () => true)).status).toBe(200);
    const effective = await readZzzPanelConfigDocument(undefined, root);
    expect(parseZzzPanelConfig(effective)).toEqual({ interval: 20, roleInterval: 1400 });
    expect(effective.feature).toBe("retained");
    expect(await readFile(inherited, "utf8")).toBe(yaml);
  } finally {
    restore(panelEnv, previous);
    restore("LOTUS_ZZZ_LEGACY_RESOURCES_DIR", legacy);
    await rm(directory, { recursive: true, force: true });
  }
});

test("绝区零旧聊天设置及网页共用原子写入，检测权限变化和旧网页快照", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-chat-zzz-refresh-"));
  const root = pathToFileURL(directory + "/");
  const previousPath = Bun.env[panelEnv];
  const file = join(directory, "config", "zzz-panel.yaml");
  const lexical = "# 保留部署方注释\ninterval: 60\nroleInterval: 3000\nextra: on\n";
  const session = new AbortController().signal;
  const owner = { adapter: "onebot", message_type: "private", user_id: 42, isMaster: true,
    isBotMaster: (user: number): boolean => user === 42, privateCredentialSignal: session };
  const run = (text: string, context = owner) => zzzPanelIntervalCommand(text, context, session, root);
  try {
    delete Bun.env[panelEnv];
    await mkdir(join(directory, "config"));
    await writeFile(file, lexical);
    const panel = panelZzzSettings(root, "panel");
    const { values: stale } = await (await panel(new Request(api), () => true)).json();
    expect(await run("%刷新角色间隔99")).toContain("100 到 10000 毫秒");
    expect(await run("#绝区零刷新面板间隔1001")).toContain("0 到 1000 秒");
    expect(await run("#刷新角色间隔480")).toBeUndefined();
    expect(await run("%刷新面板间隔12", { ...owner, user_id: 51 })).toContain("仅限当前机器人的主人");
    let checks = 0;
    expect(await run("%刷新面板间隔12", { ...owner, isBotMaster: () => ++checks < 3 })).toContain("仅限当前机器人的主人");
    expect(await readFile(file, "utf8")).toBe(lexical);

    const changed = await Promise.all([run("%刷新面板间隔0"), run("#绝区零刷新角色间隔 180")]);
    expect(changed).toEqual(["绝区零刷新面板间隔已设置为 0 秒。", "绝区零刷新角色间隔已设置为 180 毫秒。"]);
    const active = { interval: 0, roleInterval: 180 };
    expect((await (await panel(new Request(api), () => true)).json()).values).toEqual(active);
    expect((await panel(save({ ...stale, interval: 50 }, stale), () => true)).status).toBe(409);
    expect((await panel(save({ ...active, interval: 50 }, active), () => true)).status).toBe(200);
    expect(parseZzzPanelConfig(await readZzzPanelConfigDocument(undefined, root))).toEqual({ interval: 50, roleInterval: 180 });
    expect(await readFile(file, "utf8")).toContain("# 保留部署方注释");
    expect(await readFile(file, "utf8")).toContain("extra: on");
  } finally {
    restore(panelEnv, previousPath);
    await rm(directory, { recursive: true, force: true });
  }
});
