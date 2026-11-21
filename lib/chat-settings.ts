import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isMap, parseDocument } from "yaml";
import { GlobalConfigWriteError, updateLocalConfiguration } from "./lotus-global-config-write.ts";
import { readGroupLikeSettingsModule } from "./panel-group.ts";
import type { PluginLoadReport } from "./plugins/loader.ts";

type Setting =
  | { setting: "陌生人点赞" | "状态"; enabled: boolean }
  | { setting: "渲染精度" | "设置"; enabled?: never };

export function chatSetting(message: string): Setting | undefined {
  if (message === "#设置") return { setting: "设置" };
  const change = /^#设置(陌生人点赞|状态)\s*(开启|关闭)$/u.exec(message);
  if (change) return { setting: change[1] === "状态" ? "状态" : "陌生人点赞", enabled: change[2] === "开启" };
  if (/^#设置渲染精度\s*\d+秒?$/u.test(message)) return { setting: "渲染精度" };
}

async function readDefaultStatus(directories: PluginLoadReport["directories"]) {
  const system = directories.get("system");
  if (system?.packageName !== "@lotus-yunzai/system") return;
  const module = await import(pathToFileURL(join(system.path, "status-background.ts")).href) as
    typeof import("../plugins/system/status-background.ts");
  const config = await module.readStatusConfig();
  if (config) return config.defaultState === true;
}

function saveDefaultStatus(root: URL, enabled: boolean, canWrite: () => boolean, signal: AbortSignal) {
  return updateLocalConfiguration(root, "system-status", {
    canWrite, signal, override: Bun.env.LOTUS_SYSTEM_STATUS_CONFIG,
    prepare(text, current) {
      if (Buffer.byteLength(text) > 64 * 1024) throw new GlobalConfigWriteError("config");
      const document = parseDocument(text, { strict: true, uniqueKeys: true });
      if (document.errors.length || (document.contents && !isMap(document.contents))) throw new GlobalConfigWriteError("config");
      if (current.defaultState === enabled) return { value: enabled };
      document.set("defaultState", enabled);
      const yaml = document.toString({ lineWidth: 0 });
      if (Buffer.byteLength(yaml) > 64 * 1024 || !isDeepStrictEqual(Bun.YAML.parse(yaml), { ...current, defaultState: enabled })) {
        throw new GlobalConfigWriteError("config");
      }
      return { yaml, value: enabled };
    },
  });
}

const enabledLabel = (enabled: boolean | undefined) => enabled === undefined ? "无法读取" : enabled ? "已开启" : "已关闭";

export function createChatSettings(root: URL, directories: PluginLoadReport["directories"]) {
  const likes = () => readGroupLikeSettingsModule(directories);
  return async ({ setting, enabled }: Setting, canWrite: () => boolean, signal: AbortSignal) => {
    if (!canWrite()) return "暂无权限，只有主人才能操作。";
    if (setting === "渲染精度") return "当前各功能使用自己的渲染配置，聊天中没有全局渲染精度设置。";
    if (setting === "状态") {
      if (directories.get("system")?.packageName !== "@lotus-yunzai/system") return "状态模块当前不可用。";
      try {
        await saveDefaultStatus(root, enabled, canWrite, signal);
      } catch {
        return "无法保存默认状态，请检查状态配置后重试。";
      }
    } else if (setting === "陌生人点赞") {
      try {
        const service = await likes();
        if (!service) return "资料卡点赞模块当前不可用。";
        for (let attempt = 0; ; attempt++) {
          const { revision } = await service.readLikeSettings();
          try {
            await service.saveLikeSettings({ strangeThumbUp: enabled }, { revision, canWrite });
            break;
          } catch (cause) {
            if (!canWrite() || attempt >= 2 || !(cause instanceof service.LikeSettingsError) || cause.code !== "conflict") throw cause;
          }
        }
      } catch {
        return "无法保存陌生人点赞设置，请检查点赞配置后重试。";
      }
    }
    const [like, status] = await Promise.all([
      likes().then(async (service) => (await service?.readLikeSettings())?.settings.strangeThumbUp).catch(() => undefined),
      readDefaultStatus(directories).catch(() => undefined),
    ]);
    if (signal.aborted || !canWrite()) return;
    return [
      "Lotus-Yunzai 设置",
      `陌生人点赞 ${enabledLabel(like)}`,
      "  #设置陌生人点赞开启 / #设置陌生人点赞关闭",
      `默认状态 ${enabledLabel(status)}`,
      "  #设置状态开启 / #设置状态关闭",
      ...(directories.get("group")?.packageName === "@lotus-yunzai/group" ? ["通知设置发送 #通知设置"] : []),
    ].join("\n");
  };
}
