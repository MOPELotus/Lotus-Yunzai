import fs from 'node:fs/promises'
import type { ModelStore } from '../infrastructure/models.ts'
/** Immutable public lexicon, not generated answers or retrained model data. */
export class PhraseLexicon {
  private readonly words = new Map<string, Set<string>>()
  constructor(text: string) {
    for (const line of text.split('\n')) {
      const word = line.split(/\s+/)[0]!
      if (!/^[\u4e00-\u9fff]{4}$/.test(word)) continue
      const key = [...word].sort().join(''),
        candidates = this.words.get(key) || new Set<string>()
      candidates.add(word)
      this.words.set(key, candidates)
    }
  }
  unique(chars: readonly string[], rejected: readonly string[] = []): string | undefined {
    if (chars.length !== 4 || new Set(chars).size !== 4) return
    const candidates = [...(this.words.get([...chars].sort().join('')) || [])].filter(
      (word) => !rejected.includes(word),
    )
    return candidates.length === 1 ? candidates[0]! : undefined
  }
  static async load(store: ModelStore): Promise<PhraseLexicon> {
    return new PhraseLexicon(await fs.readFile(await store.get('phrase-lexicon'), 'utf8'))
  }
}
