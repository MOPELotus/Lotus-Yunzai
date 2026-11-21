import { createHash } from "node:crypto";
import { builtInDirectories } from "../builtin-modules.ts";
import { rejectionReason, repositoryKey } from "./policy.ts";

export const pluginScriptExtensions: ReadonlySet<string> = new Set([".js", ".mjs", ".cjs", ".ts"]);
const retiredScripts = new Map([
  ["c56d66b96534430c0b144051ffb5fbec74f8febec3acbb85ddc9c00427faba98",
    { name: "图库管理器", reason: "图库管理已归并到 atlas。", module: "@lotus-yunzai/atlas" }],
  ["bded3f9693c4f5b8a63e54c8b1e7bd6d2294974533cc31011fe34161dae0b9ca",
    { name: "自动群名片", reason: "批量群名片已归并到 group。", module: "@lotus-yunzai/group" }],
  ["9d03582599fff6214732f963fceccde151a1307169c956e28c2f52327734180f",
    { name: "主动复读", reason: "主人主动复读已归并到 group。", module: "@lotus-yunzai/group" }],
  ["150399f358647ea2f306b74595c33db2e2a789a4f763e48eb5804300f70e9359",
    { name: "自动复读", reason: "群自动复读已归并到 group。", module: "@lotus-yunzai/group" }],
  ["1babeb445b80a5c10ba3442e3a97d1716762931677460259b3b274d1c49d7368",
    { name: "进群退群通知", reason: "进群和退群通知已归并到 group。", module: "@lotus-yunzai/group" }],
  ["bbd4e6adedab7bbef1c336b5add6ab43c725b78ed0d85c40d158b5614e75d7bf",
    { name: "退群自动拉黑", reason: "退群黑名单已归并到 group。", module: "@lotus-yunzai/group" }],
  ["629da5e8260364f2da2c13da42be13772b065534372c63ddf3a497adc8e904c4",
    { name: "标准输入", reason: "标准输入已由宿主终端提供。", module: "@lotus-yunzai/system" }],
  ["f08fae9f680d281d9ed066b80e427908884b0f587e5221f8a2d468911ba828ca",
    { name: "原神背包查询", reason: "原神背包查询已归并到 genshin。", module: "@lotus-yunzai/genshin" }],
  ["5965452098afb917602bfcc63bcd63f0162e480b523cade00b0f0e6eb21d89ab",
    { name: "原神世界BOSS", reason: "世界 BOSS 战绩和排行已归并到 genshin。", module: "@lotus-yunzai/genshin" }],
  ["baa463126c6a8d8421ff80c29614b572a141b02870811e3ca24c5e61c3ace502",
    { name: "mcwiki", reason: "Minecraft Wiki 条目预览已归并到 media。", module: "@lotus-yunzai/media" }],
  ["a82020972ef0b317cc617136757f268feb61fdc397df58e2b331deb0507f6b9d",
    { name: "定时日历", reason: "定时日历已归并到 guides。", module: "@lotus-yunzai/guides" }],
  ["22779ce7c2e87de4653cd9d2ee8187cfe436e7d4ae42e6dfeaebde14b9bb6ed1",
    { name: "抽卡期望计算", reason: "抽卡期望和分布已由宿主提供。", module: "@lotus-yunzai/gacha-expectation" }],
]);

// Byte identities from the fixed TRSS host. Names alone cannot establish that a directory is the old host.
const trssHostScripts = new Map([
  ["other", {
    reason: "旧宿主的安装、进程管理、日志、更新与版本入口已归并到 Lotus-Yunzai。",
    scripts: new Map([
      ["install.js", "0fc91238477da8336038a75c244457845857e6d2a37c27acccc688165c4a28b7"],
      ["restart.js", "b5ee163ffa77cd019b9da68f7e15b10ec6374e40400cb63c74b841044bcd4c4c"],
      ["sendLog.js", "7ecd73facdb0b995ac0c942fb68d7950fc42d030db6b036a2a4e348418e5aa75"],
      ["update.js", "b611904e4028f188c2548425ab1cf1de27894251381f1f7ffc1d12f138e0ce94"],
      ["version.js", "98600954891a1aa7d03402b6a12188f275e4bd8fb4d0c9ce9c823ae11ec7bf5b"],
    ]),
  }],
  ["system", {
    reason: "旧宿主的主人、私聊、群与系统入口已归并到 Lotus-Yunzai。",
    scripts: new Map([
      ["add.js", "6fff15bd4bc364ca7386b0bf436fdaccc14b48130308965c253388b17f8887b2"],
      ["botOperate.js", "51c0db7b8c34dcf535ba6d7804b7f221640d9b12fd23d5779533c3a4feeabfb4"],
      ["disablePrivate.js", "d0e027cc8113a9780722f34fbfa867ecfe06dbcd6b3e496f2c25836d185bc637"],
      ["friend.js", "4436ca777bc248a03cabc783b7ee828324fea831d7683c7c44bf7a8fc494ca42"],
      ["invite.js", "2fd84b7c38cbac375882f4a5d7a6b79e3139096cc2cdc3e3aac252e0c11aa7ec"],
      ["master.js", "8c1a75f11c6667852c63a82882ecfcbca76c2aafbf9eef465b4a9c00538d2392"],
      ["quit.js", "b864b5b775c2aa3c47cd3fa854d5c6ad83f080931f15518b1c14515b0094233a"],
      ["recallReply.js", "b743ac353ff2777fdee0dfefd0a0808f5456e53f2dfcdf2816cc95484db480e4"],
      ["status.js", "d0152bef5d77a9cb33083c08156792b06851cc10722adbfcb149a8a05158f4c3"],
    ]),
  }],
]);
const retiredHostScripts = new Map([...trssHostScripts.values()].flatMap(({ reason, scripts }) =>
  [...scripts].map(([name, hash]) => [hash, { name, reason, module: "lotus-yunzai" }] as const)));

export function legacyHostScriptGroup(directory: string) {
  return trssHostScripts.get(directory);
}

interface PluginMetadata {
  readonly name: string;
  readonly declaredName: string;
  readonly repositoryKeys: readonly string[];
  readonly repositoryNames: readonly string[];
  readonly identities: readonly string[];
  readonly entry?: string;
  readonly rejection?: string;
  readonly rejectionKind?: "policy" | "built-in-directory";
  readonly rejectionIdentity?: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function retiredPluginScript(source: Uint8Array) {
  const hash = createHash("sha256").update(source).digest("hex");
  return retiredScripts.get(hash) ?? retiredHostScripts.get(hash);
}

export function inspectPluginMetadata(directory: string, source: string | undefined, urls: readonly string[]): PluginMetadata {
  const manifest = record(source === undefined ? undefined : JSON.parse(source.replace(/^\uFEFF/u, "")));
  const meta = record(manifest.lotusYunzai);
  const declaredName = typeof manifest.name === "string" ? manifest.name.trim().toLowerCase() : "";
  const name = declaredName || directory.toLowerCase();
  const repository = typeof manifest.repository === "string" ? manifest.repository : record(manifest.repository).url;
  const sources = typeof repository === "string" ? [...urls, repository] : urls;
  const repositories = sources.map(repositoryKey).filter(key => key !== undefined);
  const repositoryNames = sources.map(source => {
    const key = repositoryKey(source);
    if (key) return key.split("/").at(-1);
    try {
      // Some legacy protocol repositories sit directly at the root of their Git host.
      const url = new URL(source.trim().replace(/^git\+/iu, ""));
      if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return;
      return /^\/([\w.-]+)\/?$/u.exec(url.pathname)?.[1]?.replace(/\.git$/iu, "").toLowerCase();
    } catch {
      return;
    }
  }).filter(name => name !== undefined);
  const result = {
    name, declaredName, repositoryKeys: repositories, repositoryNames, identities: [`name:${name}`, ...repositories.map((key) => `repo:${key}`)],
  };
  const names = [directory.toLowerCase(), name, name.split("/").at(-1) ?? "",
    ...repositories, ...repositories.map((key) => key.split("/")[1] ?? "")];
  const games = Array.isArray(meta.games) ? meta.games.filter((game) => typeof game === "string") : [];
  const rejection = rejectionReason(names, games);
  if (rejection) return { ...result, rejection, rejectionKind: "policy", rejectionIdentity: declaredName || repositories[0] || directory };

  const { entry } = meta;
  if (entry !== undefined && (typeof entry !== "string" || !declaredName)) {
    throw new Error("清单模块须声明包名和入口路径。");
  }
  const builtInDirectory = builtInDirectories.get(name);
  if (builtInDirectory !== undefined && directory !== builtInDirectory) {
    return { ...result, rejection: `${name} 的内置目录为 plugins/${builtInDirectory}。`, rejectionKind: "built-in-directory" };
  }
  return { ...result, entry };
}
