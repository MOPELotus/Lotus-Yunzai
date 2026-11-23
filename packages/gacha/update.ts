export function createGachaUpdater<Result, Options = undefined>(
  sync: (qq: string, profileId: number, options?: Options) => Promise<Result>,
) {
  const active = new Set<string>();
  return async (qq: string, profileId: number, notify?: () => unknown, options?: Options): Promise<Result | undefined> => {
    const key = `${qq}/${profileId}`;
    if (active.has(key)) return;
    active.add(key);
    try {
      await notify?.();
      return await sync(qq, profileId, options);
    } finally {
      active.delete(key);
    }
  };
}
