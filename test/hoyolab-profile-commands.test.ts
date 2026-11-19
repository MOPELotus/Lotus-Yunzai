import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageFallbackContext } from "../lib/commands.ts";
import { hoyoLabProfileCommands, isHoYoLabCookieInput } from "../lib/hoyolab-profile-commands.ts";

const fixture = {
  version: 1, enabled: true, user: { qq: "42" }, profile: { id: 2 },
  account: { cookie: "cookie_token=domestic-fixture", stoken_cookie: "stoken=fixture", ltoken: "fixture" },
  games: { cn: { enable: true }, os: {
    enable: false, lang: "zh-cn", cookie: "legacy-fixture", zzz: { checkin: true, black_list: ["1300000001"] },
  } },
};

function context(message: string, overrides?: Partial<MessageFallbackContext>): MessageFallbackContext {
  return { normalizedMessage: message, message_type: "private", self_id: 99, user_id: 42, isMaster: false,
    isBotMaster: () => false, reply: () => true, ...overrides };
}

test("国际服 Cookie 命令保留原生接管，给私聊或群聊固定回复", async () => {
  const messages = [
    "#绑定国际服cookie", "  ＃ 绑定 国际服 Cookies-fake-id fixture-value ",
    "#绑定海外服Cookie2 fixture-value", "#绑定海外服cookie256 fixture-value",
    "井绑定海外服cookie000 fixture-value", "/绑定国际服COOKIE-2\nfixture-value",
  ];
  const module = hoyoLabProfileCommands("/does-not-exist", new AbortController().signal, {
    viewProfile() { throw new Error("不能渲染未保存的凭据"); },
  });
  for (const raw of messages) {
    expect(isHoYoLabCookieInput(raw)).toBe(true);
    for (const type of ["private", "group", "terminal"] as const) {
      expect(await module.fallback?.("", context("#别名", { message_type: type, raw_message: raw })))
        .toBe(type === "private" ? "当前无法核验国际服 Cookie 的账号归属。" : "请在私聊中绑定国际服 Cookie。");
    }
  }
  for (const raw of ["请看 #绑定国际服cookie", "#绑定国服cookie", "#设置国际服语言 zh-cn", "#绑定海外服UID"]) {
    expect(isHoYoLabCookieInput(raw)).toBe(false);
  }
});

test("国际服设置使用当前 QQ 的明确档案，保留原语言大小写及独立 Cookie", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-hoyolab-profile-"));
  try {
    const defaultPath = join(directory, "42.yaml");
    const target = join(directory, "42-2.yaml");
    const other = join(directory, "43-2.yaml");
    const notLoggedIn = join(directory, "42-3.yaml");
    const original = Bun.YAML.stringify(fixture);
    const sibling = Bun.YAML.stringify({ ...fixture, profile: { id: 1 } });
    const otherProfile = Bun.YAML.stringify({ ...fixture, user: { qq: "43" } });
    const unlogged = Bun.YAML.stringify({ ...fixture, profile: { id: 3 }, account: {} });
    await Promise.all([writeFile(target, original), writeFile(defaultPath, sibling),
      writeFile(other, otherProfile), writeFile(notLoggedIn, unlogged)]);

    const viewed: [number, number | undefined][] = [];
    const module = hoyoLabProfileCommands(directory, new AbortController().signal, {
      viewProfile(id, { user_id }) { viewed.push([id, user_id]); return "资料卡"; },
    });
    const run = (message: string, overrides?: Partial<MessageFallbackContext>) =>
      module.fallback?.(message, context(message, overrides));
    expect(await run("#设置海外服语言2 EN_us")).toBe("资料卡");
    expect(await run("#启用国际服签到2", { message_type: "group", group_id: 91 })).toBe("资料卡");
    expect(await run("#关闭海外服2")).toBe("资料卡");
    const targetBytes = await readFile(target, "utf8");
    expect(Bun.YAML.parse(targetBytes)).toEqual({
      ...fixture, games: { ...fixture.games, os: { ...fixture.games.os, lang: "EN_us" } },
    });
    expect(await readFile(defaultPath, "utf8")).toBe(sibling);
    expect(await run("#开启海外服")).toBe("资料卡");
    expect(Bun.YAML.parse(await readFile(defaultPath, "utf8"))).toEqual({
      ...fixture, profile: { id: 1 }, games: { ...fixture.games, os: { ...fixture.games.os, enable: true } },
    });
    for (const command of ["#关闭国际服256", "#设置国际服语言02 en-us", "#设置国际服语言9007199254740992 en-us"]) {
      expect(await run(command)).toBe("档案编号须在 1 到 255 之间。");
    }
    expect(await run("#设置国际服语言2 en-us/add")).toBeUndefined();
    expect(await run("#禁用海外服签到3")).toBe("请先登录 profile 3。");
    expect(await run("#开启海外服255")).toBe("请先登录 profile 255。");
    expect(await run("#启用国际服签到2", { message_type: "terminal" })).toBe("请从对应的 QQ 会话设置国际服。");
    expect(await run("#绑定国际服cookie2 fixture-value")).toBe("当前无法核验国际服 Cookie 的账号归属。");
    expect(viewed).toEqual([[2, 42], [2, 42], [2, 42], [1, 42]]);
    expect(await readFile(target, "utf8")).toBe(targetBytes);
    expect(await readFile(other, "utf8")).toBe(otherProfile);
    expect(await readFile(notLoggedIn, "utf8")).toBe(unlogged);
    expect((await readdir(directory)).filter(name => name.endsWith(".yaml")).sort())
      .toEqual(["42-2.yaml", "42-3.yaml", "42.yaml", "43-2.yaml"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
