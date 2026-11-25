/** Keep browser management commands out of character-panel fuzzy matching. */
export function isPanelOwnerCommand(message: string) {
  return /^#?(?:管理面板|配置面板|面板管理)$/u.test(message.trim());
}
