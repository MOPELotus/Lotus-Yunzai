import { expect, test } from "bun:test";
import { openZzzCardTheme } from "../plugins/zzz/card-theme.ts";
import { loadPanelWeaponImage, loadPanelDiscImage, readPanelArtMap } from "../plugins/zzz/panel-artwork.ts";

test("验证绝区零全量映射图标离线加载与原图渲染", async () => {
  const local = await openZzzCardTheme({});
  const weapons = await readPanelArtMap(undefined, "WeaponId2Data");
  const suits = await readPanelArtMap(undefined, "SuitData");
  expect(Object.keys(weapons).length).toBeGreaterThan(100);
  expect(Object.keys(suits).length).toBeGreaterThan(30);
  for (const record of Object.values(weapons)) {
    const image = await loadPanelWeaponImage(local, record);
    expect(image?.width).toBeGreaterThan(0);
    expect(image?.height).toBeGreaterThan(0);
  }
  for (const record of Object.values(suits)) {
    const image = await loadPanelDiscImage(local, record);
    expect(image?.width).toBeGreaterThan(0);
    expect(image?.height).toBeGreaterThan(0);
  }
  expect(await loadPanelWeaponImage(local, undefined)).toBeUndefined();
  expect(await loadPanelDiscImage(local, undefined)).toBeUndefined();
});
