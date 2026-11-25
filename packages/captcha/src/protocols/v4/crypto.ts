// Port of wulu007/geetest-bypass crypto/parser; MIT notices retained in vendor.
import crypto from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { sm2, sm4 } from 'sm-crypto'
const modulus =
  '00C1E3934D1614465B33053E7F48EE4EC87B14B95EF88947713D25EECBFF7E74C7977D02DC1D9451F79DD5D1C10C29ACB6A9B4D6FB7D0A0279B6719E1772565F09AF627715919221AEF91899CAE08C0D686D748B20A3603BE2318CA6BC2B59706592A9219D0BF05C9F65023A21D2330807252AE0066D59CEEFA5F2748EA80BAB81'
const rsa = crypto.createPublicKey({
  key: {
    kty: 'RSA',
    n: Buffer.from(modulus.replace(/^00/, ''), 'hex').toString('base64url'),
    e: 'AQAB',
  },
  format: 'jwk',
})
const sm2Public =
  '049a4ea935b2576f37516d9b29cd8d8cc9bffe548ba6853253ba20f4ba44fba8c9e97a398882769aa0dd1e3e1b5601429287303880ca17bd244ed73bf702a68fc7'
export function encryptPayload(
  payload: string,
  mode: number,
  rsaKey: crypto.KeyObject = rsa,
): string {
  if (mode === 0)
    return Buffer.from(payload)
      .toString('base64url')
      .padEnd(Math.ceil(Buffer.byteLength(payload) / 3) * 4, '=')
  if (mode !== 1 && mode !== 2) throw new Error(`Unsupported encryption mode: ${mode}`)
  const key = Buffer.from(crypto.randomBytes(8).toString('hex'))
  // Bun's node:crypto does not implement SM4. Keep the protocol's ASCII key/IV
  // bytes and PKCS#7 padding when using the existing portable implementation.
  const iv = Buffer.from('0000000000000000')
  let encrypted: string
  if (mode === 2) {
    encrypted = sm4.encrypt([...Buffer.from(payload)], [...key], {
      mode: 'cbc', iv: [...iv], padding: 'pkcs#7',
    })
  } else {
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv)
    encrypted = Buffer.concat([cipher.update(payload), cipher.final()]).toString('hex')
  }
  const wrapped =
    mode === 1
      ? crypto
          .publicEncrypt({ key: rsaKey, padding: crypto.constants.RSA_PKCS1_PADDING }, key)
          .toString('hex')
      : sm2.doEncrypt([...key], sm2Public, 0)
  return encrypted + wrapped
}
export interface PowDetail {
  version?: string
  bits?: number
  hashfunc?: string
  datetime?: string
  extra?: string
}
export async function proofOfWork(
  lot: string,
  captchaId: string,
  detail: PowDetail,
  signal: AbortSignal,
) {
  const { version = '1', bits = 10, hashfunc = 'md5', datetime = '', extra = '' } = detail
  if (
    !['md5', 'sha1', 'sha256'].includes(hashfunc) ||
    !Number.isInteger(bits) ||
    bits < 0 ||
    bits > 28
  )
    throw new Error('Invalid PoW parameters')
  const prefix = '0'.repeat(Math.floor(bits / 4)),
    threshold = ['f', '7', '3', '1'][bits % 4]!
  for (let attempt = 0; ; attempt++) {
    if (attempt % 1024 === 0) {
      signal.throwIfAborted()
      await setImmediate()
    }
    const message = `${version}|${bits}|${hashfunc}|${datetime}|${captchaId}|${lot}|${extra}|${crypto.randomUUID().replaceAll('-', '')}`
    const hash = crypto.createHash(hashfunc).update(message).digest('hex')
    if (hash.startsWith(prefix) && hash[prefix.length]! <= threshold)
      return { pow_msg: message, pow_sign: hash }
  }
}
export function lotFields(
  keyPattern: string,
  valuePattern: string,
  lot: string,
): Record<string, unknown> {
  const extract = (pattern: string) =>
    pattern
      .split('+.+')
      .map((group) =>
        group
          .split('+')
          .map((part) => {
            const match = part.match(/\[(-?\d+)(?::(-?\d+))?\]/)
            if (!match) throw new Error('Invalid lot pattern')
            const start = Number(match[1]!),
              end = match[2]! === undefined ? start + 1 : Number(match[2]!) + 1
            return lot.slice(start, end)
          })
          .join(''),
      )
      .join('.')
  const keys = extract(keyPattern).split('.'),
    result: Record<string, unknown> = {}
  let current = result
  for (const key of keys.slice(0, -1)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid lot key')
    current[key] = {}
    current = current[key]! as Record<string, unknown>
  }
  current[keys.at(-1)!] = extract(valuePattern)
  return result
}
export const trackSignature = (lot: string, track: string) =>
  crypto.createHmac('sha256', lot).update(track).digest('hex')
