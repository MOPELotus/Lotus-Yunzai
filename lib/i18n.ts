/** Runtime entry for server text and default/private language catalog initialization. */
export * from "../packages/i18n/index.ts";

export async function initializeI18n(root: URL) {
  const { getI18nSettings } = await import("./i18n-settings.ts");
  const settings = getI18nSettings(root);
  await settings.load();
  return settings;
}
