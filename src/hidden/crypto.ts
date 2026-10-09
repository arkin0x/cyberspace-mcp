// crypto.ts: sealing content to a place.
//
// Ported from ONOSENDAI src/lib/shardCrypto.ts at commit 096f71d (branch
// feat/keys-and-chests), with Node's WebCrypto and Buffer for base64.
//
// Spec 7: a region's Cantor root is a secret you can only get by doing the
// work of computing it. The derivation is spec 7.2 exactly, via
// cyberspace-core: key = sha256(int_to_bytes_be_min(region_n)), lookup_id =
// sha256(key). The cipher is spec 7.6: AES-256-GCM, a fresh 12-byte nonce
// prepended to the ciphertext and its 16-byte tag, the whole thing base64,
// in an ["encrypted", "aes-256-gcm", ...] tag.

import { webcrypto } from 'node:crypto'
import { deriveRegionKeys, deriveRegionN } from 'cyberspace-core'
import type { Position } from '../space/coords.js'

/** The algorithm string in the encrypted tag; the reference CLI rejects any other. */
export const ALGO = 'aes-256-gcm'

export interface RegionKey {
  regionN: bigint
  key: Uint8Array
  lookupId: string
}

/** The region key at a coordinate and height (spec 7.2, 7.4). Plane-free: location keys are spatial. */
export function regionKeyAt(pos: Position, height: number, maxComputeHeight: number): RegionKey {
  const regionN = deriveRegionN(pos.x, pos.y, pos.z, height, maxComputeHeight)
  const { locationDecryptionKey, lookupIdHex } = deriveRegionKeys(regionN)
  return { regionN, key: locationDecryptionKey, lookupId: lookupIdHex }
}

const subtle = webcrypto.subtle

/** Encrypt with a region key; returns the base64 nonce || ciphertext || tag. */
export async function encryptForRegion(key: Uint8Array, plaintext: string): Promise<string> {
  const cryptoKey = await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt'])
  const nonce = webcrypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cryptoKey, new TextEncoder().encode(plaintext)))
  const payload = new Uint8Array(nonce.length + ct.length)
  payload.set(nonce, 0)
  payload.set(ct, nonce.length)
  return Buffer.from(payload).toString('base64')
}

/**
 * Decrypt what encryptForRegion produced; null on any failure, including the
 * wrong key, which is the common case and is never an error in the bag
 * (spec 7.6).
 */
export async function decryptForRegion(key: Uint8Array, b64: string): Promise<string | null> {
  try {
    const payload = new Uint8Array(Buffer.from(b64, 'base64'))
    if (payload.length < 12 + 16) return null
    const nonce = payload.slice(0, 12)
    const ct = payload.slice(12)
    const cryptoKey = await subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt'])
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, cryptoKey, ct)
    return new TextDecoder().decode(pt)
  } catch {
    return null
  }
}
