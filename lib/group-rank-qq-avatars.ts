import { loadPublicQqAvatar } from "@lotus-yunzai/account";

export async function loadGroupRankQqAvatars(accounts: readonly (string | number | undefined)[], signal?: AbortSignal,
  read = loadPublicQqAvatar) {
  const ids = [...new Set(accounts.filter(id => id !== undefined).map(String))].filter(id => /^[1-9]\d{0,15}$/u.test(id));
  const images = new Map<string, Buffer>();
  const pending = ids.values();
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    for (const id of pending) {
      if (signal?.aborted) break;
      let image = await read(id, { signal }).catch(() => undefined);
      if (!image && !signal?.aborted) image = await read(id, { signal }).catch(() => undefined);
      if (image) images.set(id, image);
    }
  }));
  return images;
}
