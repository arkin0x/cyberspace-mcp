// render.test.ts: the render tool's picture (agents plan A3; arkinox,
// 2026-10-11). A cube comes out as a PNG of the size asked for, with its
// faces where they should be; a face's back is drawn darker and never culled
// (DECK-0003 1.4); sizes and views out of range are refused in words; a
// typical shard draws in well under a second; and the MCP result carries the
// picture as an image content block beside its caption. No network.

import { inflateSync } from 'node:zlib'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import type { Agent } from '../src/agent.js'
import { renderShard } from '../src/render.js'
import { createServer } from '../src/server.js'
import { validateSnoPayload } from '../src/sno.js'

/** Read back a PNG this encoder wrote: 8-bit RGB, rows filtered None or Sub. */
function decode(png: Buffer): { width: number; height: number; at: (x: number, y: number) => [number, number, number] } {
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

const BACKGROUND = [10, 12, 18]
const brightness = (c: number[]) => c[0] + c[1] + c[2]

/** A 2-unit cube centered on the origin, every face wound outward, palette 7 (cyan) all round. */
const CUBE = {
  v: 2, name: 'cube', unit: 0, mode: 'solid',
  vertices: [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
  colors: [7, 7, 7, 7, 7, 7, 7, 7],
  faces: [[4, 5, 6], [4, 6, 7], [1, 0, 3], [1, 3, 2], [5, 1, 2], [5, 2, 6], [0, 4, 7], [0, 7, 3], [3, 7, 6], [3, 6, 2], [0, 1, 5], [0, 5, 4]],
}

/** Two plates in the z = 0 plane: the left wound counter-clockwise seen from +Z (front toward +Z), the right clockwise. */
const PLATES = {
  v: 2, name: 'plates', unit: 0, mode: 'solid',
  vertices: [[-5, 0, 0], [-1, 0, 0], [-1, 4, 0], [-5, 4, 0], [1, 0, 0], [5, 0, 0], [5, 4, 0], [1, 4, 0]],
  colors: [7, 7, 7, 7, 7, 7, 7, 7],
  faces: [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6]],
}

function shardOf(payload: unknown) {
  const v = validateSnoPayload(payload)
  if (!v.ok) throw new Error(v.errors.join(' '))
  return v.shard
}

describe('render', () => {
  it('draws a cube to a PNG of the size asked for, with its faces where they should be', () => {
    const r = renderShard(shardOf(CUBE), { view: 'front', size: 256 })
    const img = decode(r.png)
    expect(img.width).toBe(256)
    expect(img.height).toBe(256)
    // The middle of the frame is the cube's front face: cyan, not background.
    const mid = img.at(128, 128)
    expect(mid).not.toEqual(BACKGROUND)
    expect(mid[2]).toBeGreaterThan(mid[0] + 60)
    // A corner of the frame is background.
    expect(img.at(2, 2)).toEqual(BACKGROUND)
    expect(r.vertices).toBe(8)
    expect(r.faces).toBe(12)
    expect(r.backFacing).toBe(0)
    expect(r.bounds).toEqual({ min: [-1, -1, -1], max: [1, 1, 1] })
    expect(r.caption).toMatch(/^"cube": 8 vertices, 12 faces, mode solid; bounds x -1\.\.1, y -1\.\.1, z -1\.\.1 units/)
    expect(r.caption).not.toMatch(/back/)
    // The default is the iso view at 512.
    const iso = renderShard(shardOf(CUBE))
    expect(decode(iso.png).width).toBe(512)
    expect(iso.view).toEqual({ name: 'iso', yaw: 45, pitch: 30 })
  })

  it('draws a face from behind darker, never culls it, and counts it in the caption (DECK-0003 1.4)', () => {
    const shard = shardOf(PLATES)
    const front = renderShard(shard, { view: 'front', size: 200 })
    const img = decode(front.png)
    // The plates sit left and right of the origin; sample the middle of each.
    const left = img.at(55, 90)
    const right = img.at(145, 90)
    expect(left).not.toEqual(BACKGROUND)
    expect(right).not.toEqual(BACKGROUND)
    expect(brightness(left)).toBeGreaterThan(brightness(right) * 1.8)
    expect(front.backFacing).toBe(2)
    expect(front.caption).toMatch(/2 faces show their back/)
    // A closed cube wound outward shows no back from any side, even where a
    // near face and a far one share their outline exactly in the picture.
    for (const view of ['iso', 'front', 'back', 'top', 'side'] as const) expect(renderShard(shardOf(CUBE), { view, size: 128 }).backFacing).toBe(0)
    // From behind, the other plate shows its back instead.
    const back = renderShard(shard, { view: 'back', size: 200 })
    const fromBehind = decode(back.png)
    expect(brightness(fromBehind.at(55, 90))).toBeGreaterThan(brightness(fromBehind.at(145, 90)) * 1.8)
    expect(back.backFacing).toBe(2)
  })

  it('draws points and lines modes too, and an object with no vertices as the floor alone', () => {
    for (const mode of ['points', 'lines']) {
      const r = renderShard(shardOf({ ...CUBE, mode }), { view: 'front', size: 128 })
      const img = decode(r.png)
      let lit = 0
      for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) if (img.at(x, y)[2] > 150) lit++
      expect(lit).toBeGreaterThan(20)
    }
    const empty = renderShard(shardOf({ v: 2, name: 'nothing', unit: 0, mode: 'solid', vertices: [], colors: [], faces: [] }), { size: 64 })
    expect(decode(empty.png).width).toBe(64)
    expect(empty.caption).toMatch(/no vertices/)
  })

  it('refuses a size or a view out of range in words, and keeps an author\'s name on one short line', () => {
    const named = renderShard(shardOf({ ...CUBE, name: `two\nlines${'x'.repeat(200)}` }), { size: 64 })
    expect(named.caption).not.toContain('\n')
    expect(named.caption).toMatch(/^"two\\nlinesx{55}": 8 vertices/)
    const shard = shardOf(CUBE)
    expect(() => renderShard(shard, { size: 2048 })).toThrow(/size must be a whole number of pixels from 64 to 1024/)
    expect(() => renderShard(shard, { size: 10.5 })).toThrow(/size must be/)
    expect(() => renderShard(shard, { pitch: 120 })).toThrow(/pitch must be/)
    expect(() => renderShard(shard, { view: 'under' as never })).toThrow(/view must be one of iso, front, back, top, side/)
  })

  it('draws a typical shard quickly', () => {
    // A 10 x 10 x 10 block of cubes' outer shell: 600 faces, more than most shards carry.
    const vertices: number[][] = []
    const faces: number[][] = []
    const n = 10
    const quad = (a: number[], b: number[], c: number[], d: number[]) => {
      const i = vertices.length
      vertices.push(a, b, c, d)
      faces.push([i, i + 1, i + 2], [i, i + 2, i + 3])
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        quad([i, j, n], [i + 1, j, n], [i + 1, j + 1, n], [i, j + 1, n])
        quad([i, j, 0], [i, j + 1, 0], [i + 1, j + 1, 0], [i + 1, j, 0])
        quad([n, i, j], [n, i + 1, j], [n, i + 1, j + 1], [n, i, j + 1])
      }
    }
    const shard = shardOf({ v: 2, name: 'block', unit: 0, mode: 'solid', vertices, colors: vertices.map((_, i) => i % 256), faces })
    renderShard(shard, { size: 512 }) // the first call warms the JIT
    const t0 = performance.now()
    const r = renderShard(shard, { size: 512 })
    expect(performance.now() - t0).toBeLessThan(1500)
    expect(r.faces).toBe(600)
  })

  it('comes back over MCP as an image content block and a caption', async () => {
    const shard = shardOf(CUBE)
    const stub = {
      render: async () => {
        const r = renderShard(shard, { size: 64 })
        return { text: r.caption, images: [{ data: r.png.toString('base64'), mimeType: 'image/png' }], data: { size: r.size } }
      },
    } as unknown as Agent
    const server = createServer(stub)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name)).toContain('render')
    const result = await client.callTool({ name: 'render', arguments: { object: CUBE, size: 64 } })
    const content = result.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>
    expect(content[0].type).toBe('image')
    expect(content[0].mimeType).toBe('image/png')
    expect(decode(Buffer.from(content[0].data!, 'base64')).width).toBe(64)
    expect(content[1].type).toBe('text')
    expect(content[1].text).toMatch(/^"cube": 8 vertices/)
    // Out of range is refused by the schema before the agent is asked.
    const big = await client.callTool({ name: 'render', arguments: { object: CUBE, size: 4096 } })
    expect(big.isError).toBe(true)
    await client.close()
  })
})
