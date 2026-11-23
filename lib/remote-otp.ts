import { Database } from "bun:sqlite";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { protectWindowsRemoteAuth } from "./remote-win32.ts";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const period = 30_000;

function remoteOtpPath(root: string) {
  return join(root, "data", "remote-auth");
}

function state(root: string, create: boolean): Database | undefined {
  const directory = remoteOtpPath(root);
  const windows = process.platform === "win32";
  if (create && windows) {
    mkdirSync(dirname(directory), { recursive: true });
    protectWindowsRemoteAuth(directory, true, true);
  } else if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = lstatSync(directory, { throwIfNoEntry: false });
  if (!dir) return;
  if (!dir.isDirectory() || (process.platform !== "win32" && (dir.mode & 0o077) !== 0)) {
    throw new Error("远程身份验证目录必须仅当前系统用户可读写。");
  }
  if (windows && !create) protectWindowsRemoteAuth(directory, false, true);
  const path = join(directory, "otp.sqlite");
  if (create && windows) protectWindowsRemoteAuth(path, true, false);
  else if (create) {
    try { closeSync(openSync(path, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (!file) return;
  if (!file.isFile() || (process.platform !== "win32" && (file.mode & 0o077) !== 0)) {
    throw new Error("远程身份验证数据库必须是当前系统用户专用的普通文件。");
  }

  if (windows && !create) protectWindowsRemoteAuth(path, false, false);
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

function saveSecret(root: string, secret: Buffer, replace: boolean, counter: number) {
  const database = state(root, true);
  if (!database) throw new Error("无法打开远程身份验证数据库。");
  try {
    database.transaction(() => {
      if (!replace && database.query("SELECT 1 FROM remote_otp WHERE id = 1").get()) {
        throw new Error("远程身份验证已配对。更换验证器请使用 reset。");
      }
      database.run("INSERT OR REPLACE INTO remote_otp (id, secret, last_counter) VALUES (1, ?, ?)", [secret, counter]);
    }).immediate();
  } finally {
    database.close();
  }
}

export function rotateRemoteOtp(root: string, replace: boolean) {
  const secret = randomBytes(20);
  try {
    saveSecret(root, secret, replace, -1);
    const query = new URLSearchParams({
      secret: base32(secret), issuer: "Lotus-Yunzai", algorithm: "SHA1", digits: "6", period: "30",
    });
    return `otpauth://totp/Lotus-Yunzai:remote?${query}`;
  } finally {
    secret.fill(0);
  }
}

export function importLegacyRemoteOtp(root: string, path: string, now = Date.now()) {
  const file = lstatSync(path);
  if (!file.isFile() || file.size < 1 || file.size > 4_096) throw new Error("旧配对文件无效。");
  const source = readFileSync(path);
  try {
    if (source.length > 4_096) throw new Error("旧配对文件无效。");
    const parsed: unknown = Bun.YAML.parse(source.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !("version" in parsed) || parsed.version !== 1 ||
        !("secret" in parsed) || typeof parsed.secret !== "string") throw new Error("旧配对文件无效。");
    const text = parsed.secret.replace(/\s+/gu, "").replace(/=+$/u, "").toUpperCase();
    if (!/^[A-Z2-7]{32}$/u.test(text)) throw new Error("旧配对密钥无效。");
    const secret = Buffer.alloc(20);
    let bits = 0;
    let pending = 0;
    let index = 0;
    try {
      for (const char of text) {
        pending = (pending << 5) | alphabet.indexOf(char);
        bits += 5;
        if (bits >= 8) {
          bits -= 8;
          secret[index++] = (pending >> bits) & 255;
        }
      }
      // Any still-valid code may have been used by the old service before the import.
      saveSecret(root, secret, false, Math.floor(now / period) + 1);
    } finally {
      secret.fill(0);
    }
  } finally {
    source.fill(0);
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
