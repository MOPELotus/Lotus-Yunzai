import { randomBytes, randomUUID } from "node:crypto";
import { parseDeviceBinding, type AndroidDeviceInfo, type DeviceBinding } from "@lotus-yunzai/account";
import { setTimeout as delay } from "node:timers/promises";
import type { HoyoTransport } from "./credentials.ts";
import { readGameRecordPayload } from "./game-record.ts";

const endpoint = "https://public-data-api.mihoyo.com/device-fp/api/getFp";
// This value is only an issuance seed. It must never be saved as an issued FP.
const seed = "38d80737ce6f3";
const apiLevels: Readonly<Record<string, string>> = {
  "8": "26", "8.1": "27", "9": "28", "10": "29", "11": "30", "12L": "32",
  "13": "33", "14": "34", "15": "35", "16": "36", "17": "37",
};

export class DeviceFingerprintError extends Error {
  constructor() { super("设备指纹申请未完成，请稍后重新发送设备 JSON。"); this.name = "DeviceFingerprintError"; }
}

export function buildDeviceFingerprintPayload(info: AndroidDeviceInfo) {
  const deviceId = randomBytes(8).toString("hex");
  const deviceGuid = randomUUID();
  const brand = info.deviceFingerprint.split("/")[0] || info.deviceBrand || "Android";
  const osVersion = info.osVersion ?? "";
  const release = osVersion.toUpperCase().replace(/(?:\.0)+$/u, "");
  const ext = {
    proxyStatus: 1, isRoot: 0, romCapacity: info.romCapacity || "512", deviceName: info.deviceName,
    productName: info.deviceProduct, romRemain: info.romRemain || (info.romCapacity ? undefined : "434"),
    hostname: "a11-gz02-test.i.nease.net", screenSize: info.screenSize || "1440x2560", isTablet: 0,
    aaid: deviceGuid, model: info.deviceModel, brand, hardware: info.hardware || brand, deviceType: info.deviceName,
    devId: "REL", serialNumber: "unknown", sdCapacity: info.sdCapacity || (info.romCapacity ? undefined : 127991),
    buildTime: info.buildTime || "1731038709000", buildUser: info.buildUser || "builder001", simState: 5,
    ramRemain: info.ramRemain || (info.ramCapacity ? undefined : "125933"), appUpdateTimeDiff: 1741848587885,
    deviceInfo: info.deviceFingerprint, vaid: randomUUID(), buildType: "user", sdkVersion: info.sdkVersion || apiLevels[release],
    ui_mode: "UI_MODE_TYPE_NORMAL", isMockLocation: 0, cpuType: "arm64-v8a", isAirMode: 0, ringMode: 2,
    chargeStatus: 1, manufacturer: info.manufacturer || brand, emulatorStatus: 0, appMemory: "512",
    osVersion: osVersion || undefined, vendor: "unknown", accelerometer: "0.10001241x9.800007x0.1999938",
    sdRemain: info.sdRemain || (info.romCapacity ? undefined : 119363), buildTags: "release-keys",
    packageName: "com.mihoyo.hyperion", networkType: "WiFi", oaid: info.oaid, debugStatus: 0,
    ramCapacity: info.ramCapacity || "127991", magnetometer: "15.625x-28.25x-32.625",
    display: info.display || info.deviceFingerprint.split("/")[3] || info.deviceModel,
    appInstallTimeDiff: 1733055335683, packageVersion: info.packageVersion || "2.118.1", gyroscope: "0.0x0.0x0.0",
    batteryStatus: 99, hasKeyboard: 1, board: info.deviceBoard,
  };
  return { app_name: "bbs_cn", bbs_device_id: deviceGuid, device_fp: seed, device_id: deviceId,
    ext_fields: JSON.stringify(ext), platform: "2", seed_id: randomUUID(), seed_time: String(Date.now()) };
}

export async function requestDeviceFingerprint(info: AndroidDeviceInfo, {
  transport = (url, init) => fetch(url, init), signal, verify,
}: { readonly transport?: HoyoTransport; readonly signal: AbortSignal; readonly verify?: () => Promise<void> }): Promise<DeviceBinding> {
  const payload = buildDeviceFingerprintPayload(info);
  const body = JSON.stringify(payload);
  async function guard() { signal.throwIfAborted(); await verify?.(); signal.throwIfAborted(); }
  for (let attempt = 0; attempt < 3; attempt++) {
    await guard();
    if (attempt) await delay(500 * attempt, undefined, { signal });
    await guard();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    let response: Response;
    try {
      response = await transport(new URL(endpoint), {
        method: "POST", headers: { "User-Agent": "okhttp/4.9.3", "Content-Type": "application/json" },
        body, signal: deadline, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
      });
    } catch {
      await guard();
      if (attempt < 2) continue;
      throw new DeviceFingerprintError();
    }
    await guard();
    if (response.redirected || (response.url && response.url !== endpoint)) {
      await response.body?.cancel().catch(() => undefined);
      throw new DeviceFingerprintError();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if ((response.status === 408 || response.status >= 500) && attempt < 2) continue;
      throw new DeviceFingerprintError();
    }
    let result: Awaited<ReturnType<typeof readGameRecordPayload>>;
    try { result = await readGameRecordPayload(response, 128 * 1024, deadline); }
    catch { await guard(); throw new DeviceFingerprintError(); }
    await guard();
    const data = result?.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new DeviceFingerprintError();
    const issued = data as Record<string, unknown>;
    if (result?.retcode !== 0 || String(issued.code) !== "200" || typeof issued.device_fp !== "string" ||
        !/^[0-9a-f]{13}$/iu.test(issued.device_fp) || issued.device_fp.toLowerCase() === seed) throw new DeviceFingerprintError();
    if ((issued.device_id !== undefined && issued.device_id !== payload.device_id) ||
        (issued.bbs_device_id !== undefined && issued.bbs_device_id !== payload.bbs_device_id)) throw new DeviceFingerprintError();
    return parseDeviceBinding(JSON.stringify({ device_id: payload.device_id, device_fp: issued.device_fp,
      deviceName: info.deviceName, deviceModel: info.deviceModel, osVersion: info.osVersion }));
  }
  throw new DeviceFingerprintError();
}
