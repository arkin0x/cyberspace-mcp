// line.test.ts: the line store against real mainnet headers served by a fetch
// that never leaves this process.
//
// What would fail silently without these tests: a store that trusted the
// manifest's digest instead of the proof of work would accept any bytes the
// host served; one that trusted its own disk would accept whatever a stray
// write left there; one that skipped a failed blob would name stations from
// a line with a hole in it; and one that ignored its budget would break the
// server's per-call cap on the first sync of a cold state directory.
//
// Fixtures (test/hyperspace/fixtures):
// - headers-0-6143.bin: records 0..6143 (6144 x 48 bytes) of headers-000.bin
//   at arkin0x/nth branch headers-v1 (blob sha256 3b1f9c41..., as its
//   manifest states), served below as three blobs of 2048 under a manifest
//   built here. Genesis is pinned by the embedded checkpoint at height 0, and
//   the blob checkpoints at 2047, 4095 and 6143 are the hashes the chain's
//   own work produces from there, so the whole run is the real chain or the
//   tests fail. The full blob (2.4 MB) is not committed; the test at the end
//   reads it from NTH_BLOBS_DIR when that is set.
// - headers-29898-36527.bin, the slice behind realRide.test.ts, fills a Line
//   directly to pin the stop for block 29898 to the landfall arkinox's ride
//   9c5d55cd arrived at, and his station under it.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { coordToHex, hexToCoord } from 'cyberspace-core'
import { checkpointState, verifyAndDerive } from '../../src/hyperspace/headers.js'
import { landfallCoord } from '../../src/hyperspace/landfall.js'
import { Line, LineStore, safeBlobFileName } from '../../src/hyperspace/line.js'
import { parseManifest, type HeadersManifest } from '../../src/hyperspace/manifest.js'
import { planeOfMerkleRoot } from '../../src/hyperspace/stops.js'
import { GENESIS_HASH } from '../../src/hyperspace/checkpoints.js'
import type { NostrEvent } from '../../src/nostr/event.js'

const FIXTURE = new Uint8Array(readFileSync(new URL('./fixtures/headers-0-6143.bin', import.meta.url)))
const BLOB_SIZE = 2048
/** Display hashes of the last block of each 2048-block blob, derived from the real chain by the verifier. */
const CHECKPOINTS: Record<number, string> = {
  2047: '000000007e8127fe750bed9f48a7c1ee882bb3a36615f9966b95f64074ae3254',
  4095: '0000000066ca066a388fea7b34b7ff1e0e6f87f97be2a1eb82ed574182664fd4',
  6143: '00000000c5461cfb9639792f4a50d79743a419f3002a7971c47baa44ac85fe17',
}
/** The genesis block's merkle root (display order): a port, since its plane bit is 1. */
const GENESIS_MERKLE = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'
const MANIFEST_URL = 'https://blobs.test/headers/manifest.json'

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function blobBytes(ordinal: number, count = BLOB_SIZE): Uint8Array {
  const start = ordinal * BLOB_SIZE * 48
  return FIXTURE.slice(start, start + count * 48)
}

/** A manifest over the first `blobs` blobs of the fixture, in the real format. */
function manifestFor(blobs: number, overrides: Partial<Record<number, Uint8Array>> = {}): HeadersManifest {
  const raw = {
    formatVersion: 1,
    network: 'mainnet',
    blobSize: BLOB_SIZE,
    generatedAtHeight: blobs * BLOB_SIZE - 1,
    blobs: Array.from({ length: blobs }, (_, ordinal) => ({
      ordinal, startHeight: ordinal * BLOB_SIZE, count: BLOB_SIZE,
      sha256: sha256Hex(overrides[ordinal] ?? blobBytes(ordinal)), file: `headers-${String(ordinal).padStart(3, '0')}.bin`,
    })),
    checkpoints: Array.from({ length: blobs }, (_, ordinal) => ({ height: (ordinal + 1) * BLOB_SIZE - 1, blockHash: CHECKPOINTS[(ordinal + 1) * BLOB_SIZE - 1] })),
  }
  const parsed = parseManifest(raw)
  if (!parsed) throw new Error('the test manifest is malformed')
  return parsed
}

interface Served {
  manifest: HeadersManifest | null
  blobs: Partial<Record<number, Uint8Array>>
  /** URLs fetched, in order. */
  log: string[]
}

/** A fetch over the served manifest and blobs; anything else is a 404, a null manifest a 503. */
function fakeFetch(served: Served): typeof globalThis.fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (init?.signal?.aborted) {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    served.log.push(url)
    if (url === MANIFEST_URL) {
      if (served.manifest === null) return new Response('unavailable', { status: 503 })
      return new Response(JSON.stringify(served.manifest), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const m = /headers-(\d{3})\.bin$/.exec(url)
    const bytes = m ? served.blobs[Number(m[1])] : undefined
    if (!bytes) return new Response('not here', { status: 404 })
    return new Response(bytes, { status: 200 })
  }
}

function servedFor(blobs: number): Served {
  const out: Served = { manifest: manifestFor(blobs), blobs: {}, log: [] }
  for (let o = 0; o < blobs; o++) out.blobs[o] = blobBytes(o)
  return out
}

/** A clock the test advances; the store reads it for the budget and the timestamps. */
function fakeClock(start = 1_760_000_000_000): { now: () => number; advance: (ms: number) => void; stepPerRead: number } {
  let t = start
  const clock = {
    stepPerRead: 0,
    now: () => {
      const v = t
      t += clock.stepPerRead
      return v
    },
    advance: (ms: number) => { t += ms },
  }
  return clock
}

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-line-'))
  dirs.push(dir)
  return join(dir, 'line')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('the manifest parser', () => {
  it('accepts the fixture manifest and refuses misaligned, oversized or partial-before-last blobs', () => {
    const good = manifestFor(3)
    expect(parseManifest(JSON.parse(JSON.stringify(good)))).not.toBeNull()
    const misaligned = JSON.parse(JSON.stringify(good)) as { blobs: Array<{ startHeight: number }> }
    misaligned.blobs[1].startHeight = BLOB_SIZE + 1
    expect(parseManifest(misaligned)).toBeNull()
    const gap = JSON.parse(JSON.stringify(good)) as { blobs: Array<{ ordinal: number }> }
    gap.blobs[2].ordinal = 3
    expect(parseManifest(gap)).toBeNull()
    const partialFirst = JSON.parse(JSON.stringify(good)) as { blobs: Array<{ count: number }> }
    partialFirst.blobs[0].count = BLOB_SIZE - 1
    expect(parseManifest(partialFirst)).toBeNull()
    expect(parseManifest({ ...good, network: 'testnet' })).toBeNull()
    expect(parseManifest(null)).toBeNull()
  })

  it('writes only plain blob file names, never a path or its own files', () => {
    expect(safeBlobFileName('headers-000.bin')).toBe('headers-000.bin')
    expect(safeBlobFileName('../key')).toBeNull()
    expect(safeBlobFileName('a/b.bin')).toBeNull()
    expect(safeBlobFileName('.hidden')).toBeNull()
    expect(safeBlobFileName('line.json')).toBeNull()
    expect(safeBlobFileName('manifest.json')).toBeNull()
  })
})

describe('a cold sync', () => {
  it('fetches, verifies from genesis and holds every blob, with the files and line.json on disk', async () => {
    const served = servedFor(3)
    const path = tempDir()
    const store = LineStore.open(path, { manifestUrl: MANIFEST_URL, fetch: fakeFetch(served) })
    expect(store.status()).toMatchObject({ asOf: -1, onDiskVerifiedTo: -1, blobsLoaded: 0, blobsTotal: null })

    const result = await store.sync({ budgetSeconds: 60 })
    expect(result.failure).toBeNull()
    expect(result).toMatchObject({ done: true, asOf: 6143, tip: 6143, blobsLoaded: 3, blobsTotal: 3, fetched: 3, verified: 3 })
    expect(served.log).toEqual([MANIFEST_URL, 'https://blobs.test/headers/headers-000.bin', 'https://blobs.test/headers/headers-001.bin', 'https://blobs.test/headers/headers-002.bin'])

    expect(readdirSync(path).sort()).toEqual(['headers-000.bin', 'headers-001.bin', 'headers-002.bin', 'line.json', 'manifest.json'])
    expect(sha256Hex(new Uint8Array(readFileSync(join(path, 'headers-001.bin'))))).toBe(sha256Hex(blobBytes(1)))
    const file = JSON.parse(readFileSync(join(path, 'line.json'), 'utf8')) as { verifiedTo: number; manifestReadAt: string; verified: Array<{ ordinal: number; count: number }> }
    expect(file.verifiedTo).toBe(6143)
    expect(typeof file.manifestReadAt).toBe('string')
    expect(file.verified.map((v) => [v.ordinal, v.count])).toEqual([[0, 2048], [1, 2048], [2, 2048]])

    // The stops are the real chain's: genesis is a port at its merkle root,
    // and a landfall's coordinate is the exact derivation from its hash.
    const line = store.line
    expect(line.asOf()).toBe(6143)
    expect(line.blockHash(0)).toBe(GENESIS_HASH)
    expect(line.blockHash(6143)).toBe(CHECKPOINTS[6143])
    const genesis = line.stopAt(0)!
    expect(genesis.kind).toBe('port')
    expect(genesis.merkleRoot).toBe(GENESIS_MERKLE)
    expect(line.stopCoordHex(0)).toBe(GENESIS_MERKLE)
    let landfall = 1
    while (line.stopAt(landfall)!.kind !== 'landfall') landfall++
    const stop = line.stopAt(landfall)!
    expect(planeOfMerkleRoot(stop.merkleRoot)).toBe(0)
    expect(line.stopCoordHex(landfall)).toBe(coordToHex(landfallCoord(stop.blockHash!)))
    expect(line.has(6144)).toBe(false)
    expect(line.stopAt(6144)).toBeNull()
  })

  it('names the station for a position under as_of, and refuses an as_of beyond what is verified', async () => {
    const served = servedFor(3)
    const store = LineStore.open(tempDir(), { manifestUrl: MANIFEST_URL, fetch: fakeFetch(served) })
    await store.sync({ budgetSeconds: 60 })
    const line = store.line
    // Standing exactly on a stop, that stop is the station at distance 0, and
    // under an as_of below its height the station is some other stop.
    const target = 5000
    const coord = line.stopCoordHex(target)!
    const here = line.station(coord, 6143)!
    expect(here.stop.height).toBe(target)
    expect(here.distance).toBe(0)
    const earlier = line.station(coord, target - 1)!
    expect(earlier.stop.height).toBeLessThan(target)
    expect(earlier.distance).toBeGreaterThan(0)
    expect(line.station(hexToCoord(coord))!.stop.height).toBe(target)
    expect(() => line.station(coord, 6144)).toThrow(/above the newest verified block, 6143/)
    const near = line.nearest(coord, 3)
    expect(near[0].stop.height).toBe(target)
    expect(near.length).toBe(3)
  })
})

describe('what the store refuses', () => {
  it('a tampered blob whose digest the manifest vouches for: proof of work refuses it, nothing of it is kept, and the honest bytes later continue the walk', async () => {
    const tampered = blobBytes(1)
    tampered[1000 * 48 + 20] ^= 0x01
    const served: Served = { manifest: manifestFor(3, { 1: tampered }), blobs: { 0: blobBytes(0), 1: tampered, 2: blobBytes(2) }, log: [] }
    const path = tempDir()
    const store = LineStore.open(path, { manifestUrl: MANIFEST_URL, fetch: fakeFetch(served) })
    const first = await store.sync({ budgetSeconds: 60 })
    expect(first.done).toBe(false)
    expect(first.failure).toMatch(/blob 1 \(headers-001\.bin\) refused: /)
    expect(first.asOf).toBe(2047)
    expect(first.blobsLoaded).toBe(1)
    expect(existsSync(join(path, 'headers-000.bin'))).toBe(true)
    expect(existsSync(join(path, 'headers-001.bin'))).toBe(false)

    // The publisher fixes the blob: the manifest changes for blob 1, which
    // is not held, so the walk simply continues from where it stopped.
    served.manifest = manifestFor(3)
    served.blobs[1] = blobBytes(1)
    const second = await store.sync({ budgetSeconds: 60, refreshManifest: true })
    expect(second.failure).toBeNull()
    expect(second).toMatchObject({ done: true, asOf: 6143, fetched: 2, verified: 2 })
  })

  it('bytes that do not match the manifest digest, before any parsing', async () => {
    const served = servedFor(2)
    const corrupt = blobBytes(1)
    corrupt[5] ^= 0xff
    served.blobs[1] = corrupt
    const store = LineStore.open(tempDir(), { manifestUrl: MANIFEST_URL, fetch: fakeFetch(served) })
    const result = await store.sync({ budgetSeconds: 60 })
    expect(result.failure).toMatch(/blob 1 .* could not be fetched: the bytes do not match the manifest sha256/)
    expect(result.asOf).toBe(2047)
  })

  it('a manifest whose checkpoint is wrong, and one that pins a different genesis-side blob than this build does', async () => {
    const served = servedFor(2)
    served.manifest!.checkpoints[0].blockHash = '00'.repeat(32)
    const store = LineStore.open(tempDir(), { manifestUrl: MANIFEST_URL, fetch: fakeFetch(served) })
    const result = await store.sync({ budgetSeconds: 60 })
    expect(result.failure).toMatch(/blob 0 .* refused: checkpoint mismatch at height 2047/)
    expect(result.asOf).toBe(-1)

    // The real manifest's blob size, with a checkpoint at 49999 that disagrees
    // with the embedded one: refused before a byte is fetched.
    const hostile = parseManifest({
      formatVersion: 1, network: 'mainnet', blobSize: 50000, generatedAtHeight: 49999,
      blobs: [{ ordinal: 0, startHeight: 0, count: 50000, sha256: 'ab'.repeat(32), file: 'headers-000.bin' }],
      checkpoints: [{ height: 49999, blockHash: 'cd'.repeat(32) }],
    })!
    const hostileServed: Served = { manifest: hostile, blobs: {}, log: [] }
    const store2 = LineStore.open(tempDir(), { manifestUrl: MANIFEST_URL, fetch: fakeFetch(hostileServed) })
    const refused = await store2.sync({ budgetSeconds: 60 })
    expect(refused.failure).toMatch(/checkpoint at height 49999 disagrees with the one this build pins/)
    expect(hostileServed.log).toEqual([MANIFEST_URL])
  })

  it('a blob file on disk that no longer verifies is dropped, so the next call fetches it afresh', async () => {
    const served = servedFor(2)
    const path = tempDir()
    const clock = fakeClock()
    await LineStore.open(path, { manifestUrl: MANIFEST_URL, fetch: fakeFetch(served), clock: clock.now }).sync({ budgetSeconds: 60 })
    // Corrupt the disk copy in a way its digest cannot reveal... it cannot:
    // the digest is checked first, so the file is stale, removed, re-fetched.
    const file = join(path, 'headers-001.bin')
    const bytes = new Uint8Array(readFileSync(file))
    bytes[700 * 48 + 3] ^= 0x01
    writeFileSync(file, bytes)
    served.log.length = 0
    const again = LineStore.open(path, { manifestUrl: MANIFEST_URL, fetch: fakeFetch(served), clock: clock.now })
    const result = await again.sync({ budgetSeconds: 60 })
    expect(result).toMatchObject({ done: true, asOf: 4095, fetched: 1, verified: 2 })
    expect(served.log).toEqual(['https://blobs.test/headers/headers-001.bin'])
    expect(sha256Hex(new Uint8Array(readFileSync(file)))).toBe(sha256Hex(blobBytes(1)))
  })
})

describe('resume and the manifest', () => {
  it('a restart re-verifies the blobs on disk without the network, and does not re-read a fresh manifest', async () => {
    const served = servedFor(3)
    const path = tempDir()
    const clock = fakeClock()
    const first = LineStore.open(path, { manifestUrl: MANIFEST_URL, fetch: fakeFetch(served), clock: clock.now })
    await first.sync({ budgetSeconds: 60 })

    // A new process: nothing held, the disk says 6143, the manifest is an hour old at most.
    clock.advance(10 * 60 * 1000)
    const second = LineStore.open(path, { manifestUrl: MANIFEST_URL, fetch: fakeFetch({ manifest: null, blobs: {}, log: served.log }), clock: clock.now })
    expect(second.status()).toMatchObject({ asOf: -1, onDiskVerifiedTo: 6143, tip: 6143, blobsLoaded: 0, blobsTotal: 3 })
    served.log.length = 0
    const result = await second.sync({ budgetSeconds: 60 })
    expect(result.failure).toBeNull()
    expect(result.notes).toEqual([])
    expect(result).toMatchObject({ done: true, asOf: 6143, fetched: 0, verified: 3 })
    expect(served.log).toEqual([])
    expect(second.line.blockHash(6143)).toBe(CHECKPOINTS[6143])
  })

  it('past its TTL the manifest is re-read, and a new blob is the only thing fetched', async () => {
    const served = servedFor(2)
    const path = tempDir()
    const clock = fakeClock()
    const store = LineStore.open(path, { manifestUrl: MANIFEST_URL, fetch: fakeFetch(served), clock: clock.now, manifestTtlMs: 60 * 60 * 1000 })
    expect((await store.sync({ budgetSeconds: 60 })).asOf).toBe(4095)

    // The publisher adds blob 2; within the TTL nothing happens.
    served.manifest = manifestFor(3)
    served.blobs[2] = blobBytes(2)
    served.log.length = 0
    expect(await store.sync({ budgetSeconds: 60 })).toMatchObject({ done: true, asOf: 4095, fetched: 0 })
    expect(served.log).toEqual([])

    clock.advance(61 * 60 * 1000)
    const result = await store.sync({ budgetSeconds: 60 })
    expect(result).toMatchObject({ done: true, asOf: 6143, tip: 6143, fetched: 1, verified: 1, blobsLoaded: 3 })
    expect(served.log).toEqual([MANIFEST_URL, 'https://blobs.test/headers/headers-002.bin'])
  })

  it('a manifest that changed under a held blob restarts the walk from genesis, re-reading unchanged blobs from disk', async () => {
    const served = servedFor(3)
    const path = tempDir()
    const store = LineStore.open(path, { manifestUrl: MANIFEST_URL, fetch: fakeFetch(served) })
    await store.sync({ budgetSeconds: 60 })

    // Blob 1 is re-cut (same chain, a byte of padding is impossible, so the
    // same bytes under a manifest that claims a different digest: the store
    // cannot know they match until it fetches, and the fetched bytes must
    // then match the new digest). Serve a copy under its real digest again
    // after the change so the second walk succeeds.
    const retouched = blobBytes(1)
    const changed = manifestFor(3)
    changed.blobs[1].sha256 = 'ff'.repeat(32)
    served.manifest = changed
    served.log.length = 0
    const refused = await store.sync({ budgetSeconds: 60, refreshManifest: true })
    expect(refused.notes[0]).toMatch(/the manifest changed at blob 1, which this line already held; the walk starts over from genesis/)
    // Blob 0 came from disk; blob 1 was fetched and did not match the new digest.
    expect(refused).toMatchObject({ done: false, asOf: 2047, fetched: 0, verified: 1 })
    expect(refused.failure).toMatch(/blob 1 .* could not be fetched: the bytes do not match/)
    expect(served.log).toEqual([MANIFEST_URL, 'https://blobs.test/headers/headers-001.bin'])

    served.manifest = manifestFor(3, { 1: retouched })
    served.log.length = 0
    const result = await store.sync({ budgetSeconds: 60, refreshManifest: true })
    expect(result.failure).toBeNull()
    expect(result).toMatchObject({ done: true, asOf: 6143, fetched: 1, verified: 2 })
    expect(served.log).toEqual([MANIFEST_URL, 'https://blobs.test/headers/headers-001.bin'])
  })

  it('an unreachable manifest keeps the copy on disk and says so; with none at all the sync fails plainly', async () => {
    const served = servedFor(2)
    const path = tempDir()
    const clock = fakeClock()
    await LineStore.open(path, { manifestUrl: MANIFEST_URL, fetch: fakeFetch(served), clock: clock.now }).sync({ budgetSeconds: 60 })
    clock.advance(2 * 60 * 60 * 1000)
    served.manifest = null
    const store = LineStore.open(path, { manifestUrl: MANIFEST_URL, fetch: fakeFetch(served), clock: clock.now })
    const result = await store.sync({ budgetSeconds: 60 })
    expect(result.failure).toBeNull()
    expect(result.notes[0]).toMatch(/the manifest could not be re-read \(HTTP 503\); using the copy read /)
    expect(result).toMatchObject({ done: true, asOf: 4095, fetched: 0, verified: 2 })

    const empty = LineStore.open(tempDir(), { manifestUrl: MANIFEST_URL, fetch: fakeFetch({ manifest: null, blobs: {}, log: [] }) })
    const none = await empty.sync({ budgetSeconds: 60 })
    expect(none.failure).toBe('the manifest could not be read: HTTP 503')
    expect(none).toMatchObject({ done: false, asOf: -1, tip: null, blobsTotal: 0 })
  })
})

describe('the time budget', () => {
  it('cuts a run short between blobs and a later call continues', async () => {
    const served = servedFor(3)
    const clock = fakeClock()
    // Every read of the clock moves it ten seconds: one blob is always more
    // than the five-second budget allows, so each call verifies exactly one.
    clock.stepPerRead = 10_000
    const store = LineStore.open(tempDir(), { manifestUrl: MANIFEST_URL, fetch: fakeFetch(served), clock: clock.now })
    const first = await store.sync({ budgetSeconds: 5 })
    expect(first).toMatchObject({ done: false, asOf: 2047, blobsLoaded: 1, blobsTotal: 3, verified: 1, fetched: 1, failure: null })
    expect(first.elapsedSeconds).toBeGreaterThan(0)
    const second = await store.sync({ budgetSeconds: 5 })
    expect(second).toMatchObject({ done: false, asOf: 4095, blobsLoaded: 2, verified: 1 })
    const third = await store.sync({ budgetSeconds: 5 })
    expect(third).toMatchObject({ done: true, asOf: 6143, blobsLoaded: 3, verified: 1 })
    const fourth = await store.sync({ budgetSeconds: 5 })
    expect(fourth).toMatchObject({ done: true, asOf: 6143, verified: 0, fetched: 0 })
  })

  it('a zero budget does nothing, an aborted signal rejects, and two syncs at once are refused', async () => {
    const served = servedFor(2)
    const store = LineStore.open(tempDir(), { manifestUrl: MANIFEST_URL, fetch: fakeFetch(served) })
    const nothing = await store.sync({ budgetSeconds: 0 })
    expect(nothing).toMatchObject({ done: false, asOf: -1, verified: 0 })
    const controller = new AbortController()
    controller.abort()
    await expect(store.sync({ budgetSeconds: 60, signal: controller.signal })).rejects.toThrow('aborted')
    const running = store.sync({ budgetSeconds: 60 })
    await expect(store.sync({ budgetSeconds: 60 })).rejects.toThrow('already running')
    expect((await running).done).toBe(true)
  })
})

describe('the stop for block 29898, the landfall arkinox rode to', () => {
  const HASH_29897 = '00000000e9274b89e3d6839bcef2314b30196d75cd985c2114299db2ff2cd928'
  const HASH_36527 = '000000006321c6bb08c71243b0262c0ee36dfdc831299e744d9e657d392d6ddf'
  const BOARDING_COORD = '56db6db6db6db6db6db6dba9b01afec741623cab6e88e3820241120b0cb695ea'
  const ride = JSON.parse(readFileSync(new URL('./fixtures/ride-9c5d55cd.json', import.meta.url), 'utf8')) as NostrEvent
  const rideC = ride.tags.find((t) => t[0] === 'C')![1]

  it('a Line filled from the verified slice answers it, and names block 36527 as the station under as_of 36527', () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/headers-29898-36527.bin', import.meta.url)))
    const verdict = verifyAndDerive(bytes, 29898, 6630, checkpointState(HASH_29897), { finalHashHex: HASH_36527, embedded: new Map() })
    if (!verdict.ok) throw new Error(verdict.reason)
    const line = new Line()
    line.append(verdict.columns)
    expect(line.firstHeight()).toBe(29898)
    expect(line.asOf()).toBe(36527)
    expect(line.stopAt(29898)!.kind).toBe('landfall')
    expect(line.stopCoordHex(29898)).toBe(rideC)
    // Columns that do not continue the run are refused.
    expect(() => line.append(verdict.columns)).toThrow(/do not continue it/)
    // arkinox's ride declared as_of 966225 from his boarding coordinate and
    // its station was block 36527 (its from_height). The slice holds a
    // subset of those stops, 36527 among them, so it is the nearest here too.
    const station = line.station(BOARDING_COORD, 36527)!
    expect(station.stop.height).toBe(36527)
    expect(line.nearest(BOARDING_COORD, 1)[0].stop.height).toBe(36527)
  })

  // The full blob 000 (2.4 MB) is not committed. With NTH_BLOBS_DIR pointing
  // at a directory holding headers-000.bin and manifest.json from
  // arkin0x/nth headers-v1, the store walks the real first blob from genesis
  // (about a second) and must land on the same landfall.
  const blobsDir = process.env.NTH_BLOBS_DIR
  it.runIf(blobsDir !== undefined && existsSync(join(blobsDir ?? '', 'headers-000.bin')))('the store, from the real blob 000 under the real manifest, holds it too', async () => {
    const real = parseManifest(JSON.parse(readFileSync(join(blobsDir!, 'manifest.json'), 'utf8')))
    if (!real) throw new Error('the manifest in NTH_BLOBS_DIR is malformed')
    const served: Served = { manifest: real, blobs: { 0: new Uint8Array(readFileSync(join(blobsDir!, 'headers-000.bin'))) }, log: [] }
    const store = LineStore.open(tempDir(), { manifestUrl: MANIFEST_URL, fetch: fakeFetch(served) })
    const result = await store.sync({ budgetSeconds: 60 })
    // Only blob 0 is served; blob 1 is a 404, where the walk stops.
    expect(result.asOf).toBe(49999)
    expect(result.failure).toMatch(/blob 1 .* could not be fetched: HTTP 404/)
    expect(store.line.blockHash(29898)).toBe('00000000ecdb66f90600cfb8ae07cdfaf510eef50c809ed83f9d49e4293c1063')
    expect(store.line.stopCoordHex(29898)).toBe(rideC)
    expect(store.line.station(BOARDING_COORD, 36527)!.stop.height).toBe(36527)
  }, 60_000)
})
