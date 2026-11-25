import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { panelApi } from "../lib/panel.ts";
import { panelGuobaRoutes } from "../lib/panel-guoba-routes.ts";
import { createPanelOwnerSession } from "../lib/panel-owner-session.ts";
import type { MessageFallbackContext } from "../lib/commands.ts";
import type { GuobaField } from "../lib/panel-guoba.ts";

const origin = "http://localhost:12450";
const path = "/panel/api/guoba/fixture";
const bearer = "test-panel-actions";
const text = "fixture-private-provider-detail";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "lotus-guoba-actions-"));
  const provider = join(root, "provider");
  const other = join(root, "other");
  await mkdir(provider);
  await mkdir(other);
  const source = `
    const started = new URL("started", import.meta.url);
    const receipt = new URL("action.json", import.meta.url);
    let values = { selection: ["alpha"], settings: { ratio: 2 }, note: "before", key: "${text}" };
    export const supportGuoba = () => ({ configInfo: {
      schemas: [
        { field: "selection", label: "选择项目", component: "CheckboxGroup",
          componentProps: { options: [{label:"甲",value:"alpha"},{label:"乙",value:"beta"},{label:"不可选",value:"blocked",disabled:true}] } },
        { field: "settings.ratio", label: "比例", component: "InputNumber", componentProps: { min: 1, max: 3 } },
        { field: "key", label: "密钥", component: "InputPassword" },
        { field: "declared", label: "维护", component: "GButtons", componentProps: { buttons: [
          { label:"预览所选", action:"preview", confirm:{ title:"复核", content:"创建本地预览" },
            args: ["selection:#{selection}", "#{ settings.ratio }", { fixed: ["template", 5, false] }] },
          { label:"复核", action:"inspect", confirm:"确认复核" },
          { label:"暂不可用", action:"preview", disabled:true },
          { label:"排除密码", action:"preview", args:["#{key}"] },
          { label:"未定义", action:"missing" },
          { label:"排除原型成员", action:"toString" },
          { label:"失败", action:"fail" },
          { label:"异常", action:"throws" },
        ] } },
        { component: "GButtons", ifShow: false, componentProps: { buttons: [{ label:"隐藏", action:"preview" }] } },
        { field: "note", label: "备注", component: "Input" },
      ],
      async getConfigData() {
        const hold = new URL("hold-read", import.meta.url);
        if (await Bun.file(hold).exists()) {
          await Bun.write(new URL("read-started", import.meta.url), "yes");
          for (let attempt = 0; attempt < 200 && await Bun.file(hold).exists(); attempt++) await Bun.sleep(5);
        }
        return values;
      },
      async setConfigData(data, { Result }) {
        if (data.note === "hold") {
          await Bun.write(started, "yes");
          await Bun.sleep(175);
        }
        values = { ...data };
        return Result.ok();
      },
      actions: {
        async preview(args, { Result }) {
          values.note = "最近一次：" + args[0];
          await Bun.write(receipt, JSON.stringify(args));
          return Result.ok({ private: "${text}" }, "${text}");
        },
        inspect(args, { Result }) { return args.length ? Result.error() : Result.ok(); },
        invisible() { throw new Error("must never be called"); },
        fail(args, { Result }) { return Result.error("${text}", 401); },
        throws() { throw new Error("${text}"); },
      },
    } });`;
  await Promise.all([provider, other].map(directory => writeFile(join(directory, "guoba.support.js"), source)));
  const directories = new Map([
    ["fixture", { path: provider, packageName: "fixture" }], ["other", { path: other, packageName: "other" }],
  ]);
  let isOwner = true;
  const session = createPanelOwnerSession({
    databasePath: join(root, "credentials.sqlite"),
    publicBase: () => new URL(origin),
    isOwner: (bot, user) => isOwner && bot === 42 && user === 7,
    config: {},
    signal: new AbortController().signal,
  });
  const handler = panelApi(bearer, [], panelGuobaRoutes(directories), undefined, session);

  async function request(route: string, method: string, data?: unknown, headers: Record<string, string> = {}) {
    const response = await handler(new Request(new URL(route, origin), {
      method, headers: { ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    }));
    return response ?? new Response(null, { status: 404 });
  }
  const trusted = { Origin: origin, "X-Lotus-Panel-Session": "1" };
  const link = await session.commands.fallback?.("#管理面板",
    { self_id: 42, user_id: 7, message_type: "private", normalizedMessage: "#管理面板",
      privateCredentialSignal: new AbortController().signal } as MessageFallbackContext);
  const ticket = new URLSearchParams(new URL(String(link).split("\n")[1]!).hash.slice(1)).get("ticket");
  const claim = await request("/panel/api/session/claim", "POST", { ticket }, trusted);
  expect(claim.status).toBe(204);
  const cookie = { Cookie: claim.headers.get("Set-Cookie")!.split(";")[0]! };
  const auth = { ...trusted, ...cookie };
  const get = async () => (await request(path, "GET", undefined, auth)).json() as Promise<{
    actionRevision: string; schemas: GuobaField[]; values: Record<string, unknown>;
  }>;
  const action = (data: unknown, headers: Record<string, string> = auth, route = path) => request(route + "/action", "POST", data, headers);
  const close = async () => {
    session.close();
    await rm(root, { recursive: true, force: true });
  };
  const setOwner = (value: boolean) => { isOwner = value; };
  return { provider, directories, auth, cookie, request, get, action, close, setOwner };
}

test("按钮声明与两版确认形态映射正确，仅使用所选字段和值并隐藏凭据和回调细节", async () => {
  const { provider, auth, cookie, request, get, action, close } = await setup();
  try {
    const { schemas, actionRevision, values } = await get();
    expect(schemas.map(s => s.component)).toEqual(["CheckboxGroup", "InputNumber", "InputPassword", "GButtons", "Input"]);
    expect(schemas[3]).toMatchObject({ label: "维护", componentProps: { buttons: [
      { id: "3-0", label: "预览所选", fields: ["selection", "settings.ratio"], confirm: "复核 · 创建本地预览" },
      { id: "3-1", label: "复核", fields: [], confirm: "确认复核" },
      { id: "3-2", label: "暂不可用", fields: [], disabled: true },
      { id: "3-6", label: "失败", fields: [] },
      { id: "3-7", label: "异常", fields: [] },
    ] } });
    expect(JSON.stringify({ schemas, values })).not.toContain(text);
    expect(JSON.stringify(schemas)).not.toContain("template");
    const data = { button: "3-0", revision: actionRevision };
    expect((await action(data, {})).status).toBe(401);
    expect((await action(data, cookie)).status).toBe(401);
    expect((await action(data, { ...auth, Origin: "http://localhost:9" })).status).toBe(401);
    expect((await request(path + "/action", "GET", undefined, auth)).status).toBe(405);
    expect((await action(data, auth, "/panel/api/guoba/missing")).status).toBe(404);
    expect((await action(data, auth, "/panel/api/guoba/other")).status).toBe(409);
    for (const button of ["3-2", "3-3", "3-4", "3-5", "4-0", "invisible"]) {
      expect((await action({ ...data, button })).status).toBe(404);
    }
    for (const body of [
      { ...data, args: ["raw"] }, { ...data, fields: { note: "extra" } },
      { ...data, fields: { key: "private" } }, { ...data, fields: { selection: ["unknown"] } },
      { ...data, fields: { selection: "beta" } }, { ...data, fields: { selection: ["blocked"] } }, { ...data, fields: null },
      { ...data, fields: { "settings.ratio": "4" } },
    ]) expect((await action(body)).status).toBe(400);
    expect(await Bun.file(join(provider, "action.json")).exists()).toBe(false);

    const accepted = await action({ ...data, fields: { selection: ["beta", "alpha"], settings: { ratio: 3 } } });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true, message: "插件操作已完成。" });
    expect(await Bun.file(join(provider, "action.json")).json()).toEqual(["selection:beta,alpha", "3", { fixed: ["template", 5, false] }]);
    expect((await get()).values).toMatchObject({ selection: ["alpha"], "settings.ratio": 2, note: "最近一次：selection:beta,alpha" });
    expect((await action({ ...data, button: "3-1" }, { Authorization: "Bearer " + bearer })).status).toBe(200);
    for (const [button, status] of [["3-6", 422], ["3-7", 500]] as const) {
      const response = await action({ ...data, button });
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain(text);
    }
    expect((await request(path, "PUT", { declared: "forged" }, auth)).status).toBe(400);
    expect((await request(path, "PUT", { selection: ["beta"] }, auth)).status).toBe(200);
    expect((await action(data)).status).toBe(409);
  } finally {
    await close();
  }
});

test("按钮动作排在保存之后核对表单与主人，加载目录更替后旧回调停止", async () => {
  const { provider, auth, request, get, action, close, setOwner, directories } = await setup();
  try {
    const data = { button: "3-0", revision: (await get()).actionRevision };
    const hold = () => request(path, "PUT", { note: "hold" }, auth);
    const started = Bun.file(join(provider, "started"));

    const saving = hold();
    for (let attempt = 0; attempt < 50 && !await started.exists(); attempt++) await Bun.sleep(5);
    expect(await started.exists()).toBe(true);
    const queued = action(data);
    await Bun.sleep(30);
    setOwner(false);
    expect((await saving).status).toBe(200);
    expect((await queued).status).toBe(401);
    expect(await Bun.file(join(provider, "action.json")).exists()).toBe(false);

    const token = { Authorization: "Bearer " + bearer };
    const registration = directories.get("fixture")!;
    const nextSaving = request(path, "PUT", { note: "hold" }, token);
    await Bun.sleep(30);
    const registrationChanged = action(data, token);
    await Bun.sleep(30);
    directories.set("fixture", { ...registration });
    expect((await nextSaving).status).toBe(200);
    expect((await registrationChanged).status).toBe(409);
    expect(await Bun.file(join(provider, "action.json")).exists()).toBe(false);

    await appendFile(join(provider, "guoba.support.js"), "\n// 模拟宿主外部替换。\n");
    expect((await action(data, token)).status).toBe(404);
    expect(await Bun.file(join(provider, "action.json")).exists()).toBe(false);
  } finally {
    await close();
  }
});

test("表单保存补读不变字段后仍需当前面板权限及同一提供器", async () => {
  const { provider, auth, request, close, setOwner, directories } = await setup();
  const hold = join(provider, "hold-read");
  const started = join(provider, "read-started");
  const token = { Authorization: "Bearer " + bearer };
  async function expectRefused(headers: Record<string, string>, interrupt: () => unknown, status: number) {
    await Bun.write(hold, "yes");
    const saving = request(path, "PUT", { note: "待保存" }, headers);
    try {
      for (let attempt = 0; attempt < 100 && !await Bun.file(started).exists(); attempt++) await Bun.sleep(5);
      expect(await Bun.file(started).exists()).toBe(true);
      await interrupt();
    } finally {
      await rm(hold);
    }
    expect((await saving).status).toBe(status);
    await rm(started);
    const body = await (await request(path, "GET", undefined, token)).json();
    expect(body).toMatchObject({ values: { note: "before" } });
  }

  try {
    await expectRefused(auth, () => setOwner(false), 401);
    await expectRefused(token, () => directories.set("fixture", { ...directories.get("fixture")! }), 409);
    await expectRefused(token, () => appendFile(join(provider, "guoba.support.js"), "// 表单文件变更\n"), 409);
    expect((await request(path, "PUT", { note: "待保存" }, token)).status).toBe(409);
  } finally {
    await close();
  }
});
