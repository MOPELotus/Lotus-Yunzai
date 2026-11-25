import { captchaConfig } from "./captcha/providers.ts";

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const pick = (source: Fields, keys: readonly string[]) => Object.fromEntries(keys.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));

/** 只转换配置数据，不执行旧验证码脚本或启动旧本地 HTTP 服务。 */
export function normalizeLegacyCaptchaGlobal(input: Fields): Fields {
  const nested = fields(input.captcha);
  const candidate = Object.hasOwn(input, "captcha") ? nested : input;
  const kind = String(candidate.type ?? "").toLowerCase();
  const ttocrKind = kind === "1" || kind.includes("ttocr");
  const flattened = ["api", "resapi", "verifyAddr", "verify_addr", "Address", "GtestType", "gtestType", "startApi"].some(key => Object.hasOwn(candidate, key)) ||
    (Object.hasOwn(input, "captcha") && ["key", "address"].some(key => Object.hasOwn(candidate, key))) || (ttocrKind && Object.hasOwn(candidate, "key"));
  if (!flattened) return input;
  const old = candidate;
  const providers = ["test_nine"];
  const type = String(old.type ?? "").toLowerCase();
  if (type === "1" || type.includes("ttocr") || old.api || old.resapi || old.key) providers.push("ttocr");
  if (old.verifyAddr || old.verify_addr || old.Address || old.address || String(old.GtestType ?? old.gtestType) === "2") providers.push("gtmanual");
  const projected = {
    providers,
    test_nine: { enable: true },
    ttocr: { enable: Boolean(old.key || old.api || old.resapi), ...pick(old, ["api", "resapi", "key", "query"]) },
    gtmanual: { enable: Boolean(old.verifyAddr || old.verify_addr || old.Address || old.address),
      ...(old.Address || old.address ? { address: old.Address || old.address } : {}),
      ...(old.verifyAddr || old.verify_addr ? { verify_addr: old.verifyAddr || old.verify_addr } : {}) },
  };
  return { ...input, captcha: { ...projected, ...nested,
    test_nine: { ...projected.test_nine, ...fields(nested.test_nine) },
    ttocr: { ...projected.ttocr, ...fields(nested.ttocr) },
    gtmanual: { ...projected.gtmanual, ...fields(nested.gtmanual) },
  } };
}

export function projectLegacyCaptchaConfig(input: unknown) {
  const source = fields(input);
  const projected = pick(source, ["enable", "providers", "order"]);
  for (const name of ["local", "test_nine"] as const) {
    if (!Object.hasOwn(source, name)) continue;
    projected[name] = pick(fields(source[name]), ["enable", "timeout_ms"]);
  }
  const ttocr = fields(source.ttocr);
  if (Object.hasOwn(source, "ttocr")) {
    const value = pick(ttocr, ["enable", "key", "api", "resapi", "timeout_ms", "poll_interval_ms", "itemid", "itemid_v4", "referer"]);
    const query = new URLSearchParams(typeof ttocr.query === "string" ? ttocr.query : "");
    if (value.itemid == null && query.has("itemid")) value.itemid = query.get("itemid");
    if (value.referer == null && query.has("referer")) value.referer = query.get("referer");
    projected.ttocr = value;
  }
  for (const name of ["manual", "gtmanual"] as const) {
    if (Object.hasOwn(source, name)) projected[name] = pick(fields(source[name]), ["enable"]);
  }
  // 校验沿用实际provider入口；错误消息不含密钥或地址。
  captchaConfig(projected);
  return projected;
}

/** 旧外部人工服务与新relay接口不同；只接受明确的公开base或已知根注册路径。 */
export function legacyManualCaptchaBase(input: unknown) {
  const source = fields(input), manual = fields(source.manual ?? source.gtmanual);
  const direct = manual.public_url ?? manual.url ?? manual.address ?? manual.Address;
  const registration = manual.verify_addr ?? manual.verifyAddr;
  const raw = direct ?? registration;
  if (typeof raw !== "string" || !raw.trim()) return { deferred: [] as string[] };
  const url = URL.parse(raw.trim());
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    return { deferred: ["captcha.manual.public_url"] };
  }
  if (direct !== undefined && !url.search) return { url: url.href.replace(/\/$/u, ""), deferred: ["captcha.manual.reverse_proxy"] };
  if (direct === undefined && /^\/GTest\/register\/?$/iu.test(url.pathname)) {
    return { url: url.origin, deferred: ["captcha.manual.reverse_proxy"] };
  }
  return { deferred: ["captcha.manual.legacy_endpoint"] };
}
