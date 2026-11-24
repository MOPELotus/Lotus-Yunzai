import cvModule from '@techstark/opencv-js'
import sharp from 'sharp'
export const vision = async () => await cvModule
export async function grayImage(bytes: Uint8Array, alpha: 'white' | 'zero' = 'white') {
  const cv = await vision()
  const { data, info } = await sharp(Buffer.from(bytes))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const rgba = cv.matFromArray(info.height, info.width, cv.CV_8UC4, data),
    gray = new cv.Mat()
  try {
    if (alpha === 'white')
      for (let i = 0; i < info.width * info.height; i++) {
        const a = data[i * 4 + 3]! / 255
        for (let c = 0; c < 3; c++)
          rgba.data[i * 4 + c] = Math.round(data[i * 4 + c]! * a + 255 * (1 - a))
      }
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY)
    if (alpha === 'zero')
      for (let i = 0; i < info.width * info.height; i++) if (data[i * 4 + 3]! === 0) gray.data[i] = 0
    return gray
  } catch (error) {
    gray.delete()
    throw error
  } finally {
    rgba.delete()
  }
}

// OpenCV.js exports a one-argument overload absent from its C++-derived types.
export function extrema(cv: typeof cvModule, mat: InstanceType<typeof cvModule.Mat>) {
  return (
    cv.minMaxLoc as unknown as (
      source: InstanceType<typeof cvModule.Mat>,
    ) => ReturnType<typeof cvModule.minMaxLoc>
  )(mat)
}
