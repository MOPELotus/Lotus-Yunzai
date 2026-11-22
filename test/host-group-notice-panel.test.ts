import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

test("面板群通知用宿主令牌和版本控制保存全部默认开关与撤回缓存", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-panel-notice-"));
  const token = "group-notice-panel-fixture";
  let host: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await copyHost(root);
    await cp(new URL("../plugins/group", import.meta.url), join(root, "plugins/group"), {
      recursive: true,
      filter: path => !path.endsWith("/.git") && !path.endsWith("/node_modules"),
    });
    await mkdir(join(root, "config"), { recursive: true });
    const file = join(root, "config/group-notice.yaml");
    const original = "# 保留注释\ndefault: { groupMessage: false, privateMessage: true }\n" +
      '42: { groupMessage: false }\n"99:42": { groupRecall: false }\n"bot:99": { notificationsAll: true }\n';
    await writeFile(file, original);
    host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0", LOTUS_PANEL_TOKEN: token },
    });
    const processHost = host;
    timer = setTimeout(() => processHost.kill("SIGKILL"), 6_000);
    const errors = new Response(host.stderr).text();
    const stream = host.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let seen = "";
    let endpoint: URL;
    try {
      for (;;) {
        const match = /http:\/\/127\.0\.0\.1:\d+\/status/u.exec(seen);
        if (match) {
          endpoint = new URL("/panel/api/settings/group/notices", match[0]);
          break;
        }
        const next = await stream.read();
        if (next.done) throw new Error(`通知面板测试宿主没有启动。\n${seen}\n${await errors}`);
        seen += next.value;
      }
    } finally {
      stream.releaseLock();
    }

    async function request(method = "GET", body?: unknown, credential = token) {
      return fetch(endpoint, {
        method, signal: AbortSignal.timeout(3_000),
        headers: { Authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    expect((await request("GET", undefined, "other-panel-token")).status).toBe(401);
    expect((await request("POST")).status).toBe(405);
    const reading = await request();
    expect(reading.status).toBe(200);
    expect(reading.headers.get("Cache-Control")).toBe("no-store");
    const before = await reading.json() as { revision: string; settings: Record<string, boolean | number>; writable: boolean };
    expect(before.writable).toBe(true);
    expect(Object.keys(before.settings)).toHaveLength(15);
    expect(before.settings).toMatchObject({ groupMessage: false, privateMessage: true, PrivateRecall: false,
      friendRequest: false, groupInviteRequest: false, friendNumberChange: false, notificationsAll: true, msgSaveDeltime: 600 });
    expect(Object.keys(before).sort()).toEqual(["revision", "settings", "writable"]);

    const patch = { groupMessage: true, addGroupApplication: true, privateMessage: false, PrivateRecall: true,
      friendRequest: true, groupInviteRequest: true, friendNumberChange: true, notificationsAll: false, msgSaveDeltime: 300 };
    const save = { revision: before.revision, patch };
    expect((await request("PUT", { ...save, path: "config/other.yaml" })).status).toBe(400);
    expect((await request("PUT", { ...save, patch: { msgSaveDeltime: 0 } })).status).toBe(400);
    expect((await request("PUT", { ...save, patch: { default: { notificationsAll: false } } })).status).toBe(400);
    expect((await request("PUT", save, "other-panel-token")).status).toBe(401);
    expect(await readFile(file, "utf8")).toBe(original);

    const saved = await request("PUT", save);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ settings: patch, writable: true });
    expect(await (await request()).json()).toMatchObject({ settings: patch });
    const changed = await readFile(file, "utf8");
    expect(changed).toContain("# 保留注释");
    expect(changed).toContain("privateMessage: false");
    expect(changed).toContain('42: { groupMessage: false }\n"99:42": { groupRecall: false }\n"bot:99": { notificationsAll: true }');
    expect((await request("PUT", { revision: before.revision, patch: { groupMessage: false } })).status).toBe(409);
    expect(await readFile(file, "utf8")).toBe(changed);

    await writeFile(file, "default: {broken");
    const unavailable = await (await request()).json() as { revision: string; writable: boolean };
    expect(unavailable.writable).toBe(false);
    expect((await request("PUT", { revision: unavailable.revision, patch: { groupMessage: false } })).status).toBe(503);
    expect(await readFile(file, "utf8")).toBe("default: {broken");
  } finally {
    clearTimeout(timer);
    host?.kill();
    await host?.exited;
    await rm(root, { recursive: true, force: true });
  }
});
