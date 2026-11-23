import {
  hostIngressKeys, hostIngressListKeys, hostIngressSettings, HostIngressSettingsError, saveHostIngressSettings,
  type HostIngressSettings,
} from "./master-config.ts";
import { readPanelJson } from "./panel.ts";
import { readRequestOtherPolicyFiles } from "./request-other-policies.ts";

const ingressFields = [
  { key: "whiteUser", label: "用户白名单", type: "list", hint: "每行一个 QQ 号。留空时允许名单外的用户。" },
  { key: "blackUser", label: "用户黑名单", type: "list" },
  { key: "whiteGroup", label: "群白名单", type: "list", hint: "每行一个群号。留空时允许名单外的群。" },
  { key: "blackGroup", label: "群黑名单", type: "list" },
  { key: "disablePrivate", label: "限制普通用户私聊", type: "boolean" },
  { key: "disableMsg", label: "私聊限制提示", type: "text", hint: "留空时不回复限制提示。" },
] as const;

const automationFields = [
  { key: "autoFriend", label: "自动同意好友申请", type: "boolean" },
  { key: "autoQuit", label: "新入群自动退出人数阈值", type: "number", min: 0,
    hint: "填 0 关闭。实际成员数不超过阈值时检查退出条件，主人所在的群仍受保护。" },
] as const;

function fieldsFor(legacy: boolean, patterns: string[]) {
  const multilinePattern = patterns.some(pattern => /[\r\n]/u.test(pattern));
  const custom = { key: "disableAdopt", label: "私聊自定义放行规则",
    ...(multilinePattern ? { type: "json", hint: "该配置含跨行规则，请按 JSON 数组编辑。空数组会清除自定义规则。" } :
      { type: "list", separator: "line", keepWhitespace: true,
        hint: "每行一个正则表达式。清空只移除自定义规则。内置的登录、帮助等入口仍照常放行。" }),
  };
  return [...ingressFields, custom, ...automationFields, { key: "autoGroup", label: "自动同意群邀请", type: "select",
    options: [...(legacy ? [] : [{ label: "关闭", value: "off" }]),
      { label: "仅限主人", value: "owners" }, { label: "所有允许的邀请者", value: "all" }] }];
}

function record(input: unknown): Record<string, unknown> | undefined {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) return input as Record<string, unknown>;
}

function validIds(value: unknown): value is string[] {
  return Array.isArray(value) && new Set(value).size === value.length &&
    value.every(id => typeof id === "string" && /^[1-9]\d{0,15}$/u.test(id) && Number.isSafeInteger(Number(id)));
}

function validValues(value: unknown): value is HostIngressSettings {
  const input = record(value);
  return !!input && Object.keys(input).length === hostIngressKeys.length &&
    hostIngressKeys.every(key => Object.hasOwn(input, key)) &&
    hostIngressListKeys.every(key => validIds(input[key])) &&
    typeof input.disablePrivate === "boolean" && typeof input.disableMsg === "string" && !input.disableMsg.includes("\0") &&
    Array.isArray(input.disableAdopt) && input.disableAdopt.every(rule => typeof rule === "string" && rule.length > 0) &&
    typeof input.autoFriend === "boolean" && (input.autoGroup === "all" || input.autoGroup === "owners" || input.autoGroup === "off") &&
    typeof input.autoQuit === "number" && Number.isSafeInteger(input.autoQuit) && input.autoQuit >= 0;
}

export function panelIngressSettings(root: URL, onSaved?: () => Promise<unknown>) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    if (request.method === "GET") {
      try {
        const files = await readRequestOtherPolicyFiles(root);
        const values = hostIngressSettings(files);
        return active() ? Response.json({ fields: fieldsFor(files[0] === undefined && files[1] !== undefined, values.disableAdopt), values })
          : new Response(null, { status: 401 });
      } catch {
        return new Response(null, { status: 500 });
      }
    }

    let input: Record<string, unknown> | undefined;
    try { input = record(await readPanelJson(request, 262_144)); }
    catch { return new Response(null, { status: 400 }); }
    if (!input || Object.keys(input).length !== 2 || !validValues(input.previous) || !validValues(input.values)) {
      return new Response(null, { status: 400 });
    }
    try {
      const { values, legacy } = await saveHostIngressSettings(root, input.previous, input.values, active);
      const fields = fieldsFor(legacy, values.disableAdopt);
      try { await onSaved?.(); }
      catch {
        return Response.json({ fields, values, warning: "配置已保存，运行时重载失败，请检查宿主日志或重启。" });
      }
      return Response.json({ fields, values });
    } catch (error) {
      if (!active()) return new Response(null, { status: 401 });
      if (error instanceof HostIngressSettingsError) {
        return Response.json({ message: error.message }, { status: error.code === "conflict" ? 409 : 400 });
      }
      return new Response(null, { status: 409 });
    }
  };
}
