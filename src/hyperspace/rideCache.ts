// rideCache.ts: what a ride keeps on disk between calls and restarts, under
// <state>/rides/.
//
// Ported from ONOSENDAI src/lib/hyperspace/ridePool.ts at commit 8cf3354
// (branch v2): leafKey and grindKey, and the two stores they key, leaves by
// `${previousEventIdHex}:${height}` and the price search's checkpoint by
// `${previousEventIdHex}:${rootHex}`, with IndexedDB (openRideDb,
// readCachedLeaves, readGrindRow, writeRows, deleteRideRows) replaced by
// files. Added here: a check at the end of every leaf line. An IndexedDB row
// is not something a person edits; a file in a state directory is, and a
// leaf that is wrong by one bit yields a root nobody else can verify, so a
// line whose check fails is dropped and its leaf recomputed rather than
// trusted. The check is a digest, not a secret: it catches corruption, torn
// writes and casual edits, and the runner's Level 1 self-verification stands
// behind it for anything that reaches the samples.
//
// Layout: `leaves/<previousEventIdHex>.log`, one line per leaf,
// `<height> <leafHex> <check>`, appended as leaves finish (a torn tail line
// is simply dropped on the next read); and `grind.json`, a map from grind
// key to the next nonce to try.

import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The persistence key for one leaf. Prefix-scannable by ride. */
export function leafKey(previousEventIdHex: string, height: number): string {
  return `${previousEventIdHex}:${height}`
}

/** The persistence key for one ride's price search: a different root is a different search. */
export function grindKey(previousEventIdHex: string, rootHex: string): string {
  return `${previousEventIdHex}:${rootHex}`
}

/** The check that ends a leaf line: the first eight hex of sha256 over the leaf's key and value. */
export function leafLineCheck(key: string, leafHex: string): string {
  return createHash('sha256').update(`${key}=${leafHex}`).digest('hex').slice(0, 8)
}

export interface CachedLeaves {
  /** Leaf hex by height, every line that passed its check. */
  leaves: Map<number, string>
  /** Lines that did not: malformed, torn, or failing their check. Their leaves are recomputed. */
  refused: number
}

interface LeafEntry {
  height: number
  leafHex: string
}

function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
}

const GRIND_FILE = 'grind.json'
const LINE = /^(\d+) ([0-9a-f]{64}) ([0-9a-f]{8})$/

export class RideCache {
  private constructor(readonly path: string) {}

  /** Open or create `<state>/rides` and its `leaves/` directory (mode 700). */
  static open(path: string): RideCache {
    mkdirSync(join(path, 'leaves'), { recursive: true, mode: 0o700 })
    return new RideCache(path)
  }

  private leavesFile(previousEventIdHex: string): string {
    return join(this.path, 'leaves', `${previousEventIdHex}.log`)
  }

  /**
   * The leaves cached for a ride, each line checked; a later line for the
   * same height wins (a leaf recomputed after a refused line is appended,
   * not spliced in). When any line was refused the file is rewritten with
   * the lines that stood, so the refusal is counted once, not forever.
   */
  readLeaves(previousEventIdHex: string): CachedLeaves {
    const leaves = new Map<number, string>()
    let refused = 0
    let text: string
    try {
      text = readFileSync(this.leavesFile(previousEventIdHex), 'utf8')
    } catch {
      return { leaves, refused }
    }
    for (const line of text.split('\n')) {
      if (line === '') continue
      const m = LINE.exec(line)
      if (m === null) {
        refused++
        continue
      }
      const height = Number(m[1])
      if (!Number.isSafeInteger(height) || leafLineCheck(leafKey(previousEventIdHex, height), m[2]) !== m[3]) {
        refused++
        continue
      }
      leaves.set(height, m[2])
    }
    if (refused > 0) this.rewriteLeaves(previousEventIdHex, leaves)
    return { leaves, refused }
  }

  /** Append finished leaves; one write per batch, so a crash loses at most the batch in hand. */
  appendLeaves(previousEventIdHex: string, entries: LeafEntry[]): void {
    if (entries.length === 0) return
    appendFileSync(this.leavesFile(previousEventIdHex), this.lines(previousEventIdHex, entries), { mode: 0o600 })
  }

  private rewriteLeaves(previousEventIdHex: string, leaves: Map<number, string>): void {
    const entries = [...leaves.entries()].map(([height, leafHex]) => ({ height, leafHex }))
    writeFileAtomic(this.leavesFile(previousEventIdHex), this.lines(previousEventIdHex, entries))
  }

  private lines(previousEventIdHex: string, entries: LeafEntry[]): string {
    let out = ''
    for (const e of entries) out += `${e.height} ${e.leafHex} ${leafLineCheck(leafKey(previousEventIdHex, e.height), e.leafHex)}\n`
    return out
  }

  /** Where a ride's price search resumes: every nonce below it is known to miss, or it is the nonce that met the price. 0 when unknown. */
  readGrind(previousEventIdHex: string, rootHex: string): number {
    const next = this.grindMap()[grindKey(previousEventIdHex, rootHex)]
    return typeof next === 'number' && Number.isSafeInteger(next) && next >= 0 ? next : 0
  }

  /** Record where the price search for a ride resumes. */
  writeGrind(previousEventIdHex: string, rootHex: string, next: number): void {
    const map = this.grindMap()
    map[grindKey(previousEventIdHex, rootHex)] = next
    writeFileAtomic(join(this.path, GRIND_FILE), JSON.stringify(map, null, 2))
  }

  /** Drop a ride's leaves and its price searches: after its hyperjump is signed, or when its proof failed to verify. */
  forget(previousEventIdHex: string): void {
    try { unlinkSync(this.leavesFile(previousEventIdHex)) } catch { /* nothing cached */ }
    const map = this.grindMap()
    const prefix = `${previousEventIdHex}:`
    let changed = false
    for (const key of Object.keys(map)) {
      if (key.startsWith(prefix)) {
        delete map[key]
        changed = true
      }
    }
    if (changed) writeFileAtomic(join(this.path, GRIND_FILE), JSON.stringify(map, null, 2))
  }

  private grindMap(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(this.path, GRIND_FILE), 'utf8'))
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
}
