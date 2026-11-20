import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGuobaForm } from "../lib/panel-guoba.ts";

test("旧锅巴表单筛选字段、兼容带括号的路径并保留未修改密码", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-guoba-form-"));
  try {
    await writeFile(join(directory, "guoba.support.js"), `
      const lastSaved = new URL("saved.json", import.meta.url);
      let config = {
        settings: { count: 0, enabled: false, note: null, password: "fixture-private-password" },
        "settings.count": 5,
        permissions: { scopes: { "checkin.refresh": { policy: "master_only" } } },
        hidden: "fixture-private-extra"
      };
      export function supportGuoba() {
        return { configInfo: {
          schemas: [
            { component: "Divider", label: "设置" },
            { component: "Input", field: "settings.note", label: "备注", bottomHelpMessage: "可留空" },
            { component: "InputNumber", field: "settings.count", label: "数量",
              componentProps: { min: 0, max: 10, step: 1, onClick: "ignored" } },
            { component: "Switch", field: "settings.enabled", label: "启用" },
            { component: "InputPassword", field: "settings.password", label: "凭据",
              defaultValue: "fixture-private-default", componentProps: { value: "fixture-private-prop" } },
            { component: "Select", field: 'permissions.scopes["checkin.refresh"].policy', label: "策略",
              componentProps: { options: [
                { label: "仅主人", value: "master_only" },
                { label: "继承", value: "inherit" },
                { label: "允许", value: "allow" }
              ] } },
            { component: "CustomControl", field: "hidden", label: "未适配字段" }
          ],
          getConfigData() { return config; },
          async setConfigData(data, { Result }) {
            if (data["settings.note"] === "error-result") return Result.error("fixture-private-rejection", 422);
            if (data["settings.note"] === "throw") throw new Error("fixture-private-write");
            await Bun.write(lastSaved, JSON.stringify(data));
            config = data;
            return Result.ok("fixture-private-result", "fixture-private-message");
          }
        } };
      }
    `);

    const form = await loadGuobaForm(directory);
    expect(form).toBeDefined();
    if (!form) throw new Error("表单未加载。");
    const policy = 'permissions.scopes["checkin.refresh"].policy';
    expect(form.schemas.map(({ component }) => component)).toEqual([
      "Divider", "Input", "InputNumber", "Switch", "InputPassword", "Select",
    ]);
    expect(form.schemas[2]?.componentProps).toEqual({ min: 0, max: 10, step: 1 });
    expect(form.schemas[5]?.componentProps?.options).toEqual([
      { label: "仅主人", value: "master_only" }, { label: "继承", value: "inherit" }, { label: "允许", value: "allow" },
    ]);
    expect(await form.read()).toEqual({
      values: { "settings.note": null, "settings.count": 5, "settings.enabled": false, [policy]: "master_only" },
      configuredPasswords: ["settings.password"],
    });
    expect(JSON.stringify(form.schemas)).not.toContain("fixture-private");
    expect(JSON.stringify(await form.read())).not.toContain("fixture-private");

    for (const data of [
      { "settings.unlisted": 1 },
      { settings: { unlisted: 1 }, "settings.count": 2 },
      JSON.parse('{"settings":{"constructor":{"prototype":{"bad":true}}}}'),
      { settings: { count: {} } },
      { "settings.count": -1 },
      { "settings.count": "11" },
      { "settings.count": "many" },
      { "settings.password": false },
      { [policy]: "unknown" },
      { [policy]: ["allow"] },
      { hidden: "不能更新" },
    ]) {
      expect(await form.save(data)).toMatchObject({ ok: false, status: 400 });
    }
    expect(await Bun.file(join(directory, "saved.json")).exists()).toBe(false);

    expect(await form.save({
      settings: { count: 99, enabled: false, note: null, password: "" },
      "settings.count": 0,
      permissions: { scopes: { "checkin.refresh": { policy: "allow" } } },
      [policy]: "inherit",
    })).toEqual({ ok: true, status: 200, message: "配置已保存。" });
    expect(JSON.parse(await readFile(join(directory, "saved.json"), "utf8"))).toEqual({
      "settings.count": 0, "settings.note": null, "settings.enabled": false,
      [policy]: "inherit", "settings.password": "fixture-private-password",
    });

    const fromSecondLoad = await loadGuobaForm(directory);
    if (!fromSecondLoad) throw new Error("表单未加载。");
    const saves = await Promise.all([
      form.save({ settings: { password: "new-fixture-password", count: 1 } }),
      fromSecondLoad.save({ settings: { count: 2 } }),
    ]);
    expect(saves.every((item) => item.ok)).toBe(true);
    expect(JSON.parse(await readFile(join(directory, "saved.json"), "utf8"))).toEqual({
      "settings.count": 2, "settings.password": "new-fixture-password", "settings.note": null,
      "settings.enabled": false, [policy]: "inherit",
    });
    expect(await form.save({ "settings.password": null })).toMatchObject({ ok: true });
    expect((await form.read()).configuredPasswords).toEqual([]);
    expect(JSON.parse(await readFile(join(directory, "saved.json"), "utf8"))).toEqual({
      "settings.password": null, "settings.count": 2, "settings.note": null, "settings.enabled": false,
      [policy]: "inherit",
    });
    expect(await form.save({ "settings.note": "error-result" })).toEqual({
      ok: false, status: 422, message: "插件拒绝保存配置。",
    });
    expect(await form.save({ "settings.note": "throw" })).toEqual({
      ok: false, status: 500, message: "无法保存插件配置。",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("锅巴 Next 分组标题沿用原顺序且不加入可写字段", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-guoba-group-"));
  try {
    await writeFile(join(directory, "guoba.support.js"), `
      let settings = { enabled: false, account: { retries: 2 } };
      export const supportGuoba = () => ({ configInfo: {
        schemas: [
          { component: "SOFT_GROUP_BEGIN", label: "基础配置", field: "heading" },
          { component: "Switch", label: "启用", field: "enabled" },
          { component: "SOFT_GROUP_BEGIN", label: "多账号配置" },
          { component: "InputNumber", label: "重试次数", field: "account.retries", componentProps: { min: 0 } },
          { component: "SOFT_GROUP_BEGIN" }
        ],
        getConfigData: () => settings,
        setConfigData(data, { Result }) { settings = data; return Result.ok(); }
      } });
    `);
    const form = await loadGuobaForm(directory);
    if (!form) throw new Error("表单未加载。");
    expect(form.schemas).toEqual([
      { component: "Divider", label: "基础配置" },
      { component: "Switch", label: "启用", field: "enabled" },
      { component: "Divider", label: "多账号配置" },
      { component: "InputNumber", label: "重试次数", field: "account.retries", componentProps: { min: 0 } },
    ]);
    expect(await form.save({ heading: "伪造分组" })).toMatchObject({ ok: false, status: 400 });
    expect(await form.save({ account: { retries: 0 } })).toMatchObject({ ok: true });
    expect(await (await loadGuobaForm(directory))?.read()).toEqual({
      values: { enabled: false, "account.retries": 0 }, configuredPasswords: [],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("锅巴适配拒绝目录外文件并屏蔽导入和读取异常", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-guoba-boundary-"));
  try {
    const linked = join(directory, "linked");
    const external = join(directory, "external.js");
    await mkdir(linked);
    expect(await loadGuobaForm(linked)).toBeUndefined();
    await writeFile(external, `await Bun.write(new URL("executed", import.meta.url), "bad");`);
    await symlink(external, join(linked, "guoba.support.js"));
    await expect(loadGuobaForm(linked)).rejects.toThrow("无法加载插件表单。");
    expect(await Bun.file(join(directory, "executed")).exists()).toBe(false);

    const broken = join(directory, "broken");
    await mkdir(broken);
    await writeFile(join(broken, "guoba.support.js"), 'throw new Error("fixture-private-import");');
    await expect(loadGuobaForm(broken)).rejects.toThrow(/^无法加载插件表单。$/u);

    const reader = join(directory, "reader");
    await mkdir(reader);
    await writeFile(join(reader, "guoba.support.js"), `
      export const supportGuoba = () => ({
        configInfo: {
          schemas: [{ component: "Input", field: "note", label: "备注" }],
          getConfigData() { throw new Error("fixture-private-read"); }
        }
      });
    `);
    const form = await loadGuobaForm(reader);
    if (!form) throw new Error("表单未加载。");
    await expect(form.read()).rejects.toThrow(/^无法读取插件配置。$/u);
    expect(await form.save({ note: "无写入入口" })).toMatchObject({ ok: false, status: 405 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("重复子表单保存按旧行合并，屏蔽密码并拒绝陈旧或歧义的行引用", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-guoba-rows-"));
  try {
    await writeFile(join(directory, "guoba.support.js"), `
      const saved = new URL("saved.json", import.meta.url);
      let config = {
        bots: [
          { id: "42", token: "fixture-password-first", enabled: true, unlisted: "fixture-row-first" },
          { id: "43", token: "fixture-password-second", enabled: true, unlisted: "fixture-row-second" }
        ],
        unrelated: true
      };
      export function supportGuoba() {
        return { configInfo: {
          schemas: [
            { component: "Switch", field: "unrelated", label: "其他设置" },
            { component: "GSubForm", field: "bots", label: "账号", componentProps: {
              multiple: true, modalProps: { title: "账号连接" }, lengthMax: 3, schemas: [
                { component: "Input", field: "id", label: "QQ", required: true },
                { component: "Switch", field: "enabled", label: "启用", componentProps: { defaultValue: true } },
                { component: "InputPassword", field: "token", label: "凭据", componentProps: { defaultValue: "fixture-prop" } }
              ]
            } }
          ],
          getConfigData() { return config; },
          async setConfigData(data, { Result }) {
            config = data;
            await Bun.write(saved, JSON.stringify(data));
            return Result.ok();
          }
        } };
      }
    `);
    const form = await loadGuobaForm(directory);
    if (!form) throw new Error("子表单未加载。");
    const first = await form.read();
    const snapshot = first.subforms?.bots;
    if (!snapshot) throw new Error("子表单快照无效。");
    expect(snapshot.rows).toEqual([
      { values: { id: "42", enabled: true }, configuredPasswords: ["token"] },
      { values: { id: "43", enabled: true }, configuredPasswords: ["token"] },
    ]);
    expect(form.schemas[1]?.componentProps).toMatchObject({ title: "账号连接", lengthMax: 3 });
    expect(JSON.stringify([first, form.schemas])).not.toContain("fixture-");
    const update = (rows: unknown, revision = snapshot.revision) => form.save({ bots: { revision, rows } });
    for (const rows of [
      [{ index: 0, values: {} }, { index: 0, values: {} }],
      [{ index: 3, values: {} }],
      [{ index: 1, values: { unlisted: "无权设置" } }],
      [{ index: null, values: { enabled: false } }],
      [{ index: null, values: { id: "44", token: false } }],
    ]) expect(await update(rows)).toMatchObject({ status: 400 });
    expect(await Bun.file(join(directory, "saved.json")).exists()).toBe(false);

    expect(await update([{ index: 1, values: { enabled: false } }, { index: null, values: { id: "44" } }]))
      .toMatchObject({ status: 200 });
    expect(JSON.parse(await readFile(join(directory, "saved.json"), "utf8"))).toEqual({
      bots: [
        { id: "43", token: "fixture-password-second", enabled: false, unlisted: "fixture-row-second" },
        { id: "44" }
      ],
      unrelated: true,
    });
    expect(await update([])).toMatchObject({ status: 409 });
    const next = await form.read();
    expect(JSON.stringify(next)).not.toContain("fixture-");
    expect(await update([{ index: 0, values: { token: null } }, { index: 1, values: {} }], next.subforms!.bots!.revision))
      .toMatchObject({ status: 200 });
    expect((await form.read()).subforms?.bots?.rows[0]?.configuredPasswords).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("单对象子表单保留缺值与原对象形状，只保存当前版本的声明字段", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-guoba-object-"));
  try {
    await writeFile(join(directory, "guoba.support.js"), `
      const saved = new URL("saved.json", import.meta.url);
      let values = { active: false, existing: { host: "old", password: "secret-test-value", extra: "keep" }, empty: null };
      const schemas = [
        { component: "Input", field: "host", label: "地址", required: true },
        { component: "InputPassword", field: "password", label: "密码", defaultValue: "secret-test-default" },
        { component: "InputNumber", field: "port", label: "端口", defaultValue: 8000 }
      ];
      export function supportGuoba() { return { configInfo: {
        schemas: [
          { component: "Switch", field: "active", label: "启用" },
          { component: "GSubForm", field: "existing", label: "现有对象", componentProps: { multiple: false, schemas } },
          { component: "GSubForm", field: "missing", label: "缺失对象", componentProps: { schemas } },
          { component: "GSubForm", field: "empty", label: "空对象值", componentProps: { schemas } }
        ],
        getConfigData() { return values; },
        async setConfigData(data, { Result }) { values = data; await Bun.write(saved, JSON.stringify(data)); return Result.ok(); }
      } }; }
    `);
    const form = await loadGuobaForm(directory);
    if (!form) throw new Error("子表单未加载。");
    const fields = (await form.read()).subforms!;
    expect(fields.existing?.rows).toEqual([{ values: { host: "old" }, configuredPasswords: ["password"] }]);
    expect(fields.missing?.rows).toEqual([]);
    expect(fields.empty?.rows).toEqual([]);
    expect(JSON.stringify([fields, form.schemas])).not.toContain("secret-test-");
    const save = (field: string, index: number | null, values: unknown) => form.save({
      [field]: { revision: fields[field]!.revision, rows: [{ index, values }] },
    });
    const read = async () => JSON.parse(await readFile(join(directory, "saved.json"), "utf8"));

    expect(await form.save({ active: true })).toMatchObject({ status: 200 });
    expect(await read()).toEqual({
      active: true, existing: { host: "old", password: "secret-test-value", extra: "keep" }, empty: null,
    });
    expect(await save("existing", null, { host: "wrong identity" })).toMatchObject({ status: 400 });
    expect(await save("missing", null, { port: 9000 })).toMatchObject({ status: 400 });
    expect(await form.save({ existing: { revision: fields.existing!.revision, rows: [] } })).toMatchObject({ status: 400 });
    expect(await save("existing", 0, { host: "updated", password: "" })).toMatchObject({ status: 200 });
    expect(await save("existing", 0, { host: "stale" })).toMatchObject({ status: 409 });
    expect(await save("missing", null, { host: "new" })).toMatchObject({ status: 200 });
    expect(await read()).toEqual({
      active: true, existing: { host: "updated", password: "secret-test-value", extra: "keep", port: 8000 },
      missing: { host: "new", port: 8000 }, empty: null,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
