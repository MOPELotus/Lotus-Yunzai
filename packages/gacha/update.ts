export function createGachaUpdater<Result>(
  sync: (qq: string, profileId: number) => Promise<Result>,
) {
  const active = new Set<string>();
  return async (qq: string, profileId: number, notify?: () => unknown): Promise<Result | undefined> => {
    const key = `${qq}/${profileId}`;
    if (active.has(key)) return;
    active.add(key);
    try {
      await notify?.();
      return await sync(qq, profileId);
    } finally {
      active.delete(key);
    }
  };
}
