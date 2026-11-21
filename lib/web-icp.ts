export const siteIcpLink = "https://beian.miit.gov.cn/";
export const siteIcpMaxLength = 256;

/** The filing number is configured as public, single-line text. */
export function siteIcpNumber(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > siteIcpMaxLength) return;
  const text = value.trim();
  if (!/[\p{Cc}\p{Zl}\p{Zp}]/u.test(text)) return text;
}

export function configuredSiteIcpNumber(value: unknown) {
  // Older pages also displayed unquoted numeric entries from YAML.
  return siteIcpNumber(typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : value);
}

export function renderSiteIcpFooter(html: string, config: unknown) {
  const text = config && typeof config === "object" && "icp_number" in config ? configuredSiteIcpNumber(config.icp_number) : undefined;
  const escape: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return html.replace("<!--miyoushe-icp-footer-->", () => text
    ? `<footer class="site-footer"><a href="${siteIcpLink}" target="_blank" rel="noopener noreferrer">${text.replace(/[&<>"']/gu, char => escape[char]!)}</a></footer>`
    : "");
}
