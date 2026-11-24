// Port/adaptation of PyPasser keyring.py (MIT, Copyright 2021 xHossein).
// Only parses data literals. Downloaded widget JavaScript is never executed.
import crypto from 'node:crypto'
export function extractModulus(script: string): string {
  const blob = script.match(/decodeURI\("((?:[^"\\]|\\.)*)"\)/)?.[1],
    key = script.match(/\}\}\("(.+?)"\)\}/)?.[1]
  if (!blob || !key) throw new Error('Widget has no recognized key table')
  const raw = decodeURIComponent(blob),
    bytes = Buffer.from(raw, 'latin1'),
    keyBytes = Buffer.from(key, 'latin1')
  for (let i = 0; i < bytes.length; i++) bytes[i] = bytes[i]! ^ keyBytes[i % keyBytes.length]!
  const candidates = bytes.toString('latin1').match(/[0-9a-fA-F]{200,}/g) || []
  const modulus = candidates.sort((a, b) => b.length - a.length)[0]!
  if (!modulus || modulus.length > 1024 || modulus.length % 2)
    throw new Error('Widget RSA modulus not found')
  return modulus.replace(/^00/, '')
}
export class Keyring {
  private readonly keys = new Map<string, crypto.KeyObject>()
  get(build: string): crypto.KeyObject | undefined {
    return this.keys.get(build)
  }
  recover(build: string, script: string): void {
    const hex = extractModulus(script)
    this.keys.set(
      build,
      crypto.createPublicKey({
        format: 'jwk',
        key: { kty: 'RSA', n: Buffer.from(hex, 'hex').toString('base64url'), e: 'AQAB' },
      }),
    )
  }
}
