export interface FooterStyle { fontSize: number; bold: boolean; color: string }
export interface FooterRun extends FooterStyle { text: string }

const colors: Record<string, string> = { white: '#fff', black: '#000', gold: '#ffd700', red: '#f00', blue: '#00f', green: '#008000' };
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

function decode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (entity, name: string) => {
    if (!name.startsWith('#')) return entities[name.toLowerCase()] ?? entity;
    const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
  });
}

/** Only text spans and line breaks are interpreted; no HTML, URLs or scripts are executed. */
export function footerMarkup(text: string, base: FooterStyle): FooterRun[] | undefined {
  if (!/<(?:span\b|b>|strong>|br\s*\/?>)/iu.test(text)) return;
  const runs: FooterRun[] = [];
  const stack: { tag: string; style: FooterStyle }[] = [{ tag: '', style: base }];
  for (const token of text.split(/(<\/?(?:span\b[^>]*|b|strong)\s*>|<br\s*\/?>)/giu)) {
    if (!token) continue;
    const parent = stack.at(-1)!.style;
    if (/^<br\s*\/?>$/iu.test(token)) { runs.push({ ...parent, text: '\n' }); continue; }
    const close = /^<\/(span|b|strong)\s*>$/iu.exec(token);
    if (close) {
      const index = stack.findLastIndex(entry => entry.tag === close[1]!.toLowerCase());
      if (index > 0) stack.splice(index);
      continue;
    }
    const open = /^<(span|b|strong)\b[^>]*>$/iu.exec(token);
    if (!open) { runs.push({ ...parent, text: decode(token) }); continue; }
    const style = { ...parent };
    const tag = open[1]!.toLowerCase();
    if (tag !== 'span') style.bold = true;
    const inline = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/iu.exec(token);
    for (const declaration of (inline?.[1] ?? inline?.[2] ?? '').split(';')) {
      const [property, raw] = declaration.split(':');
      const value = raw?.trim().toLowerCase();
      if (!value) continue;
      switch (property?.trim().toLowerCase()) {
        case 'color':
          if (/^#(?:[a-f\d]{3}|[a-f\d]{6})$/iu.test(value)) style.color = value;
          else if (colors[value]) style.color = colors[value]!;
          break;
        case 'font-weight':
          if (/^(?:bold|[6-9]00)$/u.test(value)) style.bold = true;
          else if (/^(?:normal|[1-5]00)$/u.test(value)) style.bold = false;
          break;
        case 'font-size': {
          const size = value === 'larger' ? parent.fontSize * 1.2 : value === 'x-large' ? 24
            : /^\d+(?:\.\d+)?px$/u.test(value) ? parseFloat(value) : NaN;
          if (Number.isFinite(size)) style.fontSize = Math.min(32, Math.max(8, size));
          break;
        }
      }
    }
    stack.push({ tag, style });
  }
  return runs;
}
