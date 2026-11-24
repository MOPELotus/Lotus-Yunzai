import type { Puzzle, Answer } from './puzzle.ts'
export type Challenge =
  | { version: 3; gt: string; challenge: string }
  | {
      version: 4
      captcha_id: string
      risk_type?: string
      lang?: string
      client_type?: string
      voice?: boolean
      tz?: { name: string; offset: number }
    }
export type Proof =
  | { version: 3; validate: string; challenge: string; seccode: string }
  | {
      version: 4
      captcha_id: string
      lot_number: string
      pass_token: string
      gen_time: string
      captcha_output: string
    }
export interface ProtocolContext {
  signal: AbortSignal
}
export type ProtocolSession =
  | { proof: Proof; puzzle?: never; submit?: never }
  | {
      puzzle: Puzzle
      proof?: never
      submit(answer: Answer): Promise<Proof>
      fallback?: () => Promise<ProtocolSession>
    }
export interface ProtocolAdapter {
  readonly version: 3 | 4
  open(challenge: Challenge, context: ProtocolContext): Promise<ProtocolSession>
}
