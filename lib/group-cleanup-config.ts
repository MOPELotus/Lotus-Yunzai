function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const fields = ["enable", "dry_run", "remove_group_fallback", "delete_orphan_profiles", "keep_if_private_possible"] as const;

export function projectGroupCleanupConfig(value: unknown) {
  const source = record(record(value).cleanup);
  return Object.fromEntries(fields.filter(key => typeof source[key] === "boolean").map(key => [key, source[key]]));
}

export function groupCleanupConfig(value: unknown) {
  const source = projectGroupCleanupConfig(value);
  return {
    dryRun: source.dry_run !== false,
    removeFallback: source.remove_group_fallback !== false,
    archiveRequested: source.delete_orphan_profiles === true,
  };
}
