import { readLocalConfig } from "./config.ts";

export async function readMasterPermissions(root: URL) {
  const owners = new Map<string, Set<string>>();
  const { master } = await readLocalConfig(root, "other");
  const entries = Array.isArray(master) ? master : master == null ? [] : [master];
  for (const entry of entries) {
    const match = typeof entry === "string" ? /^(stdin|[1-9]\d*):(stdin|[1-9]\d*)$/u.exec(entry.trim()) : null;
    const bot = match?.[1];
    const user = match?.[2];
    if (!bot || !user || (bot === "stdin") !== (user === "stdin")) {
      throw new Error("other.yaml 的 master 须为机器人账号:主人账号，终端可使用 stdin:stdin。");
    }
    const users = owners.get(bot) ?? new Set<string>();
    users.add(user);
    owners.set(bot, users);
  }

  return {
    terminal: owners.get("stdin")?.has("stdin") ?? false,
    isMaster(bot: number, user: number) {
      return owners.get(String(bot))?.has(String(user)) ?? false;
    },
  };
}
