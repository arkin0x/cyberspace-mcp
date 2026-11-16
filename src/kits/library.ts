// library.ts: the kits an operator copied onto this machine, read from a
// local directory (arkinox, 2026-11-15: "dont publish the kits ever. can we
// just copy them to a directory for xor to use"). Nothing here downloads,
// publishes or sends a kit: a kit is local data, one folder per kit, each
// with a catalog.json (format cyberspace-kit-catalog-1, docs/kits.md) and its
// pieces' SNO payloads as files beside it. The kits' own repositories write
// these folders (each kit's own export script).
//
// Where: the kitsDir setting (config.json "kitsDir", --kits-dir), else the
// first of <state>/kits and <state>/../kits that holds a catalog. With none,
// every kit tool says that no kits are installed and where it looked.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

export const CATALOG_FORMAT = 'cyberspace-kit-catalog-1'

export type Side = 'px' | 'nx' | 'pz' | 'nz'
export type Face = '+x' | '-x' | '+y' | '-y' | '+z' | '-z'
export type V3 = [number, number, number]
type Seg = [[number, number], [number, number]]

/** One piece of a kit, as its catalog lists it. Every field past the first block is optional: a kit says what it knows. */
export interface KitEntry {
  /** The kit's name, from its catalog. Added on load. */
  kit: string
  /** The folder the kit was read from, added on load (its files are under it). */
  folder: string
  id: string
  file: string
  name: string
  set: string
  group: string
  kind: string
  bytes: number
  vertices: number
  faces: number
  unit: number
  bounds: { min: V3; max: V3 }
  constrain: string | null
  bag: { minHeight: number; offsets: Array<[number, number]>; note: string }
  tags: string[]
  notes: string[]
  blurb?: string
  origin?: string
  /** A standard job this piece does, which hints name instead of an id (plug:wall:<size>, door:<size>, step-wall:<length>...): the exporter sets it. */
  role?: string
  opacity?: number
  // A rooms kit (rules.family 'rooms')
  cells?: { lo: V3; hi: V3 }
  footprint?: number[]
  levels?: number
  openings?: Array<{ face: Face; size: string; w: number; h: number; cell: V3 }>
  floorSeals?: Array<{ cell: V3; seals: string[] }>
  plug?: { side: 'wall' | 'floor' | 'ceiling' | 'ceiling-recessed'; size: string; room?: string }
  reducer?: { side: 'wall' | 'floor'; from: string; to: string }
  host?: string
  cap?: { level: string; faces: Face[] }
  mount?: 'floor' | 'wall' | 'ceiling'
  size?: number[]
  closes?: string
  decorGroup?: string
  // A terrain kit (rules.family 'terrain')
  edges?: Record<Side, string>
  base?: number
  step?: number
  wall?: { kind: 'seam' | 'step' | 'ramp-step'; length: number; height: number; segments: Seg[]; hides: Seg[]; low?: string; corner?: boolean; highEnd?: number }
  solid?: boolean
  sink?: number
}

/**
 * What a catalog tells check_layout about its kit, so that no kit is named in
 * this code: the rule family, the grid, and for a terrain kit what each edge
 * profile means.
 */
export interface KitRules {
  family: 'rooms' | 'terrain'
  /** The tile's side in gibsons. */
  tile: number
  /** Rooms: how far walls stand inside the cell boundary, the floor below the tile's centre, and a door's origin from its tile for the -z opening. */
  wallInset?: number
  floor?: number
  doorOffset?: V3
  /** Terrain: the module tile edges sit on, the least height of a seam wall that hides a step, and each profile's meaning. */
  module?: number
  minHideHeight?: number
  profiles?: Record<string, { flat?: number; open?: boolean; reverse?: string; ramp?: boolean; rises?: number }>
  /** The face wall plugs, reducers, doors and step walls are built facing, in world axes. */
  builtFacing?: string
}

export interface KitCatalog {
  format: string
  kit: string
  /** The folder it was read from, added on load. */
  folder: string
  title: string
  generated: string
  source: { repo?: string; commit?: string; zips?: string[] }
  notice?: string
  standard: Record<string, unknown> & { rules?: KitRules }
  pieces: KitEntry[]
}

/** A refusal-shaped error: the kit tools turn it into the tool's refusal. */
export class KitError extends Error {}

/** Where kits are looked for, in order: the setting alone when it is given, else <state>/kits and <state>/../kits. */
export function kitsDirCandidates(stateDir: string, kitsDir?: string): string[] {
  if (kitsDir) return [resolve(kitsDir)]
  return [join(resolve(stateDir), 'kits'), join(dirname(resolve(stateDir)), 'kits')]
}

/** The kits in one directory, read once and again whenever a catalog file changes. */
export class KitLibrary {
  private loaded: { dir: string; stamp: string; catalogs: KitCatalog[]; byId: Map<string, KitEntry>; shapes?: Map<string, string> } | null = null

  constructor(private readonly candidates: string[]) {}

  /** The directory the kits are read from, or null when none of the candidates holds one. */
  dir(): string | null {
    for (const d of this.candidates) {
      if (catalogFiles(d).length) return d
    }
    return null
  }

  /** The sentence for a server with no kits. */
  noKits(): string {
    return `No kits are installed on this server: no <kit>/catalog.json in ${this.candidates.join(' or ')}. Kits are local data your human copies onto this machine (docs/kits.md says how); nothing here can download one. Build from your own objects instead.`
  }

  private load(): NonNullable<KitLibrary['loaded']> {
    const dir = this.dir()
    if (!dir) throw new KitError(this.noKits())
    const files = catalogFiles(dir)
    const stamp = files.map((f) => `${f}:${statSync(f).mtimeMs}`).join('|')
    if (this.loaded && this.loaded.dir === dir && this.loaded.stamp === stamp) return this.loaded
    const catalogs: KitCatalog[] = []
    const byId = new Map<string, KitEntry>()
    for (const f of files) {
      let c: KitCatalog
      try { c = JSON.parse(readFileSync(f, 'utf8')) as KitCatalog } catch { continue }
      if (c.format !== CATALOG_FORMAT || !Array.isArray(c.pieces)) continue
      const folder = f.split(sep).slice(-2)[0]
      // The catalog names its kit; the folder is only where it lives (a kit copied to another folder keeps its rules).
      c.folder = folder
      c.kit = typeof c.kit === 'string' && c.kit ? c.kit : folder
      for (const p of c.pieces) {
        p.kit = c.kit
        p.folder = folder
        p.tags ??= []
        p.notes ??= []
        byId.set(p.id, p)
      }
      catalogs.push(c)
    }
    if (!catalogs.length) throw new KitError(`${this.noKits()} (${dir} has catalogs, but none in the format ${CATALOG_FORMAT}.)`)
    this.loaded = { dir, stamp, catalogs, byId }
    return this.loaded
  }

  catalogs(): KitCatalog[] {
    return this.load().catalogs
  }

  entries(): KitEntry[] {
    return this.load().catalogs.flatMap((c) => c.pieces)
  }

  /** The rules of a piece's kit, or null for a kit whose catalog gives none (check_layout then checks only overlaps and bags). */
  rulesOf(entry: KitEntry): KitRules | null {
    const r = this.catalogOf(entry).standard?.rules
    return r && (r.family === 'rooms' || r.family === 'terrain') && typeof r.tile === 'number' ? r : null
  }

  /** The piece that does a standard job in a kit (its catalog's role), preferring the given kit; null when none does. */
  byRole(role: string, kit?: string): KitEntry | null {
    const all = this.entries().filter((e) => e.role === role)
    return all.find((e) => e.kit === kit) ?? all[0] ?? null
  }

  /** Each installed kit's own guide (its GUIDE.md), for the resource cyberspace://kits.md. */
  guides(): Array<{ kit: string; title: string; text: string }> {
    const dir = this.dir()
    if (!dir) return []
    const out: Array<{ kit: string; title: string; text: string }> = []
    for (const c of this.catalogs()) {
      try { out.push({ kit: c.kit, title: c.title, text: readFileSync(join(dir, c.folder, 'GUIDE.md'), 'utf8') }) } catch { /* a kit without a guide */ }
    }
    return out
  }

  /** The kits' titles, as their pieces' names start in the zips ("<title>: ..."). */
  titles(): string[] {
    return this.catalogs().map((c) => c.title).filter((t) => typeof t === 'string' && t.length > 0)
  }

  catalogOf(entry: KitEntry): KitCatalog {
    return this.load().catalogs.find((c) => c.folder === entry.folder)!
  }

  /**
   * One piece by its id (<kit>/<set>/<folder>/<piece>), or by the end of its
   * id when only one piece ends that way (<folder>/<piece>, <piece>). Refused with the candidates when it fits several.
   */
  get(name: string): KitEntry {
    const { byId } = this.load()
    const q = String(name ?? '').trim().replace(/\.json$/, '').replace(/^\/+/, '')
    if (!q) throw new KitError('Name a kit piece: its id as kit lists it.')
    const exact = byId.get(q)
    if (exact) return exact
    const hits = [...byId.values()].filter((p) => p.id.endsWith(`/${q}`))
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) throw new KitError(`"${q}" fits ${hits.length} pieces: ${hits.slice(0, 8).map((p) => p.id).join(', ')}${hits.length > 8 ? ', ...' : ''}. Give the whole id.`)
    const loose = [...byId.values()].filter((p) => p.id.includes(q) || p.name.toLowerCase() === q.toLowerCase())
    throw new KitError(`No kit piece "${q}".${loose.length ? ` Close: ${loose.slice(0, 8).map((p) => p.id).join(', ')}.` : ' Search with kit.'}`)
  }

  /**
   * Every piece's shape fingerprint (shapeKey), read once per catalog: what a
   * turned, scaled or renamed copy still has, so a kit piece published on its
   * own is known whatever it is called.
   */
  shapes(): Map<string, string> {
    const l = this.load()
    if (l.shapes) return l.shapes
    const shapes = new Map<string, string>()
    for (const e of l.byId.values()) {
      try {
        const raw = this.payload(e) as { vertices?: unknown[]; faces?: unknown }
        if (Array.isArray(raw.vertices) && Array.isArray(raw.faces)) shapes.set(shapeKey(raw.vertices.length, raw.faces as unknown[]), e.id)
      } catch { /* a missing payload is said when it is used */ }
    }
    l.shapes = shapes
    return shapes
  }

  /** A piece's payload as the kit holds it, parsed. */
  payload(entry: KitEntry): unknown {
    const { dir } = this.load()
    const root = resolve(dir, entry.folder)
    const file = resolve(root, entry.file)
    if (!file.startsWith(root + sep)) throw new KitError(`${entry.id}: its file is outside its kit's folder.`)
    if (!existsSync(file)) throw new KitError(`${entry.id}: its payload ${file} is missing; your human should refresh the kit (docs/kits.md).`)
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      throw new KitError(`${entry.id}: its payload is not JSON.`)
    }
  }
}

function catalogFiles(dir: string): string[] {
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  return names.filter((n) => !n.startsWith('.')).map((n) => join(dir, n, 'catalog.json')).filter((f) => existsSync(f)).sort()
}

// ---------- search ----------

export interface KitQuery {
  text?: string
  kit?: string
  set?: string
  group?: string
  kind?: string
  tags?: string[]
  /** Any opening of this size (window, door, hallway, arch). */
  opening?: string
  /** Any edge carrying this profile (L0, L10, S, V, B+, K-, R+...). */
  edge?: string
  max_bytes?: number
  /** Only pieces that fit a bag of this height or lower. */
  max_bag_height?: number
  limit?: number
}

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9+\-.]+/).filter(Boolean)

export function searchKits(lib: KitLibrary, q: KitQuery): { total: number; pieces: KitEntry[] } {
  const want = q.text ? words(q.text) : []
  const scored: Array<{ p: KitEntry; score: number }> = []
  for (const p of lib.entries()) {
    if (q.kit && p.kit !== q.kit) continue
    if (q.set && p.set !== q.set) continue
    if (q.group && !(p.group === q.group || p.group.startsWith(`${q.group}/`))) continue
    if (q.kind && p.kind !== q.kind) continue
    if (q.tags?.length && !q.tags.every((t) => p.tags.includes(t))) continue
    if (q.opening && !(p.openings ?? []).some((o) => o.size === q.opening) && p.plug?.size !== q.opening && p.closes !== q.opening && p.reducer?.from !== q.opening && p.reducer?.to !== q.opening) continue
    if (q.edge && !Object.values(p.edges ?? {}).includes(q.edge)) continue
    if (q.max_bytes !== undefined && p.bytes > q.max_bytes) continue
    if (q.max_bag_height !== undefined && p.bag.minHeight > q.max_bag_height) continue
    let score = 0
    let all = true
    for (const w of want) {
      let s = 0
      if (p.tags.includes(w)) s += 4
      if (p.id.toLowerCase().includes(w)) s += 3
      if (p.name.toLowerCase().includes(w)) s += 3
      if (p.kind === w) s += 3
      if ((p.blurb ?? '').toLowerCase().includes(w)) s += 1
      if (!s) { all = false; break }
      score += s
    }
    if (!all) continue
    scored.push({ p, score })
  }
  scored.sort((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id))
  const limit = Math.max(1, Math.min(100, q.limit ?? 20))
  return { total: scored.length, pieces: scored.slice(0, limit).map((s) => s.p) }
}

/** One line of a piece for a list: what it is, its size and how it connects. */
export function pieceLine(p: KitEntry): string {
  const parts = [`${p.id} (${p.kind}) "${p.name}"`]
  if (p.footprint) parts.push(p.footprint.join(' x '))
  else {
    const d = [0, 1, 2].map((k) => Math.round((p.bounds.max[k] - p.bounds.min[k]) * 10) / 10)
    parts.push(`${d.join(' x ')} gibsons`)
  }
  if (p.openings?.length) parts.push(`openings ${p.openings.map((o) => `${o.face} ${o.size}${o.cell.some((c) => c !== 0) ? `@${o.cell.join(',')}` : ''}`).join(', ')}`)
  if (p.edges) parts.push(`edges px ${p.edges.px}, nx ${p.edges.nx}, pz ${p.edges.pz}, nz ${p.edges.nz}`)
  if (p.plug) parts.push(`seals a ${p.plug.side} ${p.plug.size}`)
  if (p.reducer) parts.push(`${p.reducer.side} reducer ${p.reducer.from} to ${p.reducer.to}`)
  if (p.closes) parts.push(`closes a ${p.closes}`)
  if (p.wall) parts.push(`${p.wall.kind} wall ${p.wall.length} long, ${p.wall.height} high`)
  if (p.mount && p.kind !== 'tile') parts.push(`${p.mount} mount`)
  parts.push(`${p.bytes} bytes, bag height ${p.bag.minHeight}+`)
  if (p.tags.length) parts.push(`tags ${p.tags.join(' ')}`)
  return parts.join('; ')
}

/** What is installed, in a few lines: each kit, its sets, and how many pieces of each kind. */
export function overview(lib: KitLibrary): { text: string; kits: Array<Record<string, unknown>> } {
  const kits = lib.catalogs().map((c) => {
    const sets: Record<string, number> = {}
    const kinds: Record<string, number> = {}
    for (const p of c.pieces) { sets[p.set] = (sets[p.set] ?? 0) + 1; kinds[p.kind] = (kinds[p.kind] ?? 0) + 1 }
    return { kit: c.kit, title: c.title, pieces: c.pieces.length, sets, kinds, generated: c.generated, commit: c.source?.commit }
  })
  const text = kits.map((k) => `${k.kit} (${k.title}): ${k.pieces} pieces. Sets: ${Object.entries(k.sets as Record<string, number>).map(([s, n]) => `${s} ${n}`).join(', ')}. Kinds: ${Object.entries(k.kinds as Record<string, number>).map(([s, n]) => `${s} ${n}`).join(', ')}.`).join('\n')
  return { text, kits }
}

/** A shape's fingerprint: its vertex count and its faces, which a quarter turn, a scale or a new name never change. */
export function shapeKey(vertexCount: number, faces: unknown[]): string {
  return createHash('sha256').update(`${vertexCount}|${JSON.stringify(faces)}`).digest('hex')
}
