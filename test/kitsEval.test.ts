// kitsEval.test.ts: the kit build briefs (<kits>/<kit>/briefs; evals/kits/README.md), run without a
// model against the real kits on this machine. Each brief carries the build a
// good agent would make; this drives the MCP tools the way an agent does
// (kit, kit_piece, check_layout, render, place) and checks the result: no
// errors, the brief's own assertions, a picture, and every piece placed
// through the place path as a valid payload under the build's own name.
// Nothing is published: hide is replaced by a recorder.
//
// Skipped unless CYBERSPACE_KITS_DIR names a kit directory (kits are local
// data and never in this repository). Run it with
//
//   CYBERSPACE_KITS_DIR=<kits dir> npm run eval:kits
//
// Pictures and a summary go to KITS_EVAL_OUT (default: a folder in the
// system temp directory, printed at the end). evals/kits/README.md says how
// to run the same briefs with the agent itself.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { Agent } from '../src/agent.js'
import { KitLibrary } from '../src/kits/library.js'
import { parseCoordinate, placeOf, type CoordinateInput, type Place } from '../src/space/coords.js'
import { createServer } from '../src/server.js'
import { validateSnoPayload } from '../src/sno.js'
import { checkLayout } from '../src/kits/layout.js'
import { kitObject, turnY } from '../src/kits/transform.js'
import { ticksOf } from 'sno-core/shards'

const DIR = process.env.CYBERSPACE_KITS_DIR
const OUT = process.env.KITS_EVAL_OUT ?? join(tmpdir(), 'cyberspace-kits-eval')
// The briefs name kit pieces, so they ship in a kit's zip and live with the installed kit (<kits>/<kit>/briefs), never in this
// repository. KITS_EVAL_BRIEFS: another folder of briefs (an agent's answers put in as solutions, evals/kits/README.md).
const briefDirs = (): string[] => {
  if (process.env.KITS_EVAL_BRIEFS) return [process.env.KITS_EVAL_BRIEFS]
  if (!DIR || !existsSync(DIR)) return []
  return readdirSync(DIR).filter((k) => !k.startsWith('.')).map((k) => join(DIR, k, 'briefs')).filter((d) => existsSync(d))
}

interface Brief {
  id: string
  title: string
  brief: string
  solution: { placements: Array<{ piece: string; at: [number, number, number]; turn?: number; label?: string; open?: string[]; height?: number; room_height?: number }> }
  assert: {
    ok?: boolean
    atLeast?: Record<string, number>
    noErrors?: string[]
    noWarnings?: string[]
    bagHeightAtMost?: number
    levels?: number
    regionEdgesOnlyOn?: string[]
  }
}

const briefs: Brief[] = briefDirs().flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')) as Brief)).filter((b) => b.solution?.placements)

type Result = { content: Array<{ type: string; text?: string; data?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean }

async function connect(lib: KitLibrary, stand: Place, hidden: Array<{ object?: unknown; door?: Record<string, unknown>; coordinate: CoordinateInput; height: number }>) {
  // The agent as far as the kit tools reach: the kits, where it stands, and a hide that records instead of publishing.
  const stub = Object.create(Agent.prototype) as Agent & Record<string, unknown>
  Object.assign(stub, {
    kits: lib,
    keeper: { place: () => stand },
    target: (c: CoordinateInput, from: Place) => parseCoordinate(c, from),
    hide: async (input: { contents: { object?: unknown; door?: Record<string, unknown> }; coordinate: CoordinateInput; height: number }) => {
      hidden.push({ object: input.contents.object, door: input.contents.door, coordinate: input.coordinate, height: input.height })
      return { text: 'recorded (dry run: nothing published).', data: { dryRun: true } }
    },
  })
  const server = createServer(stub)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  const client = new Client({ name: 'kits-eval', version: '0' })
  await client.connect(a)
  return { call: async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as unknown as Result }
}

const textOf = (r: Result) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')

describe.skipIf(!DIR)('check_layout against the real geometry of the installed kits', () => {
  // These read only the catalogs and the payloads: if the catalog's faces or the checker's turns were wrong, the meshes would say so.
  const N: Record<string, [number, number, number]> = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] }
  const faceOf = (n: number[]) => Object.keys(N).find((k) => N[k].every((x, i) => x === n[i]))!
  const turnTo = (from: string, to: string) => [0, 1, 2, 3].find((q) => faceOf(turnY(N[from], q)) === to)! * 90

  it('a wall plug turned as check_layout asks lands on the rim of the tile\'s turned opening, every rooms kit, every tile, every turn', () => {
    const lib = new KitLibrary([DIR!])
    const ticks = (piece: string, turn: number) => { const k = kitObject(lib, piece, { turn }); const per = 2 ** k.shard.unit; return k.shard.vertices.map((v) => ticksOf(v).map((t) => t * per)) }
    const bad: string[] = []
    let n = 0
    for (const cat of lib.catalogs()) {
      const rules = cat.standard.rules
      if (rules?.family !== 'rooms') continue
      const facing = rules.builtFacing ?? '-z'
      const tiles = cat.pieces.filter((e) => e.kind === 'tile' && e.cells && e.cells.hi.every((x, i) => x === e.cells!.lo[i]) && (e.openings ?? []).some((o) => o.face[1] !== 'y'))
      for (const t of tiles) for (const q of [0, 1, 2, 3]) {
        const tv = new Set(ticks(t.id, q * 90).map((p) => p.join(',')))
        for (const o of t.openings!) {
          if (o.face[1] === 'y') continue
          const plug = lib.byRole(`plug:wall:${o.size}`, cat.kit)
          if (!plug) continue
          const w = faceOf(turnY(N[o.face], q))
          const turn = turnTo(facing, w)
          // The same plug and turn check_layout's fix names.
          const r = checkLayout(lib, { placements: [{ piece: t.id, at: [0, 0, 0], turn: q * 90, open: t.openings!.filter((x) => x !== o).map((x) => faceOf(turnY(N[x.face], q))) }] })
          expect(r.errors.map((e) => e.fix).join(' ')).toContain(`(${plug.id}) at [0, 0, 0]${turn ? ` turned ${turn}` : ''}`)
          const axis = w[1] === 'x' ? 0 : 2, sign = w[0] === '+' ? 1 : -1
          const rim = ticks(plug.id, turn).filter((p) => p[axis] === sign * (rules.tile / 2) * 120)
          const hit = rim.filter((p) => tv.has(p.join(','))).length
          n++
          if (!(rim.length >= 4 && hit >= rim.length / 2)) bad.push(`${t.id} turned ${q * 90}: ${o.face} -> ${w} ${o.size}, ${hit} of ${rim.length} rim points on the tile`)
        }
      }
    }
    expect(bad).toEqual([])
    expect(n).toBeGreaterThan(0)
  })

  it('terrain tiles side by side: check_layout calls the seam a match exactly when the meshes meet, every terrain kit, every pair, every turn', () => {
    const lib = new KitLibrary([DIR!])
    const wrong: string[] = []
    let n = 0
    for (const cat of lib.catalogs()) {
      const rules = cat.standard.rules
      if (rules?.family !== 'terrain') continue
      const T = rules.tile, half = T / 2
      const step = Number(cat.standard.edgeStep ?? 1)
      const tiles = cat.pieces.filter((e) => e.edges && e.footprint && e.footprint[0] === T && e.footprint[1] === T)
      // The top of each tile's mesh along its world +x and -x edges, per turn.
      const tops = new Map<string, number[]>()
      for (const t of tiles) for (const q of [0, 1, 2, 3]) {
        const v = kitObject(lib, t.id, { turn: q * 90 }).shard.vertices.map((x) => ticksOf(x).map((c) => c / 120))
        for (const x of [half, -half]) {
          const row: number[] = []
          for (let z = -half; z <= half; z += step) row.push(Math.max(...v.filter((p) => Math.abs(p[0] - x) < 1e-6 && Math.abs(p[2] - z) < 1e-6).map((p) => p[1])))
          tops.set(`${t.id}|${q}|${x}`, row)
        }
      }
      for (const a of tiles) for (const qa of [0, 1, 2, 3]) for (const b of tiles) for (const qb of [0, 1, 2, 3]) {
        const ra = tops.get(`${a.id}|${qa}|${half}`)!, rb = tops.get(`${b.id}|${qb}|${-half}`)!
        const meet = ra.every((y, i) => Number.isFinite(y) && Math.abs(y - rb[i]) < 0.01)
        const r = checkLayout(lib, { placements: [{ piece: a.id, at: [0, 0, 0], turn: qa * 90 }, { piece: b.id, at: [T, 0, 0], turn: qb * 90 }] })
        const said = !r.errors.some((e) => e.code === 'edge-mismatch')
        n++
        if (meet !== said && wrong.length < 10) wrong.push(`${a.id} turned ${qa * 90} | ${b.id} turned ${qb * 90}: meshes ${meet ? 'meet' : 'differ'}, check_layout says ${said ? 'match' : 'mismatch'}`)
      }
    }
    expect(wrong).toEqual([])
    expect(n).toBeGreaterThan(0)
  }, 300_000)
})

describe.skipIf(!DIR)('kit build briefs, dry run against the installed kits', () => {
  const summary: Array<Record<string, unknown>> = []
  mkdirSync(OUT, { recursive: true })

  for (const brief of briefs) {
    it(`${brief.id}: ${brief.title}`, async () => {
      const lib = new KitLibrary([DIR!])
      const hidden: Array<{ object?: unknown; door?: Record<string, unknown>; coordinate: CoordinateInput; height: number }> = []
      // First where it would stand: anywhere; check_layout says where the origin must sit for one bag.
      let tools = await connect(lib, placeOf({ x: 1n << 40n, y: 1n << 40n, z: 1n << 40n }, 1), hidden)
      const placements = brief.solution.placements
      for (const p of [...new Set(placements.map((x) => x.piece))]) {
        const r = await tools.call('kit_piece', { piece: p })
        expect(r.isError, `${p}: ${textOf(r)}`).toBeFalsy()
      }
      const plan = await tools.call('check_layout', { placements })
      const report = plan.structuredContent as { ok: boolean; errors: Array<{ code: string; message: string }>; warnings: Array<{ code: string; message: string }>; counts: Record<string, number>; bag: { height: number; originOffsets: Array<[number, number]> } }
      const a = brief.assert
      if (a.ok) expect(report.errors, textOf(plan)).toEqual([])
      for (const [kind, n] of Object.entries(a.atLeast ?? {})) expect(report.counts[kind] ?? 0, `${kind}`).toBeGreaterThanOrEqual(n)
      for (const code of a.noErrors ?? []) expect(report.errors.map((e) => e.code)).not.toContain(code)
      for (const code of a.noWarnings ?? []) expect(report.warnings.filter((w) => w.code === code).map((w) => w.message), code).toEqual([])
      if (a.bagHeightAtMost !== undefined) expect(report.bag.height).toBeLessThanOrEqual(a.bagHeightAtMost)
      if (a.levels !== undefined) expect(new Set(placements.filter((p) => lib.get(p.piece).kind === 'tile').map((p) => p.at[1])).size).toBe(a.levels)
      if (a.regionEdgesOnlyOn) {
        const edge = report.warnings.find((w) => w.code === 'region-edge')
        for (const part of (edge?.message.split(': ').slice(1).join(': ').split('; ') ?? [])) expect(a.regionEdgesOnlyOn.some((n) => part.includes(` ${n} at`)), part).toBe(true)
      }
      // Stand where the layout's origin fits one bag, check again there, and look.
      const h = report.bag.height
      const base = 1n << 40n
      const stand = placeOf({ x: base + BigInt(report.bag.originOffsets[0][0]), y: base + BigInt(report.bag.originOffsets[1][0]), z: base + BigInt(report.bag.originOffsets[2][0]) }, 1)
      tools = await connect(lib, stand, hidden)
      const there = await tools.call('check_layout', { placements, origin: { dx: 0, dy: 0, dz: 0 }, height: h })
      expect((there.structuredContent as { errors: unknown[] }).errors, textOf(there)).toEqual([])
      const pictures: string[] = []
      // A top view cut 3 above the lowest room floor shows enclosed rooms as a plan; open ground needs no cut.
      const rooms = placements.filter((p) => lib.rulesOf(lib.get(p.piece))?.family === 'rooms' && lib.get(p.piece).kind === 'tile')
      const top = rooms.length ? { view: 'top', cut: Math.min(...rooms.map((p) => p.at[1])) - 8 + 3 } : { view: 'top' }
      for (const view of [{ view: 'iso' }, top]) {
        const pic = await tools.call('render', { layout: placements, size: 512, ...view })
        expect(pic.isError, textOf(pic)).toBeFalsy()
        const img = pic.content.find((c) => c.type === 'image')!
        const file = join(OUT, `${brief.id}-${view.view}.png`)
        writeFileSync(file, Buffer.from(img.data!, 'base64'))
        pictures.push(file)
      }
      // Place every piece the way an agent would: kit, turn, the offset from where it stands, the layout's height.
      // A locked door is sealed with seal_door (its looks the closed and open door of its kit), before the room's pieces.
      const ordered = [...placements].sort((a, b) => Number(b.room_height !== undefined) - Number(a.room_height !== undefined))
      for (const p of ordered) {
        const coordinate = { dx: p.at[0], dy: p.at[1], dz: p.at[2] }
        if (p.room_height !== undefined) {
          const open = lib.byRole(`door-open:${lib.get(p.piece).closes}`, lib.get(p.piece).kit)
          const r = await tools.call('seal_door', { name: p.label ?? 'door', lock: 'the key', room_height: p.room_height, height: p.height ?? h, coordinate, look: { kit: p.piece, turn: p.turn ?? 0 }, ...(open ? { open_look: { kit: open.id, turn: p.turn ?? 0 } } : {}) })
          expect(r.isError, `${p.piece}: ${textOf(r)}`).toBeFalsy()
          continue
        }
        const r = await tools.call('place', { kit: p.piece, turn: p.turn ?? 0, coordinate, height: p.height ?? h })
        expect(r.isError, `${p.piece}: ${textOf(r)}`).toBeFalsy()
      }
      expect(hidden).toHaveLength(placements.length)
      for (const x of hidden) {
        if (x.door) { expect(x.door.room_height).toBeGreaterThan(0); continue }
        const v = validateSnoPayload(x.object)
        expect(v.ok).toBe(true)
        expect((x.object as { name: string }).name).not.toMatch(/kit\s*:/i)
      }
      summary.push({ id: brief.id, title: brief.title, ok: report.ok, placements: placements.length, errors: report.errors.length, warnings: report.warnings.map((w) => w.code), bagHeight: h, pictures })
    }, 120_000)
  }

  it('writes the summary', () => {
    writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2))
    console.log(`kit briefs: ${summary.length} of ${briefs.length} passed; pictures and summary in ${OUT}`)
    expect(summary.length).toBe(briefs.length)
  })
})
