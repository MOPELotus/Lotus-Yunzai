import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { readPanelJson } from "./panel.ts";
import type { GuobaApiDefinition } from "./panel-guoba-http.ts";
import type { ExternalGuobaPage } from "./panel-guoba-pages.ts";
import type { WebMountSettings } from "./server.ts";

const operations = [
  ["get", "/data"], ["get", "/config"], ["post", "/config"], ["post", "/reload"], ["post", "/reset"],
] as const;

export function webMountPage({ directory, socket }: WebMountSettings, signal: AbortSignal): ExternalGuobaPage {
  const apis = operations.map(([method, route]): GuobaApiDefinition => ({
    method,
    route,
    handlers: [async (request, response) => {
      try {
        const [parent, endpoint] = await Promise.all([lstat(dirname(socket)), lstat(socket)]);
        const uid = process.getuid?.();
        if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0 ||
            !endpoint.isSocket() || endpoint.uid !== uid || (endpoint.mode & 0o077) !== 0) throw new Error();
        const body = request.body === undefined ? undefined : JSON.stringify(request.body);
        const reply = await fetch(`http://localhost${route}`, {
          method: method.toUpperCase(), unix: socket, body,
          headers: body === undefined ? undefined : { "Content-Type": "application/json" },
          signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]), redirect: "error", keepalive: false,
        });
        response.status(reply.status).json(await readPanelJson(reply, 1_048_576));
      } catch {
        response.status(503).json({ ok: false });
      }
    }],
  }));
  return {
    plugin: "web-mount", directory, apis, servicePreview: true,
    definition: { id: "web-mount", title: $t("lib.panel-web-mount.text_95d22549ef"), icon: "mdi:lan-connect", priority: 60,
      src: "dashboard.html", style: "dashboard.css", script: "dashboard.js" },
  };
}
