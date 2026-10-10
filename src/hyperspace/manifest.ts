// manifest.ts: the headers-v1 manifest, the one file that names the blobs.
//
// Ported from ONOSENDAI src/lib/hyperspace/headerSync.ts at commit a828bba
// (branch v2): HEADERS_MANIFEST_URL, the manifest types, parseManifest and
// blobUrl, verbatim. Left out: manifestUrl's localStorage override (the
// server takes the URL as an option), fetchManifest (the store fetches with
// an injected fetch and keeps the failure instead of logging it), and the
// worker driver runHeaderSync with its skip list (the store walks the blobs
// itself, in line.ts, and never skips one: a server's line is continuous
// from genesis or it is not a line).

/**
 * The manifest is a small JSON published next to the blobs (format in
 * nth/docs/HEADER-BLOBS.md): one entry per blob with its byte digest, and
 * one checkpoint per blob, the display hash of its last block. The parser is
 * strict on the invariants verification leans on: ordinals contiguous from
 * zero, each blob starting exactly at ordinal * blobSize, only the last blob
 * partial. A lax parser would let a hostile manifest describe overlapping or
 * misaligned blobs, and the per-blob height arithmetic (row r = startHeight
 * + r) would then file every stop under the wrong block.
 */

// raw.githubusercontent, not a release asset: release downloads redirect to
// a host without CORS headers, which ONOSENDAI cannot fetch from a browser;
// the server keeps the same URL so both clients read one manifest.
export const HEADERS_MANIFEST_URL =
  'https://raw.githubusercontent.com/arkin0x/nth/headers-v1/manifest.json'

export interface ManifestBlob {
  ordinal: number
  startHeight: number
  count: number
  /** sha256 of the blob file's bytes, 64 lowercase hex. */
  sha256: string
  file: string
}

export interface ManifestCheckpoint {
  height: number
  /** Display-order block hash of the LAST block of a blob. */
  blockHash: string
}

export interface HeadersManifest {
  formatVersion: 1
  network: 'mainnet'
  blobSize: number
  generatedAtHeight: number
  blobs: ManifestBlob[]
  checkpoints: ManifestCheckpoint[]
}

/** Blob file URLs resolve relative to the manifest they were named in. */
export function blobUrl(manifest: string, file: string): string {
  return new URL(file, manifest).toString()
}

const HEX64 = /^[0-9a-f]{64}$/

/**
 * Validate an untrusted manifest into a HeadersManifest, or null. Strict on
 * the invariants verification leans on: ordinals contiguous from zero, each
 * blob starting exactly at ordinal * blobSize, only the last blob partial.
 */
export function parseManifest(raw: unknown): HeadersManifest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  if (m.formatVersion !== 1 || m.network !== 'mainnet') return null
  const blobSize = m.blobSize
  const generatedAtHeight = m.generatedAtHeight
  if (!Number.isSafeInteger(blobSize) || (blobSize as number) <= 0) return null
  if (!Number.isSafeInteger(generatedAtHeight) || (generatedAtHeight as number) < 0) return null
  if (!Array.isArray(m.blobs) || !Array.isArray(m.checkpoints)) return null
  const blobs: ManifestBlob[] = []
  for (const entry of m.blobs as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null
    const b = entry as Record<string, unknown>
    const { ordinal, startHeight, count, sha256, file } = b
    if (!Number.isSafeInteger(ordinal) || (ordinal as number) !== blobs.length) return null
    if (startHeight !== (ordinal as number) * (blobSize as number)) return null
    if (!Number.isSafeInteger(count) || (count as number) <= 0 || (count as number) > (blobSize as number)) return null
    if ((count as number) < (blobSize as number) && (ordinal as number) !== (m.blobs as unknown[]).length - 1) return null
    if (typeof sha256 !== 'string' || !HEX64.test(sha256)) return null
    if (typeof file !== 'string' || file.length === 0) return null
    blobs.push({
      ordinal: ordinal as number,
      startHeight: startHeight as number,
      count: count as number,
      sha256,
      file,
    })
  }
  const checkpoints: ManifestCheckpoint[] = []
  for (const entry of m.checkpoints as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null
    const c = entry as Record<string, unknown>
    if (!Number.isSafeInteger(c.height) || (c.height as number) < 0) return null
    if (typeof c.blockHash !== 'string' || !HEX64.test(c.blockHash)) return null
    checkpoints.push({ height: c.height as number, blockHash: c.blockHash })
  }
  return {
    formatVersion: 1,
    network: 'mainnet',
    blobSize: blobSize as number,
    generatedAtHeight: generatedAtHeight as number,
    blobs,
    checkpoints,
  }
}
