import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeRemoteOtp, remoteOtpPaired, rotateRemoteOtp } from "../lib/remote-otp.ts";
import { readRemoteFile, writeRemoteFile } from "../lib/remote-files.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

function otp(uri: string, offset = 0, time = Date.now()) {
  const secret = new URL(uri).searchParams.get("secret")!;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret].map(char => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/gu)!.map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000) + offset));
  const digest = createHmac("sha1", key).update(counter).digest();
  return String((digest.readUInt32BE(digest[19]! & 15) & 0x7fff_ffff) % 1_000_000).padStart(6, "0");
}

test("远程 TOTP 持久拒绝重放，配对不可静默覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-otp-test-"));
  try {
    expect(remoteOtpPaired(root)).toBe(false);
    const uri = rotateRemoteOtp(root, false);
    expect(remoteOtpPaired(root)).toBe(true);
    expect(() => rotateRemoteOtp(root, false)).toThrow();
    const time = 1_700_000_010_000;
    expect(consumeRemoteOtp(root, otp(uri, -2, time), time)).toBe(false);
    expect(consumeRemoteOtp(root, otp(uri, 0, time), time)).toBe(true);
    expect(consumeRemoteOtp(root, otp(uri, 0, time), time)).toBe(false);
    expect(consumeRemoteOtp(root, otp(uri, -1, time), time)).toBe(false);
    const replacement = rotateRemoteOtp(root, true);
    expect(consumeRemoteOtp(root, otp(uri, 1, time), time)).toBe(false);
    expect(consumeRemoteOtp(root, otp(replacement, 1, time), time)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")("运维文件拒绝目录跳转与符号链接，不允许无授权覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-remote-files-test-"));
  try {
    const files = join(root, "files");
    await mkdir(join(files, "nested"), { recursive: true });
    await writeFile(join(root, "outside"), "outside");
    await symlink(root, join(files, "outside"));
    await symlink(join(root, "outside"), join(files, "linked"));
    const signal = new AbortController().signal;
    const bytes = Buffer.from("inside");
    expect(await readRemoteFile(files, "../outside", signal)).toBeUndefined();
    await expect(readRemoteFile(files, "outside/outside", signal)).rejects.toThrow();
    await expect(readRemoteFile(files, "linked", signal)).rejects.toThrow();
    expect(await writeRemoteFile(files, "nested/demo", bytes, false, () => true)).toBe(true);
    await expect(writeRemoteFile(files, "nested/demo", Buffer.from("changed"), false, () => true)).rejects.toThrow();
    expect((await readRemoteFile(files, join(files, "nested/demo"), signal))?.bytes.toString()).toBe("inside");
    expect(await writeRemoteFile(files, "nested/demo", Buffer.from("changed"), true, () => false)).toBe(false);
    expect(await writeRemoteFile(files, "linked", bytes, true, () => true)).toBe(true);
    expect(await readFile(join(root, "outside"), "utf8")).toBe("outside");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")("旧远程命令只接真实好友私聊主人，默认关闭且双协议共享拒绝重放", async () => {
  let uri = "";
  await withDualGatewayFixture("remote-control-fixture", 'master: ["99:42", "100:43"]\ndisablePrivate: true\n',
    async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
      const sendResult = async (expected: string) => {
        const message = await onebot.next("send_msg");
        expect(message.params).toMatchObject({ user_id: 42, message: expected });
        message.respond({ message_id: 409 });
      };
      sendOneBot("#远程2FA初始化");
      await sendResult(expect.stringContaining("私人本机终端"));
      sendOneBot("#远程spawn 123456 sh printf ignored");
      await sendResult("远程运维未开启。");
      await writeFile(join(root, "config", "remote.yaml"), "enable: true\nshells: [sh]\n");
      const oldCode = otp(uri, -1);
      sendOneBot(`#spawn ${oldCode} sh printf should-not-run`, { user_id: 43 });
      sendOneBot(`#spawn ${oldCode} sh printf should-not-run`, { message_type: "group", group_id: 77 });
      await sendMilky(`#spawn ${oldCode} sh printf should-not-run`, { sender_id: 42, peer_id: 42 });
      sendOneBot(`#远程管理员spawn ${oldCode} sh printf should-not-run`);
      await sendResult(expect.stringContaining("管理员模式须显式开启"));
      const settings = join(root, "config", "global.yaml");
      await writeFile(settings, "permissions: {scopes: {remote.spawn: {policy: deny}}}\n");
      sendOneBot(`#spawn ${oldCode} sh printf should-not-run`);
      await Bun.sleep(180);
      expect(onebot.calls).toEqual([]);
      await rm(settings);
      const freshCode = otp(uri);
      sendOneBot(`#spawn ${freshCode} sh printf remote-test`);
      await sendResult("命令已结束，退出码 0。\nremote-test");
      await sendMilky(`#远程spawn ${freshCode} sh printf blocked`);
      const replay = await milky.next("send_private_message");
      expect(replay.params).toMatchObject({ message: [{ type: "text", data: { text: "验证码无效、已使用或尚未配对。" } }] });
      replay.respond({ message_seq: 410 });

      uri = rotateRemoteOtp(root, true);
      const files = join(root, "data", "remote", "files");
      await mkdir(files, { recursive: true });
      await writeFile(join(files, "report.txt"), "isolated-file");
      sendOneBot(`#远程下载 ${otp(uri)} report.txt`);
      const delivery = await onebot.next("upload_private_file");
      expect(delivery.params).toMatchObject({
        user_id: 42, name: "report.txt",
        file: "base64://" + Buffer.from("isolated-file").toString("base64"),
      });
      await sendResult("文件发送结果未确认，请先核对当前私聊。");
      delivery.respond(null);
      const journal = await readFile(join(root, "data", "remote-auth", "operations.jsonl"), "utf8");
      expect(journal.trim().split("\n").map(line => JSON.parse(line))).toEqual([
        { at: expect.any(String), action: "remote.spawn", adapter: "onebot", bot: 99, owner: 42 },
        { at: expect.any(String), action: "remote.download", adapter: "onebot", bot: 99, owner: 42 },
      ]);
      expect(journal).not.toContain("remote-test");
      expect(journal).not.toContain("report.txt");
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
    }, 8_000, undefined, async root => {
      uri = rotateRemoteOtp(root, false);
    });
}, 18_000);
