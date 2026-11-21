import { randomBytes } from "node:crypto";
import { parseDocument } from "yaml";
import { readOptionalConfigFile } from "./config.ts";
import { updateLocalConfiguration } from "./lotus-global-config-write.ts";
import { parseServerSettings, type ServerEnvironment } from "./server.ts";

export async function prepareMigratedOneBot(root: URL, env: ServerEnvironment, initialize: boolean, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const config = await readOptionalConfigFile(root, "config/server.yaml");
  if (config?.onebot_token !== null || parseServerSettings(config, env).oneBot) return false;
  if (!initialize) throw new Error("旧 OneBot 网关使用无令牌连接。请先运行 bun run init 配置接入令牌。");

  return updateLocalConfiguration(root, "server", {
    signal,
    canWrite: () => true,
    prepare(text, local) {
      if (local.onebot_token !== null || parseServerSettings(local, env).oneBot) return { value: false };
      const document = parseDocument(text);
      if (document.errors.length) throw new Error("无法更新 OneBot 网关配置。");
      document.set("onebot_token", randomBytes(32).toString("base64url"));
      return { yaml: document.toString(), value: true };
    },
  });
}
