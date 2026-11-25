import { afterEach, expect, spyOn, test } from 'bun:test'
import crypto from 'node:crypto'
import { encryptPayload } from '../packages/captcha/src/protocols/v4/crypto.ts'

afterEach(() => { cryptoRandom?.mockRestore() })
let cryptoRandom: ReturnType<typeof spyOn> | undefined

// Independently generated with Node/OpenSSL SM4-CBC, the ASCII key
// 0123456789abcdef, ASCII IV 0000000000000000 and PKCS#7 padding.
test('V4 pt=2 matches OpenSSL SM4 wire bytes in Bun', () => {
  cryptoRandom = spyOn(crypto, 'randomBytes').mockImplementation(((size: number) => {
    expect(size).toBe(8)
    return Buffer.from('0123456789abcdef', 'hex')
  }) as typeof crypto.randomBytes)
  const vectors = [
    ['', '1799d4bb520210d6c9b0b557e3e50b6d'],
    ['0123456789abcdef', '17eb982fad4defa2c429a3d4c3503b751be0c7019ea07667e52c46ad65a2c00a'],
    ['验证码🙂', 'a3e1f8ea4e9ccf273bc052a24c9833f5'],
    ['x'.repeat(33), '998083532a181a8d85f636dde5491e93e665e76ff2732bfda7fab4eebb56cfe3dc5462e25580ac534481f6351718fb57'],
  ] as const
  for (const [plain, encrypted] of vectors) {
    const wire = encryptPayload(plain, 2)
    expect(wire.slice(0, encrypted.length)).toBe(encrypted)
    // SM2 C1C2C3 wraps the 16 ASCII key bytes: 64 + 16 + 32 bytes.
    expect(wire.slice(encrypted.length)).toMatch(/^[0-9a-f]{224}$/i)
  }
})

test('V4 pt=1 decrypts to the original UTF-8 payload', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 })
  const plain = JSON.stringify({ text: '验证码🙂' })
  const wire = Buffer.from(encryptPayload(plain, 1, publicKey), 'hex')
  // Decode PKCS#1 v1.5 manually after raw RSA: modern OpenSSL disables
  // privateDecrypt's legacy PKCS#1 padding on some builds.
  const wrapped = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_NO_PADDING }, wire.subarray(-128))
  expect([...wrapped.subarray(0, 2)]).toEqual([0, 2])
  const separator = wrapped.indexOf(0, 2)
  expect(separator).toBeGreaterThanOrEqual(10)
  const key = wrapped.subarray(separator + 1)
  expect(key.length).toBe(16)
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.from('0000000000000000'))
  expect(Buffer.concat([decipher.update(wire.subarray(0, -128)), decipher.final()]).toString()).toBe(plain)
})

test('V4 pt=0 preserves UTF-8 and rejects unsupported modes', () => {
  const plain = JSON.stringify({ text: '验证码🙂' })
  expect(Buffer.from(encryptPayload(plain, 0), 'base64url').toString()).toBe(plain)
  expect(() => encryptPayload(plain, 3)).toThrow('Unsupported encryption mode')
})
