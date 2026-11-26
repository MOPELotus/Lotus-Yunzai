export function rankLabelLayout(value: string, width: number, measure: (value: string) => number, size = 11) {
  const chars = Array.from(value);
  if (chars.length < 2 || measure(value) <= width) return { lines: [value], size };
  let split = 1, balance = Infinity;
  for (let index = 1; index < chars.length; index++) {
    const span = Math.max(measure(chars.slice(0, index).join("")), measure(chars.slice(index).join("")));
    if (span < balance) { split = index; balance = span; }
  }
  return { lines: [chars.slice(0, split).join(""), chars.slice(split).join("")], size: size * Math.min(1, width / balance) };
}
