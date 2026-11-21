import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { readStarRailPanel } from "../packages/hoyo-client/starrail-panel.ts";
import { findPanelAvatar, readTheme } from "../plugins/starrail/panel-card.ts";
import { normalizePanel, parsePanelCommand, readLegacyPanel } from "../plugins/starrail/panel-model.ts";

const source: ProfileRequestContext = {
  qq: "42", profileId: 2, revision: "fixture", game: "sr",
  account: { cookie: "cookie_token=fixture", stoken: "st", stokenCookie: "", stuid: "42", ltuid: "", mid: "", ltoken: "" },
  device: { id: "slot-two-device", fp: "slot-two-fp", name: "", model: "", androidVersion: "", raw: {} },
  role: { uid: "500000123", region: "prod_qd_cn", nickname: "", gameBiz: "hkrpg_cn", chosen: false },
};

test("星铁面板保留更新、列表、详情别名与 profile 后缀", () => {
  expect(parsePanelCommand("*更新面板2")).toEqual({ type: "update", profileId: 2, name: "" });
  expect(parsePanelCommand("#星铁全部面板更新")).toEqual({ type: "update", profileId: 1, name: "" });
  expect(parsePanelCommand("*备用更新面板")).toEqual({ type: "showcase", profileId: 1, name: "" });
  expect(parsePanelCommand("#星铁角色面板列表 20")).toEqual({ type: "list", profileId: 20, name: "" });
  expect(parsePanelCommand("*托帕&账账面板")).toEqual({ type: "detail", profileId: 1, name: "托帕&账账" });
  expect(parsePanelCommand("*银狼LV.999面版2")).toEqual({ type: "detail", profileId: 2, name: "银狼LV.999" });
  for (const name of ["*删除面板", "*混沌", "#角色面板", "*更新面板256", "*抽卡记录"]) {
    expect(parsePanelCommand(name)).toBeUndefined();
  }
});

test("米游社面板遵循旧 avatar/info 路由、区服和设备，拒绝响应身份错配", async () => {
  let calls = 0, guards = 0;
  const result = await readStarRailPanel(source, async (url, init) => {
    calls++;
    expect(url.href).toBe("https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api/avatar/info?need_wiki=true&role_id=500000123&server=prod_qd_cn");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("Cookie")).toBe("cookie_token=fixture");
    expect(new Headers(init.headers).get("x-rpc-device_id")).toBe("slot-two-device");
    return Response.json({ retcode: 0, data: { role: { role_id: source.role.uid, region: source.role.region }, avatar_list: [{ id: 1001 }] } });
  }, {}, async () => { guards++; });
  expect(result.avatars).toEqual([{ id: 1001 }]);
  expect([calls, guards]).toEqual([1, 2]);
  await expect(readStarRailPanel(source, async () => Response.json({ retcode: 0, data: {
    role: { role_id: "100000001" }, avatar_list: [],
  } }), {})).rejects.toMatchObject({ code: "response" });
  await expect(readStarRailPanel(source, async () => Response.json({ retcode: 10102 }), {}))
    .rejects.toMatchObject({ code: "api", retcode: 10102 });
  await expect(readStarRailPanel(source, async () => Response.json({ retcode: 0, data: {} }, { headers: { "x-rpc-aigis": "required" } }), {}))
    .rejects.toMatchObject({ reason: "risk" });
});

test("缓存投影仅保存角色面板字段，不保存凭据、预览词条与非官网图链", () => {
  const rows = [{ id: 1001, name: "三月七", level: 80, rank: 2, rarity: 4, cookie: "secret-value",
    icon: "http://127.0.0.1/a.svg", properties: [{ property_type: 5, base: "5%", final: "32.02%" }],
    equip: { id: 21001, name: "模拟光锥", level: 70, rank: 4, cookie: "secret-value" },
    skills: [{ remake: "普攻", level: 5 }, { remake: "战技", level: 8 }],
    relics: [{ id: 61011, pos: 1, rarity: 5, level: 9, main_property: { property_type: 27, value: "300" },
      properties: [{ property_type: 52, value: "4.2%", times: 1 }, { property_type: 6, value: "9%", is_preview: true }] }],
  }];
  const shot = normalizePanel(source.role.uid, rows);
  expect(shot.avatars[0]).toMatchObject({
    id: "1001", name: "三月七", rank: 2, face: "",
    stats: [{ key: "cpct", base: "5%", value: "32.02%" }],
    cone: { name: "模拟光锥", rank: 4, level: 70 },
    relics: [{ main: { key: "hp", value: "300" }, subs: [{ key: "cpct", value: "4.2%", times: 1 }] }],
  });
  expect(JSON.stringify(shot)).not.toContain("secret-value");
  expect(() => normalizePanel(source.role.uid, [...rows, ...rows])).toThrow("重复");
});

test("兼容旧喵喵 PlayerData 的角色等级、星魂、光锥与遗器 ID", () => {
  const legacy = {
    uid: "500000123", _profile: 1780010101,
    avatars: { "1001": { id: 1001, name: "三月七", level: 70, cons: 6, _source: "mysPanelHSR",
      weapon: { id: "21001", level: 65, affix: 3 }, talent: { a: 5 }, trees: ["1001021"],
      artis: { 3: { id: 61013, level: 12, star: 5, mainId: 4, attrIds: ["7,1,1"] } } } },
  };
  const result = readLegacyPanel(source.role.uid, legacy);
  expect(result.avatars[0]).toMatchObject({
    id: "1001", name: "三月七", level: 70, rank: 6,
    cone: { id: "21001", level: 65, rank: 3 }, skills: [{ key: "a", level: 5 }],
    relics: [{ id: "61013", slot: 3, legacyMainId: "4", legacySubIds: ["7,1,1"] }],
  });
  expect(() => readLegacyPanel("100000123", legacy)).toThrow("不匹配");
});

test("旧模板素材按实际遗器物品 ID 寻址，并支持喵喵角色别名", async () => {
  const folder = await mkdtemp(join(tmpdir(), "lotus-sr-panel-meta-"));
  try {
    const artifact = join(folder, "meta-sr", "artifact");
    await mkdir(artifact, { recursive: true });
    await writeFile(join(artifact, "data.json"), JSON.stringify({
      "101": { name: "云无留迹的过客", idxs: {
        "3": { name: "过客的残绣风衣", ids: { "31013": 2, "41013": 3, "51013": 4, "61013": 5 } },
      } },
    }));
    const theme = await readTheme(folder);
    expect(theme.relicById.get("61013")).toEqual({ name: "过客的残绣风衣", asset: ["artifact", "云无留迹的过客", "arti-3.webp"] });
    const { avatars } = normalizePanel("500000123", [{ id: 1001, name: "三月七", level: 80 }]);
    expect(findPanelAvatar(avatars, "三月", theme)?.id).toBe("1001");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
