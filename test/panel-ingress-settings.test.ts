import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readGroupDispatch } from "../lib/group-dispatch.ts";
import { persistMaster } from "../lib/master-config.ts";
import { panelIngressSettings } from "../lib/panel-ingress-settings.ts";
import { defaultPrivateAccessMessage, readPrivateAccess } from "../lib/private-access.ts";

const url = "http://localhost/panel/api/settings/native/ingress";
const get = () => new Request(url);
const put = (previous: unknown, values: unknown) => new Request(url, {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ previous, values }),
});

async function withConfig(run: (root: URL, legacy: string, modern: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-ingress-"));
  try {
    await mkdir(join(directory, "config/config"), { recursive: true });
    await run(pathToFileURL(directory + "/"), join(directory, "config/config/other.yaml"), join(directory, "config/other.yaml"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("宿主入口设置按旧层保存，和新增主人共用锁，浏览器收不到主人字段", () => withConfig(async (root, legacy, modern) => {
  const before = "master: [100:42, \"stdin:stdin\"]\r\nmasterQQ: [42]\r\n"
    + "# keep this value\r\ndisableAdopt: [stoken]\r\nwhiteUser: [\"42\", 55, 55]\r\nblackGroup: 333\r\n";
  await writeFile(legacy, before);
  const handler = panelIngressSettings(root);
  expect((await handler(get(), () => false)).status).toBe(401);
  const first = await handler(get(), () => true);
  const visible = await first.text();
  expect(visible.includes("master")).toBe(false);
  const previous = JSON.parse(visible).values;
  expect(previous).toEqual({
    whiteUser: ["42", "55"], blackUser: [], whiteGroup: [], blackGroup: ["333"],
    disablePrivate: false, disableMsg: defaultPrivateAccessMessage,
  });
  const values = { ...previous, blackUser: ["800"], disablePrivate: true, disableMsg: "稍后再试。" };
  const [saved] = await Promise.all([
    handler(put(previous, values), () => true),
    persistMaster(root, 100, 66, 42),
  ]);
  expect(saved.status).toBe(200);
  expect((await saved.json()).values).toEqual(values);
  const raw = await readFile(legacy, "utf8");
  expect(raw).toContain("# keep this value");
  expect(Bun.YAML.parse(raw)).toMatchObject({
    master: ["100:42", "stdin:stdin", "100:66"], masterQQ: [42, 66], disableAdopt: ["stoken"], whiteUser: ["42", 55, 55],
    blackUser: [800], disablePrivate: true, disableMsg: "稍后再试。",
  });
  expect(await Bun.file(modern).exists()).toBe(false);
  expect((await handler(put(previous, values), () => true)).status).toBe(409);
  expect((await readFile(legacy, "utf8")) === raw).toBe(true);
  expect((await handler(put(values, { ...values, masterQQ: [] }), () => true)).status).toBe(400);
  expect((await handler(put(values, { ...values, blackUser: ["66"] }), () => true)).status).toBe(400);
  expect(await readFile(legacy, "utf8")).toBe(raw);

  await writeFile(modern, "disablePrivate: false\r\nwhiteGroup: [101]\r\nmaster: [\"100:42\"]\r\n");
  const preferred = (await (await handler(get(), () => true)).json()).values;
  expect(preferred.whiteGroup).toEqual(["101"]);
  expect(preferred.blackUser).toEqual([]);
  expect((await handler(put(preferred, { ...preferred, whiteGroup: [] }), () => true)).status).toBe(200);
  expect(await readFile(modern, "utf8")).toMatch(/disablePrivate: false\r\n/u);
  expect(await readFile(legacy, "utf8")).toBe(raw);
}));

test("宿主业务设置提交前重验授权，关闭文件监听也能刷新现行策略", () => withConfig(async (root, _legacy, modern) => {
  await writeFile(modern, "master: [\"100:42\"]\n");
  const routing = await readGroupDispatch(root);
  const privateAccess = await readPrivateAccess(root);
  const handler = panelIngressSettings(root, async () => {
    await Promise.all([routing.refreshLists(), privateAccess.refresh(true)]);
  });
  const previous = (await (await handler(get(), () => true)).json()).values;
  const values = { ...previous, disablePrivate: true, disableMsg: "", blackUser: ["799"] };
  const message = { post_type: "message", message_type: "private", user_id: 799 } as const;
  expect(routing.allowsInbound(message)).toBe(true);
  expect(privateAccess.disabled).toBe(false);
  let checks = 0;
  expect((await handler(put(previous, values), () => ++checks < 3)).status).toBe(401);
  expect(await readFile(modern, "utf8")).toBe("master: [\"100:42\"]\n");
  expect((await handler(put(previous, values), () => true)).status).toBe(200);
  expect(routing.allowsInbound(message)).toBe(false);
  expect(privateAccess.disabled).toBe(true);
  expect((await handler(put(values, { ...values, disablePrivate: false }), () => true)).status).toBe(200);
  expect(privateAccess.disabled).toBe(false);
  const validFile = await readFile(modern, "utf8");
  const invalidPolicy = validFile + "disableAdopt: ['[']\n";
  await writeFile(modern, invalidPolicy);
  const out = await handler(put({ ...values, disablePrivate: false }, values), () => true);
  expect(out.status).toBe(400);
  expect(await readFile(modern, "utf8")).toBe(invalidPolicy);
  expect(privateAccess.disabled).toBe(false);
}));
