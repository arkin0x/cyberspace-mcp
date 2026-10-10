// lineFixture.ts: the real chain's first 6144 blocks as a line the tests can
// serve without a network, shared by line.test.ts (the store) and
// rides.test.ts (the tools over it).
//
// headers-0-6143.bin holds records 0..6143 (6144 x 48 bytes) of
// headers-000.bin at arkin0x/nth branch headers-v1 (blob sha256 3b1f9c41...,
// as its manifest states), served here as three blobs of 2048 under a
// manifest built in the real format. Genesis is pinned by the embedded
// checkpoint at height 0, and the blob checkpoints at 2047, 4095 and 6143 are
// the hashes the chain's own work produces from there, so the whole run is
// the real chain or the verifier refuses it.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseManifest, type HeadersManifest } from '../../src/hyperspace/manifest.js'

export const FIXTURE = new Uint8Array(readFileSync(new URL('./fixtures/headers-0-6143.bin', import.meta.url)))
export const BLOB_SIZE = 2048
/** Display hashes of the last block of each 2048-block blob, derived from the real chain by the verifier. */
export const CHECKPOINTS: Record<number, string> = {
  2047: '000000007e8127fe750bed9f48a7c1ee882bb3a36615f9966b95f64074ae3254',
  4095: '0000000066ca066a388fea7b34b7ff1e0e6f87f97be2a1eb82ed574182664fd4',
  6143: '00000000c5461cfb9639792f4a50d79743a419f3002a7971c47baa44ac85fe17',
}
export const MANIFEST_URL = 'https://blobs.test/headers/manifest.json'

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function blobBytes(ordinal: number, count = BLOB_SIZE): Uint8Array {
  const start = ordinal * BLOB_SIZE * 48
  return FIXTURE.slice(start, start + count * 48)
}

/** A manifest over the first `blobs` blobs of the fixture, in the real format. */
export function manifestFor(blobs: number, overrides: Partial<Record<number, Uint8Array>> = {}): HeadersManifest {
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

export interface Served {
  manifest: HeadersManifest | null
  blobs: Partial<Record<number, Uint8Array>>
  /** URLs fetched, in order. */
  log: string[]
}

/** A fetch over the served manifest and blobs; anything else is a 404, a null manifest a 503. */
export function fakeFetch(served: Served): typeof globalThis.fetch {
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

export function servedFor(blobs: number): Served {
  const out: Served = { manifest: manifestFor(blobs), blobs: {}, log: [] }
  for (let o = 0; o < blobs; o++) out.blobs[o] = blobBytes(o)
  return out
}
