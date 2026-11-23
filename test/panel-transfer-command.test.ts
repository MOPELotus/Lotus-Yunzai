import { expect, test } from "bun:test";
import { createPanelTransferCommand, hasPanelTransferCapability, matchPanelTransferCommand, type TransferContext } from "../lib/panel-transfer-command.ts";
import { createPanelTransferReceiver, createPanelTransferSource } from "../lib/panel-transfer.ts";

const sourceOrigin = "https://source.example.invalid";
const uid = "123450001";
const owner = { game: "gs", uid, qq: "730521" } as const;

test("旧入口、游戏前缀、本人档案及私聊分发，未发出的交接码撤销", async () => {
  const controller = new AbortController();
  const source = createPanelTransferSource({ publicOrigin: sourceOrigin, signal: controller.signal });
  let writes = 0;
  let bindings = 0;
  const events: Request[] = [];
  const receive = createPanelTransferReceiver({ peers: [sourceOrigin], async transport(url, init) {
    const request = new Request(url, init);
    events.push(request);
    return source.serve(request)!;
  } });
  const run = createPanelTransferCommand("gs", controller.signal, async (qq, profileId) => {
    expect(qq).toBe(owner.qq);
    expect(profileId).toBe(2);
    bindings++;
    return {
      uid, async verify() {}, async read() { return Uint8Array.of(11, 12); },
      async write(bytes) { expect([...bytes]).toEqual([11, 12]); writes++; return { state: "saved", added: 1 }; },
    };
  });
  let code = "";
  let delivered = false;
  const ctx = { message_type: "private", self_id: 41, user_id: Number(owner.qq), privateCredentialSignal: controller.signal,
    panelTransfer: { source, receive, exportLevel: 1, importLevel: 2 },
    reply: async (message: string) => {
      code = message.split(" ").at(-1)!;
      return delivered;
    },
  } satisfies TransferContext;
  const exportCmd = matchPanelTransferCommand("#原神导出面板数据 档案 2")!;
  expect(matchPanelTransferCommand("#原神导出面板2")).toBeUndefined();
  expect(matchPanelTransferCommand("*导出面板数据2")).toMatchObject({ game: "sr", action: "export", profileId: 2 });
  expect(matchPanelTransferCommand("#星铁导入面板数据123450001")).toMatchObject({ game: "sr", action: "import", uid });
  expect(matchPanelTransferCommand("#星铁导入面板数据 档案999")).toMatchObject({ invalid: true });
  expect(matchPanelTransferCommand("#星铁导入面板数据 blah")).toMatchObject({ invalid: true });
  expect(await run(exportCmd, { ...ctx, message_type: "group" })).toContain("好友私聊");
  expect(await run(exportCmd, { ...ctx, isDelegated: true })).toContain("好友私聊");
  expect(await run(exportCmd, { ...ctx, privateCredentialSignal: undefined })).toContain("好友私聊");
  expect(await run(exportCmd, { ...ctx, panelTransfer: undefined })).toContain("未开启");
  expect(bindings).toBe(0);
  expect(await run(exportCmd, ctx)).toContain("已撤销");
  expect(hasPanelTransferCapability(code)).toBe(true);
  expect(await receive(code, owner, controller.signal)).toEqual({ state: "expired" });
  delivered = true;
  expect(await run(exportCmd, ctx)).toEqual([]);
  const importing = matchPanelTransferCommand(`#导入面板数据 ${code} 档案2`)!;
  expect(importing.code).toBe(code);
  expect(await run(importing, ctx)).toContain("仅供当前");
  expect(await run({ ...importing, uid: "123450002" }, { ...ctx, isBotMaster: () => true })).toContain("不一致");
  expect(await run(importing, { ...ctx, isBotMaster: () => true })).toContain("已导入 1");
  expect(await run(importing, { ...ctx, isBotMaster: () => true })).toContain("已完成");
  expect(writes).toBe(1);
  expect(events.map(event => event.headers.get("X-Lotus-Panel-Operation"))).toEqual(["claim", "claim", "ack", "claim"]);
  controller.abort();
});

test("输入码不进伪造存档，写入失败或删除边界拒绝时不确认领取", async () => {
  const controller = new AbortController();
  const source = createPanelTransferSource({ publicOrigin: sourceOrigin, signal: controller.signal });
  const code = source.offer(owner, Uint8Array.of(41))!;
  const receive = createPanelTransferReceiver({ peers: [sourceOrigin], async transport(url, init) {
    return source.serve(new Request(url, init))!;
  } });
  const command = matchPanelTransferCommand(`#导入面板数据 档案2`)!;
  let state: "invalid" | "discarded" = "invalid";
  const run = createPanelTransferCommand("gs", controller.signal, async () => ({
    uid, async verify() {}, async read() { return undefined; }, async write() { return { state }; },
  }));
  const context = { message_type: "private", self_id: 77, user_id: Number(owner.qq), privateCredentialSignal: controller.signal,
    panelTransfer: { source, receive, exportLevel: 1, importLevel: 1 } } satisfies TransferContext;
  expect(await run(command, context)).toContain("请先在来源");
  expect(await run({ ...command, code }, context)).toContain("格式");
  state = "discarded";
  expect(await run({ ...command, code }, context)).toContain("早于本档案");
  expect((await receive(code, owner, controller.signal)).state).toBe("ready");
  controller.abort();
});
