/** The Genshin index may report a server display name instead of its request code. */
export function genshinResponseRegion(value: unknown): unknown {
  if (value === "天空岛") return "cn_gf01";
  if (value === "世界树") return "cn_qd01";
  return value;
}
