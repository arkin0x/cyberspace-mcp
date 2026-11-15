// kitsEval.test.ts: the kit build briefs (evals/kits/briefs), run without a
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
//   CYBERSPACE_KITS_DIR=/data/repos/csmcp/kits npm run eval:kits
//
// Pictures and a summary go to KITS_EVAL_OUT (default: a folder in the
// system temp directory, printed at the end). evals/kits/README.md says how
// to run the same briefs with the agent itself.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { Agent } from '../src/agent.js'
import { KitLibrary } from '../src/kits/library.js'
import { parseCoordinate, placeOf, type CoordinateInput, type Place } from '../src/space/coords.js'
import { createServer } from '../src/server.js'
import { validateSnoPayload } from '../src/sno.js'

const DIR = process.env.CYBERSPACE_KITS_DIR
const OUT = process.env.KITS_EVAL_OUT ?? join(tmpdir(), 'cyberspace-kits-eval')
// KITS_EVAL_BRIEFS: another folder of briefs (an agent's answers put in as solutions, evals/kits/README.md).
const BRIEFS = process.env.KITS_EVAL_BRIEFS ? pathToFileURL(`${process.env.KITS_EVAL_BRIEFS.replace(/\/+$/, '')}/`) : new URL('../evals/kits/briefs/', import.meta.url)

interface Brief {
  id: string
  title: string
  brief: string
  solution: { placements: Array<{ piece: string; at: [number, number, number]; turn?: number; label?: string; open?: string[] }> }
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

const briefs: Brief[] = existsSync(BRIEFS) ? readdirSync(BRIEFS).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(new URL(f, BRIEFS), 'utf8'))) : []

type Result = { content: Array<{ type: string; text?: string; data?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean }

async function connect(lib: KitLibrary, stand: Place, hidden: Array<{ object: unknown; coordinate: CoordinateInput; height: number }>) {
  // The agent as far as the kit tools reach: the kits, where it stands, and a hide that records instead of publishing.
  const stub = Object.create(Agent.prototype) as Agent & Record<string, unknown>
  Object.assign(stub, {
    kits: lib,
    keeper: { place: () => stand },
    target: (c: CoordinateInput, from: Place) => parseCoordinate(c, from),
    hide: async (input: { contents: { object: unknown }; coordinate: CoordinateInput; height: number }) => {
      hidden.push({ object: input.contents.object, coordinate: input.coordinate, height: input.height })
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

describe.skipIf(!DIR)('kit build briefs, dry run against the installed kits', () => {
  const summary: Array<Record<string, unknown>> = []
  mkdirSync(OUT, { recursive: true })

  for (const brief of briefs) {
    it(`${brief.id}: ${brief.title}`, async () => {
      const lib = new KitLibrary([DIR!])
      const hidden: Array<{ object: unknown; coordinate: CoordinateInput; height: number }> = []
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
      const rooms = placements.filter((p) => lib.get(p.piece).kit === 'maze-kit' && lib.get(p.piece).kind === 'tile')
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
      for (const p of placements) {
        const r = await tools.call('place', { kit: p.piece, turn: p.turn ?? 0, coordinate: { dx: p.at[0], dy: p.at[1], dz: p.at[2] }, height: h })
        expect(r.isError, `${p.piece}: ${textOf(r)}`).toBeFalsy()
      }
      expect(hidden).toHaveLength(placements.length)
      for (const x of hidden) {
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
