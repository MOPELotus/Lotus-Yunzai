import { Database } from "bun:sqlite";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const period = 30_000;

function remoteOtpPath(root: string) {
  return join(root, "data", "remote-auth");
}

function state(root: string, create: boolean): Database | undefined {
  const directory = remoteOtpPath(root);
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = lstatSync(directory, { throwIfNoEntry: false });
  if (!dir) return;
  if (!dir.isDirectory() || (process.platform !== "win32" && (dir.mode & 0o077) !== 0)) {
    throw new Error("远程身份验证目录必须仅当前系统用户可读写。");
  }
  const path = join(directory, "otp.sqlite");
  if (create) {
    try { closeSync(openSync(path, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (!file) return;
  if (!file.isFile() || (process.platform !== "win32" && (file.mode & 0o077) !== 0)) {
    throw new Error("远程身份验证数据库必须是当前系统用户专用的普通文件。");
  }

  const database = new Database(path, { create: false, strict: true });
  try {
    database.run("PRAGMA busy_timeout = 1000");
    if (create) database.run(`CREATE TABLE IF NOT EXISTS remote_otp (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      secret BLOB NOT NULL,
      last_counter INTEGER NOT NULL
    )`);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function base32(secret: Buffer) {
  let bits = 0;
  let pending = 0;
  let encoded = "";
  for (const byte of secret) {
    pending = (pending << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += alphabet[(pending >> bits) & 31]!;
    }
  }
  if (bits > 0) encoded += alphabet[(pending << (5 - bits)) & 31]!;
  return encoded;
}

export function rotateRemoteOtp(root: string, replace: boolean) {
  const database = state(root, true);
  if (!database) throw new Error("无法打开远程身份验证数据库。");
  const secret = randomBytes(20);
  try {
    const query = new URLSearchParams({
      secret: base32(secret), issuer: "Lotus-Yunzai", algorithm: "SHA1", digits: "6", period: "30",
    });
    return database.transaction(() => {
      if (!replace && database.query("SELECT 1 FROM remote_otp WHERE id = 1").get()) {
        throw new Error("远程身份验证已配对。更换验证器请使用 reset。");
      }
      database.run("INSERT OR REPLACE INTO remote_otp (id, secret, last_counter) VALUES (1, ?, -1)", [secret]);
      return `otpauth://totp/Lotus-Yunzai:remote?${query}`;
    }).immediate();
  } finally {
    secret.fill(0);
    database.close();
  }
}

export function remoteOtpPaired(root: string): boolean {
  const database = state(root, false);
  if (!database) return false;
  try { return database.query("SELECT 1 FROM remote_otp WHERE id = 1").get() != null; }
  finally { database.close(); }
}

export function consumeRemoteOtp(root: string, token: string, now = Date.now()): boolean {
  if (!/^\d{6}$/u.test(token)) return false;
  const database = state(root, false);
  if (!database) return false;
  try {
    const data = database.query<{ secret: Uint8Array; last_counter: number }, []>(
      "SELECT secret, last_counter FROM remote_otp WHERE id = 1",
    ).get();
    if (!data || data.secret.byteLength < 20) return false;
    const provided = Buffer.from(token);
    const current = Math.floor(now / period);
    try {
      for (const counter of [current, current - 1, current + 1]) {
        if (counter < 0) continue;
        const bytes = Buffer.alloc(8);
        bytes.writeBigUInt64BE(BigInt(counter));
        const hmac = createHmac("sha1", data.secret).update(bytes).digest();
        const offset = hmac[19]! & 15;
        const code = ((hmac.readUInt32BE(offset) & 0x7fff_ffff) % 1_000_000).toString().padStart(6, "0");
        if (!timingSafeEqual(provided, Buffer.from(code))) continue;
        if (counter <= data.last_counter) return false;
        return database.run(
          "UPDATE remote_otp SET last_counter = ? WHERE id = 1 AND secret = ? AND last_counter < ?",
          [counter, data.secret, counter],
        ).changes === 1;
      }
      return false;
    } finally {
      data.secret.fill(0);
      provided.fill(0);
    }
  } finally {
    database.close();
  }
}
