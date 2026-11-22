import { createHash } from "node:crypto";
import type { LegacyPluginPlanEntry } from "./migration-plan.ts";

export interface LegacyProtocolOrigin {
  readonly protocol: string;
  readonly packageName: string;
  // Exact, host-qualified spellings from the reviewed release. A basename is never an origin.
  readonly gitRemotes: readonly string[];
  readonly manifestSha256: string;
  readonly sourceFiles: Readonly<Record<string, string>>;
}

export interface ApprovedProtocolReplacement {
  readonly id: string;
  readonly legacy: LegacyProtocolOrigin;
  readonly target: {
    readonly packageName: string;
    readonly packageTreeSha256: string;
  };
}

export interface LegacyProtocolIdentity {
  readonly packageName: string;
  readonly manifest: string | undefined;
  readonly gitRemotes: readonly string[];
}

// Only the release can approve replacements. No optional adapter is approved yet.
export const approvedProtocolReplacements: readonly ApprovedProtocolReplacement[] = [];

function sha256(bytes: string | Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function matchApprovedProtocolReplacement(
  candidate: LegacyProtocolIdentity,
  readSourceFile: (path: string) => Promise<Uint8Array>,
  replacements: readonly ApprovedProtocolReplacement[] = approvedProtocolReplacements,
) {
  if (!candidate.packageName || candidate.manifest === undefined || !replacements.length) return;
  const manifest = sha256(candidate.manifest);
  let matched: ApprovedProtocolReplacement | undefined;
  for (const replacement of replacements) {
    const legacy = replacement.legacy;
    const files = Object.entries(legacy.sourceFiles);
    if (candidate.packageName !== legacy.packageName || legacy.manifestSha256 !== manifest || !files.length ||
        candidate.gitRemotes.some(origin => !legacy.gitRemotes.includes(origin))) continue;
    let unchanged = true;
    for (const [path, expected] of files) {
      if (sha256(await readSourceFile(path)) !== expected) {
        unchanged = false;
        break;
      }
    }
    if (!unchanged) continue;
    if (matched) return; // One old installation cannot authorize two replacements.
    matched = replacement;
  }
  return matched;
}

type ProtocolCandidate = Extract<LegacyPluginPlanEntry, { readonly status: "protocol-candidate" }>;

/** A second installation of the same protocol needs an explicit operator decision. */
export function selectApprovedProtocolCandidates(
  plan: { readonly plugins: readonly LegacyPluginPlanEntry[] },
  replacements: readonly ApprovedProtocolReplacement[] = approvedProtocolReplacements,
) {
  const protocols = new Map<string, ProtocolCandidate[]>();
  for (const entry of plan.plugins) {
    if (entry.status !== "protocol-candidate") continue;
    const current = protocols.get(entry.protocol) ?? [];
    current.push(entry);
    protocols.set(entry.protocol, current);
  }
  return [...protocols.values()].flatMap(entries => {
    const candidate = entries[0];
    if (entries.length !== 1 || !candidate?.replacement) return [];
    const trusted = replacements.filter(replacement => replacement.id === candidate.replacement);
    const [replacement] = trusted;
    return trusted.length === 1 && replacement?.legacy.protocol === candidate.protocol ? [{ candidate, replacement }] : [];
  });
}
