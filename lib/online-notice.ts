interface OnlineNoticeOptions {
  readonly signal?: AbortSignal;
  readonly version?: string;
  readonly masterIds: (botId: number) => readonly number[];
  readonly claim: (botId: number, seconds: number) => Promise<boolean>;
  readonly send: (botId: number, userId: number, message: string) => Promise<boolean | void>;
}

const defaultMinutes = 1_440;
const maxSeconds = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);
const decimal = /^(?:\d+(?:\.\d*)?|\.\d+)$/u;
const help = [
  "【#帮助】查看指令说明",
  "【#状态】查看运行状态",
  "【#日志】查看运行日志",
  "【#重启】重新启动",
  "【#更新】检查宿主更新",
  "【#全部更新】更新宿主和插件",
  "【#更新日志】查看更新日志",
  "【#设置主人】设置主人账号",
  "【#安装插件】查看安装名录",
].join("\n");

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function onlineNoticeSeconds(value: unknown): number | undefined {
  const configured = value === undefined ? defaultMinutes : value;
  const minutes = typeof configured === "string" && decimal.test(configured.trim()) ? Number(configured) : configured;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return;
  const seconds = Math.ceil(minutes * 60);
  if (positiveInteger(seconds) && seconds <= maxSeconds) return seconds;
}

export async function notifyOnlineMasters(
  botId: number, seconds: number | undefined, { signal, version, masterIds, claim, send }: OnlineNoticeOptions,
): Promise<void> {
  if (!positiveInteger(botId) || !positiveInteger(seconds) || seconds > maxSeconds || signal?.aborted) return;
  const recipients = () => new Set(masterIds(botId).filter((id) => positiveInteger(id) && id !== botId));
  let current: Set<number>;
  try {
    if (!recipients().size || signal?.aborted || await claim(botId, seconds) !== true || signal?.aborted) return;
    current = recipients();
  } catch {
    return;
  }

  const welcome = `欢迎使用【Lotus-Yunzai${version ? ` v${version}` : ""}】\n${help}`;
  for (const userId of current) {
    if (signal?.aborted) return;
    try {
      await send(botId, userId, welcome);
    } catch {
      // The delivery result is unknown. Keep the cooldown and continue with other owners.
    }
  }
}
