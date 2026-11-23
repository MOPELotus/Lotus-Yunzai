import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const startup = /Lotus-Yunzai 已启动。/u;
const help = /^https:\/\/www.lotusshared.cn\/yunzai\/\r?$/mu;
const status = /^Lotus-Yunzai 正在运行/mu;
const proofInput = "terminal-fixture-private-input";
const png = [137, 80, 78, 71, 13, 10, 26, 10, 1, 2];
const video = "data:video/mp4;base64,dGVzdC12aWRlbw==";
const bytes = [0, 127, 255, 2];

async function withTerminalFixture<T>(run: (root: string) => Promise<T>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-terminal-"));
  try {
    await copyHost(root);
    disableMemberPrewarm(root);
    await mkdir(join(root, "config/config"), { recursive: true });
    await writeFile(join(root, "config/config/other.yaml"), 'master: ["stdin:stdin"]\n');
    await writeFile(join(root, "plugins/terminal-fixture.js"), `
      export default class extends plugin {
        constructor() { super({ event: "message.terminal", rule: [
          { reg: "^#终端样本$", fnc: "show" },
          { reg: "^#样本口令 ${proofInput}$", fnc: "received" },
        ] }); }
        received(e) { return e.reply("终端口令测试已收件"); }
        show(e) { return e.reply([
          "测试首行\\n测试次行",
          segment.image(new Uint8Array(${JSON.stringify(png)})),
          { type: "record", data: { file: new Blob(["test-audio"], { type: "audio/wav" }), name: "proof.wav" } },
          { type: "video", file: ${JSON.stringify(video)}, name: "proof.mp4" },
          { type: "file", file: new Uint8Array(${JSON.stringify(bytes)}), name: "proof.bin" },
        ]); }
      }
    `);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function capture() {
  const decoder = new TextDecoder();
  let text = "", read = 0;
  const append = (value: Uint8Array) => { text += decoder.decode(value, { stream: true }); };
  async function until(pattern: RegExp) {
    const deadline = performance.now() + 5_000;
    for (;;) {
      const match = pattern.exec(text.slice(read));
      if (match) {
        read += match.index + match[0].length;
        return match;
      }
      if (performance.now() >= deadline) throw new Error(`终端未输出 ${pattern.source}：\n${text}`);
      await Bun.sleep(15);
    }
  }
  return { append, until, output: () => text };
}

const flags = { PATH: process.env.PATH, TERM: "xterm", LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "0" };

test("管道保持读行并按原顺序输出文字和四类可回读的附件", async () => {
  await withTerminalFixture(async root => {
    const child = Bun.spawn([process.execPath, "app.ts"], { cwd: root, env: flags, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    const output = capture();
    const read = (async () => { for await (const chunk of child.stdout) output.append(chunk); })();
    try {
      await output.until(startup);
      child.stdin.write("#终端样本\r\n");
      child.stdin.flush();
      await output.until(/测试首行\r?\n测试次行/u);
      const media = [
        ["图片", "image/png", new Uint8Array(png)],
        ["音频", "audio/wav", new TextEncoder().encode("test-audio")],
        ["视频", "video/mp4", new TextEncoder().encode("test-video")],
        ["文件", "application/octet-stream", new Uint8Array(bytes)],
      ] as const;
      for (const [label, mime, expected] of media) {
        const match = await output.until(new RegExp(`${label} (http[^\\s]+)\\r?\\n`, "u"));
        const url = new URL(match[1]!);
        expect(url.hostname).toBe("127.0.0.1");
        expect(url.pathname).toMatch(/^\/File\/[0-9a-f-]+$/u);
        const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe(mime);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
      }
      expect(output.output()).not.toContain("\x1b[");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      await read;
    }
  });
}, 15_000);

test.skipIf(process.platform === "win32")("交互终端上下键只召回本次只读指令且 Ctrl+C 正常停机", async () => {
  await withTerminalFixture(async root => {
    const output = capture();
    const terminal = new Bun.Terminal({ cols: 100, rows: 30, data: (_terminal, chunk) => output.append(chunk) });
    const child = Bun.spawn([process.execPath, "app.ts"], { cwd: root, env: flags, terminal });
    try {
      await output.until(startup);
      terminal.write("#帮助\r");
      await output.until(help);
      terminal.write("#状态\r");
      await output.until(status);
      terminal.write(`#样本口令 ${proofInput}\r`);
      await output.until(/终端口令测试已收件/u);

      terminal.write("\x1b[A\x1b[A\x1b[B\r");
      await output.until(status);
      terminal.write("\x1b[A\x1b[A\r");
      await output.until(help);
      expect(output.output().match(/终端口令测试已收件/gu)).toHaveLength(1);

      terminal.write("\x03");
      const deadline = performance.now() + 5_000;
      while (child.exitCode === null && child.signalCode === null && performance.now() < deadline) await Bun.sleep(15);
      expect(child.exitCode).toBe(130);
      expect(await Bun.file(join(root, "data/stdin/history")).exists()).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
      terminal.close();
    }
  });
}, 20_000);
