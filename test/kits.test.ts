// kits.test.ts: the kit tools on two made-up kits, built here as kit zips and
// installed with `kits add` into a temp folder. No real kit is in this
// repository (kits are local data, never published), and none of these
// numbers are anyone's: a rooms kit on a 12-gibson grid with openings named
// slot, gate and wide, and a terrain kit of 48-gibson tiles whose profiles are
// FLAT, HIGH, DEEP and SLOPE. So the tests also prove check_layout runs on
// what a manifest declares, not on any one kit.
//
// Covers: the zip installer (measuring, refusing unsafe zips, list, remove),
// no kits installed, lookup and search, the turn and the scale of a placed
// copy, the rooms rules (joins, plugs, open faces, sizes, reducers, floors
// over hatches, doors, the grid, decor), the terrain rules (edges, steps
// hidden by facing walls on the low ground, ramps, region edges, decor on the
// ground), the bag check, the guide resource, render's layout picture, place
// with kit through hide, and the refusal to publish a kit piece. No network.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { Agent } from '../src/agent.js'
import { installKit, listKits, removeKit } from '../src/kits/install.js'
import { KitLibrary, kitsDirCandidates, searchKits } from '../src/kits/library.js'
import { checkLayout } from '../src/kits/layout.js'
import { kitPieceIn } from '../src/kits/tools.js'
import { kitObject, turnY } from '../src/kits/transform.js'
import { createServer } from '../src/server.js'
import { validateSnoPayload } from '../src/sno.js'

type V = [number, number, number]

/** A closed box from lo to hi (wire frame, as a payload holds it), one colour. */
function box(name: string, lo: V, hi: V, extra: Record<string, unknown> = {}) {
  const [a, b, c] = lo, [d, e, f] = hi
  const points = [[a, b, c], [d, b, c], [d, e, c], [a, e, c], [a, b, f], [d, b, f], [d, e, f], [a, e, f]]
  const vertices = points.map((q) => q.map((x) => Math.floor(x)))
  const ticks = points.map((q, i) => q.map((x, k) => Math.round((x - vertices[i][k]) * 120)))
  const faces = [[4, 5, 6], [4, 6, 7], [1, 0, 3], [1, 3, 2], [5, 1, 2], [5, 2, 6], [0, 4, 7], [0, 7, 3], [3, 7, 6], [3, 6, 2], [0, 1, 5], [0, 5, 4]]
  return { v: 2, name, unit: 0, mode: 'solid', vertices, ticks, colors: vertices.map(() => 7), faces, ...extra }
}

/** A stored (uncompressed) zip of these files. */
function zipOf(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const n = Buffer.from(name)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, n, data); centrals.push(central, n)
    offset += 30 + n.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const ROOT = mkdtempSync(join(tmpdir(), 'kits-test-'))
const KITS = join(ROOT, 'kits')
const json = (x: unknown) => JSON.stringify(x)

function blocksZip(): string {
  const T = 'Toy Blocks'
  const P = (id: string) => `toy-blocks/${id}`
  const room = box(`${T}: room`, [-6, -6, -6], [6, 6, 6], { constrain: 'all' })
  const opening = (face: string, size: string, w: number, h: number) => ({ face, size, w, h, cell: [0, 0, 0] })
  const gate = (face: string) => opening(face, 'gate', 2, 3)
  const tile = (openings: unknown[], seals: string[]) => ({ kind: 'tile', cells: { lo: [0, 0, 0], hi: [0, 0, 0] }, openings, floorSeals: seals.length ? [{ cell: [0, 0, 0], seals }] : [] })
  const files: Record<string, string> = {
    [`${P('rooms/room')}.json`]: json(room),
    [`${P('rooms/room-hatch')}.json`]: json({ ...room, name: 'hatch room' }),
    [`${P('rooms/room-partial')}.json`]: json({ ...room, name: 'partial floor' }),
    [`${P('rooms/room-wide')}.json`]: json({ ...room, name: 'wide room' }),
    [`${P('rooms/room-floor-wide')}.json`]: json({ ...room, name: 'floor wide room' }),
    // Built facing world -z: the wire's +z (a payload's z is negated on the way in).
    [`${P('plugs/gate-plug')}.json`]: json(box('gate plug', [-1, -6, 6], [1, -3, 6.25])),
    [`${P('plugs/gate-ceiling-plug')}.json`]: json(box('gate ceiling plug', [-1, 6, -1.5], [1, 6.25, 1.5])),
    [`${P('plugs/gate-recessed-plug')}.json`]: json(box('gate recessed plug', [-1, 5.5, -1.5], [1, 6, 1.5])),
    [`${P('plugs/wide-gate-reducer')}.json`]: json(box('wide to gate', [-2, -6, 6], [2, 0, 6.25])),
    [`${P('plugs/wide-gate-floor-reducer')}.json`]: json(box('wide to gate, floor', [-2, -6.25, -3], [2, -6, 3])),
    [`${P('doors/gate-door')}.json`]: json(box('gate door', [-1, 0, -0.5], [1, 3, 0], { constrain: 'all' })),
    [`${P('doors/gate-door-open')}.json`]: json(box('gate door, open', [-1, 2.5, -0.5], [1, 3, 0], { constrain: 'off' })),
    [`${P('decor/lamp')}.json`]: json(box('lamp', [-0.4, 0, -0.4], [0.4, 1, 0.4], { constrain: 'all' })),
    [`${P('broken')}.json`]: json({ v: 2, name: 'broken' }),
  }
  const manifest = {
    format: 'cyberspace-kit-1', kit: 'toy-blocks', title: T, version: '1',
    rules: { family: 'rooms', tile: 12, wallInset: 0.5, floor: -6, doorOffset: [0, -6, -6], builtFacing: '-z' },
    pieces: {
      [P('rooms/room')]: { ...tile([gate('+z'), gate('-z')], ['slot', 'gate', 'gate-x', 'wide', 'wide-x']), tags: ['straight'] },
      [P('rooms/room-hatch')]: tile([gate('+z'), gate('+y')], ['slot', 'gate', 'gate-x']),
      [P('rooms/room-partial')]: tile([gate('-z')], ['slot']),
      [P('rooms/room-wide')]: tile([opening('-z', 'wide', 4, 6), gate('+z')], ['slot']),
      [P('rooms/room-floor-wide')]: tile([opening('-y', 'wide', 4, 6), gate('+z')], []),
      [P('plugs/gate-plug')]: { kind: 'plug', role: 'plug:wall:gate', plug: { side: 'wall', size: 'gate' } },
      [P('plugs/gate-ceiling-plug')]: { kind: 'plug', role: 'plug:ceiling:gate', plug: { side: 'ceiling', size: 'gate' } },
      [P('plugs/gate-recessed-plug')]: { kind: 'recessed-plug', role: 'plug:ceiling-recessed:gate', plug: { side: 'ceiling-recessed', size: 'gate' } },
      [P('plugs/wide-gate-reducer')]: { kind: 'reducer', role: 'reducer:wall:wide-gate', reducer: { side: 'wall', from: 'wide', to: 'gate' } },
      [P('plugs/wide-gate-floor-reducer')]: { kind: 'reducer', role: 'reducer:floor:wide-gate', reducer: { side: 'floor', from: 'wide', to: 'gate' } },
      [P('doors/gate-door')]: { kind: 'door', role: 'door:gate', closes: 'gate' },
      [P('doors/gate-door-open')]: { kind: 'door-open', role: 'door-open:gate', closes: 'gate' },
      [P('decor/lamp')]: { kind: 'decor', mount: 'floor', tags: ['light'], bytes: 1, bounds: { min: [0, 0, 0], max: [99, 99, 99] } },
    },
  }
  const file = join(ROOT, 'toy-blocks.zip')
  writeFileSync(file, zipOf({ 'kit.json': json(manifest), 'GUIDE.md': '# Toy Blocks\n\nGates are 2 by 3.\n', 'briefs/one.json': json({ id: 'one' }), ...files }))
  return file
}

function hillsZip(): string {
  const P = (id: string) => `hill-tiles/${id}`
  const slab = box('slab', [-24, -12, -24], [24, 0, 24], { constrain: 'all' })
  const wall = (h: number, back = 3) => box('wall', [-24, -1, -3], [24, h, back], { constrain: 'all' })
  const files: Record<string, string> = {
    [`${P('tiles/flat')}.json`]: json(slab),
    [`${P('tiles/ramp')}.json`]: json({ ...slab, name: 'ramp' }),
    [`${P('walls/step-48')}.json`]: json(wall(9)),
    [`${P('walls/tall-48')}.json`]: json(wall(11)),
    [`${P('walls/low-48')}.json`]: json(wall(4)),
    [`${P('walls/slope-wall-a')}.json`]: json(wall(9, 5)),
    [`${P('walls/slope-wall-b')}.json`]: json(wall(9, 5)),
    [`${P('decor/rock')}.json`]: json(box('rock', [-1, -0.2, -1], [1, 1.5, 1], { constrain: 'all' })),
  }
  const seg = [[[-24, 0], [24, 0]]]
  const manifest = {
    format: 'cyberspace-kit-1', kit: 'hill-tiles', title: 'Hill Tiles',
    rules: {
      family: 'terrain', tile: 48, module: 24, builtFacing: '-z', minHideHeight: 10,
      profiles: { FLAT: { flat: 0 }, HIGH: { flat: 8 }, DEEP: { flat: -8, open: true }, 'SLOPE+': { reverse: 'SLOPE-', ramp: true, rises: 1 }, 'SLOPE-': { reverse: 'SLOPE+', ramp: true, rises: -1 } },
    },
    pieces: {
      [P('tiles/flat')]: { kind: 'tile', footprint: [48, 48], edges: { px: 'FLAT', nx: 'FLAT', pz: 'FLAT', nz: 'FLAT' } },
      [P('tiles/ramp')]: { kind: 'tile', footprint: [48, 48], edges: { px: 'HIGH', nx: 'FLAT', pz: 'SLOPE+', nz: 'SLOPE+' } },
      [P('walls/step-48')]: { kind: 'wall', role: 'step-wall:48', wall: { kind: 'step', length: 48, height: 9, segments: seg, hides: seg } },
      [P('walls/tall-48')]: { kind: 'wall', role: 'seam-wall:48', wall: { kind: 'seam', length: 48, height: 11, segments: seg, hides: seg } },
      [P('walls/low-48')]: { kind: 'wall', wall: { kind: 'seam', length: 48, height: 4, segments: seg, hides: seg } },
      [P('walls/slope-wall-a')]: { kind: 'wall', role: 'ramp-step-wall', wall: { kind: 'ramp-step', length: 48, height: 9, segments: seg, hides: seg, highEnd: 1 } },
      [P('walls/slope-wall-b')]: { kind: 'wall', role: 'ramp-step-mirror', wall: { kind: 'ramp-step', length: 48, height: 9, segments: seg, hides: seg, highEnd: -1 } },
      [P('decor/rock')]: { kind: 'decor', mount: 'floor', solid: true, sink: 0.2 },
    },
  }
  const file = join(ROOT, 'hill-tiles.zip')
  writeFileSync(file, zipOf({ 'kit.json': json(manifest), ...files }))
  return file
}

const installed = [installKit(blocksZip(), KITS), installKit(hillsZip(), KITS)]
const lib = new KitLibrary([KITS])
const B = (id: string) => `toy-blocks/${id}`
const H = (id: string) => `hill-tiles/${id}`
const P = (piece: string, at: V, turn = 0, extra: Record<string, unknown> = {}) => ({ piece, at, turn, ...extra })
const codes = (r: { errors: Array<{ code: string }> }) => r.errors.map((e) => e.code)

describe('kits add, list, remove', () => {
  it('installs a kit zip: measures every payload itself, takes meaning from kit.json, leaves out what it cannot read', () => {
    expect(installed[0]).toMatchObject({ kit: 'toy-blocks', title: 'Toy Blocks', pieces: 13, guide: true, briefs: 1, replaced: false })
    expect(installed[0].skipped).toEqual([{ id: 'toy-blocks/broken', why: expect.stringContaining('not valid SNO') }])
    const lamp = lib.get(B('decor/lamp'))
    // The manifest said 1 byte and a huge box; the payload says otherwise.
    expect(lamp.bytes).toBeGreaterThan(100)
    expect(lamp.bounds.max).toEqual([0.4, 1, 0.4])
    expect(lamp.set).toBe('decor')
    // The kit's title is dropped from a piece's name.
    expect(lib.get(B('rooms/room')).name).toBe('room')
    expect(listKits(KITS).map((k) => `${k.kit}:${k.pieces}:${k.guide}`)).toEqual(['hill-tiles:8:false', 'toy-blocks:13:true'])
    // Again: it replaces its own folder.
    expect(installKit(join(ROOT, 'hill-tiles.zip'), KITS).replaced).toBe(true)
  })

  it('refuses a zip with no kit.json, an unsafe path, or a bad kit name, and touches only folders it wrote', () => {
    const z = (name: string, files: Record<string, string>) => { const f = join(ROOT, name); writeFileSync(f, zipOf(files)); return f }
    expect(() => installKit(z('no.zip', { 'a/b.json': json(box('x', [0, 0, 0], [1, 1, 1])) }), KITS)).toThrow(/no kit.json/)
    expect(() => installKit(z('slip.zip', { 'kit.json': json({ format: 'cyberspace-kit-1', kit: 'slip', title: 'S' }), '../evil.json': '{}' }), KITS)).toThrow(/not a safe relative path/)
    expect(() => installKit(z('name.zip', { 'kit.json': json({ format: 'cyberspace-kit-1', kit: '../up', title: 'S' }) }), KITS)).toThrow(/lowercase letters/)
    mkdirSync(join(KITS, 'mine'), { recursive: true })
    writeFileSync(join(KITS, 'mine', 'catalog.json'), '{"format":"something else"}')
    expect(() => installKit(z('mine.zip', { 'kit.json': json({ format: 'cyberspace-kit-1', kit: 'mine', title: 'M' }), 'mine/a.json': json(box('a', [0, 0, 0], [1, 1, 1])) }), KITS)).toThrow(/not a kit folder this server wrote/)
    expect(() => removeKit(KITS, 'mine')).toThrow(/not a kit folder this server wrote/)
    installKit(z('temp.zip', { 'kit.json': json({ format: 'cyberspace-kit-1', kit: 'temp', title: 'T' }), 'temp/a.json': json(box('a', [0, 0, 0], [1, 1, 1])) }), KITS)
    expect(removeKit(KITS, 'temp')).toMatch(/temp$/)
    expect(listKits(KITS).map((k) => k.kit)).not.toContain('temp')
  })
})

describe('kits: the library', () => {
  it('says plainly that no kits are installed, and where it looked', () => {
    const none = new KitLibrary(kitsDirCandidates(join(ROOT, 'nowhere', 'state')))
    expect(none.dir()).toBeNull()
    expect(() => none.entries()).toThrow(/No kits are installed on this server: no <kit>\/catalog.json in .*nowhere.*kits or .*kits/)
    expect(kitsDirCandidates('/x/state')).toEqual(['/x/state/kits', '/x/kits'])
    expect(kitsDirCandidates('/x/state', '/elsewhere')).toEqual(['/elsewhere'])
  })

  it('finds a piece by its id or the unique end of it, by role, and searches by words and filters', () => {
    expect(lib.get(B('rooms/room-hatch')).id).toBe(B('rooms/room-hatch'))
    expect(lib.get('room-hatch').id).toBe(B('rooms/room-hatch'))
    expect(() => lib.get('nothing-here')).toThrow(/No kit piece/)
    expect(lib.byRole('plug:wall:gate')?.id).toBe(B('plugs/gate-plug'))
    expect(searchKits(lib, { text: 'lamp' }).pieces.map((p) => p.id)).toEqual([B('decor/lamp')])
    expect(searchKits(lib, { opening: 'wide' }).pieces.map((p) => p.id)).toEqual([B('plugs/wide-gate-floor-reducer'), B('plugs/wide-gate-reducer'), B('rooms/room-floor-wide'), B('rooms/room-wide')])
    expect(searchKits(lib, { edge: 'SLOPE+' }).pieces.map((p) => p.id)).toEqual([H('tiles/ramp')])
  })

  it('turns a copy by quarter turns about Y and scales it by its unit, under the build\'s own name', () => {
    const k = kitObject(lib, B('decor/lamp'), { turn: 90, scale: 1 })
    expect(k.payload.name).toBe('lamp')
    expect(k.payload.unit).toBe(1)
    expect(validateSnoPayload(k.payload).ok).toBe(true)
    // x, z -> z, -x: the door's slab (world z 0 to 0.5) lies from x 0 to 0.5.
    const door = kitObject(lib, B('doors/gate-door'), { turn: 90 })
    const xs = door.shard.vertices.map((v) => v.p[0] + (v.t?.[0] ?? 0) / 120)
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([0, 0.5])
    expect(turnY([1, 0, 0], 1)).toEqual([0, 0, -1])
    expect(() => kitObject(lib, B('decor/lamp'), { turn: 45 })).toThrow(/multiple of 90/)
    expect(() => kitObject(lib, B('decor/lamp'), { scale: -1 })).toThrow(/whole number, 0 or more/)
  })

  it('knows a kit piece when an agent tries to publish one on its own, whatever it is called', () => {
    expect(kitPieceIn(lib, { name: 'Toy Blocks: anything', vertices: [], faces: [] })).toBe('Toy Blocks: anything')
    const k = kitObject(lib, B('decor/lamp'))
    expect(kitPieceIn(lib, k.shard)).toBeTruthy()
    expect(kitPieceIn(lib, { ...kitObject(lib, B('decor/lamp'), { turn: 270, scale: 2 }).shard, name: 'my own lamp' })).toBeTruthy()
    expect(kitPieceIn(lib, { name: 'mine', vertices: k.shard.vertices.slice(0, 7), faces: k.shard.faces.slice(0, 10) })).toBeNull()
  })
})

describe('check_layout: a rooms kit', () => {
  it('passes two rooms joined gate to gate, the far gate plugged and the way in left open', () => {
    const r = checkLayout(lib, { placements: [
      P(B('rooms/room'), [0, 0, 0], 0, { open: ['-z'] }),
      P(B('rooms/room'), [0, 0, 12]),
      // The far gate faces +z: the plug is built facing -z, so it turns 180.
      P(B('plugs/gate-plug'), [0, 0, 12], 180),
      P(B('decor/lamp'), [2, -6, 14]),
    ] })
    expect(r.errors).toEqual([])
    expect(r.text).toMatch(/^Layout OK/)
  })

  it('names an opening into nothing, with the plug that fits by its role and its turn', () => {
    const r = checkLayout(lib, { placements: [P(B('rooms/room'), [0, 0, 0], 90)] })
    expect(codes(r)).toEqual(['opens-into-nothing', 'opens-into-nothing'])
    const fixes = r.errors.map((e) => e.fix).join(' ')
    expect(fixes).toContain(`the wall plug for a 2 x 3 opening (${B('plugs/gate-plug')}) at [0, 0, 0] turned 270`)
    expect(fixes).toContain('turned 90')
  })

  it('refuses a plug where there is no opening, a doorway against a wall, tiles in one cell, and the grid', () => {
    const r = checkLayout(lib, { placements: [P(B('rooms/room'), [0, 0, 0], 0, { open: ['-z'] }), P(B('rooms/room'), [0, 0, 12], 90), P(B('rooms/room'), [0, 0, 12]), P(B('plugs/gate-plug'), [0, 0, 0], 90)] })
    expect(codes(r)).toContain('overlap')
    expect(codes(r)).toContain('plug-no-opening')
    expect(codes(checkLayout(lib, { placements: [P(B('rooms/room'), [0, 0, 0], 0, { open: ['-z', '+z'] }), P(B('rooms/room'), [0, 0, 15], 0, { open: ['-z', '+z'] })] }))).toEqual(['off-grid'])
    expect(codes(checkLayout(lib, { placements: [P(B('rooms/room'), [0, 0, 0], 0, { open: ['-z'] }), P(B('rooms/room'), [0, 0, 12], 90, { open: ['+x', '-x'] })] }))).toEqual(['opens-into-wall'])
  })

  it('asks for a reducer where sizes differ (larger by area), and turns a floor reducer with its hatches', () => {
    const base = [P(B('rooms/room-wide'), [0, 0, 12], 0, { open: ['+z'] }), P(B('rooms/room'), [0, 0, 0], 0, { open: ['-z'] })]
    const r = checkLayout(lib, { placements: base })
    expect(codes(r)).toEqual(['needs-reducer'])
    expect(r.errors[0].fix).toContain(`(${B('plugs/wide-gate-reducer')}) at [0, 0, 12], or`)
    expect(checkLayout(lib, { placements: [...base, P(B('plugs/wide-gate-reducer'), [0, 0, 12], 0)] }).errors).toEqual([])
    const up = [P(B('rooms/room-hatch'), [0, 0, 0], 0, { open: ['+z'] }), P(B('rooms/room-floor-wide'), [0, 12, 0], 0, { open: ['+z'] })]
    expect(codes(checkLayout(lib, { placements: up }))).toEqual(['needs-reducer'])
    expect(checkLayout(lib, { placements: [...up, P(B('plugs/wide-gate-floor-reducer'), [0, 12, 0], 0)] }).errors).toEqual([])
    expect(codes(checkLayout(lib, { placements: [...up, P(B('plugs/wide-gate-floor-reducer'), [0, 12, 0], 90)] }))).toEqual(['plug-turn', 'needs-reducer'])
  })

  it('seals a ceiling hatch with the floor above when it covers it, and asks for the recessed plug when it does not', () => {
    const lower = P(B('rooms/room-hatch'), [0, 0, 0], 0, { open: ['+z'] })
    expect(checkLayout(lib, { placements: [lower, P(B('rooms/room'), [0, 12, 0], 0, { open: ['+z', '-z'] })] }).errors).toEqual([])
    expect(codes(checkLayout(lib, { placements: [lower, P(B('rooms/room'), [0, 12, 0], 0, { open: ['+z', '-z'] }), P(B('plugs/gate-ceiling-plug'), [0, 0, 0])] }))).toEqual(['zfight'])
    expect(codes(checkLayout(lib, { placements: [lower, P(B('rooms/room-partial'), [0, 12, 0], 0, { open: ['-z'] })] }))).toEqual(['needs-recessed-plug'])
    expect(checkLayout(lib, { placements: [lower, P(B('rooms/room-partial'), [0, 12, 0], 0, { open: ['-z'] }), P(B('plugs/gate-recessed-plug'), [0, 0, 0])] }).errors).toEqual([])
    // Turned a quarter, the hatch lies along x, and the floor above (sealing gate-x) still covers it.
    expect(checkLayout(lib, { placements: [P(B('rooms/room-hatch'), [0, 0, 0], 90, { open: ['+x'] }), P(B('rooms/room'), [0, 12, 0], 0, { open: ['+z', '-z'] })] }).errors).toEqual([])
  })

  it('takes a closed door in a doorway as its seal, from either room, and refuses one in no opening', () => {
    // The door's origin: the tile's position plus the kit's doorOffset (0, -6, -6) for its -z opening.
    expect(checkLayout(lib, { placements: [P(B('rooms/room'), [0, 0, 0], 0, { open: ['+z'] }), P(B('doors/gate-door'), [0, -6, -6], 0)] }).errors).toEqual([])
    expect(checkLayout(lib, { placements: [P(B('rooms/room'), [0, 0, 0], 0, { open: ['-z'] }), P(B('doors/gate-door'), [0, -6, 6], 180)] }).errors).toEqual([])
    expect(codes(checkLayout(lib, { placements: [P(B('rooms/room'), [0, 0, 0], 0, { open: ['-z', '+z'] }), P(B('doors/gate-door'), [5, -6, 6], 0)] }))).toEqual(['door-no-opening'])
  })

  it('checks a locked door: one side at its room height, the room pieces in its cube, and the origin where both fit', () => {
    const vault = [
      P(B('rooms/room'), [0, 0, 0], 0, { open: ['-z'] }),
      P(B('rooms/room'), [0, 0, 12], 0, { height: 4 }),
      P(B('plugs/gate-plug'), [0, 0, 12], 180, { height: 4 }),
      // The door in the outer room's +z doorway: the kit's door offset (0, -6, -6) turned 180 with it.
      P(B('doors/gate-door'), [0, -6, 6], 180, { room_height: 4 }),
    ]
    const r = checkLayout(lib, { placements: vault })
    expect(r.errors).toEqual([])
    // Every room piece shares the door's height-4 cube at every offset check_layout gives.
    const [[x0], [y0], [z0]] = r.bag.originOffsets as Array<[number, number]>
    for (const p of vault.filter((q) => (q as { height?: number }).height === 4)) for (let a = 0; a < 3; a++) {
      const o = [x0, y0, z0][a]
      expect(Math.floor((o + (p.at as number[])[a]) / 16)).toBe(Math.floor((o + [0, -6, 6][a]) / 16))
    }
    expect(codes(checkLayout(lib, { placements: vault.map((p) => ({ ...p, height: undefined })).map((p, i) => (i === 3 ? { ...p, room_height: 4 } : p)) }))).toEqual(['door-locks-nothing'])
    expect(checkLayout(lib, { placements: [vault[0], { ...vault[1], height: undefined, open: ['+z'] }, vault[3]] }).warnings.map((w) => w.code)).toContain('room-empty')
    expect(codes(checkLayout(lib, { placements: vault, height: 3 }))).toContain('door-height')
    expect(() => checkLayout(lib, { placements: [P(B('rooms/room'), [0, 0, 0], 0, { room_height: 4 })] })).toThrow(/room_height goes on a closed door/)
  })

  it('warns when decor floats above the floor or stands outside every room', () => {
    const r = checkLayout(lib, { placements: [P(B('rooms/room'), [0, 0, 0], 0, { open: ['-z', '+z'] }), P(B('decor/lamp'), [0, -3, 0]), P(B('decor/lamp'), [40, 0, 0])] })
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['decor-floating', 'decor-outside']))
    expect(r.warnings.find((w) => w.code === 'decor-floating')!.fix).toBe('place it at y -6')
  })
})

describe('check_layout: a terrain kit', () => {
  const ground = [P(H('tiles/flat'), [0, 0, 0]), P(H('tiles/flat'), [48, 0, 0])]
  const raised = [P(H('tiles/flat'), [0, 0, 0]), P(H('tiles/flat'), [48, 8, 0])]

  it('passes flat ground beside flat ground, and lists the region edges that show a skirt', () => {
    const r = checkLayout(lib, { placements: ground })
    expect(r.errors).toEqual([])
    expect(r.warnings.map((w) => w.code)).toEqual(['region-edge'])
    expect(r.warnings[0].message).toMatch(/^6 region edges/)
  })

  it('asks for a step wall where a raised tile meets the ground, facing the low tile, and accepts it', () => {
    const r = checkLayout(lib, { placements: raised })
    expect(codes(r)).toEqual(['edge-mismatch'])
    expect(r.errors[0].message).toContain('a step from 0 to 8')
    // The low tile is on -x: the plumb face (built facing -z) turns to -x at 90.
    expect(r.errors[0].fix).toContain('turn 90')
    expect(codes(checkLayout(lib, { placements: [...raised, P(H('walls/step-48'), [24, 0, 0], 270)] }))).toEqual(['step-facing', 'edge-mismatch'])
    expect(checkLayout(lib, { placements: [...raised, P(H('walls/step-48'), [24, 0, 0], 90)] }).errors).toEqual([])
  })

  it('hides a step only with a wall on the low ground, high enough; a wall on a matching seam is on an edge', () => {
    expect(checkLayout(lib, { placements: [...raised, P(H('walls/tall-48'), [24, 0, 0], 90)] }).errors).toEqual([])
    expect(codes(checkLayout(lib, { placements: [...raised, P(H('walls/tall-48'), [24, 500, 0], 90)] }))).toEqual(['wall-cannot-hide', 'edge-mismatch'])
    expect(codes(checkLayout(lib, { placements: [...raised, P(H('walls/low-48'), [24, 0, 0], 90)] }))).toEqual(['wall-cannot-hide', 'edge-mismatch'])
    const flat = checkLayout(lib, { placements: [...ground, P(H('walls/low-48'), [24, 0, 0], 90)] })
    expect(flat.warnings.map((w) => w.code)).not.toContain('wall-off-seam')
  })

  it('lines a ramp\'s side only with a ramp-step wall, its back to the ramp and its high end where the ramp rises', () => {
    const base = [P(H('tiles/ramp'), [0, 0, 0]), P(H('tiles/flat'), [0, 0, 48])]
    expect(codes(checkLayout(lib, { placements: base }))).toEqual(['edge-mismatch'])
    expect(codes(checkLayout(lib, { placements: [...base, P(H('walls/slope-wall-a'), [0, 0, 24], 180)] }))).toEqual(['wall-cannot-hide', 'edge-mismatch'])
    expect(checkLayout(lib, { placements: [...base, P(H('walls/slope-wall-b'), [0, 0, 24], 180)] }).errors).toEqual([])
    expect(codes(checkLayout(lib, { placements: [...base, P(H('walls/slope-wall-a'), [0, 0, 24], 0)] }))).toEqual(['wall-cannot-hide', 'edge-mismatch'])
    expect(codes(checkLayout(lib, { placements: [...base, P(H('walls/tall-48'), [0, 0, 24], 0)] }))).toEqual(['wall-cannot-hide', 'edge-mismatch'])
  })

  it('reads a turned edge reversed by the kit\'s own profiles', () => {
    expect(codes(checkLayout(lib, { placements: [P(H('tiles/ramp'), [0, 0, 0]), P(H('tiles/flat'), [48, 8, 0]), P(H('tiles/flat'), [0, 0, 48])] }))).toEqual(['edge-mismatch'])
    // Turned 180, the ramp's high edge faces -x.
    expect(checkLayout(lib, { placements: [P(H('tiles/ramp'), [0, 0, 0], 180), P(H('tiles/flat'), [-48, 8, 0])] }).errors).toEqual([])
  })

  it('refuses overlapping tiles and tiles off the module, and warns about decor off the ground', () => {
    const r = checkLayout(lib, { placements: [...ground, P(H('tiles/flat'), [12, 0, 0]), P(H('decor/rock'), [5, 4, 5])] })
    expect(codes(r)).toContain('overlap')
    expect(codes(r)).toContain('off-module')
    expect(r.warnings.map((w) => w.code)).toContain('decor-floating')
  })
})

describe('check_layout: bags', () => {
  it('gives the one-bag height and where the origin may sit, with an origin names what is clipped, and fits pieces with heights of their own', () => {
    const placements = [P(B('rooms/room'), [0, 0, 0], 0, { open: ['-z', '+z'] })]
    const r = checkLayout(lib, { placements })
    expect(r.bag.height).toBe(4)
    expect(r.bag.originOffsets).toEqual([[6, 9], [6, 9], [6, 9]])
    expect(codes(checkLayout(lib, { placements, origin: { x: 0n, y: 0n, z: 0n }, height: 4 }))).toEqual(['clipped'])
    expect(checkLayout(lib, { placements, origin: { x: 40n, y: 40n, z: 40n }, height: 4 }).errors).toEqual([])
    const auto = checkLayout(lib, { placements, origin: { x: 0n, y: 8n, z: 8n } })
    expect(auto.bag.height).toBeGreaterThan(4)
    expect(auto.bag.shiftForHeight).toEqual({ height: 4, by: [6, 0, 0] })
    // Two rooms in a height-5 bag, the second also in a height-4 cube of its own.
    const two = checkLayout(lib, { placements: [P(B('rooms/room'), [0, 0, 0], 0, { open: ['-z'] }), P(B('rooms/room'), [0, 0, 12], 0, { open: ['+z'], height: 4 })] })
    const [zlo, zhi] = (two.bag.originOffsets as Array<[number, number]>)[2]
    for (const o of [zlo, zhi]) { expect(((o + 12) % 16) + -6.5).toBeGreaterThanOrEqual(-0.5); expect(((o + 12) % 16) + 6.5).toBeLessThanOrEqual(16.5) }
  })
})

describe('the kit tools over MCP', () => {
  async function connect(hidden: unknown[], kits = lib) {
    const stub = Object.create(Agent.prototype) as Agent & Record<string, unknown>
    Object.assign(stub, {
      kits,
      keeper: { place: () => ({ position: { x: 1000n, y: 1000n, z: 1000n }, plane: 0 }) },
      target: (_c: unknown, from: unknown) => from,
      hide: async (input: { contents: { object: unknown } }) => { hidden.push(input.contents.object); return { text: 'hidden (stub).', data: { stub: true } } },
    })
    const server = createServer(stub)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(a)
    return client
  }
  const text = (r: unknown) => ((r as { content: Array<{ type: string; text?: string }> }).content.find((c) => c.type === 'text')?.text ?? '')

  it('answers kit, kit_piece and check_layout, draws a layout, places through hide, and refuses to publish a piece', async () => {
    const hidden: unknown[] = []
    const client = await connect(hidden)
    expect(text(await client.callTool({ name: 'kit', arguments: {} }))).toContain('toy-blocks (Toy Blocks): 13 pieces')
    expect(text(await client.callTool({ name: 'kit', arguments: { text: 'lamp' } }))).toContain(B('decor/lamp'))
    expect(text(await client.callTool({ name: 'kit_piece', arguments: { piece: B('rooms/room'), turn: 90 } }))).toContain('+z -> +x (gate)')
    const check = await client.callTool({ name: 'check_layout', arguments: { placements: [{ piece: B('rooms/room'), at: [0, 0, 0], open: ['-z', '+z'] }] } })
    expect((check as unknown as { structuredContent: { ok: boolean } }).structuredContent.ok).toBe(true)
    const pic = await client.callTool({ name: 'render', arguments: { layout: [{ piece: B('rooms/room'), at: [0, 0, 0] }, { piece: B('rooms/room'), at: [0, 0, 12] }], view: 'top', cut: 2, size: 64 } })
    expect((pic as { content: Array<{ type: string }> }).content.some((c) => c.type === 'image')).toBe(true)
    expect(text(await client.callTool({ name: 'place', arguments: { kit: B('decor/lamp'), turn: 90, coordinate: { dx: 0, dy: 0, dz: 0 }, height: 4 } }))).toContain(`Kit piece ${B('decor/lamp')} turned 90, as "lamp"`)
    expect((hidden[0] as { name: string }).name).toBe('lamp')
    expect(text(await client.callTool({ name: 'place', arguments: { kit: B('rooms/room'), coordinate: { dx: 0, dy: 0, dz: 0 }, height: 3 } }))).toMatch(/REFUSED: Not placed: .*would stick out/)
    expect(hidden).toHaveLength(1)
    // The guide: the workflow, then each installed kit's own GUIDE.md.
    const guide = (await client.readResource({ uri: 'cyberspace://kits.md' })).contents[0] as { text: string }
    expect(guide.text).toMatch(/^# Building with kits/)
    expect(guide.text).toContain('Gates are 2 by 3.')
    const pub = await client.callTool({ name: 'publish_object', arguments: { object: { ...kitObject(lib, B('decor/lamp')).payload, name: 'renamed' } } })
    expect(text(pub)).toMatch(/REFUSED: Not published: .* is a kit piece/)
  })

  it('offers no kits resource when no kits are installed', async () => {
    const client = await connect([], new KitLibrary([join(ROOT, 'empty')]))
    expect((await client.listResources()).resources.map((r) => r.uri)).not.toContain('cyberspace://kits.md')
    expect(text(await client.callTool({ name: 'kit', arguments: {} }))).toMatch(/No kits are installed/)
  })
})

// The installer's own read of a payload must survive its checks: a sanity check of the fixture itself.
it('the fixture kits are installed where the library reads them', () => {
  expect(JSON.parse(readFileSync(join(KITS, 'toy-blocks', 'catalog.json'), 'utf8')).standard.rules.family).toBe('rooms')
})
