import { expect, test } from "bun:test";
import { inspectPluginMetadata } from "../lib/plugins/metadata.ts";

test("清单检查统一规范化包名及 Git 来源，保留原入口与重复判断顺序", () => {
  const source = "\uFEFF" + JSON.stringify({
    name: " @Publisher/Example ", repository: { url: "https://gitee.com/Publisher/Example.git" },
    lotusYunzai: { entry: "./index.ts" },
  });
  const urls = Object.freeze(["git@github.com:Publisher/Example-Fork.git", "invalid remote"]);
  const result = inspectPluginMetadata("Example", source, urls);

  expect(result).toEqual({
    name: "@publisher/example", declaredName: "@publisher/example", entry: "./index.ts",
    repositoryKeys: ["publisher/example-fork", "publisher/example"],
    repositoryNames: ["example-fork", "example"],
    identities: ["name:@publisher/example", "repo:publisher/example-fork", "repo:publisher/example"],
  });
  expect(urls).toEqual(["git@github.com:Publisher/Example-Fork.git", "invalid remote"]);
  expect(inspectPluginMetadata("LegacyExample", undefined, [])).toMatchObject({
    name: "legacyexample", declaredName: "", identities: ["name:legacyexample"],
  });
});

test("候选包可因目录、仓库或游戏声明变化被拒，沿用图库归并优先级", () => {
  const manifest = JSON.stringify({ name: "renamed", lotusYunzai: { entry: 42, games: ["鸣潮"] } });
  const source = inspectPluginMetadata("renamed", manifest, ["git@gitee.com:mirror/atlas-plugin.git"]);
  expect(source.rejection).toBe("旧插件功能已归并，请使用 atlas。");
  expect(source.rejectionIdentity).toBe("renamed");
  expect(inspectPluginMetadata("renamed", manifest, []).rejection).toContain("鸣潮");
  expect(inspectPluginMetadata("Starrail-Plugin", undefined, []).rejection).toContain("starrail");
  expect(inspectPluginMetadata("renamed", undefined, ["gitee:mirror/waves-plugin"])).toMatchObject({
    repositoryKeys: ["mirror/waves-plugin"], rejectionIdentity: "mirror/waves-plugin",
  });
});

test("下载版混合签到和表情插件按真实包名拒载", () => {
  for (const path of ["a-game_checkin", "a-game-checkin"]) {
    expect(inspectPluginMetadata("local-checkin", JSON.stringify({ name: path }), []).rejection)
      .toContain("包含鸣潮、战双帕弥什功能");
  }
  expect(inspectPluginMetadata("local-emoji", JSON.stringify({ name: "mcbq-plugin" }), []).rejection)
    .toContain("包含鸣潮功能");
  expect(inspectPluginMetadata("local-emoji", undefined, ["github:xh2580/MingChaoBQ-Plugin"]).rejection)
    .toContain("包含鸣潮功能");
  expect(inspectPluginMetadata("minecraft-tools", JSON.stringify({ name: "mc-plugin" }), []).rejection)
    .toBeUndefined();
  expect(inspectPluginMetadata("declared-game", '{"lotusYunzai":{"games":["pns"]}}', []).rejection)
    .toContain("包含战双帕弥什功能");
});

test("现代插件入口须是字符串且需包名，内置包仅在指定目录通过", () => {
  const source = JSON.stringify({ name: "@lotus-yunzai/system", lotusYunzai: { entry: "./index.ts" } });
  expect(inspectPluginMetadata("system", source, []).rejection).toBeUndefined();
  expect(inspectPluginMetadata("renamed", source, [])).toMatchObject({
    rejection: "@lotus-yunzai/system 的内置目录为 plugins/system。",
  });
  expect(inspectPluginMetadata("renamed", source, []).rejectionIdentity).toBeUndefined();
  expect(() => inspectPluginMetadata("renamed", '{"lotusYunzai":{"entry":"./index.ts"}}', [])).toThrow("须声明包名");
  expect(() => inspectPluginMetadata("renamed", '{"name":"normal","lotusYunzai":{"entry":42}}', [])).toThrow("须声明包名");
  expect(() => inspectPluginMetadata("renamed", "invalid JSON", [])).toThrow(SyntaxError);
});
