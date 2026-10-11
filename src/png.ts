// png.ts: an RGB image written as a PNG, with node:zlib and nothing else. The
// render tool needs one encoder for one image type (8-bit truecolor, no
// alpha, no interlace), and that is forty lines, not a dependency an agent
// has to install (agents plan A3; arkinox, 2026-10-11).

import { deflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The CRC-32 table of the PNG spec (ISO 3309), built once. zlib.crc32 is newer than Node 22.0. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  out.set(data, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** `rgb` is width * height * 3 bytes, rows top to bottom. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  if (rgb.length !== width * height * 3) throw new Error(`encodePng: expected ${width * height * 3} bytes, got ${rgb.length}`)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // color type: truecolor
  // Compression, filter and interlace methods stay 0.
  // Every row is filtered with Sub (type 1): a render is mostly runs of one
  // color, which Sub turns into runs of zero for deflate.
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1)
    raw[row] = 1
    const src = y * stride
    for (let i = 0; i < stride; i++) raw[row + 1 + i] = (rgb[src + i] - (i >= 3 ? rgb[src + i - 3] : 0)) & 0xff
  }
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))])
}
