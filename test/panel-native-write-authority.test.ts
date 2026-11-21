import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { panelAtlasChannel } from "../lib/panel-atlas-channel.ts";
import { panelGroupNoticeSettings, panelGroupSettings } from "../lib/panel-group.ts";
import { panelWebLogin } from "../lib/panel-web-login.ts";

function request(method: "GET" | "PUT", data?: unknown) {
  return new Request("http://127.0.0.1/panel/", {
    method,
    headers: { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

test("原生配置在实际提交前复核会话，群配置同时复核已加载的提供器", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-panel-native-authority-"));
  const config = join(root, "config");
  const groupLikes = join(config, "group.yaml");
  const groupNotices = join(config, "group-notice.yaml");
  const atlas = join(config, "global.yaml");
  const before = Bun.env.LOTUS_GROUP_CONFIG;
  Bun.env.LOTUS_GROUP_CONFIG = groupLikes;
  try {
    await mkdir(config);
    const original = {
      atlas: "# 图鉴注释\natlas: { version_channel: live }\n",
      likes: "# 点赞注释\nenable: true\ncount: 5\n",
      notices: "# 群通知注释\ndefault: { groupMessage: false }\n",
    };
    await Promise.all([
      writeFile(atlas, original.atlas),
      writeFile(groupLikes, original.likes),
      writeFile(groupNotices, original.notices),
    ]);
    const url = pathToFileURL(root + "/");
    const group = { path: join(import.meta.dir, "../plugins/group"), packageName: "@lotus-yunzai/group" };
    const directories = new Map([["group", group]]);
    const channel = panelAtlasChannel(url);
    const webLogin = panelWebLogin(url);
    const like = panelGroupSettings(directories);
    const notice = panelGroupNoticeSettings(url, directories);
    const allowed = () => true;
    const changeAtlas = { channel: "latest", previous: "live" };
    const { revision: likeRevision } = await (await like(request("GET"), allowed)).json() as { revision: string };
    const { revision: noticeRevision } = await (await notice(request("GET"), allowed)).json() as { revision: string };
    const { revision: loginRevision, settings } = await (await webLogin(request("GET"), allowed)).json() as {
      revision: string; settings: { enable: boolean };
    };
    const changeLikes = { revision: likeRevision, patch: { count: 9 } };
    const changeNotices = { revision: noticeRevision, patch: { groupMessage: true } };

    for (const [route, changes, file, initial] of [
      [channel, changeAtlas, atlas, original.atlas],
      [webLogin, { revision: loginRevision, patch: { enable: !settings.enable } }, atlas, original.atlas],
      [like, changeLikes, groupLikes, original.likes],
      [notice, changeNotices, groupNotices, original.notices],
    ] as const) {
      let checked = 0;
      expect((await route(request("PUT", changes), () => ++checked === 1)).status).toBe(401);
      expect(checked).toBeGreaterThanOrEqual(2);
      expect(await Bun.file(file).text()).toBe(initial);
    }

    for (const [route, changes, file, initial] of [
      [like, changeLikes, groupLikes, original.likes],
      [notice, changeNotices, groupNotices, original.notices],
    ] as const) {
      let checked = 0;
      expect((await route(request("PUT", changes), () => {
        if (++checked === 2) directories.set("group", { ...group });
        return true;
      })).status).toBe(409);
      expect(await Bun.file(file).text()).toBe(initial);
      directories.set("group", group);
    }

    expect((await channel(request("PUT", changeAtlas), allowed)).status).toBe(200);
    expect((await like(request("PUT", changeLikes), allowed)).status).toBe(200);
    expect((await notice(request("PUT", changeNotices), allowed)).status).toBe(200);
    expect(await Bun.file(atlas).text()).toContain("version_channel: latest");
    expect(await Bun.file(groupLikes).text()).toContain("count: 9");
    expect(await Bun.file(groupNotices).text()).toContain("groupMessage: true");
  } finally {
    if (before === undefined) delete Bun.env.LOTUS_GROUP_CONFIG;
    else Bun.env.LOTUS_GROUP_CONFIG = before;
    await rm(root, { recursive: true, force: true });
  }
});
