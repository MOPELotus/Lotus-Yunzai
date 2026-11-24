import { parseServerSettings, type ServerEnvironment } from "./server.ts";
import { readOptionalConfigFile } from "./config.ts";

/** Kept as an initialization compatibility hook; LAN connections do not require a generated token. */
export async function prepareMigratedOneBot(root: URL, env: ServerEnvironment, _initialize: boolean, signal?: AbortSignal) {
  signal?.throwIfAborted();
  parseServerSettings(await readOptionalConfigFile(root, "config/server.yaml") ?? {}, env);
  return false;
}
