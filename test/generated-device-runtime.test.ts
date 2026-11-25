import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "../packages/account/index.ts";
import { generateProfileDevice, VIRTUAL_DEVICE_TEMPLATES } from "../packages/account/generated-device.ts";
import { createGeneratedDeviceRefresh } from "../lib/generated-device-runtime.ts";

const fp = "a1b2c3d4e5f67";
const signal = () => new AbortController().signal;
const issued = () => Response.json({ retcode: 0, data: { code: 200, device_fp: fp } });
async function fixture(run: (profiles: ReturnType<typeof createProfileStore>, path: string) => Promise<void>, device: unknown = {}) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-generated-device-"));
  const path = join(directory, "42.yaml");
  try {
    await writeFile(path, Bun.YAML.stringify({ version: 1, user: { qq: "42" }, profile: { id: 1 },
      account: { cookie: "cookie_token=fixture", stoken: "fixture", stuid: "123" }, device }));
    await run(createProfileStore(directory), path);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("六组模板的型号、系统与固件成套生成，OAID 和实例独立", () => {
  expect(VIRTUAL_DEVICE_TEMPLATES).toHaveLength(6);
  for (const template of VIRTUAL_DEVICE_TEMPLATES) {
    const device = generateProfileDevice({ templateId: template.id });
    expect(device).toMatchObject({ bound: false, generated: true, fp: "", model: template.model, android_version: template.os });
    expect(device.raw.deviceFingerprint).toBe(`google/${template.product}/${template.product}:${template.os}/${template.build}/${template.incremental}:user/release-keys`);
    expect(device.raw.sdkVersion).toBe(template.sdk);
    expect(device.raw.oaid).toMatch(/^[a-f0-9]{64}$/u);
    expect(device.id).toMatch(/^[a-f0-9]{32}$/u);
    expect(generateProfileDevice({ templateId: template.id }).instance_id).not.toBe(device.instance_id);
  }
});

test("生成参数先落盘，同一设备重试申请 FP，人工绑定随后覆盖自动设备", () => fixture(async (profiles, path) => {
  const bodies: string[] = [];
  const runtime = createGeneratedDeviceRefresh(profiles, { signal: signal(), report() {}, transport: async (_url, init) => {
    const saved = Bun.YAML.parse(await readFile(path, "utf8")) as any;
    const body = JSON.parse(String(init.body));
    expect(body.device_id).toBe(saved.device.id);
    expect(body.bbs_device_id).toBe(saved.device.raw.bbsDeviceId);
    expect(saved.device.fp).toBe("");
    expect(new Headers(init.headers).has("Cookie")).toBe(false);
    expect(init.keepalive).toBe(false);
    bodies.push(String(init.body));
    return bodies.length === 1 ? new Response(null, { status: 503 }) : issued();
  } });
  const [a, b] = await Promise.all([runtime.refresh("42"), runtime.refresh("42")]);
  expect(a.ok && b.ok).toBe(true);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  let saved = Bun.YAML.parse(await readFile(path, "utf8")) as any;
  expect(saved.device).toMatchObject({ generated: true, bound: false, fp, fp_source: "mihoyo" });
  const original = saved.device.id;
  const current = await profiles.accountContext("42");
  await profiles.saveBoundDevice("42", 1, current, { id: "manual-device-id", fp: "123456789abcd" });
  expect((await runtime.refresh("42")).ok).toBe(true);
  saved = Bun.YAML.parse(await readFile(path, "utf8")) as any;
  expect(saved.device).toMatchObject({ bound: true, generated: false, id: "manual-device-id", fp: "123456789abcd" });
  expect(saved.device.id).not.toBe(original);
  expect(bodies).toHaveLength(2);
}));

test("申请失败和冷却不更换设备，重启补跑仍复用已保存 ID 与 GUID", () => fixture(async (profiles, path) => {
  let requests = 0;
  const failed = createGeneratedDeviceRefresh(profiles, { signal: signal(), report() {}, transport: async () => {
    requests++; return new Response(null, { status: 429 });
  } });
  expect((await failed.refresh("42")).ok).toBe(false);
  const before = Bun.YAML.parse(await readFile(path, "utf8")) as any;
  expect((await failed.refresh("42")).cooldown).toBe(true);
  expect(requests).toBe(1);
  const retry = createGeneratedDeviceRefresh(profiles, { signal: signal(), transport: async (_url, init) => {
    const body = JSON.parse(String(init.body));
    expect(body.device_id).toBe(before.device.id);
    expect(body.bbs_device_id).toBe(before.device.raw.bbsDeviceId);
    return issued();
  } });
  expect((await retry.refresh("42")).ok).toBe(true);
  expect((await profiles.accountContext("42")).device.id).toBe(before.device.id);
}));

test("FP 在途期间手动绑定优先，不覆盖新设备", () => fixture(async profiles => {
  const runtime = createGeneratedDeviceRefresh(profiles, { signal: signal(), report() {}, transport: async () => {
    const current = await profiles.accountContext("42");
    await profiles.saveBoundDevice("42", 1, current, { id: "manual-new-device", fp: "123456789abcd" });
    return issued();
  } });
  expect(await runtime.refresh("42")).toMatchObject({ ok: false, changed: true });
  expect((await profiles.accountContext("42")).device).toMatchObject({ id: "manual-new-device", fp: "123456789abcd" });
}));

test("升级旧 TS 占位设备保留 ID，未知半份旧设备不重建", async () => {
  await fixture(async profiles => {
    const result = await profiles.prepareGeneratedDevice("42");
    expect(result.pending).toBe(true);
    expect(result.source.device.id).toBe("ABCDEF0123456789ABCDEF0123456789");
    expect(result.source.device.raw.deviceModel).toMatch(/^Pixel /u);
  }, { bound: false, id: "ABCDEF0123456789ABCDEF0123456789", fp: "", name: "Lotus Device", model: "Lotus", raw: {} });
  await fixture(async (profiles, path) => {
    const before = await readFile(path, "utf8");
    const result = await profiles.prepareGeneratedDevice("42");
    expect(result.pending).toBe(false);
    expect(await readFile(path, "utf8")).toBe(before);
  }, { id: "legacy-partial-id", fp: "", model: "Legacy" });
});
