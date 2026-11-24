import sharp from 'sharp'
import { setTimeout as sleep } from 'node:timers/promises'
import type {
  ProtocolAdapter,
  ProtocolContext,
  ProtocolSession,
  Challenge,
  Proof,
} from '../../domain/protocol.ts'
import type { Puzzle, Answer } from '../../domain/puzzle.ts'
import { GeetestChallenge } from './client.ts'
import { CaptchaError } from '../../domain/errors.ts'

export class V3Adapter implements ProtocolAdapter {
  readonly version = 3 as const
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}
  async open(challenge: Challenge, { signal }: ProtocolContext): Promise<ProtocolSession> {
    if (challenge.version !== 3) throw new Error('V3 adapter received another protocol')
    const started = Date.now(),
      client = new GeetestChallenge(challenge, { fetch: this.fetchImpl, signal })
    const prepared = await client.prepare()
    const proof = (value: string): Proof => ({
      version: 3,
      validate: value.split('|')[0]!,
      challenge: client.challenge,
      seccode: `${value.split('|')[0]!}|jordan`,
    })
    if (prepared.validate) return { proof: proof(prepared.validate) }
    if (!prepared.image) throw new CaptchaError('invalid_v3_challenge')
    let puzzle: Puzzle
    if (prepared.type === 'nine') {
      const cells: Buffer[] = []
      for (let i = 0; i < 9; i++)
        cells.push(
          await sharp(prepared.image)
            .extract({ left: (i % 3) * 116, top: Math.floor(i / 3) * 116, width: 112, height: 112 })
            .png()
            .toBuffer(),
        )
      const prompt = await sharp(prepared.image)
        .extract({ left: 2, top: 344, width: 40, height: 40 })
        .png()
        .toBuffer()
      puzzle = { kind: 'grid', cells, prompts: [prompt] }
    } else if (['icon', 'icon1'].includes(prepared.type))
      puzzle = {
        kind: 'click',
        image: prepared.image,
        prompts: [],
        style: prepared.type === 'icon1' ? 'embedded-pairs' : 'embedded-similarity',
      }
    else
      throw new CaptchaError('unsupported_puzzle', `Unsupported V3 picture type: ${prepared.type}`)
    return {
      puzzle,
      submit: async (answer: Answer) => {
        const points =
          answer.kind === 'grid'
            ? answer.indices.map((i) => `${(i % 3) + 1}_${Math.floor(i / 3) + 1}`)
            : answer.kind === 'points'
              ? answer.points.map(([x, y]) => `${Math.round(x * 10000)}_${Math.round(y * 10000)}`)
              : []
        if (!points.length) throw new CaptchaError('invalid_answer')
        await sleep(Math.max(0, 4000 - (Date.now() - started)), undefined, { signal })
        const result = await client.verify(points),
          value = result?.data?.data || result?.data || result
        if (
          (value.result && value.result !== 'success') ||
          typeof value.validate !== 'string' ||
          !value.validate
        )
          throw new CaptchaError('verification_failed', undefined, true)
        return proof(value.validate)
      },
    }
  }
}
