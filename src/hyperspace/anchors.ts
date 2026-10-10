// anchors.ts: the pure bookkeeping of a stop line built from several sources.
//
// Ported from ONOSENDAI src/lib/hyperspace/anchors.ts at commit 18eded9
// (branch v2), the exported pure helpers only, verbatim: the covered-range
// arithmetic (mergeCovered, subtractCovered, missingRanges, batchesOf,
// replayStretches, runsOf), the anchor dedupe preference (pickBetter) and
// the cache row shape (StopRecord, recordFromStop, stopFromRecord). Left
// out: the sync driver that follows them in the original (the IndexedDB
// cache, the relay query and subscription, the idle-scheduled merge pump,
// the module singletons and the window hook), which is browser-bound. The
// server's line store (plan task A3) owns that side and uses these helpers.
//
// Everything here is a pure function over height ranges and plain rows,
// which is why anchors.test.ts ports unchanged.

import type { Stop, StopKind } from './stops.js'

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Insert a range into a sorted, merged list of inclusive [start, end] ranges,
 * fusing overlaps and adjacency ([0,4] + [5,9] is one covered stretch).
 * Returns a new array; the inputs are never mutated, because the caller may
 * hand the previous value to an in-flight IndexedDB write.
 */
export function mergeCovered(
  covered: Array<[number, number]>,
  range: [number, number],
): Array<[number, number]> {
  const all = [...covered, range].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: Array<[number, number]> = []
  for (const [start, end] of all) {
    const last = out[out.length - 1]
    if (last && start <= last[1] + 1) {
      if (end > last[1]) last[1] = end
    } else {
      out.push([start, end])
    }
  }
  return out
}

/** Remove a range from a sorted, merged covered list; the pruning inverse of
 * mergeCovered, with the same never-mutate contract. */
export function subtractCovered(
  covered: Array<[number, number]>,
  range: [number, number],
): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const [start, end] of covered) {
    if (end < range[0] || start > range[1]) {
      out.push([start, end])
      continue
    }
    if (start < range[0]) out.push([start, range[0] - 1])
    if (end > range[1]) out.push([range[1] + 1, end])
  }
  return out
}

/**
 * The complement of the covered ranges within [0, tip]. Assumes covered is
 * sorted and merged, which mergeCovered maintains.
 */
export function missingRanges(
  covered: Array<[number, number]>,
  tip: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let cursor = 0
  for (const [start, end] of covered) {
    if (cursor > tip) break
    if (start > cursor) out.push([cursor, Math.min(start - 1, tip)])
    if (end + 1 > cursor) cursor = end + 1
  }
  if (cursor <= tip) out.push([cursor, tip])
  return out
}

/**
 * Flatten ranges into ascending height batches of at most `size`. A batch may
 * span disjoint ranges: the relay filter takes an explicit height list, so
 * there is no reason to waste a round trip on a short tail range.
 */
export function batchesOf(ranges: Array<[number, number]>, size: number): number[][] {
  const out: number[][] = []
  let current: number[] = []
  for (const [start, end] of ranges) {
    for (let h = start; h <= end; h++) {
      current.push(h)
      if (current.length === size) {
        out.push(current)
        current = []
      }
    }
  }
  if (current.length > 0) out.push(current)
  return out
}

/**
 * Where the IndexedDB row replay still has work to do: the complement of the
 * union of the snapshot's covered ranges and this session's verified blob
 * ranges, as [start, endOrNull] stretches with null for the open-ended tail.
 * Every IDB row inside coveredAtSnapshot is by construction already in the
 * adopted snapshot (rows are appended to the index when they arrive, and the
 * snapshot serialized the whole index), and blob heights were just appended
 * by the header phase, so replaying either would only burn IDB reads on rows
 * the height dedupe then drops. With no snapshot this reduces to the
 * blob-only complement, i.e. byte-for-byte the pre-snapshot behaviour; with
 * neither it is one unbounded stretch, the old full replay.
 */
export function replayStretches(
  coveredAtSnapshot: Array<[number, number]>,
  blobCovered: Array<[number, number]>,
): Array<[number, number | null]> {
  let union: Array<[number, number]> = []
  for (const range of coveredAtSnapshot) union = mergeCovered(union, range)
  for (const range of blobCovered) union = mergeCovered(union, range)
  const out: Array<[number, number | null]> = []
  let cursor = 0
  for (const [start, end] of union) {
    if (start > cursor) out.push([cursor, start - 1])
    if (end + 1 > cursor) cursor = end + 1
  }
  out.push([cursor, null])
  return out
}

/** Contiguous runs within an ascending height list, as inclusive ranges. */
export function runsOf(heights: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const h of heights) {
    const last = out[out.length - 1]
    if (last && h === last[1] + 1) last[1] = h
    else out.push([h, h])
  }
  return out
}

/**
 * Dedupe preference between two anchors for the same height. hasM is whether
 * the anchor event carried an M tag: a v3 anchor supplies the stop coordinate
 * exactly, a legacy one forces the landfall to be re-derived, so v3 wins.
 * On a tie the first seen wins, so ingestion order is stable.
 */
export interface StopRecordLike {
  hasM: boolean
}

export function pickBetter<T extends StopRecordLike>(first: T, incoming: T): T {
  return incoming.hasM && !first.hasM ? incoming : first
}

// ---------------------------------------------------------------------------
// Cache rows
// ---------------------------------------------------------------------------

/** A stop as it sits in the IndexedDB 'stops' store: plain JSON, hex coords. */
export interface StopRecord {
  height: number
  kind: StopKind
  merkleRoot: string
  blockHash: string | null
  coordApproxHex: string
}

const HEX64 = /^[0-9a-f]{64}$/

export function recordFromStop(stop: Stop): StopRecord {
  return {
    height: stop.height,
    kind: stop.kind,
    merkleRoot: stop.merkleRoot,
    blockHash: stop.blockHash,
    coordApproxHex: stop.coordApprox.toString(16).padStart(64, '0'),
  }
}

/**
 * Rebuild a Stop from a cached row, or null for anything corrupt: the cache
 * is a convenience, so a bad row is dropped and re-fetched, never trusted.
 * coordExact is not cached. A port's equals its coordApprox; a landfall's is
 * re-derived from the block hash on demand by stopCoordExact.
 */
export function stopFromRecord(row: StopRecord): Stop | null {
  if (!Number.isSafeInteger(row.height) || row.height < 0) return null
  if (row.kind !== 'port' && row.kind !== 'landfall') return null
  if (!HEX64.test(row.merkleRoot) || !HEX64.test(row.coordApproxHex)) return null
  if (row.blockHash !== null && !HEX64.test(row.blockHash)) return null
  const coordApprox = BigInt('0x' + row.coordApproxHex)
  return {
    height: row.height,
    kind: row.kind,
    merkleRoot: row.merkleRoot,
    blockHash: row.blockHash,
    coordExact: row.kind === 'port' ? coordApprox : null,
    coordApprox,
  }
}
