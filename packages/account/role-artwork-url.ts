const artworkHosts = new Set([
  "act-webstatic.mihoyo.com", "fastcdn.mihoyo.com", "upload-static.mihoyo.com", "webstatic.mihoyo.com",
  "upload-bbs.mihoyo.com", "upload-bbs.miyoushe.com", "uploadstatic-sea.mihoyo.com", "webstatic-sea.mihoyo.com",
  "act-webstatic.hoyoverse.com", "fastcdn.hoyoverse.com", "upload-static.hoyoverse.com", "webstatic.hoyoverse.com",
  "upload-os-bbs.hoyolab.com", "hyl-static-res-prod.hoyolab.com",
]);

/** 档案只保存官方角色原图 URL，移除签名、查询参数和片段。 */
export function normalizeProfileRoleArtworkUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const source = value.trim();
  if (!/^https:\/\//iu.test(source) || /[\\\x00-\x20\x7f]/u.test(source)) return;

  const url = URL.parse(source);
  if (!url || url.protocol !== "https:" || url.port || url.username || url.password ||
      !artworkHosts.has(url.hostname) || !/\.(?:png|jpe?g|webp)$/iu.test(url.pathname)) return;
  url.search = "";
  url.hash = "";
  return url.href;
}
