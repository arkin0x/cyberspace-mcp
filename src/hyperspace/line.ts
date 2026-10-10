// line.ts: the hyperspace line for the server: verified header blobs on disk
// under <state>/line/, the stop index in memory, and the questions the tools
// ask of it (the stop for a height, the station for a position, the newest
// verified height a ride can declare as `as_of`).
//
// Ported from ONOSENDAI src/workers/headers.worker.ts at commit a828bba
// (branch v2): the walk over the manifest's blobs with the chain state
// carried blob to blob, the manifest checkpoint cross-checked against the
// embedded one before a blob is trusted, the cached bytes re-verified rather
// than trusted; and from src/lib/hyperspace/headerSync.ts at a828bba, the
// manifest fetch. Adapted: the Cache API and IndexedDB (idb.ts at 3a86554)
// become files in a directory; the work runs on the calling thread, chunked
// by blob against a time budget, instead of in a Web Worker; and a blob that
// fails stops the walk instead of being skipped, because the server has no
// relay path to cover a gap and a line with a hole would name wrong stations.
// What a browser keeps across reloads (the raw blobs, re-verified on every
// boot) this keeps across restarts, for the same reason: derivation costs the
// same sha256d per header as verification, so trusting the disk would save
// nothing, and the state directory is not a trusted input.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hexToCoord } from 'cyberspace-core'
import { EMBEDDED_CHECKPOINTS } from './checkpoints.js'
import { appendColumns, createStopIndex, mergeAll, stopByHeight, type StopIndex } from './compactIndex.js'
import { genesisState, verifyAndDerive, type BlobColumns, type ChainState } from './headers.js'
import { HEADERS_MANIFEST_URL, blobUrl, parseManifest, type HeadersManifest, type ManifestBlob } from './manifest.js'
import { findStation, nearestStops, type StationResult } from './station.js'
import { stopCoordHex, type Stop } from './stops.js'

export type { StationResult } from './station.js'
export type { Stop } from './stops.js'

// ---------------------------------------------------------------------------
// The line in memory
// ---------------------------------------------------------------------------

function toCoord(coord: bigint | string): bigint {
  return typeof coord === 'string' ? hexToCoord(coord) : coord
}

/**
 * The verified stops this process holds, as one contiguous run of heights,
 * and the questions asked of them. The store below fills it from genesis;
 * a test may fill it from any verified slice. Every answer is about blocks
 * this run holds and no others: `asOf()` is the newest, and a station is
 * never named under an `as_of` beyond it, because a stop not yet verified
 * could be nearer.
 */
export class Line {
  index: StopIndex = createStopIndex()
  private first = -1
  private last = -1

  /** Append a verified blob's columns; they must start the line or continue it at the next height. */
  append(cols: BlobColumns): void {
    if (cols.count === 0) return
    if (this.last !== -1 && cols.startHeight !== this.last + 1) {
      throw new Error(`the line holds heights ${this.first} to ${this.last}; columns starting at ${cols.startHeight} do not continue it`)
    }
    if (this.last === -1) this.first = cols.startHeight
    appendColumns(this.index, cols)
    mergeAll(this.index)
    this.last = cols.startHeight + cols.count - 1
  }

  /** Forget every stop; the store does this when the manifest changed under a blob it already holds. */
  reset(): void {
    this.index = createStopIndex()
    this.first = -1
    this.last = -1
  }

  /** The newest verified height, the `as_of` a first ride declares (DECK-0001 v3 4.2), or -1 when nothing is held. */
  asOf(): number {
    return this.last
  }

  /** The lowest height held, or -1; the store's line starts at 0. */
  firstHeight(): number {
    return this.first
  }

  /** Whether this height's stop is held. */
  has(height: number): boolean {
    return this.first !== -1 && height >= this.first && height <= this.last
  }

  /** The stop for a block height (port or landfall, with its merkle root and block hash), or null when not held. */
  stopAt(height: number): Stop | null {
    return this.has(height) ? stopByHeight(this.index, height) ?? null : null
  }

  /** The exact coordinate of the stop for a height, as 64 hex (a hyperjump's `C`), or null when not held. */
  stopCoordHex(height: number): string | null {
    const stop = this.stopAt(height)
    return stop ? stopCoordHex(stop) : null
  }

  /** The block hash for a height, 64 lowercase hex (what a ride leaf is seeded from), or null when not held. */
  blockHash(height: number): string | null {
    return this.stopAt(height)?.blockHash ?? null
  }

  /**
   * The station for a position (DECK-0001 v3 4.2): the nearest stop by
   * max-axis LCA among stops at or below `asOf`, ties to the lowest height.
   * Throws when `asOf` is above the newest verified height, since a nearer
   * stop could still be unverified; null when nothing qualifies.
   */
  station(coord: bigint | string, asOf: number = this.last): StationResult | null {
    if (this.last === -1) return null
    if (!Number.isSafeInteger(asOf) || asOf < 0) throw new Error('as_of must be a block height')
    if (asOf > this.last) {
      throw new Error(`as_of ${asOf} is above the newest verified block, ${this.last}; the line must be synced further before a station under it can be named`)
    }
    return findStation(this.index, toCoord(coord), asOf)
  }

  /** The k stops nearest a position, by max-axis LCA, with no height bound. */
  nearest(coord: bigint | string, k: number): StationResult[] {
    return nearestStops(this.index, toCoord(coord), k)
  }
}

// ---------------------------------------------------------------------------
// The store on disk
// ---------------------------------------------------------------------------

export interface LineStoreOptions {
  /** Where the manifest is read from; blob files resolve relative to it. */
  manifestUrl?: string
  /** The fetch to use; tests inject one that serves fixtures. */
  fetch?: typeof globalThis.fetch
  /** Epoch milliseconds, for the budget and the timestamps written; tests inject a fake clock. */
  clock?: () => number
  /** How long a manifest once read is used before sync re-reads it. Default one hour. */
  manifestTtlMs?: number
}

export interface SyncOptions {
  /** Seconds this call may spend; checked between blobs, so one blob (about half a second of verification plus its download) is the unit of work and a call always does at least one when any remains. */
  budgetSeconds: number
  signal?: AbortSignal
  /** Re-read the manifest now, whatever its age. */
  refreshManifest?: boolean
}

export interface SyncResult {
  /** Every blob the manifest lists is verified and held. */
  done: boolean
  /** The newest verified height held now, or -1. */
  asOf: number
  /** The newest height the manifest's blobs reach, or null without a manifest. */
  tip: number | null
  blobsLoaded: number
  blobsTotal: number
  /** Blobs downloaded by this call. */
  fetched: number
  /** Blobs verified by this call, from disk or downloaded. */
  verified: number
  elapsedSeconds: number
  /** Why the walk stopped short of done, or null: a blob refused, unreachable, or the manifest unavailable. The next call tries again from there. */
  failure: string | null
  /** What happened that was not a failure: a manifest that could not be re-read, a restart of the walk. */
  notes: string[]
}

export interface LineStatus {
  path: string
  asOf: number
  /** The newest height a previous run verified onto disk; held again only once re-verified by sync. */
  onDiskVerifiedTo: number
  tip: number | null
  blobsLoaded: number
  blobsTotal: number | null
  manifestReadAt: string | null
}

interface VerifiedBlob {
  ordinal: number
  file: string
  sha256: string
  startHeight: number
  count: number
  verifiedAt: string
}

/** line.json: what is verified on disk, and when the manifest was last read. */
interface LineFile {
  version: 1
  manifestUrl: string
  manifestReadAt: string | null
  verified: VerifiedBlob[]
  verifiedTo: number
}

const LINE_FILE = 'line.json'
const MANIFEST_FILE = 'manifest.json'
const DEFAULT_MANIFEST_TTL_MS = 60 * 60 * 1000

const EMBEDDED = new Map(EMBEDDED_CHECKPOINTS.map((c) => [c.height, c.blockHash]))

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Write bytes atomically: a temporary file beside the target, then a rename, as the state directory does for JSON. */
function writeFileAtomic(path: string, bytes: Uint8Array | string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, bytes, { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * The blob file name as this store will write it, or null. The manifest is
 * fetched from the network, so its file names are untrusted: nothing with a
 * path separator, a leading dot or the store's own file names is written.
 */
export function safeBlobFileName(file: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file) || file.includes('..')) return null
  if (file === LINE_FILE || file === MANIFEST_FILE) return null
  return file
}

function abortError(): Error {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError()
}

function readLineFile(path: string, manifestUrl: string): LineFile {
  const fresh: LineFile = { version: 1, manifestUrl, manifestReadAt: null, verified: [], verifiedTo: -1 }
  let parsed: Partial<LineFile> | null = null
  try {
    parsed = JSON.parse(readFileSync(join(path, LINE_FILE), 'utf8')) as Partial<LineFile>
  } catch {
    return fresh
  }
  // A line.json written for another manifest URL describes other blobs; start over.
  if (!parsed || parsed.version !== 1 || parsed.manifestUrl !== manifestUrl) return fresh
  return {
    version: 1,
    manifestUrl,
    manifestReadAt: typeof parsed.manifestReadAt === 'string' ? parsed.manifestReadAt : null,
    verified: Array.isArray(parsed.verified) ? parsed.verified : [],
    verifiedTo: Number.isSafeInteger(parsed.verifiedTo) ? (parsed.verifiedTo as number) : -1,
  }
}

/**
 * The store: fetches the manifest and the blobs it lists, verifies each by
 * proof of work from genesis through the checkpoints, keeps the verified
 * bytes under its directory, and fills a Line. `sync` does as much as its
 * budget allows and reports how far it got; a later call continues. After a
 * restart the blobs on disk are re-verified (never fetched again while their
 * digests match the manifest) before they are held, so the first calls of a
 * process rebuild the line without the network.
 */
export class LineStore {
  readonly line = new Line()
  private manifest: HeadersManifest | null = null
  private file: LineFile
  /** Per ordinal held in `line`: the manifest entry it was verified against. */
  private loaded: Array<{ sha256: string; count: number }> = []
  /** Per ordinal held: the chain state its successor is verified from. */
  private endStates: ChainState[] = []
  private syncing = false
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly clock: () => number
  private readonly manifestUrl: string
  private readonly manifestTtlMs: number

  private constructor(readonly path: string, options: LineStoreOptions) {
    this.manifestUrl = options.manifestUrl ?? HEADERS_MANIFEST_URL
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.clock = options.clock ?? Date.now
    this.manifestTtlMs = options.manifestTtlMs ?? DEFAULT_MANIFEST_TTL_MS
    this.file = readLineFile(path, this.manifestUrl)
    // The manifest on disk is only as good as the line.json that says when
    // it was read, and from where: without that it was read for another URL.
    if (this.file.manifestReadAt !== null) {
      try {
        this.manifest = parseManifest(JSON.parse(readFileSync(join(path, MANIFEST_FILE), 'utf8')))
      } catch {
        this.manifest = null
      }
    }
    if (this.manifest === null) this.file.manifestReadAt = null
  }

  /** Open or create the line directory (`<state>/line`, mode 700); nothing is held until the first sync. */
  static open(path: string, options: LineStoreOptions = {}): LineStore {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    return new LineStore(path, options)
  }

  /** What is held, what is on disk, and what the manifest promises. */
  status(): LineStatus {
    return {
      path: this.path,
      asOf: this.line.asOf(),
      onDiskVerifiedTo: this.file.verifiedTo,
      tip: this.manifest?.generatedAtHeight ?? null,
      blobsLoaded: this.loaded.length,
      blobsTotal: this.manifest?.blobs.length ?? null,
      manifestReadAt: this.file.manifestReadAt,
    }
  }

  /**
   * Read the manifest when it is due, then verify blobs in order, from disk
   * or the network, until every one is held or the budget is spent. Rejects
   * only on abort; every other outcome is in the result.
   */
  async sync(options: SyncOptions): Promise<SyncResult> {
    if (this.syncing) throw new Error('a sync of this line is already running')
    this.syncing = true
    try {
      return await this.walk(options)
    } finally {
      this.syncing = false
    }
  }

  private async walk(options: SyncOptions): Promise<SyncResult> {
    const started = this.clock()
    const budgetMs = Math.max(0, options.budgetSeconds) * 1000
    const deadline = started + budgetMs
    const notes: string[] = []
    let fetched = 0
    let verified = 0
    const result = (failure: string | null): SyncResult => ({
      done: this.manifest !== null && this.loaded.length === this.manifest.blobs.length,
      asOf: this.line.asOf(),
      tip: this.manifest?.generatedAtHeight ?? null,
      blobsLoaded: this.loaded.length,
      blobsTotal: this.manifest?.blobs.length ?? 0,
      fetched,
      verified,
      elapsedSeconds: (this.clock() - started) / 1000,
      failure,
      notes,
    })

    throwIfAborted(options.signal)
    const manifest = await this.ensureManifest(options, notes)
    if (manifest === null) return result(notes.pop() ?? 'the manifest could not be read')
    this.reconcile(manifest, notes)

    const checkpoints = new Map(manifest.checkpoints.map((c) => [c.height, c.blockHash]))
    let lastBlobMs = 0
    while (this.loaded.length < manifest.blobs.length) {
      throwIfAborted(options.signal)
      if (budgetMs <= 0) break
      // Predictive: a blob costs about what the last one did, and starting one
      // that would end past the deadline is what breaks the caller's cap. The
      // first blob of a call always runs, or a small budget would never advance.
      if (verified > 0 && this.clock() + lastBlobMs > deadline) break
      const t0 = this.clock()
      const outcome = await this.loadBlob(manifest.blobs[this.loaded.length], checkpoints, options.signal)
      if (!outcome.ok) return result(outcome.reason)
      if (outcome.fetched) fetched++
      verified++
      lastBlobMs = this.clock() - t0
    }
    return result(null)
  }

  /** The manifest to walk: the one held while it is within its TTL, else re-read; a failed re-read keeps the held one and says so. */
  private async ensureManifest(options: SyncOptions, notes: string[]): Promise<HeadersManifest | null> {
    const readAt = this.file.manifestReadAt === null ? NaN : Date.parse(this.file.manifestReadAt)
    const now = this.clock()
    const fresh = this.manifest !== null && Number.isFinite(readAt) && now >= readAt && now - readAt < this.manifestTtlMs
    if (fresh && !options.refreshManifest) return this.manifest
    try {
      const res = await this.fetchImpl(this.manifestUrl, { signal: options.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const parsed = parseManifest(await res.json())
      if (parsed === null) throw new Error('malformed manifest')
      this.manifest = parsed
      this.file.manifestReadAt = new Date(this.clock()).toISOString()
      writeFileAtomic(join(this.path, MANIFEST_FILE), JSON.stringify(parsed, null, 2))
      this.writeLineFile()
      return parsed
    } catch (err) {
      if (isAbort(err)) throw err
      const why = err instanceof Error ? err.message : String(err)
      if (this.manifest !== null) {
        notes.push(`the manifest could not be re-read (${why}); using the copy read ${this.file.manifestReadAt ?? 'earlier'}`)
        return this.manifest
      }
      notes.push(`the manifest could not be read: ${why}`)
      return null
    }
  }

  /**
   * A manifest that changed under a blob already held (a re-cut partial blob,
   * or a blob the publisher replaced) invalidates the chain state everything
   * after it was verified from, so the walk starts over from genesis. Blobs
   * whose files still match their digests are re-read from disk, not fetched.
   */
  private reconcile(manifest: HeadersManifest, notes: string[]): void {
    let changed = -1
    for (let ordinal = 0; ordinal < this.loaded.length; ordinal++) {
      const have = this.loaded[ordinal]
      const want = manifest.blobs[ordinal]
      if (!want || have.sha256 !== want.sha256 || have.count !== want.count) {
        changed = ordinal
        break
      }
    }
    if (changed === -1) return
    notes.push(`the manifest changed at blob ${changed}, which this line already held; the walk starts over from genesis (blobs still matching their digests are re-read from disk, not fetched)`)
    this.line.reset()
    this.loaded = []
    this.endStates = []
    this.file.verified = []
    this.file.verifiedTo = -1
    this.writeLineFile()
  }

  /** Verify one blob and hold it, from disk when its bytes still match the manifest, else from the network. */
  private async loadBlob(
    blob: ManifestBlob,
    checkpoints: ReadonlyMap<number, string>,
    signal: AbortSignal | undefined,
  ): Promise<{ ok: true; fetched: boolean } | { ok: false; reason: string }> {
    const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })
    const finalHeight = blob.startHeight + blob.count - 1
    const finalHashHex = checkpoints.get(finalHeight)
    if (finalHashHex === undefined) return refuse(`the manifest has no checkpoint for blob ${blob.ordinal} (height ${finalHeight})`)
    // The embedded list is the stronger opinion: a manifest checkpoint that
    // disagrees with it means the manifest host is wrong, or hostile.
    const pinned = EMBEDDED.get(finalHeight)
    if (pinned !== undefined && pinned !== finalHashHex) return refuse(`the manifest's checkpoint at height ${finalHeight} disagrees with the one this build pins`)
    const name = safeBlobFileName(blob.file)
    if (name === null) return refuse(`the manifest names a blob file this store will not write: ${JSON.stringify(blob.file)}`)
    const state = blob.ordinal === 0 ? genesisState() : this.endStates[blob.ordinal - 1]
    if (!state) return refuse(`blob ${blob.ordinal} has no verified predecessor to link from`)

    const path = join(this.path, name)
    let bytes = this.readDisk(path, blob.sha256)
    let fetched = false
    if (bytes === null) {
      try {
        bytes = await this.fetchBlob(blob, signal)
      } catch (err) {
        if (isAbort(err)) throw err
        return refuse(`blob ${blob.ordinal} (${blob.file}) could not be fetched: ${err instanceof Error ? err.message : String(err)}`)
      }
      fetched = true
    }

    const verdict = verifyAndDerive(bytes, blob.startHeight, blob.count, state, { finalHashHex, embedded: EMBEDDED })
    if (!verdict.ok) {
      // A disk copy that fails is dropped, so the next call fetches afresh
      // instead of refusing the same bytes forever.
      if (!fetched) {
        try { unlinkSync(path) } catch { /* already gone */ }
      }
      return refuse(`blob ${blob.ordinal} (${blob.file}) refused: ${verdict.reason}`)
    }
    this.line.append(verdict.columns)
    this.endStates[blob.ordinal] = verdict.state
    this.loaded[blob.ordinal] = { sha256: blob.sha256, count: blob.count }
    // Persist only what verified: the directory never holds bytes the line refused.
    if (fetched) writeFileAtomic(path, bytes)
    this.file.verified = this.file.verified.slice(0, blob.ordinal)
    this.file.verified[blob.ordinal] = {
      ordinal: blob.ordinal, file: name, sha256: blob.sha256, startHeight: blob.startHeight, count: blob.count,
      verifiedAt: new Date(this.clock()).toISOString(),
    }
    this.file.verifiedTo = finalHeight
    this.writeLineFile()
    return { ok: true, fetched }
  }

  /** The bytes on disk when they match the manifest's digest; a stale or corrupt file is removed and null returned. */
  private readDisk(path: string, sha256: string): Uint8Array | null {
    if (!existsSync(path)) return null
    const bytes = new Uint8Array(readFileSync(path))
    if (sha256Hex(bytes) === sha256) return bytes
    try { unlinkSync(path) } catch { /* already gone */ }
    return null
  }

  private async fetchBlob(blob: ManifestBlob, signal: AbortSignal | undefined): Promise<Uint8Array> {
    const res = await this.fetchImpl(blobUrl(this.manifestUrl, blob.file), { signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (sha256Hex(bytes) !== blob.sha256) throw new Error('the bytes do not match the manifest sha256')
    return bytes
  }

  private writeLineFile(): void {
    writeFileAtomic(join(this.path, LINE_FILE), JSON.stringify(this.file, null, 2))
  }
}
