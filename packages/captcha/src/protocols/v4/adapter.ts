// Protocol-only port of wulu's load/verify/payload flow. Solvers never see this state.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type {
  ProtocolAdapter,
  ProtocolContext,
  ProtocolSession,
  Challenge,
  Proof,
} from '../../domain/protocol.ts'
import type { Puzzle, Answer } from '../../domain/puzzle.ts'
import { Keyring } from './keyring.ts'
import { CaptchaError } from '../../domain/errors.ts'
import { HttpClient } from '../../infrastructure/http.ts'
import { rootPath } from '../../infrastructure/paths.ts'
import { encryptPayload, proofOfWork, lotFields, trackSignature, type PowDetail } from './crypto.ts'
import {
  clickTrack,
  gridTrack,
  boardTrack,
  slideTrack,
  svgTrack,
  zipTrack,
  integer,
  type Track,
} from './track.ts'
interface Patrol {
  biht: string
  lib_key: string
  lib_val: string
  abo_key: string
  abo_val: string
  track_enable?: boolean
}
interface WireChallenge {
  captcha_type: string
  lot_number: string
  static_path: string
  pt: string | number
  pow_detail: PowDetail
  payload: string
  process_token: string
  payload_protocol: number
  guard?: boolean
  [field: string]: any // Dynamic fields are confined to the protocol boundary.
}
export class V4Adapter implements ProtocolAdapter {
  readonly version = 4 as const
  private readonly patrols = new Map<string, Patrol>()
  private readonly keyring = new Keyring()
  constructor(
    private readonly http = new HttpClient(),
    private readonly options: { voiceFallback?: boolean } = {},
  ) {}
  private async config(staticPath: string): Promise<Patrol> {
    const version = staticPath?.replace('/v4/static/', ''),
      release = version?.match(/^v?\d+\.\d+\.\d+/)?.[0]
    if (!release) throw new CaptchaError('unsupported_build')
    if (!this.patrols.has(version)) {
      const entries = JSON.parse(
        await fs.readFile(path.join(rootPath, `resources/${release}-config.json`), 'utf8'),
      ) as Record<string, Patrol>
      for (const [name, value] of Object.entries(entries)) this.patrols.set(name, value)
    }
    const patrol = this.patrols.get(version)
    if (!patrol) throw new CaptchaError('unsupported_build')
    return patrol
  }
  private api(route: string, params: Record<string, unknown>, signal: AbortSignal) {
    const url = new URL(route, 'https://gcaptcha4.geetest.com')
    for (const [key, value] of Object.entries({ callback: `geetest_${Date.now()}`, ...params }))
      if (value !== undefined) url.searchParams.set(key, String(value))
    return this.http.jsonp(url, signal)
  }
  private resource(resource: string, signal: AbortSignal): Promise<Buffer> {
    const url = new URL(resource, 'https://static.geetest.com/')
    if (
      url.protocol !== 'https:' ||
      !/(^|\.)(geetest\.com|geevisit\.com|geetest\.net)$/.test(url.hostname)
    )
      throw new CaptchaError('invalid_resource_url')
    return this.http.bytes(url, signal)
  }
  async open(challenge: Challenge, { signal }: ProtocolContext): Promise<ProtocolSession> {
    if (challenge.version !== 4) throw new Error('V4 adapter received another protocol')
    const site = {
      captcha_id: challenge.captcha_id,
      client_type: challenge.client_type || 'web',
      ...(challenge.risk_type && challenge.risk_type !== 'auto'
        ? { risk_type: challenge.risk_type }
        : {}),
    }
    const result = await this.api(
      '/load',
      {
        ...site,
        challenge: crypto.randomUUID(),
        lang: challenge.lang || 'zh',
        ...(challenge.voice ? { switch_to: 'voice' } : {}),
      },
      signal,
    )
    const data = result.data as WireChallenge
    if (!data || !/^[a-f\d]{32}$/i.test(data.lot_number))
      throw new CaptchaError('invalid_v4_challenge')
    const patrol = await this.config(data.static_path),
      puzzle = await this.puzzle(data, signal)
    return {
      puzzle,
      ...(this.options.voiceFallback !== false &&
      data.show_voice === true &&
      !challenge.voice &&
      data.captcha_type !== 'voice'
        ? {
            fallback: () =>
              this.open({ ...challenge, risk_type: 'voice', voice: true }, { signal }),
          }
        : {}),
      submit: async (answer: Answer): Promise<Proof> => {
        const { track, ...response } = this.answer(data.captcha_type, answer)
        const td = track && patrol.track_enable !== false ? zipTrack(track) : undefined
        const payload: Record<string, unknown> = {
          ...(await proofOfWork(data.lot_number, challenge.captcha_id, data.pow_detail, signal)),
          ...lotFields(patrol.abo_key, patrol.abo_val, data.lot_number),
          [patrol.lib_key]: patrol.lib_val,
          biht: patrol.biht,
          device_id: '',
          em: { cp: 0, ek: '11', nt: 0, ph: 0, sc: 0, si: 0, wd: 1 },
          ep: '123',
          geetest: 'captcha',
          lang: 'zh',
          lot_number: data.lot_number,
          nd: [0, 0, 0, 0, 0, 0, 0],
          tc: { mtp: 0, te: false, ts: false },
          tz: challenge.tz || { name: 'Asia/Shanghai', offset: 480 },
          ...response,
        }
        if (td) payload.td_sign = trackSignature(data.lot_number, td)
        if (data.guard)
          payload.roe = {
            aup: '3',
            sep: '3',
            egp: '3',
            auh: '3',
            rew: '3',
            snh: '3',
            res: '3',
            cdc: '3',
          }
        let verified
        try {
          verified = (
            await this.api(
              '/verify',
              {
                ...site,
                risk_type: site.risk_type || data.captcha_type,
                lot_number: data.lot_number,
                payload: data.payload,
                process_token: data.process_token,
                payload_protocol: data.payload_protocol,
                pt: data.pt,
                w: encryptPayload(
                  JSON.stringify(payload),
                  Number(data.pt),
                  this.keyring.get(data.static_path),
                ),
                ...(td ? { td } : {}),
              },
              signal,
            )
          ).data
        } catch (error) {
          const code = (error as { upstreamCode?: number }).upstreamCode
          if (Number(data.pt) === 1 && (code === -50002 || code === -50003)) {
            const script = await this.resource(
              `${data.static_path.replace(/\/$/, '')}/js/gcaptcha4.js`,
              signal,
            )
            this.keyring.recover(data.static_path, script.toString('utf8'))
            throw new CaptchaError('protocol_key_updated', undefined, true)
          }
          throw error
        }
        if (
          Number(data.pt) === 1 &&
          [-50002, -50003].includes(Number(verified?.code ?? verified?.status))
        ) {
          const script = await this.resource(
            `${data.static_path.replace(/\/$/, '')}/js/gcaptcha4.js`,
            signal,
          )
          this.keyring.recover(data.static_path, script.toString('utf8'))
          throw new CaptchaError('protocol_key_updated', undefined, true)
        }
        if (verified?.result !== 'success')
          throw new CaptchaError(
            verified?.result === 'forbidden' ? 'forbidden' : 'verification_failed',
            undefined,
            verified?.result !== 'forbidden',
          )
        const proof = verified.seccode as Record<string, unknown>
        if (
          !proof ||
          !['captcha_id', 'lot_number', 'pass_token', 'gen_time', 'captcha_output'].every(
            (key) => typeof proof[key]! === 'string' && proof[key]!,
          )
        )
          throw new CaptchaError('invalid_v4_proof')
        if (proof.captcha_id !== challenge.captcha_id || proof.lot_number !== data.lot_number)
          throw new CaptchaError('proof_identity_mismatch')
        return {
          version: 4,
          captcha_id: proof.captcha_id as string,
          lot_number: proof.lot_number as string,
          pass_token: proof.pass_token as string,
          gen_time: proof.gen_time as string,
          captcha_output: proof.captcha_output as string,
        }
      },
    }
  }
  private async puzzle(data: WireChallenge, signal: AbortSignal): Promise<Puzzle> {
    const type = data.captcha_type
    if (type === 'ai') return { kind: 'silent' }
    if (type === 'slide') {
      const [background, piece] = await Promise.all([
        this.resource(data.bg, signal),
        this.resource(data.slice, signal),
      ])
      return { kind: 'slide', background, piece, y: Number(data.ypos || 0) }
    }
    if (type === 'match' || type === 'winlinze')
      return { kind: type === 'match' ? 'match' : 'gomoku', board: data.ques }
    if (type === 'svg_seed' || type === 'svg_icon') {
      const question =
        type === 'svg_icon'
          ? (await this.resource(data.question_path, signal)).toString('utf8')
          : (data.question_path as string)
      const answers =
        type === 'svg_icon'
          ? await this.resource(data.answer_path, signal)
          : Buffer.from(data.answer_path, 'base64')
      return { kind: 'svg', question, answers }
    }
    if (type === 'voice') {
      const parts = (data.voice_path as string).split('/')
      return {
        kind: 'voice',
        audio: await this.resource(data.voice_path, signal),
        language: parts.at(-2)!,
        templateVersion: parts.at(-3)!,
      }
    }
    if (['icon', 'word', 'phrase', 'nine'].includes(type)) {
      const image = await this.resource(data.imgs, signal),
        prompts = await Promise.all(
          ((data.ques || []) as string[]).map((q) => this.resource(q, signal)),
        )
      if (type !== 'nine')
        return {
          kind: 'click',
          image,
          prompts,
          style: type === 'word' ? 'text' : type === 'phrase' ? 'phrase' : 'symbols',
        }
      const { width, height } = await sharp(image).metadata()
      if (
        !width ||
        !height ||
        !Number.isInteger(data.nine_nums) ||
        data.nine_nums < 1 ||
        data.nine_nums > 9
      )
        throw new CaptchaError('invalid_grid')
      const cells: Buffer[] = []
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++) {
          const left = Math.trunc((c * width) / 3),
            top = Math.trunc((r * height) / 3)
          cells.push(
            await sharp(image)
              .extract({
                left,
                top,
                width: Math.trunc(((c + 1) * width) / 3) - left,
                height: Math.trunc(((r + 1) * height) / 3) - top,
              })
              .png()
              .toBuffer(),
          )
        }
      return { kind: 'grid', cells, prompts, count: data.nine_nums }
    }
    throw new CaptchaError('unsupported_puzzle', `Unsupported puzzle: ${type}`)
  }
  private answer(type: string, answer: Answer): { track?: Track; [key: string]: unknown } {
    if (type === 'ai' && answer.kind === 'silent') return {}
    if (type === 'slide' && answer.kind === 'slide')
      return {
        setLeft: answer.offset,
        userresponse: answer.offset / 1.0059466666666665 + 2,
        ...slideTrack(answer.offset),
      }
    if (type === 'nine' && answer.kind === 'grid')
      return {
        userresponse: answer.indices.map((i) => [Math.floor(i / 3) + 1, (i % 3) + 1]),
        ...gridTrack(answer.indices),
      }
    if (['icon', 'word', 'phrase'].includes(type) && answer.kind === 'points')
      return {
        userresponse: answer.points.map(([x, y]) => [Math.round(x * 10000), Math.round(y * 10000)]),
        ...clickTrack(answer.points),
      }
    if (['match', 'winlinze'].includes(type) && answer.kind === 'board')
      return { userresponse: answer.cells, ...boardTrack(answer.cells, type === 'winlinze') }
    if (['svg_seed', 'svg_icon'].includes(type) && answer.kind === 'svg') {
      const passtime = integer(answer.start + 50, answer.end - 50)
      return {
        userresponse: answer.cell,
        passtime,
        track: svgTrack(answer.cell, answer.columns, passtime),
      }
    }
    if (type === 'voice' && answer.kind === 'text')
      return { userresponse: answer.text, passtime: integer(20000, 30000) }
    throw new CaptchaError('answer_type_mismatch')
  }
}
