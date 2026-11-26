import { loadPublicQqAvatar } from "@lotus-yunzai/account";

export async function loadGroupRankQqAvatars(accounts: readonly (string | number | undefined)[], signal?: AbortSignal,
  read = loadPublicQqAvatar) {
  const ids = [...new Set(accounts.filter(id => id !== undefined).map(String))].filter(id => /^[1-9]\d{0,15}$/u.test(id));
  const images = new Map<string, Buffer>();
  await Promise.all(ids.map(async id => {
    const image = await read(id, { signal }).catch(() => undefined);
    if (image) images.set(id, image);
  }));
  return images;
}
