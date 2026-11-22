import { lstat, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readOptionalConfigFile } from "../config.ts";
import { inspectOptionalProtocolPackage } from "../optional-protocol-package.ts";
import type { OptionalProtocolRegistration } from "./optional-protocol-runtime.ts";
import type { ProtocolGateway } from "./optional-protocol.ts";

const packages = { satori: "@lotus-yunzai/adapter-satori", kook: "@lotus-yunzai/adapter-kook" } as const;
const ids = ["satori", "kook"] as const;
export type OptionalProtocolId = typeof ids[number];
/** Package tree digests come from the approved release or installer, never from the YAML. */
export type OptionalProtocolPins = Readonly<Partial<Record<OptionalProtocolId, string>>>;

const instanceName = /^[a-z][a-z0-9-]{0,47}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const ownOptions = {
  satori: new Set(["http_endpoint", "ws_endpoint", "token", "platform", "timeout", "heartbeat_interval"]),
  kook: new Set(["token", "sendCardMessage", "assetByteLimit"]),
};

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function configError(id: OptionalProtocolId): never {
  throw new Error("附加协议 " + id + " 的选装配置无效。");
}

interface ConfiguredInstance {
  readonly instance: string;
  readonly options: Readonly<Record<string, unknown>>;
}

export function parseOptionalProtocolSettings(id: OptionalProtocolId,
  config: Readonly<Record<string, unknown>> | undefined): readonly ConfiguredInstance[] {
  if (!config || config.enable === undefined || config.enable === null || config.enable === false) return [];
  const slots = record(config.instances);
  if (config.enable !== true || !slots || Object.keys(config).some(key => key !== "enable" && key !== "instances")) {
    return configError(id);
  }
  const entries = Object.entries(slots);
  if (!entries.length) return configError(id);
  return entries.map(([instance, value]) => {
    const options = record(value);
    if (!instanceName.test(instance) || !options || Object.keys(options).some(key => !ownOptions[id].has(key))) return configError(id);
    if (id === "kook") {
      const { token, sendCardMessage, assetByteLimit } = options;
      if (typeof token !== "string" || !/^[!-~]{1,512}$/u.test(token) ||
          (sendCardMessage !== undefined && typeof sendCardMessage !== "boolean") ||
          (assetByteLimit !== undefined && (typeof assetByteLimit !== "number" || !Number.isSafeInteger(assetByteLimit) ||
            assetByteLimit < 1 || assetByteLimit > 64 * 1024 * 1024))) return configError(id);
    }
    return { instance, options };
  });
}

function packageError(id: OptionalProtocolId): never {
  throw new Error("附加协议 " + id + " 缺少已验证的固定包。");
}

async function verifyPackage(root: string, id: OptionalProtocolId, digest: string, signal?: AbortSignal): Promise<URL> {
  if (!sha256Pattern.test(digest)) return packageError(id);
  const packageParent = join(root, "data", "optional-protocols");
  const directory = join(packageParent, id);
  const stableFolders = [join(root, "data"), packageParent];
  try {
    for (const folder of stableFolders) {
      const info = await lstat(folder);
      if (!info.isDirectory() || (info.mode & 0o6000) || await realpath(folder) !== folder) return packageError(id);
    }
    const pkg = await inspectOptionalProtocolPackage(directory, signal);
    if (pkg?.manifest.name !== packages[id] || pkg.packageTreeSha256 !== digest) return packageError(id);
    const { manifest, packageFiles } = pkg;
    const entry = typeof manifest.exports === "string" ? manifest.exports : record(manifest.exports)?.["."];
    if (typeof entry !== "string" || !/^\.\/(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+\.ts$/iu.test(entry) ||
        !packageFiles.some(file => file.path === entry.slice(2))) return packageError(id);
    return pathToFileURL(join(directory, entry));
  } catch {
    signal?.throwIfAborted();
    return packageError(id);
  }
}

export async function verifiedOptionalProtocolEntry(root: URL, id: OptionalProtocolId, digest: string, signal?: AbortSignal): Promise<URL> {
  signal?.throwIfAborted();
  return verifyPackage(await realpath(fileURLToPath(root)), id, digest, signal);
}

function gateway(value: unknown): value is ProtocolGateway {
  const shape = record(value);
  return typeof shape?.start === "function" && typeof shape.send === "function";
}

function bindGateway(id: OptionalProtocolId, module: Record<string, unknown>, config: ConfiguredInstance): ProtocolGateway {
  let candidate: unknown;
  if (id === "satori") {
    const { createSatoriGateway, parseSatoriSettings } = module;
    if (typeof createSatoriGateway !== "function" || typeof parseSatoriSettings !== "function") return packageError(id);
    const settings: unknown = parseSatoriSettings({ ...config.options, enable: true });
    if (!settings) return configError(id);
    candidate = createSatoriGateway(settings, config.instance);
  } else {
    const { createKookGateway } = module;
    if (typeof createKookGateway !== "function") return packageError(id);
    candidate = createKookGateway({ ...config.options, instance: config.instance });
  }
  if (!gateway(candidate)) return packageError(id);
  if (id === "kook") return candidate;

  // Satori's fixed package starts its socket immediately; the host contract waits for shutdown.
  const satori = candidate;
  return {
    send: (message, parts, signal) => satori.send(message, parts, signal),
    async start(receive, signal) {
      if (signal.aborted) return;
      await satori.start(receive, signal);
      if (signal.aborted) return;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  };
}

/** Resolve and construct deliberately selected gateways. The caller controls their lifecycle separately. */
export async function loadConfiguredOptionalProtocols(root: URL, pins: OptionalProtocolPins = {},
  signal?: AbortSignal): Promise<readonly OptionalProtocolRegistration[]> {
  signal?.throwIfAborted();
  const physicalRoot = await realpath(fileURLToPath(root));
  const configRoot = pathToFileURL(physicalRoot + sep);
  const registrations: OptionalProtocolRegistration[] = [];
  for (const adapter of ids) {
    signal?.throwIfAborted();
    const local = "config/optional-protocols/" + adapter + ".yaml";
    const path = join(physicalRoot, local);
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!info) continue;
    if (!info.isFile() || await realpath(path) !== path) return configError(adapter);
    const selections = parseOptionalProtocolSettings(adapter, await readOptionalConfigFile(configRoot, local));
    if (!selections.length) continue;
    const digest = pins[adapter];
    if (!digest) return packageError(adapter);
    const entry = await verifyPackage(physicalRoot, adapter, digest, signal);
    signal?.throwIfAborted();
    try {
      const module: unknown = await import(entry.href);
      signal?.throwIfAborted();
      const exports = record(module);
      if (!exports) return packageError(adapter);
      for (const selected of selections) {
        registrations.push({ adapter, instance: selected.instance, gateway: bindGateway(adapter, exports, selected) });
      }
    } catch {
      signal?.throwIfAborted();
      throw new Error("附加协议 " + adapter + " 入口或配置校验失败。");
    }
  }
  return registrations;
}
