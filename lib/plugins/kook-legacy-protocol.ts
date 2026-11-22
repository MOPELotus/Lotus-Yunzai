import type { ApprovedProtocolReplacement } from "./legacy-protocol-replacements.ts";

/** Candidate for explicit approval after the deployment supplies an authorized KOOK account. */
export const kookLegacyProtocol = {
  source: {
    repository: "https://github.com/TimeRainStarSky/Yunzai-KOOK-Plugin",
    revision: "24d007df282ce64c0384af6ca85147bf52cbb7b1",
    configPath: "config/KOOK.yaml",
  },
  target: {
    repository: "https://github.com/MOPELotus/Lotus-Yunzai-KOOK",
    revision: "4fd5375bceb724768e0af5dc57d677bbe0704787",
  },
  replacement: {
    id: "kook",
    legacy: {
      protocol: "kook",
      packageName: "kook-plugin",
      gitRemotes: [
        "https://git.trss.me/Yunzai-KOOK-Plugin",
        "https://github.com/TimeRainStarSky/Yunzai-KOOK-Plugin",
        "https://github.com/TimeRainStarSky/Yunzai-KOOK-Plugin.git",
      ],
      manifestSha256: "a8980eb87829ebb538288fe6f1a3fff904265db16598bd5b0c0c6e52125e3f53",
      sourceFiles: { "index.js": "36aba9e85507cf7c042d836e79c9046e8f707879334aa65ab293f3cc11d5ac81" },
    },
    target: {
      packageName: "@lotus-yunzai/adapter-kook",
      packageTreeSha256: "5385e97c56bfb785b4ca45fa074b77b1ebf81e6bada01cf66fc7a54494a54a30",
    },
  } satisfies ApprovedProtocolReplacement,
} as const;

/** The credential provider is separate. Neither token nor old administrative permission is consulted here. */
export function migrateKookPublicSettings(source: Readonly<Record<string, unknown>> | undefined) {
  if (!source) return;
  const sendCardMessage = source.sendCardMsg;
  if (sendCardMessage !== undefined && typeof sendCardMessage !== "boolean") return;
  return { sendCardMessage: sendCardMessage ?? true };
}
