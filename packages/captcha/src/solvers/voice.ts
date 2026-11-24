// Port of wulu's pretrained offline MFCC digit recognizer (no retraining).
import FFT from 'fft.js'
import { MPEGDecoder } from 'mpg123-decoder'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Puzzle, Solver, Answer } from '../domain/puzzle.ts'
import { rootPath } from '../infrastructure/paths.ts'
const f32 = Math.fround
const sampleRate = 16000,
  fftSize = 2048,
  hop = 512,
  filters = 128,
  coefficients = 13
const window = Float32Array.from(
  { length: fftSize },
  (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1)),
)
const fft = new FFT(fftSize)
const bins = Array.from({ length: filters + 2 }, (_, i) =>
  Math.floor(
    ((fftSize + 1) *
      (700 *
        (10 ** ((2595 * Math.log10(1 + sampleRate / 2 / 700) * i) / (filters + 1) / 2595) - 1))) /
      sampleRate,
  ),
)
const mel = Array.from({ length: filters }, (_, i) =>
  Float32Array.from({ length: fftSize / 2 + 1 }, (_, j) =>
    j >= bins[i]! && j < bins[i + 1]!
      ? (j - bins[i]!) / (bins[i + 1]! - bins[i]!)
      : j >= bins[i + 1]! && j < bins[i + 2]!
        ? (bins[i + 2]! - j) / (bins[i + 2]! - bins[i + 1]!)
        : 0,
  ),
)
const dct = Array.from({ length: coefficients }, (_, k) =>
  Float32Array.from(
    { length: filters },
    (_, n) =>
      (Math.cos((Math.PI * k * (2 * n + 1)) / (2 * filters)) * Math.sqrt(2 / filters)) /
      (k === 0 ? Math.sqrt(2) : 1),
  ),
)
export function splitSpeech(audio: Float32Array): Float32Array[] {
  if (!audio.length) return []
  const frameSize = 2048,
    step = 160,
    frameCount = 1 + Math.floor(audio.length / step),
    energies: number[] = []
  for (let frame = 0; frame < frameCount; frame++) {
    let power = 0
    for (let i = 0; i < frameSize; i++) {
      const value = audio[frame * step + i - frameSize / 2]! || 0
      power += value * value
    }
    energies.push(20 * Math.log10(Math.max(1e-10, Math.sqrt(power / frameSize))))
  }
  const threshold = Math.max(...energies) - 35,
    starts: number[] = [],
    ends: number[] = []
  let previous = false
  for (let i = 0; i <= energies.length; i++) {
    const speech = i < energies.length && energies[i]! > threshold
    if (speech && !previous) starts.push(i * step)
    if (!speech && previous) ends.push(i * step)
    previous = speech
  }
  const spans: [number, number][] = []
  for (let i = 0; i < starts.length; i++) {
    if (spans.length && starts[i]! - ends[i - 1]! < sampleRate * 0.18) spans.at(-1)![1] = ends[i]!
    else spans.push([starts[i]!, ends[i]!])
  }
  return spans
    .filter(([a, b]) => b - a >= sampleRate * 0.05)
    .map(([a, b]) => audio.slice(a, b))
    .filter(
      (segment) => Math.sqrt(segment.reduce((sum, x) => sum + x * x, 0) / segment.length) >= 0.02,
    )
}
function delta(matrix: Float32Array[]): Float32Array[] {
  return matrix.map((row) =>
    Float32Array.from(row, (_, t) => {
      let value = 0
      for (let i = 1; i <= 4; i++)
        value = f32(
          value + f32(i * f32(row[Math.min(row.length - 1, t + i)]! - row[Math.max(0, t - i)]!)),
        )
      return value / 60
    }),
  )
}
export function voiceFeature(audio: Float32Array): number[] {
  if (audio.length < 2) return Array(39).fill(0)
  const frames = 1 + Math.floor(audio.length / hop),
    matrix = Array.from({ length: coefficients }, () => new Float32Array(frames)),
    input = new Float64Array(fftSize),
    spectrum = fft.createComplexArray()
  const reflected = (index: number): number => {
    const period = 2 * (audio.length - 1)
    let i = ((index % period) + period) % period
    if (i >= audio.length) i = period - i
    return audio[i]!
  }
  for (let frame = 0; frame < frames; frame++) {
    for (let i = 0; i < fftSize; i++)
      input[i] = f32(reflected(frame * hop + i - fftSize / 2) * window[i]!)
    fft.realTransform(spectrum, input)
    const power = Float32Array.from({ length: fftSize / 2 + 1 }, (_, i) => {
      const real = f32(spectrum[2 * i]!),
        imaginary = f32(spectrum[2 * i + 1]!)
      return real * real + imaginary * imaginary
    })
    const logs = mel.map((weights) => {
      let sum = 0
      for (let i = 0; i < weights.length; i++) sum += weights[i]! * power[i]!
      return f32(10 * Math.log10(Math.max(1e-10, sum)))
    })
    for (let k = 0; k < coefficients; k++) {
      let value = 0
      for (let i = 0; i < filters; i++) value += dct[k]![i]! * logs[i]!
      matrix[k]![frame] = value
    }
  }
  const first = delta(matrix),
    second = delta(first)
  return [...matrix, ...first, ...second].map((row) =>
    f32(row.reduce((sum, value) => sum + value, 0) / row.length),
  )
}
interface Templates {
  y: number[]
  langs: string[]
  sr: number
  [key: string]: unknown
}
const templates = new Map<string, Promise<Templates>>()
export class VoiceSolver implements Solver {
  readonly id = 'voice.mfcc'
  readonly kinds = ['voice'] as const
  supports(p: Puzzle): boolean {
    return p.kind === 'voice'
  }
  async solve(puzzle: Puzzle): Promise<Answer> {
    if (puzzle.kind !== 'voice' || !/^[\w-]+$/.test(puzzle.templateVersion))
      throw new Error('Invalid voice template')
    const decoder = new MPEGDecoder()
    await decoder.ready
    let audio: Float32Array
    try {
      const decoded = decoder.decode(puzzle.audio)
      if (!decoded.samplesDecoded || decoded.errors.length) throw new Error('Voice decoding failed')
      const length = Math.floor((decoded.samplesDecoded * sampleRate) / decoded.sampleRate)
      audio = new Float32Array(length)
      for (let i = 0; i < length; i++) {
        const position = (i * decoded.sampleRate) / sampleRate,
          index = Math.floor(position),
          fraction = position - index
        audio[i] =
          decoded.channelData.reduce(
            (sum, channel) =>
              sum +
              (channel[index]! || 0) * (1 - fraction) +
              (channel[Math.min(index + 1, channel.length - 1)]! || 0) * fraction,
            0,
          ) / decoded.channelData.length
      }
    } finally {
      decoder.free()
    }
    const segments = splitSpeech(audio)
    if (segments.length !== 7)
      throw new Error(`Expected seven voice segments, got ${segments.length}`)
    if (!templates.has(puzzle.templateVersion))
      templates.set(
        puzzle.templateVersion,
        fs
          .readFile(path.join(rootPath, `resources/${puzzle.templateVersion}-voice.json`), 'utf8')
          .then((text) => JSON.parse(text) as Templates),
      )
    const data = await templates.get(puzzle.templateVersion)!,
      distance = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + (x - b[i]!) ** 2, 0)
    let language = puzzle.language
    if (!language) {
      const prompt = voiceFeature(segments[0]!)
      language = ['zho', 'eng'].sort(
        (a, b) =>
          distance(prompt, data[`prompt_${a}`]! as number[]) -
          distance(prompt, data[`prompt_${b}`]! as number[]),
      )[0]!
    }
    const centroids = data[`X_${language}`]! as number[][]
    if (!Array.isArray(centroids)) throw new Error(`Unsupported voice language: ${language}`)
    const text = segments
      .slice(1)
      .map((segment) => {
        const feature = voiceFeature(segment),
          scores = centroids.map((centroid) => distance(feature, centroid))
        return data.y[scores.indexOf(Math.min(...scores))]!
      })
      .join('')
    return { kind: 'text', text }
  }
}
