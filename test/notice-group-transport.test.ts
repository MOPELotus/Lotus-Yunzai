import { expect, test } from "bun:test";
import { openMilkySession } from "../lib/adapters/milky-session.ts";
import { noticeGroupTransport } from "../lib/adapters/notice-groups.ts";
import { OneBotCalls, type OneBotAction } from "../lib/adapters/onebot-calls.ts";
import { OneBotGroups } from "../lib/adapters/onebot-groups.ts";

test("公告快照同账号去重，撤回按原网关和群绑定，换连接后不能续发旧快照", async () => {
  const groups = new OneBotGroups();
  const onebot = new OneBotCalls();
  const frames: OneBotAction[] = [];
  function connect() {
    return groups.connect(98, { calls: onebot, send(frame) {
      frames.push(frame);
      const data = frame.action === "get_group_list" ? [{ group_id: 77 }] : { message_id: -9 };
      onebot.receive({ status: "ok", retcode: 0, data, echo: frame.echo });
      return true;
    } });
  }

  const controller = new AbortController();
  const calls: { action: string; data: unknown }[] = [];
  let sequence: number | undefined = 92;
  let rejectSend = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const action = new URL(request.url).pathname.split("/").at(-1)!;
    calls.push({ action, data: await request.json() });
    if (action === "send_group_message" && rejectSend) return Response.json({ status: "failed", retcode: 1200 });
    const data = action === "get_login_info" ? { uin: 98 } : action === "get_group_list" ? { groups: [{ group_id: 80 }] }
      : action === "send_group_message" ? { message_seq: sequence } : {};
    return Response.json({ status: "ok", retcode: 0, data });
  } });

  try {
    const milky = await openMilkySession({ apiBase: new URL("api/", server.url), eventUrl: new URL("event", server.url),
      connection: "webhook", webhookPath: "/events", timeoutMs: 2_000, reconnectMs: 100, heartbeatMs: 1_000,
    }, { signal: controller.signal, dispatch: async () => {} });
    expect(milky).toBeDefined();
    const transport = noticeGroupTransport(groups.transport(), () => groups.noticeAccounts(),
      () => !controller.signal.aborted ? milky?.noticeAccount : undefined);
    const detach = connect();
    expect(transport.noticeAccounts().map(({ adapter, botId }) => [adapter, botId])).toEqual([["onebot", 98]]);
    const selected = transport.noticeAccounts()[0]!;
    expect(await selected.listGroups()).toEqual([{ id: 77 }]);
    expect(await selected.sendGroup(77, "当前 OneBot")).toBe(-9);

    const disconnectCurrent = connect();
    detach();
    await expect(selected.sendGroup(77, "旧连接")).rejects.toMatchObject({ delivery: "not-sent" });
    expect(frames).toHaveLength(2);
    await transport.recallGroupMessage("milky", 98, 80, 92);
    expect(calls.at(-1)).toEqual({ action: "recall_group_message", data: { group_id: 80, message_seq: 92 } });
    await transport.recallGroupMessage("onebot", 98, 77, -9);
    expect(frames.at(-1)).toMatchObject({ action: "delete_msg", params: { message_id: -9 } });

    disconnectCurrent();
    await expect(transport.recallGroupMessage("onebot", 98, 77, -9)).rejects.toMatchObject({ delivery: "not-sent" });
    expect(transport.noticeAccounts().map(({ adapter }) => adapter)).toEqual(["milky"]);
    const alternate = transport.noticeAccounts()[0]!;
    expect(await alternate.listGroups()).toEqual([{ id: 80 }]);
    expect(calls.at(-1)).toEqual({ action: "get_group_list", data: { no_cache: true } });
    expect(await alternate.sendGroup(80, "当前 Milky")).toBe(92);
    sequence = undefined;
    await expect(alternate.sendGroup(80, "结果未知")).rejects.toThrow("发送结果未确认");
    rejectSend = true;
    await expect(alternate.sendGroup(80, "明确拒绝")).rejects.toMatchObject({ delivery: "not-sent" });
    const received = calls.length;
    controller.abort();
    await expect(alternate.sendGroup(80, "已经断线")).rejects.toMatchObject({ delivery: "not-sent" });
    expect(calls).toHaveLength(received);
  } finally {
    controller.abort();
    onebot.close();
    server.stop(true);
  }
});
