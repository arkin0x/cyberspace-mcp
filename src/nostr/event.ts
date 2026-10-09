// event.ts: the nostr event as this server passes it around, and the few
// helpers every module needs: hex, signing with the client tag, verifying.
// The server signs with nostr-tools and never with anything else.

import { finalizeEvent, verifyEvent as verify } from 'nostr-tools/pure'

/** The shape nostr-tools signs and relays return. */
export interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export type EventTemplate = Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>

export const HEX_64 = /^[0-9a-f]{64}$/

/**
 * The name this server signs its events with (NIP-89 client tag). Every
 * published event carries it except auth events, which are proofs handed to
 * one server and never published.
 */
export const CLIENT_NAME = 'cyberspace-mcp'

/** NIP-42 relay auth, Blossom upload auth, NIP-98 HTTP auth: never attributed. */
const UNATTRIBUTED_KINDS = new Set([22242, 24242, 27235])

/** The template with the client tag, unless it is an auth event or already names a client. */
export function attributed<T extends EventTemplate>(template: T): T {
  if (UNATTRIBUTED_KINDS.has(template.kind)) return template
  if (template.tags.some((t) => t[0] === 'client')) return template
  return { ...template, tags: [...template.tags, ['client', CLIENT_NAME]] }
}

/** Sign a template with the secret key, client tag added. The one signing path. */
export function signEvent(template: EventTemplate, secretKey: Uint8Array): NostrEvent {
  const signed = finalizeEvent(attributed(template), secretKey)
  return { id: signed.id, pubkey: signed.pubkey, created_at: signed.created_at, kind: signed.kind, tags: signed.tags, content: signed.content, sig: signed.sig }
}

/**
 * Whether an event is authentic (spec 8.7.3): a valid NIP-01 id and
 * signature. Checked on the fields alone, never on an object a library may
 * have marked verified, so a copy made from JSON is checked like any other.
 */
export function isAuthentic(ev: NostrEvent): boolean {
  try {
    return verify({ id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at, kind: ev.kind, tags: ev.tags, content: ev.content, sig: ev.sig })
  } catch {
    return false
  }
}

/** Whether a value has the fields of a nostr event, with the right types. */
export function looksLikeEvent(x: unknown): x is NostrEvent {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false
  const e = x as Record<string, unknown>
  return typeof e.id === 'string' && typeof e.pubkey === 'string' && typeof e.created_at === 'number' &&
    typeof e.kind === 'number' && Array.isArray(e.tags) && typeof e.content === 'string' && typeof e.sig === 'string'
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 ? '0' + hex : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** The first tag of that name's value, or undefined. */
export function tagValue(ev: Pick<NostrEvent, 'tags'>, name: string): string | undefined {
  return ev.tags.find((t) => t[0] === name)?.[1]
}

/** Unix seconds now. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
