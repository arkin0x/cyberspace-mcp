// kits.test.ts: the kit tools on a made-up kit written into a temp folder
// (no real kit is in this repository, and none may be: kits are local data,
// never published). A box room with two doors, a plug and a door stand in
// for the Maze Kit; flat and raised ground tiles and a step wall for the
// Landscape Kit. Covers: no kits installed, lookup and search, the turn and
// the scale of a placed copy, check_layout's maze rules (joins, plugs, open
// faces, sizes, floors over hatches, the grid), its landscape rules (edges,
// steps hidden by facing walls, region edges, decor on the ground), the bag
// check, render's layout picture, place with kit through hide, and the
// refusal to publish a kit piece. No network.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { Agent } from '../src/agent.js'
import { KitLibrary, kitsDirCandidates, searchKits } from '../src/kits/library.js'
import { checkLayout } from '../src/kits/layout.js'
import { kitPieceIn } from '../src/kits/tools.js'
import { kitObject, turnY } from '../src/kits/transform.js'
import { createServer } from '../src/server.js'
import { validateSnoPayload } from '../src/sno.js'

type V = [number, number, number]

/** A closed box from lo to hi, wound outward, one colour: enough for bounds, the ground under a point, and a picture. */
function box(name: string, lo: V, hi: V, extra: Record<string, unknown> = {}) {
  const [a, b, c] = lo, [d, e, f] = hi
  const points = [[a, b, c], [d, b, c], [d, e, c], [a, e, c], [a, b, f], [d, b, f], [d, e, f], [a, e, f]]
  // Whole units on the wire, the rest in ticks (DECK-0003 1.2).
  const vertices = points.map((q) => q.map((x) => Math.floor(x)))
  const ticks = points.map((q, i) => q.map((x, k) => Math.round((x - vertices[i][k]) * 120)))
  const faces = [[4, 5, 6], [4, 6, 7], [1, 0, 3], [1, 3, 2], [5, 1, 2], [5, 2, 6], [0, 4, 7], [0, 7, 3], [3, 7, 6], [3, 6, 2], [0, 1, 5], [0, 5, 4]]
  return { v: 2, name, unit: 0, mode: 'solid', vertices, ticks, colors: vertices.map(() => 7), faces, ...extra }
}

const bag = (min: V, max: V) => ({ minHeight: 5, offsets: [[8, 23], [8, 23], [8, 23]], note: 'needs a bag of height 5' , min, max })

function writeKits(): string {
  const root = mkdtempSync(join(tmpdir(), 'kits-test-'))
  const maze = join(root, 'maze-kit'), land = join(root, 'landscape-kit')
  const file = (dir: string, rel: string, payload: unknown) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), JSON.stringify(payload)) }
  const roomPayload = box('Maze Kit: test room', [-8, -8, -8], [8, 8, 8], { constrain: 'all' })
  file(maze, 'test/rooms/room.json', roomPayload)
  file(maze, 'test/rooms/room-hatch.json', box('Maze Kit: test hatch room', [-8, -8, -8], [8, 8, 8], { constrain: 'all' }))
  file(maze, 'test/rooms/room-partial.json', box('Maze Kit: test partial floor', [-8, -8, -8], [8, 8, 8], { constrain: 'all' }))
  file(maze, 'test/rooms/room-hall.json', box('Maze Kit: test hall room', [-8, -8, -8], [8, 8, 8], { constrain: 'all' }))
  file(maze, 'shared/plugs/wall/plug-wall-door.json', box('Maze Kit: wall plug, door', [-1, -8, 8], [1, -5, 8.25]))
  file(maze, 'shared/plugs/ceiling/plug-ceiling-door.json', box('Maze Kit: ceiling plug, door', [-1, 8, -1.5], [1, 8.01, 1.5]))
  file(maze, 'shared/plugs/ceiling-recessed/plug-ceiling-recessed-door.json', box('Maze Kit: recessed plug, door', [-1, 7.5, -1.5], [1, 8, 1.5]))
  file(maze, 'shared/plugs/reducers/wall/plug-wall-reduce-hallway-door.json', box('Maze Kit: reducer', [-2, -8, 8], [2, -2, 8.25]))
  file(maze, 'locks/doors/door-standard/door-standard.json', box('Maze Kit: door (2 x 3)', [-1, 0, -0.5], [1, 3, 0], { constrain: 'all' }))
  file(maze, 'test/decor/barrel.json', box('Maze Kit: barrel', [-0.4, 0, -0.4], [0.4, 1, 0.4], { constrain: 'all' }))
  const tile = (id: string, openings: unknown[], floorSeals: unknown[], extra: Record<string, unknown> = {}) => ({
    id: `maze-kit/${id}`, file: `${id}.json`, name: id.split('/').pop(), set: 'test', group: 'rooms', kind: 'tile', bytes: 600, vertices: 8, faces: 12, unit: 0,
    bounds: { min: [-8, -8, -8], max: [8, 8, 8] }, constrain: 'all', bag: bag([-8, -8, -8], [8, 8, 8]), tags: ['room'], notes: [],
    cells: { lo: [0, 0, 0], hi: [0, 0, 0] }, footprint: [16, 16, 16], levels: 1, openings, floorSeals, ...extra,
  })
  const door = (face: string) => ({ face, size: 'door', w: 2, h: 3, cell: [0, 0, 0] })
  const catalog = {
    format: 'cyberspace-kit-catalog-1', kit: 'maze-kit', title: 'Test maze kit', generated: '2026-11-15T00:00:00Z', source: { repo: 'test' }, standard: { tile: 16 },
    pieces: [
      tile('test/rooms/room', [door('+z'), door('-z')], [{ cell: [0, 0, 0], seals: ['window', 'door', 'door-x', 'hallway'] }]),
      tile('test/rooms/room-hatch', [door('+z'), { face: '+y', size: 'door', w: 2, h: 3, cell: [0, 0, 0] }], [{ cell: [0, 0, 0], seals: ['window', 'door', 'door-x'] }]),
      tile('test/rooms/room-partial', [door('-z')], [{ cell: [0, 0, 0], seals: ['window'] }]),
      tile('test/rooms/room-hall', [{ face: '-z', size: 'hallway', w: 4, h: 6, cell: [0, 0, 0] }, door('+z')], [{ cell: [0, 0, 0], seals: ['window'] }]),
      { id: 'maze-kit/shared/plugs/wall/plug-wall-door', file: 'shared/plugs/wall/plug-wall-door.json', name: 'wall plug, door', set: 'shared', group: 'plugs/wall', kind: 'plug', bytes: 600, vertices: 8, faces: 12, unit: 0, bounds: { min: [-1, -8, -8.25], max: [1, -5, -8] }, constrain: 'all', bag: bag([-1, -8, -8.25], [1, -5, -8]), tags: ['plug'], notes: [], plug: { side: 'wall', size: 'door' } },
      { id: 'maze-kit/shared/plugs/ceiling/plug-ceiling-door', file: 'shared/plugs/ceiling/plug-ceiling-door.json', name: 'ceiling plug, door', set: 'shared', group: 'plugs/ceiling', kind: 'plug', bytes: 600, vertices: 8, faces: 12, unit: 0, bounds: { min: [-1, 8, -1.5], max: [1, 8.01, 1.5] }, constrain: 'all', bag: bag([-1, 8, -1.5], [1, 8, 1.5]), tags: ['plug'], notes: [], plug: { side: 'ceiling', size: 'door' } },
      { id: 'maze-kit/shared/plugs/ceiling-recessed/plug-ceiling-recessed-door', file: 'shared/plugs/ceiling-recessed/plug-ceiling-recessed-door.json', name: 'recessed plug, door', set: 'shared', group: 'plugs/ceiling-recessed', kind: 'recessed-plug', bytes: 600, vertices: 8, faces: 12, unit: 0, bounds: { min: [-1, 7.5, -1.5], max: [1, 8, 1.5] }, constrain: 'all', bag: bag([-1, 7.5, -1.5], [1, 8, 1.5]), tags: ['plug'], notes: [], plug: { side: 'ceiling-recessed', size: 'door' } },
      { id: 'maze-kit/shared/plugs/reducers/wall/plug-wall-reduce-hallway-door', file: 'shared/plugs/reducers/wall/plug-wall-reduce-hallway-door.json', name: 'reducer', set: 'shared', group: 'plugs/reducers/wall', kind: 'reducer', bytes: 600, vertices: 8, faces: 12, unit: 0, bounds: { min: [-2, -8, -8.25], max: [2, -2, -8] }, constrain: null, bag: bag([-2, -8, -8.25], [2, -2, -8]), tags: ['reducer'], notes: [], reducer: { side: 'wall', from: 'hallway', to: 'door' } },
      { id: 'maze-kit/locks/doors/door-standard/door-standard', file: 'locks/doors/door-standard/door-standard.json', name: 'door (2 x 3)', set: 'locks', group: 'doors/door-standard', kind: 'door', closes: 'door', bytes: 600, vertices: 8, faces: 12, unit: 0, bounds: { min: [-1, 0, 0], max: [1, 3, 0.5] }, constrain: 'all', bag: bag([-1, 0, 0], [1, 3, 0.5]), tags: ['door'], notes: [] },
      { id: 'maze-kit/test/decor/barrel', file: 'test/decor/barrel.json', name: 'barrel', set: 'test', group: 'decor', kind: 'decor', mount: 'floor', size: [1, 1, 1], bytes: 600, vertices: 8, faces: 12, unit: 0, bounds: { min: [-0.4, 0, -0.4], max: [0.4, 1, 0.4] }, constrain: 'all', bag: bag([-0.4, 0, -0.4], [0.4, 1, 0.4]), tags: ['decor', 'barrel'], notes: [] },
    ],
  }
  writeFileSync(join(maze, 'catalog.json'), JSON.stringify(catalog))
  // Landscape: a 64 slab of flat ground (its top at 0), and a step wall along x.
  file(land, 'plains/tiles/flat.json', box('Landscape Kit: flat', [-32, -16, -32], [32, 0, 32], { constrain: 'all' }))
  file(land, 'plains/walls/step-64.json', box('Landscape Kit: step', [-32, -1, -3], [32, 12, 3], { constrain: 'all' }))
  file(land, 'plains/decor/rock.json', box('Landscape Kit: rock', [-1, -0.2, -1], [1, 1.5, 1], { constrain: 'all' }))
  const lcat = {
    format: 'cyberspace-kit-catalog-1', kit: 'landscape-kit', title: 'Test landscape kit', generated: '2026-11-15T00:00:00Z', source: { repo: 'test' }, standard: { tile: 64 },
    pieces: [
      { id: 'landscape-kit/plains/tiles/flat', file: 'plains/tiles/flat.json', name: 'flat', set: 'plains', group: 'tiles', kind: 'tile', bytes: 600, vertices: 8, faces: 12, unit: 0, bounds: { min: [-32, -16, -32], max: [32, 0, 32] }, constrain: 'all', bag: bag([-32, -16, -32], [32, 0, 32]), tags: ['ground'], notes: [], footprint: [64, 64], edges: { px: 'L0', nx: 'L0', pz: 'L0', nz: 'L0' }, base: -16, step: 2 },
      { id: 'landscape-kit/plains/tiles/ramp', file: 'plains/tiles/flat.json', name: 'ramp', set: 'plains', group: 'tiles', kind: 'tile', bytes: 600, vertices: 8, faces: 12, unit: 0, bounds: { min: [-32, -16, -32], max: [32, 0, 32] }, constrain: 'all', bag: bag([-32, -16, -32], [32, 0, 32]), tags: ['ground', 'ramp'], notes: [], footprint: [64, 64], edges: { px: 'L10', nx: 'L0', pz: 'R+', nz: 'R+' }, base: -16, step: 2 },
      { id: 'landscape-kit/plains/walls/step-64', file: 'plains/walls/step-64.json', name: 'step 64', set: 'plains', group: 'walls', kind: 'wall', bytes: 600, vertices: 8, faces: 12, unit: 0, bounds: { min: [-32, -1, -3], max: [32, 12, 3] }, constrain: 'all', bag: bag([-32, -1, -3], [32, 12, 3]), tags: ['wall', 'step-wall'], notes: [], wall: { kind: 'step', length: 64, height: 12.8, segments: [[[-32, 0], [32, 0]]], hides: [[[-32, 0], [32, 0]]], low: '-z' } },
      { id: 'landscape-kit/plains/decor/rock', file: 'plains/decor/rock.json', name: 'rock', set: 'plains', group: 'decor', kind: 'decor', bytes: 600, vertices: 8, faces: 12, unit: 0, bounds: { min: [-1, -0.2, -1], max: [1, 1.5, 1] }, constrain: 'all', bag: bag([-1, -0.2, -1], [1, 1.5, 1]), tags: ['decor'], notes: [], mount: 'floor', size: [2, 2, 2], solid: true, sink: 0.2 },
    ],
  }
  writeFileSync(join(land, 'catalog.json'), JSON.stringify(lcat))
  return root
}

const ROOT = writeKits()
const lib = new KitLibrary([ROOT])
const P = (piece: string, at: V, turn = 0, extra: Record<string, unknown> = {}) => ({ piece, at, turn, ...extra })
const codes = (r: { errors: Array<{ code: string }> }) => r.errors.map((e) => e.code)

describe('kits: the library', () => {
  it('says plainly that no kits are installed, and where it looked', () => {
    const none = new KitLibrary(kitsDirCandidates(join(ROOT, 'nowhere', 'state')))
    expect(none.dir()).toBeNull()
    expect(() => none.entries()).toThrow(/No kits are installed on this server: no <kit>\/catalog.json in .*nowhere.*kits or .*kits/)
    expect(kitsDirCandidates('/x/state')).toEqual(['/x/state/kits', '/x/kits'])
    expect(kitsDirCandidates('/x/state', '/elsewhere')).toEqual(['/elsewhere'])
  })

  it('finds a piece by its id or the unique end of it, and searches by words and filters', () => {
    expect(lib.get('maze-kit/test/rooms/room').name).toBe('room')
    expect(lib.get('rooms/room-hatch').id).toBe('maze-kit/test/rooms/room-hatch')
    expect(() => lib.get('nothing-here')).toThrow(/No kit piece/)
    expect(searchKits(lib, { text: 'barrel' }).pieces.map((p) => p.id)).toEqual(['maze-kit/test/decor/barrel'])
    expect(searchKits(lib, { kind: 'plug' }).total).toBe(2)
    expect(searchKits(lib, { opening: 'hallway' }).pieces.map((p) => p.id)).toEqual(['maze-kit/shared/plugs/reducers/wall/plug-wall-reduce-hallway-door', 'maze-kit/test/rooms/room-hall'])
    expect(searchKits(lib, { edge: 'R+' }).pieces.map((p) => p.id)).toEqual(['landscape-kit/plains/tiles/ramp'])
  })

  it('turns a copy by quarter turns about Y and scales it by its unit, under the build\'s own name', () => {
    const k = kitObject(lib, 'test/decor/barrel', { turn: 90, scale: 1 })
    expect(k.payload.name).toBe('barrel')
    expect(k.payload.unit).toBe(1)
    expect(validateSnoPayload(k.payload).ok).toBe(true)
    const door = kitObject(lib, 'locks/doors/door-standard/door-standard', { turn: 90 })
    // x, z -> z, -x: the door's slab (z 0 to 0.5) now lies from x 0 to 0.5.
    const xs = door.shard.vertices.map((v) => v.p[0] + (v.t?.[0] ?? 0) / 120)
    expect(Math.min(...xs)).toBe(0)
    expect(Math.max(...xs)).toBe(0.5)
    expect(turnY([1, 0, 0], 1)).toEqual([0, 0, -1])
    expect(() => kitObject(lib, 'test/decor/barrel', { turn: 45 })).toThrow(/multiple of 90/)
    expect(() => kitObject(lib, 'test/decor/barrel', { scale: -1 })).toThrow(/whole number, 0 or more/)
  })

  it('knows a kit piece when an agent tries to publish one on its own', () => {
    expect(kitPieceIn(lib, { name: 'Maze Kit: anything', vertices: [], faces: [] })).toBe('Maze Kit: anything')
    const k = kitObject(lib, 'test/decor/barrel')
    expect(kitPieceIn(lib, k.shard)).toBe('maze-kit/test/decor/barrel')
    expect(kitPieceIn(lib, { ...k.shard, name: 'my own barrel' })).toBeNull()
  })
})

describe('check_layout: the Maze Kit rules', () => {
  it('passes two rooms joined door to door, the far doors plugged and the way in left open', () => {
    const r = checkLayout(lib, { placements: [
      P('test/rooms/room', [0, 0, 0], 0, { open: ['-z'] }),
      P('test/rooms/room', [0, 0, 16]),
      // The far door faces +z: a wall plug is built on -z, so it turns 180.
      P('shared/plugs/wall/plug-wall-door', [0, 0, 16], 180),
      P('test/decor/barrel', [2, -8, 18]),
    ] })
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.text).toMatch(/^Layout OK/)
  })

  it('names an opening into nothing, with the plug that fits and its turn', () => {
    const r = checkLayout(lib, { placements: [P('test/rooms/room', [0, 0, 0], 90)] })
    expect(codes(r)).toEqual(['opens-into-nothing', 'opens-into-nothing'])
    // Turned 90, its +z door faces +x: the plug for +x is turned 90.
    expect(r.errors.map((e) => e.fix).join(' ')).toContain('plug-wall-door at [0, 0, 0] turned 90')
    expect(r.errors.map((e) => e.fix).join(' ')).toContain('plug-wall-door at [0, 0, 0] turned 270')
  })

  it('refuses a plug where there is no opening, a doorway against a wall, and tiles in one cell', () => {
    const r = checkLayout(lib, { placements: [
      P('test/rooms/room', [0, 0, 0], 0, { open: ['-z'] }),
      P('test/rooms/room', [0, 0, 16], 90),
      P('test/rooms/room', [0, 0, 16]),
      P('shared/plugs/wall/plug-wall-door', [0, 0, 0], 90),
    ] })
    expect(codes(r)).toContain('overlap')
    expect(codes(r)).toContain('plug-no-opening')
    const off = checkLayout(lib, { placements: [P('test/rooms/room', [0, 0, 0], 0, { open: ['-z', '+z'] }), P('test/rooms/room', [0, 0, 20], 0, { open: ['-z', '+z'] })] })
    expect(codes(off)).toEqual(['off-grid'])
    const wall = checkLayout(lib, { placements: [P('test/rooms/room', [0, 0, 0], 0, { open: ['-z'] }), P('test/rooms/room', [0, 0, 16], 90, { open: ['+x', '-x'] })] })
    expect(codes(wall)).toEqual(['opens-into-wall'])
  })

  it('asks for a reducer where a hallway meets a door, and accepts it placed with the larger', () => {
    const base = [P('test/rooms/room-hall', [0, 0, 16], 0, { open: ['+z'] }), P('test/rooms/room', [0, 0, 0], 0, { open: ['-z'] })]
    const r = checkLayout(lib, { placements: base })
    expect(codes(r)).toEqual(['needs-reducer'])
    expect(r.errors[0].fix).toContain('plug-wall-reduce-hallway-door at [0, 0, 16], or')
    const ok = checkLayout(lib, { placements: [...base, P('shared/plugs/reducers/wall/plug-wall-reduce-hallway-door', [0, 0, 16], 0)] })
    expect(ok.errors).toEqual([])
  })

  it('seals a ceiling hatch with the floor above when it covers it, and asks for the recessed plug when it does not', () => {
    const covered = checkLayout(lib, { placements: [P('test/rooms/room-hatch', [0, 0, 0], 0, { open: ['+z'] }), P('test/rooms/room', [0, 16, 0], 0, { open: ['+z', '-z'] })] })
    expect(covered.errors).toEqual([])
    const zfight = checkLayout(lib, { placements: [P('test/rooms/room-hatch', [0, 0, 0], 0, { open: ['+z'] }), P('test/rooms/room', [0, 16, 0], 0, { open: ['+z', '-z'] }), P('shared/plugs/ceiling/plug-ceiling-door', [0, 0, 0])] })
    expect(codes(zfight)).toEqual(['zfight'])
    const partial = checkLayout(lib, { placements: [P('test/rooms/room-hatch', [0, 0, 0], 0, { open: ['+z'] }), P('test/rooms/room-partial', [0, 16, 0], 0, { open: ['-z'] })] })
    expect(codes(partial)).toEqual(['needs-recessed-plug'])
    const fixed = checkLayout(lib, { placements: [P('test/rooms/room-hatch', [0, 0, 0], 0, { open: ['+z'] }), P('test/rooms/room-partial', [0, 16, 0], 0, { open: ['-z'] }), P('shared/plugs/ceiling-recessed/plug-ceiling-recessed-door', [0, 0, 0])] })
    expect(fixed.errors).toEqual([])
    // Turned a quarter, the hatch lies along x, and the floor above (sealing door-x) still covers it.
    const quarter = checkLayout(lib, { placements: [P('test/rooms/room-hatch', [0, 0, 0], 90, { open: ['+x'] }), P('test/rooms/room', [0, 16, 0], 0, { open: ['+z', '-z'] })] })
    expect(quarter.errors).toEqual([])
  })

  it('takes a closed door in a doorway as its seal, from either room, and refuses one in no opening', () => {
    // The door's origin is the sill's centre on the rim: the tile's position plus (0, -8, -8) for its -z opening.
    const r = checkLayout(lib, { placements: [P('test/rooms/room', [0, 0, 0], 0, { open: ['+z'] }), P('locks/doors/door-standard/door-standard', [0, -8, -8], 0)] })
    expect(r.errors).toEqual([])
    // Turned 180 it closes the +z opening, at (0, -8, +8): the same place as the next room's -z door, from that side.
    const other = checkLayout(lib, { placements: [P('test/rooms/room', [0, 0, 0], 0, { open: ['-z'] }), P('locks/doors/door-standard/door-standard', [0, -8, 8], 180)] })
    expect(other.errors).toEqual([])
    const lost = checkLayout(lib, { placements: [P('test/rooms/room', [0, 0, 0], 0, { open: ['-z', '+z'] }), P('locks/doors/door-standard/door-standard', [5, -8, 8], 0)] })
    expect(codes(lost)).toEqual(['door-no-opening'])
  })

  it('warns when decor floats above the floor or stands outside every room', () => {
    const r = checkLayout(lib, { placements: [P('test/rooms/room', [0, 0, 0], 0, { open: ['-z', '+z'] }), P('test/decor/barrel', [0, -4, 0]), P('test/decor/barrel', [40, 0, 0])] })
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['decor-floating', 'decor-outside']))
    expect(r.warnings.find((w) => w.code === 'decor-floating')!.fix).toBe('place it at y -8')
  })
})

describe('check_layout: the Landscape Kit rules', () => {
  const ground = [P('landscape-kit/plains/tiles/flat', [0, 0, 0]), P('landscape-kit/plains/tiles/flat', [64, 0, 0])]

  it('passes flat ground beside flat ground, and lists the region edges that show a skirt', () => {
    const r = checkLayout(lib, { placements: ground })
    expect(r.errors).toEqual([])
    expect(r.warnings.map((w) => w.code)).toEqual(['region-edge'])
    expect(r.warnings[0].message).toMatch(/^6 region edges/)
  })

  it('asks for a step wall where a raised tile meets the ground, facing the low tile, and accepts it', () => {
    const raised = [P('landscape-kit/plains/tiles/flat', [0, 0, 0]), P('landscape-kit/plains/tiles/flat', [64, 10, 0])]
    const r = checkLayout(lib, { placements: raised })
    expect(codes(r)).toEqual(['edge-mismatch'])
    expect(r.errors[0].message).toContain('a step from 0 to 10')
    // The low tile is on -x: the plumb face (-z, built) turns to -x at 90.
    expect(r.errors[0].fix).toContain('turn 90')
    const wrong = checkLayout(lib, { placements: [...raised, P('landscape-kit/plains/walls/step-64', [32, 0, 0], 270)] })
    expect(codes(wrong)).toEqual(['step-facing'])
    const right = checkLayout(lib, { placements: [...raised, P('landscape-kit/plains/walls/step-64', [32, 0, 0], 90)] })
    expect(right.errors).toEqual([])
  })

  it('reads a turned edge reversed, and wants a ramp\'s side lined', () => {
    // The ramp's px edge (L10) meets a raised tile; its R+ sides are region edges or need a bank.
    const r = checkLayout(lib, { placements: [P('landscape-kit/plains/tiles/ramp', [0, 0, 0]), P('landscape-kit/plains/tiles/flat', [64, 10, 0]), P('landscape-kit/plains/tiles/flat', [0, 0, 64])] })
    expect(codes(r)).toEqual(['edge-mismatch'])
    expect(r.errors[0].message).toContain('a ramp\'s side')
    // Turned 180, the ramp's high edge faces -x.
    const turned = checkLayout(lib, { placements: [P('landscape-kit/plains/tiles/ramp', [0, 0, 0], 180), P('landscape-kit/plains/tiles/flat', [-64, 10, 0])] })
    expect(turned.errors).toEqual([])
  })

  it('refuses overlapping tiles and warns about decor off the ground', () => {
    const r = checkLayout(lib, { placements: [...ground, P('landscape-kit/plains/tiles/flat', [16, 0, 0]), P('landscape-kit/plains/decor/rock', [5, 4, 5])] })
    expect(codes(r)).toContain('overlap')
    expect(codes(r)).toContain('off-module')
    expect(r.warnings.map((w) => w.code)).toContain('decor-floating')
  })
})

describe('check_layout: bags', () => {
  it('gives the one-bag height and where the origin may sit, and with an origin names what is clipped', () => {
    const placements = [P('test/rooms/room', [0, 0, 0], 0, { open: ['-z', '+z'] })]
    const r = checkLayout(lib, { placements })
    expect(r.bag.height).toBe(5)
    expect(r.bag.originOffsets).toEqual([[8, 23], [8, 23], [8, 23]])
    const clipped = checkLayout(lib, { placements, origin: { x: 0n, y: 0n, z: 0n }, height: 5 })
    expect(codes(clipped)).toEqual(['clipped'])
    const fine = checkLayout(lib, { placements, origin: { x: 40n, y: 40n, z: 40n }, height: 5 })
    expect(fine.errors).toEqual([])
    // With no height: the lowest that fits here, and the move that fits the smaller one.
    const auto = checkLayout(lib, { placements, origin: { x: 0n, y: 8n, z: 8n } })
    expect(auto.bag.height).toBeGreaterThan(5)
    expect(auto.bag.shiftForHeight).toEqual({ height: 5, by: [8, 0, 0] })
  })
})

describe('the kit tools over MCP', () => {
  async function connect(hidden: unknown[]) {
    // An agent with only what the kit tools touch: the kits, a place to stand, and a hide that records.
    const stub = Object.create(Agent.prototype) as Agent & Record<string, unknown>
    Object.assign(stub, {
      kits: lib,
      keeper: { place: () => ({ position: { x: 1000n, y: 1000n, z: 1000n }, plane: 0 }) },
      target: (_c: unknown, from: unknown) => from,
      hide: async (input: { contents: { object: unknown } }) => { hidden.push(input.contents.object); return { text: 'hidden (stub).', data: { stub: true } } },
      relays: undefined,
    })
    const server = createServer(stub)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(a)
    return client
  }

  it('answers kit, kit_piece and check_layout, draws a layout, places through hide, and refuses to publish a piece', async () => {
    const hidden: unknown[] = []
    const client = await connect(hidden)
    const text = (r: unknown) => ((r as { content: Array<{ type: string; text?: string }> }).content.find((c) => c.type === 'text')?.text ?? '')
    expect(text(await client.callTool({ name: 'kit', arguments: {} }))).toContain('maze-kit (Test maze kit): 10 pieces')
    expect(text(await client.callTool({ name: 'kit', arguments: { text: 'barrel' } }))).toContain('maze-kit/test/decor/barrel')
    const piece = await client.callTool({ name: 'kit_piece', arguments: { piece: 'rooms/room', turn: 90 } })
    expect(text(piece)).toContain('+z -> +x (door)')
    const check = await client.callTool({ name: 'check_layout', arguments: { placements: [{ piece: 'rooms/room', at: [0, 0, 0], open: ['-z', '+z'] }] } })
    expect((check as unknown as { structuredContent: { ok: boolean } }).structuredContent.ok).toBe(true)
    const pic = await client.callTool({ name: 'render', arguments: { layout: [{ piece: 'rooms/room', at: [0, 0, 0] }, { piece: 'rooms/room', at: [0, 0, 16] }], view: 'top', cut: 2, size: 64 } })
    expect((pic as { content: Array<{ type: string }> }).content.some((c) => c.type === 'image')).toBe(true)
    const placed = await client.callTool({ name: 'place', arguments: { kit: 'test/decor/barrel', turn: 90, coordinate: { dx: 0, dy: 0, dz: 0 }, height: 4 } })
    expect(text(placed)).toContain('Kit piece maze-kit/test/decor/barrel turned 90, as "barrel"')
    expect((hidden[0] as { name: string }).name).toBe('barrel')
    // A room hidden at height 4 would be clipped: refused before anything is hidden.
    const clipped = await client.callTool({ name: 'place', arguments: { kit: 'rooms/room', coordinate: { dx: 0, dy: 0, dz: 0 }, height: 4 } })
    expect(text(clipped)).toMatch(/REFUSED: Not placed: maze-kit\/test\/rooms\/room would stick out/)
    expect(hidden).toHaveLength(1)
    const guide = await client.readResource({ uri: 'cyberspace://kits.md' })
    expect((guide.contents[0] as { text: string }).text).toMatch(/^# Building with kits/)
    const pub = await client.callTool({ name: 'publish_object', arguments: { object: kitObject(lib, 'test/decor/barrel').payload } })
    expect(text(pub)).toMatch(/REFUSED: Not published: maze-kit\/test\/decor\/barrel is a kit piece/)
  })
})
