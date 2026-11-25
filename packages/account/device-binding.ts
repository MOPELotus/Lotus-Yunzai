import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("account", messageCatalog.messages);
export interface DeviceBinding {
  readonly id: string;
  readonly fp: string;
  readonly name?: string;
  readonly model?: string;
  readonly androidVersion?: string;
}

type Fields = Record<string, unknown>;
type DeviceField = keyof DeviceBinding;
const maxInputBytes = 16 * 1024;
const aliases: Readonly<Record<DeviceField, readonly string[]>> = {
  id: ["device_id", "deviceid", "id", "bbs_device_id", "x-rpc-device_id"],
  fp: ["device_fp", "devicefp", "fp", "x-rpc-device_fp"],
  name: ["devicename", "device_name", "name", "x-rpc-device_name"],
  model: ["devicemodel", "device_model", "model", "x-rpc-device_model"],
  androidVersion: ["android_version", "androidversion", "osversion", "x-rpc-sys_version"],
};
const labels = new Set(Object.values(aliases).flat());

function formatError(): never {
  throw new TypeError($t("device-binding.text_90c0b0a166"));
}

function object(value: unknown): Fields | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Fields;
}

function readJson(input: string): Fields {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    formatError();
  }
  const root = object(value);
  if (!root) formatError();

  // JSON.parse keeps the last value for duplicate keys. Check the original
  // keys so a second device ID or fingerprint cannot silently replace a first.
  const scopes: (Set<string> | null)[] = [];
  for (const [token] of input.matchAll(/"(?:[^"\\]|\\.)*"\s*:?|[{}\[\]]/gsu)) {
    if (token === "{") scopes.push(new Set());
    else if (token === "[") scopes.push(null);
    else if (token === "}" || token === "]") scopes.pop();
    else if (token.endsWith(":")) {
      const keys = scopes.at(-1);
      const key = JSON.parse(token.slice(0, -1)) as string;
      if (keys?.has(key)) throw new TypeError($t("device-binding.text_5d3e5cca57"));
      keys?.add(key);
    }
  }
  return root;
}

function readText(input: string): Fields {
  const entry = /([\w-]+)\s*[:=：]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s;'",]+))(?:[\s;,]+|$)/gyu;
  const fields: Fields = Object.create(null);
  let end = 0;
  for (const match of input.matchAll(entry)) {
    const key = match[1]!.toLowerCase();
    if (!labels.has(key)) formatError();
    const value = match[2] ?? match[3] ?? match[4];
    if (Object.hasOwn(fields, key) && fields[key] !== value) {
      throw new TypeError($t("device-binding.text_87110b5e0f"));
    }
    fields[key] = value;
    end = match.index + match[0].length;
  }
  if (end !== input.length) formatError();
  return fields;
}

function values(input: Fields, field: DeviceField): string[] {
  return Object.entries(input).flatMap(([key, value]) => {
    if (!aliases[field].includes(key.toLowerCase()) || value === "" || value === null || value === undefined) return [];
    if (field === "androidVersion" && typeof value === "number" && Number.isFinite(value)) return [String(value)];
    if (typeof value !== "string") {
      if (field === "id" || field === "fp") formatError();
      return [];
    }
    const text = value.trim();
    if ((field === "id" || field === "fp") && /[^\x20-\x7E]/u.test(value)) formatError();
    return text ? [text] : [];
  });
}

function single(candidates: readonly string[]): string | undefined {
  const [first] = candidates;
  if (candidates.some((candidate) => candidate !== first)) {
    throw new TypeError($t("device-binding.text_87110b5e0f"));
  }
  return first;
}

function friendlyLabel(value: string | undefined): string | undefined {
  if (value && /^[A-Za-z0-9][A-Za-z0-9 ._+()-]{0,63}$/u.test(value)) return value;
}

function bindingInput(input: string): Fields {
  if (typeof input !== "string" || Buffer.byteLength(input) > maxInputBytes) formatError();
  const text = input.trim();
  const fenced = /^\x60{3}(?:json)?\r?\n([\s\S]*)\r?\n\x60{3}$/iu.exec(text);
  const firstLabel = /^([\w-]+)\s*[:=：]/u.exec(text)?.[1]?.toLowerCase();
  const embedded = firstLabel && labels.has(firstLabel) ? undefined : /\{[\s\S]*\}/u.exec(text)?.[0];
  const json = fenced?.[1] ?? embedded;
  return json === undefined ? readText(text) : readJson(json);
}

export function parseDeviceBinding(input: string): DeviceBinding {
  const root = bindingInput(input);
  const nested = object(root.data);
  const source = nested ?? root;
  for (const candidate of [root, source]) {
    if (Object.hasOwn(candidate, "ext_fields") || (Object.hasOwn(candidate, "app_name") && Object.hasOwn(candidate, "seed_id"))) {
      throw new TypeError($t("device-binding.text_9bf70b125f"));
    }
  }
  if ((Object.hasOwn(root, "retcode") || Object.hasOwn(source, "code")) &&
      (!(root.retcode === 0 || root.retcode === "0") || !(source.code === 200 || source.code === "200"))) {
    throw new TypeError($t("device-binding.text_704a85f1a1"));
  }

  const id = single(values(source, "id"));
  const fp = single(values(source, "fp"));
  if (!id || !fp) throw new TypeError($t("device-binding.text_00c7b2076f"));
  if (nested) {
    single([id, ...values(root, "id")]);
    single([fp, ...values(root, "fp")]);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(id) || !/^[\da-f]{13}$/iu.test(fp)) {
    throw new TypeError($t("device-binding.text_a0d5419d13"));
  }

  function metadata(field: DeviceField): string | undefined {
    return single(nested ? [...values(source, field), ...values(root, field)] : values(root, field));
  }
  const name = friendlyLabel(metadata("name"));
  const model = friendlyLabel(metadata("model"));
  const version = metadata("androidVersion")?.replace(/^Android\s+/iu, "");
  const androidVersion = version && /^\d{1,2}(?:L|(?:\.\d{1,2}){0,2})$/iu.test(version) ? version : undefined;
  return { id, fp, ...(name ? { name } : {}), ...(model ? { model } : {}), ...(androidVersion ? { androidVersion } : {}) };
}


export interface AndroidDeviceInfo {
  readonly deviceName: string;
  readonly deviceModel: string;
  readonly deviceFingerprint: string;
  readonly deviceProduct: string;
  readonly deviceBoard: string;
  readonly oaid: string;
  readonly [key: string]: string | undefined;
}

// Only APK metadata without an existing identity may start fingerprint issuance.
// Complete pairs, partial pairs and getFp requests/responses keep the strict
// direct-binding checks, rather than silently replacing their device identity.
export function parseAndroidDeviceInfo(input: string): AndroidDeviceInfo | undefined {
  const root = bindingInput(input);
  if (root.data !== undefined || root.retcode !== undefined || root.code !== undefined ||
      root.ext_fields !== undefined || root.seed_id !== undefined || root.app_name !== undefined ||
      Object.keys(root).some(key => [...aliases.id, ...aliases.fp].includes(key.toLowerCase()))) return;
  const required = ["deviceName", "deviceModel", "deviceFingerprint", "deviceProduct", "deviceBoard", "oaid"] as const;
  if (!required.some(field => Object.hasOwn(root, field))) return;
  const result: Record<string, string> = Object.create(null);
  for (const field of required) {
    const value = root[field];
    if (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new TypeError($t("device-binding.text_ffbef5173b"));
    }
    result[field] = value.trim();
  }
  if (result.oaid!.startsWith("error_")) throw new TypeError($t("device-binding.text_024297a620"));
  const optional = ["deviceBrand", "manufacturer", "hardware", "romCapacity", "romRemain", "screenSize", "sdCapacity", "sdRemain",
    "buildTime", "buildUser", "ramCapacity", "ramRemain", "sdkVersion", "display", "packageVersion"];
  for (const field of optional) {
    const value = root[field];
    if (value === undefined || value === null || value === "") continue;
    const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
    if (typeof text !== "string" || text.length > 1024 || /[\u0000-\u001f\u007f]/u.test(text)) {
      throw new TypeError($t("device-binding.text_aac811e11e"));
    }
    result[field] = text.trim();
  }
  const version = single(values(root, "androidVersion")) ?? /:([^/]+)\//u.exec(result.deviceFingerprint!)?.[1];
  if (version) {
    const normalized = version.replace(/^Android\s+/iu, "");
    if (!/^\d{1,2}(?:L|(?:\.\d{1,2}){0,2})$/iu.test(normalized)) throw new TypeError($t("device-binding.text_1f5fcc390f"));
    result.osVersion = normalized;
  }
  return result as unknown as AndroidDeviceInfo;
}
