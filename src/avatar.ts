// avatar.ts: the shape others see the agent as, a kind 11333 (spec 8.10).
//
// Ported from ONOSENDAI src/lib/avatar.ts, src/lib/avatarMine.ts and
// src/store/useAvatars.ts at origin/v2 17fa254 (arkinox, 2026-10-11: "tell
// XOR to set a shard as his avatar"). The event is the one ONOSENDAI's
// workshop publishes: kind 11333, replaceable, no `d`; the tags in ONOSENDAI's
// order, `name` then `client` then `nonce`; the content a shard payload as
// sno-core's toPayload writes it. The client tag is in the template before
// mining, because the work is NIP-13 over the event's own id: a tag added at
// signing would change the id and void the work. It names this server
// (cyberspace-mcp), where ONOSENDAI's names ONOSENDAI; no reader looks at it.
//
// The work owed and the reader's verdict are cyberspace-core's avatarWork
// and verifyAvatarWork, the same pinned commit ONOSENDAI draws with, so an
// event this file mines is one ONOSENDAI draws, and one it would not draw is
// never published.

import { AVATAR_KIND, avatarWork, verifyAvatarWork } from 'cyberspace-core'
import { fromPayload, toPayload, type ShardModel, type ShardPayload } from 'sno-core/shards'
import { CLIENT_NAME, type EventTemplate } from './nostr/event.js'

export { AVATAR_KIND, avatarWork, verifyAvatarWork }

/**
 * The largest payload an avatar may carry, in bytes. Every nonce hashes the
 * whole event, so bytes are paid per try (spec 8.10, "bytes are charged
 * already"); this is the threshold above which a bag carries a shard by
 * reference (DECK-0003 3.2), the size the rest of the server already treats
 * as large.
 */
export const MAX_AVATAR_BYTES = 16_384

/** The event to mine and sign: this shard as the avatar, or none for the dodecahedron. ONOSENDAI's avatarTemplate. */
export function avatarTemplate(shard: ShardModel | null, createdAt: number): EventTemplate {
  return {
    kind: AVATAR_KIND,
    created_at: createdAt,
    tags: shard ? [['name', shard.name], ['client', CLIENT_NAME]] : [['client', CLIENT_NAME]],
    content: shard ? JSON.stringify(toPayload(shard)) : '',
  }
}

/** The template with its nonce tag set (replacing any earlier one), NIP-13 shape: ["nonce", n, target]. */
export function nonceTagged<T extends { tags: string[][] }>(t: T, nonce: string, target: number): T {
  return { ...t, tags: [...t.tags.filter((tag) => tag[0] !== 'nonce'), ['nonce', nonce, String(target)]] }
}

/** The shard an avatar event carries, or null when it carries none or is not one. ONOSENDAI's avatarFromEvent. */
export function avatarFromEvent(ev: { kind: number; pubkey: string; content: string; tags: string[][] }): ShardModel | null {
  if (ev.kind !== AVATAR_KIND) return null
  if (!ev.content) return null
  try {
    return fromPayload(JSON.parse(ev.content), `avatar:${ev.pubkey}`)
  } catch {
    return null
  }
}

/** The shard ONOSENDAI draws for an event: none for empty content, none for a shape that has not paid. ONOSENDAI's paidShard. */
export function paidShard(ev: { kind: number; pubkey: string; content: string; tags: string[][]; id: string }): ShardModel | null {
  if (!ev.content) return null
  if (!verifyAvatarWork(ev).ok) return null
  return avatarFromEvent(ev)
}

/** SHA-256 blocks a serialized event of this many bytes takes, padding included. */
export function blocksOf(bytes: number): number {
  return Math.ceil((bytes + 9) / 64)
}

/**
 * Seconds of wall time the expected 2^bits tries take on this machine, from
 * the calibration's hash rate: each try hashes the whole event, plus about a
 * block's worth of per-try overhead, and each thread past the first adds
 * about seven tenths (ONOSENDAI's triesPerSec, measured there).
 */
export function avatarSeconds(bits: number, eventBytes: number, sha256PerSec: number, threads: number): number {
  const perThread = sha256PerSec / (blocksOf(eventBytes) + 1)
  const rate = perThread * (1 + 0.7 * Math.max(0, threads - 1))
  return 2 ** bits / rate
}

/** What a payload owes, for the price: the bits, and the bytes each try hashes. */
export function avatarPrice(payload: ShardPayload, template: EventTemplate, pubkey: string): { bits: number; eventBytes: number } {
  const bits = avatarWork(payload)
  const mined = nonceTagged(template, '0'.repeat(10), bits)
  const eventBytes = new TextEncoder().encode(JSON.stringify([0, pubkey, mined.created_at, mined.kind, mined.tags, mined.content])).length
  return { bits, eventBytes }
}
