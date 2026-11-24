import { readOptionalConfigFile } from "./config.ts";

/** Music login and partner tasks share this account file. No credential leaves this reader. */
export async function hasNeteasePartnerAccount(root: URL): Promise<boolean> {
  const saved = await readOptionalConfigFile(root, "data/netease/accounts.yaml");
  return Array.isArray(saved?.accounts) && saved.accounts.length > 0;
}
