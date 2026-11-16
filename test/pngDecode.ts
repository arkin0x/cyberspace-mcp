// pngDecode.ts: reading back a PNG this server's encoder wrote (8-bit RGB,
// rows filtered None or Sub), for tests that look at pictures.

import { inflateSync } from 'node:zlib'
import { expect } from 'vitest'

/** Read back a PNG this encoder wrote: 8-bit RGB, rows filtered None or Sub. */
export function decode(png: Buffer): { width: number; height: number; at: (x: number, y: number) => [number, number, number] } {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  let pos = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  while (pos < png.length) {
    const len = png.readUInt32BE(pos)
    const type = png.toString('ascii', pos + 4, pos + 8)
    const data = png.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); expect(data[8]).toBe(8); expect(data[9]).toBe(2) }
    if (type === 'IDAT') idat.push(data)
    pos += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 3
  const rgb = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    expect([0, 1]).toContain(filter)
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i]
      rgb[y * stride + i] = filter === 1 && i >= 3 ? (v + rgb[y * stride + i - 3]) & 0xff : v
    }
  }
  return { width, height, at: (x, y) => [rgb[(y * width + x) * 3], rgb[(y * width + x) * 3 + 1], rgb[(y * width + x) * 3 + 2]] }
}

/** Where the eye's magenta ring is drawn (render.ts): how many pixels, and their middle. */
export function magentaRing(png: Buffer): { n: number; x: number; y: number } {
  return centroid(png, ([r, g, b]) => r > 200 && g < 110 && b > 180)
}

/** The pixels a test picks out, and their middle. */
export function centroid(png: Buffer, test: (c: [number, number, number]) => boolean): { n: number; x: number; y: number } {
  const img = decode(png)
  let n = 0, sx = 0, sy = 0
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (test(img.at(x, y))) { n++; sx += x; sy += y }
  return { n, x: sx / Math.max(n, 1), y: sy / Math.max(n, 1) }
}
