// render.ts: an SNO object drawn to a PNG on the CPU, so an agent can see
// what it built before it places it (agents plan A3, ruling D12 B; arkinox,
// 2026-10-11). The ruling allowed a headless browser; a software rasterizer
// was chosen instead because an SNO is a few hundred flat triangles, which a
// z-buffer draws in milliseconds, and because an agent installs this server
// with npm and should not have to download a browser to look at a cube.
//
// What it draws follows the workshop bench in ONOSENDAI (src/scene/ShardMesh
// and src/workshop/Bench): faces lit flat by an ambient light and two
// directional ones, each face's front as its winding gives it (DECK-0003
// 1.4: counter-clockwise seen from the front, in the frame of section 2), and
// its back drawn too, as the other side of the same face and darker by the
// bench's multiplier, so a face wound the wrong way is plain to see. Nothing
// is culled: 1.4 forbids it, because an open shell would vanish from behind.
// Points and lines modes draw as the bench does: every vertex a dot, and in
// lines mode every face edge once (or, with no faces, one line through the
// points in order). A floor grid of whole units and the three axes from the
// origin say how big it is. The view is orthographic, so a front, top or side
// view measures true.
//
// Placed parts (DECK-0003 1.10) are not fetched or drawn here; the caption
// says how many were left out.

import { createHash } from 'node:crypto'
import { faceEdges } from 'sno-core/outline'
import { formatCellSize } from 'sno-core/scale'
import { expandFaceColors, flatten, type ShardModel } from 'sno-core/shards'
import { encodePng } from './png.js'

export const RENDER_DEFAULT_SIZE = 512
export const RENDER_MIN_SIZE = 64
export const RENDER_MAX_SIZE = 1024

/** More faces than any object a relay will carry; past it a picture is refused rather than slow. */
export const RENDER_MAX_FACES = 100_000

/**
 * The hex handle find and look print for an object, and render takes: its
 * event id when it has one of its own, or for a public object placed by
 * reference (whose entry id is the bag's lookup id, a slash and the address)
 * the SHA-256 of that entry id, so two references in one bag never share a
 * prefix (arkinox, 2026-10-11).
 */
export function objectHandle(entryId: string): string {
  return /^[0-9a-f]{64}$/.test(entryId) ? entryId : createHash('sha256').update(entryId).digest('hex')
}

export type NamedView = 'iso' | 'front' | 'back' | 'top' | 'side'

/** Each named view as a yaw (degrees about +Y, 0 looking from +Z) and a pitch (degrees above the horizon). */
export const VIEWS: Record<NamedView, { yaw: number; pitch: number }> = {
  iso: { yaw: 45, pitch: 30 },
  front: { yaw: 0, pitch: 0 },
  back: { yaw: 180, pitch: 0 },
  top: { yaw: 0, pitch: 90 },
  side: { yaw: 90, pitch: 0 },
}

export interface RenderOptions {
  view?: NamedView
  /** Overrides the named view's yaw. */
  yaw?: number
  /** Overrides the named view's pitch; -90 to 90. */
  pitch?: number
  /** Pixels on a side; RENDER_MIN_SIZE to RENDER_MAX_SIZE. */
  size?: number
}

export interface Rendered {
  png: Buffer
  size: number
  view: { name: NamedView | 'custom'; yaw: number; pitch: number }
  vertices: number
  faces: number
  /** In model units, the frame of DECK-0003 section 2; null for an object with no vertices. */
  bounds: { min: [number, number, number]; max: [number, number, number] } | null
  /** Faces whose back is what this view shows of them, among the faces that show at all. */
  backFacing: number
  /** Placed parts (DECK-0003 1.10) not drawn. */
  partsNotDrawn: number
  gridY: number
  ms: number
  caption: string
}

// The bench's two lights from the same directions (onosendai-v2 src/workshop/Bench.tsx) and its inside
// multiplier (#6a6a6a, ShardMesh.tsx). The intensities are the bench's in proportion but scaled so the
// brightest face is its own color: at the bench's 0.4 + 0.9 + 0.6 a saturated color clips, and two faces
// of one red at different angles come out the same red, which is the one thing this picture must not do.
const AMBIENT = 0.35
const LIGHTS: Array<{ dir: [number, number, number]; intensity: number }> = [
  { dir: norm([8, 12, 6]), intensity: 0.65 * 0.6 },
  { dir: norm([-9, 2, -3]), intensity: 0.65 * 0.4 },
]
const BACK = 0x6a / 0xff
const BACKGROUND: [number, number, number] = [10, 12, 18]
const GRID: [number, number, number] = [0.13, 0.22, 0.28]
const AXIS_X: [number, number, number] = [0.85, 0.25, 0.25]
const AXIS_Y: [number, number, number] = [0.3, 0.8, 0.35]
const AXIS_Z: [number, number, number] = [0.3, 0.5, 0.95]
/** Outlines darken the pixels where one face meets another at a crease, or meets nothing. */
const OUTLINE = 0.55
/** Supersampling per axis: drawn at twice the size and averaged down, so edges are smooth. */
const SS = 2
const MARGIN = 0.07
/** How far outside a triangle, in barycentric weight, a pixel center still counts as covered by it. */
const COVER_SLACK = 1e-7
/** At most this many grid lines a side, however wide the object. */
const MAX_GRID_LINES = 24

type V3 = [number, number, number]

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000)
}

/** The camera for a yaw and pitch: `d` points from the object toward the camera, `r` and `u` are the screen's right and up. */
function camera(yawDeg: number, pitchDeg: number): { d: V3; r: V3; u: V3 } {
  const yaw = (yawDeg * Math.PI) / 180
  const pitch = (pitchDeg * Math.PI) / 180
  const d: V3 = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)]
  // Right is the horizontal turned with the yaw, which stays defined looking straight down.
  const r: V3 = [Math.cos(yaw), 0, -Math.sin(yaw)]
  const u: V3 = [d[1] * r[2] - d[2] * r[1], d[2] * r[0] - d[0] * r[2], d[0] * r[1] - d[1] * r[0]]
  return { d, r, u }
}

/** The view a caller asked for, in plain numbers. Throws with the reason for a value out of range. */
export function resolveView(opts: RenderOptions): { name: NamedView | 'custom'; yaw: number; pitch: number; size: number } {
  const name = opts.view ?? 'iso'
  if (!(name in VIEWS)) throw new Error(`view must be one of ${Object.keys(VIEWS).join(', ')}; got ${JSON.stringify(name)}.`)
  const base = VIEWS[name]
  const yaw = opts.yaw ?? base.yaw
  const pitch = opts.pitch ?? base.pitch
  if (!Number.isFinite(yaw)) throw new Error('yaw must be a number of degrees.')
  if (!Number.isFinite(pitch) || pitch < -90 || pitch > 90) throw new Error('pitch must be a number of degrees from -90 to 90.')
  const size = opts.size ?? RENDER_DEFAULT_SIZE
  if (!Number.isInteger(size) || size < RENDER_MIN_SIZE || size > RENDER_MAX_SIZE) throw new Error(`size must be a whole number of pixels from ${RENDER_MIN_SIZE} to ${RENDER_MAX_SIZE}; got ${JSON.stringify(size)}.`)
  const custom = opts.yaw !== undefined || opts.pitch !== undefined
  return { name: custom ? 'custom' : name, yaw: ((yaw % 360) + 360) % 360, pitch, size }
}

/**
 * Draw a validated shard. The shard comes from sno-core's fromPayload (via
 * validateSnoPayload), so every index is in range; nothing here re-checks it.
 */
export function renderShard(shard: ShardModel, opts: RenderOptions = {}): Rendered {
  const t0 = performance.now()
  const view = resolveView(opts)
  if (shard.faces.length > RENDER_MAX_FACES || shard.vertices.length > RENDER_MAX_FACES) throw new Error(`The object has ${shard.vertices.length} vertices and ${shard.faces.length} faces; render draws at most ${RENDER_MAX_FACES} of each.`)
  const { d, r, u } = camera(view.yaw, view.pitch)
  const W = view.size * SS

  // A face with a color of its own gets three corners of its own (sno-core), so
  // the color is flat; lines mode draws the edges of the faces as authored.
  const solid = shard.mode === 'solid' ? expandFaceColors(shard) : shard
  const flat = flatten(solid)
  const P = flat.positions
  const C = flat.colors
  const nv = P.length / 3
  const faces = shard.mode === 'solid' ? solid.faces : []

  // Bounds of the object, in units, from the shard as authored.
  const authored = shard === solid ? flat : flatten(shard)
  let bounds: Rendered['bounds'] = null
  if (shard.vertices.length > 0) {
    const min: V3 = [Infinity, Infinity, Infinity]
    const max: V3 = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < authored.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], authored.positions[i + k])
        max[k] = Math.max(max[k], authored.positions[i + k])
      }
    }
    bounds = { min, max }
  }

  // The floor: whole units around the object, at y 0 unless the object reaches below it.
  const lo = bounds ? bounds.min : ([0, 0, 0] as V3)
  const hi = bounds ? bounds.max : ([0, 0, 0] as V3)
  const gridY = lo[1] < 0 ? Math.floor(lo[1]) : 0
  const gx0 = Math.min(0, Math.floor(lo[0]) - 1)
  const gx1 = Math.max(0, Math.ceil(hi[0]) + 1)
  const gz0 = Math.min(0, Math.floor(lo[2]) - 1)
  const gz1 = Math.max(0, Math.ceil(hi[2]) + 1)
  const step = Math.max(1, Math.ceil(Math.max(gx1 - gx0, gz1 - gz0) / MAX_GRID_LINES))
  const axisLen = Math.max(1, Math.min(gx1, gz1, Math.ceil(hi[1]) || 1))

  // Fit the object and its floor into the frame.
  const sx = (p: V3) => dot(p, r)
  const sy = (p: V3) => dot(p, u)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  const fit = (p: V3) => {
    const x = sx(p), y = sy(p)
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  for (const x of [gx0, gx1]) for (const z of [gz0, gz1]) fit([x, gridY, z])
  fit([0, axisLen, 0])
  for (let i = 0; i < nv; i++) fit([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]])
  const span = Math.max(maxX - minX, maxY - minY, 1e-9)
  const scale = (W * (1 - 2 * MARGIN)) / span
  const cx = W / 2 - ((minX + maxX) / 2) * scale
  const cy = W / 2 + ((minY + maxY) / 2) * scale
  // Depth bias for lines and points over faces, and for the floor under a face lying on it: a hair of the scene.
  let depthSpan = 0
  for (const x of [gx0, gx1]) for (const z of [gz0, gz1]) depthSpan = Math.max(depthSpan, Math.abs(dot([x, gridY, z], d)))
  for (let i = 0; i < nv; i++) depthSpan = Math.max(depthSpan, Math.abs(dot([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], d)))
  const bias = Math.max(depthSpan, 1) * 1e-4

  // Screen position and depth of every vertex (depth grows toward the camera).
  const X = new Float64Array(nv)
  const Y = new Float64Array(nv)
  const Z = new Float64Array(nv)
  for (let i = 0; i < nv; i++) {
    const p: V3 = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]
    X[i] = cx + sx(p) * scale
    Y[i] = cy - sy(p) * scale
    Z[i] = dot(p, d)
  }

  const frame = frameBuffers(W)
  const { depth, color, id, edge } = frame

  // ---- faces ---------------------------------------------------------------
  const normals = new Float32Array(faces.length * 3)
  const back = new Uint8Array(faces.length)
  for (let f = 0; f < faces.length; f++) {
    const [a, b, c] = faces[f]
    const pa: V3 = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]]
    const e1: V3 = [P[b * 3] - pa[0], P[b * 3 + 1] - pa[1], P[b * 3 + 2] - pa[2]]
    const e2: V3 = [P[c * 3] - pa[0], P[c * 3 + 1] - pa[1], P[c * 3 + 2] - pa[2]]
    // The front is the side (b - a) x (c - a) points to (DECK-0003 1.4).
    let n = norm([e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]])
    const isBack = dot(n, d) < 0
    if (isBack) n = [-n[0], -n[1], -n[2]]
    back[f] = isBack ? 1 : 0
    normals.set(n, f * 3)
    let shade = AMBIENT
    for (const l of LIGHTS) shade += l.intensity * Math.max(0, dot(n, l.dir))
    if (isBack) shade *= BACK
    rasterTriangle(frame, f, X[a], Y[a], Z[a], X[b], Y[b], Z[b], X[c], Y[c], Z[c], C, a, b, c, shade * 255)
  }

  outline(W, id, normals, back, color, edge)

  // ---- floor, axes, lines and points (after outlines: they are not faces) ----
  const lineHalf = (SS * Math.max(1, view.size / 512)) / 2
  function line3(p: V3, q: V3, cp: V3, cq: V3, half: number, zBias: number): void {
    const ax = cx + sx(p) * scale, ay = cy - sy(p) * scale, az = dot(p, d)
    const bx = cx + sx(q) * scale, by = cy - sy(q) * scale, bz = dot(q, d)
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))))
    const reach = Math.max(0, Math.ceil(half - 0.5))
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const x = Math.floor(ax + (bx - ax) * t), y = Math.floor(ay + (by - ay) * t)
      const z = az + (bz - az) * t + zBias
      for (let oy = -reach; oy <= reach; oy++) {
        for (let ox = -reach; ox <= reach; ox++) {
          const px = x + ox, py = y + oy
          if (px < 0 || py < 0 || px >= W || py >= W) continue
          const k = py * W + px
          if (z < depth[k]) continue
          depth[k] = z
          for (let ch = 0; ch < 3; ch++) color[k * 3 + ch] = (cp[ch] + (cq[ch] - cp[ch]) * t) * 255
        }
      }
    }
  }
  // The floor sits a hair behind anything at its own depth, so a face lying on it wins.
  for (let x = Math.ceil(gx0 / step) * step; x <= gx1; x += step) if (x !== 0) line3([x, gridY, gz0], [x, gridY, gz1], GRID, GRID, lineHalf / 2, -bias)
  for (let z = Math.ceil(gz0 / step) * step; z <= gz1; z += step) if (z !== 0) line3([gx0, gridY, z], [gx1, gridY, z], GRID, GRID, lineHalf / 2, -bias)
  line3([gx0, gridY, 0], [gx1, gridY, 0], GRID, GRID, lineHalf / 2, -bias)
  line3([0, gridY, gz0], [0, gridY, gz1], GRID, GRID, lineHalf / 2, -bias)
  // The axes from the origin, one unit or more: +X red, +Y green, +Z blue.
  line3([0, 0, 0], [axisLen, 0, 0], AXIS_X, AXIS_X, lineHalf, -bias / 2)
  line3([0, 0, 0], [0, axisLen, 0], AXIS_Y, AXIS_Y, lineHalf, -bias / 2)
  line3([0, 0, 0], [0, 0, axisLen], AXIS_Z, AXIS_Z, lineHalf, -bias / 2)

  const vc = (i: number): V3 => [C[i * 3], C[i * 3 + 1], C[i * 3 + 2]]
  const vp = (i: number): V3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]
  if (shard.mode === 'lines') {
    const edges = shard.faces.length > 0 ? faceEdges(shard.faces) : Array.from({ length: Math.max(0, nv - 1) }, (_, i) => [i, i + 1]).flat()
    for (let i = 0; i + 1 < edges.length; i += 2) line3(vp(edges[i]), vp(edges[i + 1]), vc(edges[i]), vc(edges[i + 1]), lineHalf, bias)
  }
  // Points mode draws every vertex as a dot; so do lines mode and a solid with no faces, as the bench does.
  if (shard.mode !== 'solid' || faces.length === 0) {
    const radius = SS * Math.max(1.5, view.size / 170)
    for (let i = 0; i < nv; i++) {
      const z = Z[i] + bias
      const rr = Math.ceil(radius)
      for (let oy = -rr; oy <= rr; oy++) {
        for (let ox = -rr; ox <= rr; ox++) {
          if (ox * ox + oy * oy > radius * radius) continue
          const px = Math.floor(X[i]) + ox, py = Math.floor(Y[i]) + oy
          if (px < 0 || py < 0 || px >= W || py >= W) continue
          const k = py * W + px
          if (z < depth[k]) continue
          depth[k] = z
          id[k] = -2
          for (let ch = 0; ch < 3; ch++) color[k * 3 + ch] = C[i * 3 + ch] * 255
        }
      }
    }
  }

  // Which faces show, and how many of those show their back. A face shows
  // when it covers at least one pixel of the picture, not a stray sample on
  // another face's silhouette.
  const shown = new Uint32Array(faces.length)
  for (let k = 0; k < W * W; k++) if (id[k] >= 0) shown[id[k]]++
  let backFacing = 0
  for (let f = 0; f < faces.length; f++) if (shown[f] >= SS * SS && back[f]) backFacing++

  const N = view.size
  const out = downsample(color, W, N)
  const png = encodePng(N, N, out)
  const ms = performance.now() - t0

  const partsNotDrawn = shard.parts?.length ?? 0
  const box = bounds
    ? `bounds x ${fmt(bounds.min[0])}..${fmt(bounds.max[0])}, y ${fmt(bounds.min[1])}..${fmt(bounds.max[1])}, z ${fmt(bounds.min[2])}..${fmt(bounds.max[2])} units (${fmt(bounds.max[0] - bounds.min[0])} x ${fmt(bounds.max[1] - bounds.min[1])} x ${fmt(bounds.max[2] - bounds.min[2])})`
    : 'no vertices'
  const viewWords = view.name === 'custom' ? `yaw ${fmt(view.yaw)}, pitch ${fmt(view.pitch)}` : `${view.name} view (yaw ${fmt(view.yaw)}, pitch ${fmt(view.pitch)})`
  const caption = [
    // The name is the author's text (sno-core keeps 64 characters of it): quoted as JSON so it stays on one line.
    `${JSON.stringify(shard.name)}: ${shard.vertices.length} vertices, ${shard.faces.length} faces, mode ${shard.mode}; ${box}; one unit is ${formatCellSize(shard.unit)} (2^${shard.unit} gibsons), one floor square is ${step} unit${step === 1 ? '' : 's'} at y ${gridY}; ${viewWords}, ${N}x${N}`,
    backFacing > 0 ? `; ${backFacing} face${backFacing === 1 ? ' shows its' : 's show their'} back (darker: wound clockwise from here; if that side is the outside, reverse the face's vertex order)` : '',
    partsNotDrawn > 0 ? `; ${partsNotDrawn} placed part${partsNotDrawn === 1 ? '' : 's'} not drawn` : '',
    `; drawn in ${Math.round(ms)} ms.`,
  ].join('')
  return { png, size: N, view: { name: view.name, yaw: view.yaw, pitch: view.pitch }, vertices: shard.vertices.length, faces: shard.faces.length, bounds, backFacing, partsNotDrawn, gridY, ms, caption }
}

interface Buffers {
  W: number
  depth: Float32Array
  /** Which face covers each pixel: -1 nothing, -2 a line or point. */
  id: Int32Array
  color: Uint8ClampedArray
  edge: Uint8Array
}

/**
 * The frame's buffers, kept between calls and cleared for each: at the largest
 * size they are about 40 MB, and allocating that afresh for every picture cost
 * more than drawing it. renderShard is synchronous, so one set is never shared
 * by two pictures at once.
 */
let kept: Buffers | null = null

function frameBuffers(W: number): Buffers {
  if (!kept || kept.W !== W) kept = { W, depth: new Float32Array(W * W), id: new Int32Array(W * W), color: new Uint8ClampedArray(W * W * 3), edge: new Uint8Array(W * W) }
  kept.depth.fill(-Infinity)
  kept.id.fill(-1)
  kept.edge.fill(0)
  const color = kept.color
  color.set(BACKGROUND, 0)
  for (let filled = 3; filled < color.length; filled *= 2) color.copyWithin(filled, 0, Math.min(filled, color.length - filled))
  return kept
}

/**
 * One triangle into the frame, z-buffered: colors interpolate across it
 * (DECK-0003 section 4), then take the face's light. A top-level function
 * with plain numbers, so V8 optimizes it whatever the caller does.
 */
function rasterTriangle(fr: Buffers, f: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, C: Float32Array, a: number, b: number, c: number, light: number): void {
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
  if (Math.abs(area) < 1e-12) return
  const { W, depth, id, color } = fr
  const minPx = Math.max(0, Math.floor(Math.min(x0, x1, x2)))
  const maxPx = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)))
  const minPy = Math.max(0, Math.floor(Math.min(y0, y1, y2)))
  const maxPy = Math.min(W - 1, Math.ceil(Math.max(y0, y1, y2)))
  if (minPx > maxPx || minPy > maxPy) return
  const inv = 1 / area
  // w0 = ((x1 - x)(y2 - y) - (x2 - x)(y1 - y)) / area, and likewise; each is linear in x and y.
  const a0x = (y1 - y2) * inv, a0y = (x2 - x1) * inv, a0c = (x1 * y2 - x2 * y1) * inv
  const a1x = (y2 - y0) * inv, a1y = (x0 - x2) * inv, a1c = (x2 * y0 - x0 * y2) * inv
  const ra = C[a * 3] * light, ga = C[a * 3 + 1] * light, ba = C[a * 3 + 2] * light
  const rb = C[b * 3] * light, gb = C[b * 3 + 1] * light, bb = C[b * 3 + 2] * light
  const rc = C[c * 3] * light, gc = C[c * 3 + 1] * light, bc = C[c * 3 + 2] * light
  for (let py = minPy; py <= maxPy; py++) {
    const y = py + 0.5
    // Per pixel, not stepped: a running sum drifts, and on a silhouette where
    // two faces meet exactly the drift hands a pixel to the face behind.
    const r0 = a0y * y + a0c
    const r1 = a1y * y + a1c
    let k = py * W + minPx
    for (let px = minPx; px <= maxPx; px++, k++) {
      const x = px + 0.5
      const w0 = a0x * x + r0
      const w1 = a1x * x + r1
      const w2 = 1 - w0 - w1
      // A hair inclusive: in a front, top or side view a pixel center often
      // lands exactly on an edge two faces share in projection (a roof over a
      // floor), and rounding alone would pick which one covers it. Covered by
      // both, the depth test decides, and the nearer face wins as it should.
      if (w0 < -COVER_SLACK || w1 < -COVER_SLACK || w2 < -COVER_SLACK) continue
      const z = w0 * z0 + w1 * z1 + w2 * z2
      if (z <= depth[k]) continue
      depth[k] = z
      id[k] = f
      const o = k * 3
      color[o] = w0 * ra + w1 * rb + w2 * rc
      color[o + 1] = w0 * ga + w1 * gb + w2 * gc
      color[o + 2] = w0 * ba + w1 * bb + w2 * bc
    }
  }
}

/** Darken the pixels where a face meets nothing, or meets another face at a crease or with its other side showing. */
function outline(W: number, id: Int32Array, normals: Float32Array, back: Uint8Array, color: Uint8ClampedArray, edge: Uint8Array): void {
  const crease = (f: number, g: number): boolean => {
    if (f === g) return false
    if (f < 0 || g < 0 || back[f] !== back[g]) return true
    return normals[f * 3] * normals[g * 3] + normals[f * 3 + 1] * normals[g * 3 + 1] + normals[f * 3 + 2] * normals[g * 3 + 2] < 0.999
  }
  for (let py = 0; py < W; py++) {
    for (let px = 0; px < W; px++) {
      const k = py * W + px
      const f = id[k]
      if (px + 1 < W) {
        const g = id[k + 1]
        if (f !== g && (f >= 0 || g >= 0) && crease(f, g)) { if (f >= 0) edge[k] = 1; if (g >= 0) edge[k + 1] = 1 }
      }
      if (py + 1 < W) {
        const g = id[k + W]
        if (f !== g && (f >= 0 || g >= 0) && crease(f, g)) { if (f >= 0) edge[k] = 1; if (g >= 0) edge[k + W] = 1 }
      }
    }
  }
  for (let k = 0; k < W * W; k++) {
    if (!edge[k]) continue
    color[k * 3] *= OUTLINE
    color[k * 3 + 1] *= OUTLINE
    color[k * 3 + 2] *= OUTLINE
  }
}

/** Average each SS x SS block of the frame down to one pixel of the image. */
function downsample(color: Uint8ClampedArray, W: number, N: number): Uint8Array {
  const out = new Uint8Array(N * N * 3)
  const n = SS * SS
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let r = 0, g = 0, b = 0
      for (let oy = 0; oy < SS; oy++) {
        let o = ((y * SS + oy) * W + x * SS) * 3
        for (let ox = 0; ox < SS; ox++, o += 3) { r += color[o]; g += color[o + 1]; b += color[o + 2] }
      }
      const q = (y * N + x) * 3
      out[q] = Math.round(r / n)
      out[q + 1] = Math.round(g / n)
      out[q + 2] = Math.round(b / n)
    }
  }
  return out
}
