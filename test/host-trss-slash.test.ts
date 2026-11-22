import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

test.each([
  { label: "沿用裁剪过的旧运行配置默认", legacy: "cache_group_member: false\n", primary: undefined, enabled: true },
  { label: "保留旧运行配置明确关闭", legacy: "cache_group_member: false\n'/→#': false\n", primary: undefined, enabled: false },
  { label: "主配置只有其他字段时保留旧关闭", legacy: "'/→#': false\n", primary: "cache_group_member: false\n", enabled: false },
  { label: "主配置明确关闭优先于旧默认，且限制私聊时三种帮助仍可用", legacy: "cache_group_member: false\n",
    primary: "cache_group_member: false\n'/→#': false\n", enabled: false, limited: true },
])("旧 TRSS 斜线指令的正常宿主入口 $label", async ({ legacy, primary, enabled, limited }) => {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-slash-"));
  const token = "legacy-trss-slash-fixture";
  let host: ReturnType<typeof spawn> | undefined;
  let client: WebSocket | undefined;
  function spawn() {
    return Bun.spawn([process.execPath, "--no-env-file", "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
    });
  }
  try {
    await copyHost(root);
    await mkdir(join(root, "config/config"), { recursive: true });
    await writeFile(join(root, "config/config/bot.yaml"), legacy);
    if (primary !== undefined) await writeFile(join(root, "config/bot.yaml"), primary);
    if (limited) await writeFile(join(root, "config/other.yaml"), 'disablePrivate: true\ndisableMsg: ""\n');
    await writeFile(join(root, "config/global.yaml"), "coin_shop: {enable: false}\nscheduler: {enable: false}\n");
    host = spawn();
    const reader = host.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    let endpoint: string | undefined;
    try {
      while (!endpoint) {
        const part = await reader.read();
        if (part.done) throw new Error(output + await new Response(host.stderr).text());
        output += decoder.decode(part.value, { stream: true });
        endpoint = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0];
      }
    } finally {
      reader.releaseLock();
    }
    const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const gateway = client = new Socket(endpoint, {
      headers: { Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": "99" },
    });
    const replies: unknown[] = [];
    gateway.addEventListener("message", ({ data }) => {
      const frame = JSON.parse(data);
      if (frame.action === "send_msg") replies.push(frame.params.message);
    });
    await new Promise<void>((resolve, reject) => {
      gateway.addEventListener("open", () => resolve(), { once: true });
      gateway.addEventListener("error", reject, { once: true });
    });
    function send(message: string, message_id: number) {
      gateway.send(JSON.stringify({ post_type: "message", message_type: "private", sub_type: "friend",
        self_id: 99, user_id: 42, message_id, message }));
    }
    send("/帮助", 1);
    send("#帮助", 2);
    send("*帮助", 3);
    send("%帮助", 4);
    send("%help", 5);
    const deadline = performance.now() + 500;
    while (replies.length < (enabled ? 5 : 4) && performance.now() < deadline) await Bun.sleep(10);
    if (!enabled) await Bun.sleep(80);
    expect(replies).toHaveLength(enabled ? 5 : 4);
    for (const reply of replies) expect(reply).toEqual(expect.stringContaining("https://www.lotusshared.cn/yunzai/"));
  } finally {
    client?.close();
    host?.kill("SIGTERM");
    await host?.exited;
    await rm(root, { recursive: true, force: true });
  }
});
