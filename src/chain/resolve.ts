// resolve.ts: an identity's chain, from the relays, and the head confirmation.
//
// Ported from ONOSENDAI src/lib/chains.ts at commit c9dbf53 (branch
// feat/keys-and-chests), with the relay set and the holders passed in
// instead of read from stores.
//
// Two kinds of question are asked of a relay, and each keeps the v1 flood
// (ten thousand drift events from the proof-of-work era) out its own way:
//
//   where is anyone              #A = the recognized actions
//   what is one identity's chain  its spawns by #A = spawn, then #e = the newest spawn's id
//
// The second cannot list names: a chain is followed through every one of
// its events, whatever its action is called (spec 8.9 rule 1). Asking by the
// genesis returns every event of the current chain and nothing of any other.
//
// confirmChainEvents is the rule of spec 8.7.3, "clients MUST confirm they
// hold the live head before signing", as ONOSENDAI implements it: the
// canonical relay and every configured relay are asked together, the relays
// that hold the chain are waited for up to HEAD_CONFIRM_MS, and an empty
// answer from a non-canonical relay does not count.

import type { Filter } from 'nostr-tools/filter'
import { nip19 } from 'nostr-tools'
import { normalizeURL } from 'nostr-tools/utils'
import type { NostrEvent } from '../nostr/event.js'
import { PARTIAL_CHAIN_REASON, mergeAnswers, type RelayAnswer } from '../nostr/relayOutcome.js'
import type { Relays } from '../nostr/relays.js'
import { ACTION_KIND } from './builder.js'
import { RECOGNIZED_ACTIONS, actionLink, buildChain, chainGap, newestSpawn, parseAction, type ActionEvent } from './events.js'
import type { Holders } from './holders.js'

/** The actions that say where an identity is, and therefore the only ones the position feeds ask for. */
export const PLACING_ACTIONS: string[] = [...RECOGNIZED_ACTIONS]

/** The newest placing action per pubkey, newest pubkey first. */
export function latestByPubkey(events: NostrEvent[]): ActionEvent[] {
  const best = new Map<string, ActionEvent>()
  for (const ev of events) {
    const a = parseAction(ev)
    if (!a) continue
    const cur = best.get(a.pubkey)
    if (!cur || isNewerAction(a, cur)) best.set(a.pubkey, a)
  }
  return [...best.values()].sort(byNewest)
}

/** Whether `a` is a newer action than `cur`: the later created_at, and on the same second the larger id. */
export function isNewerAction(a: { createdAt: number; id: string }, cur: { createdAt: number; id: string }): boolean {
  return a.createdAt > cur.createdAt || (a.createdAt === cur.createdAt && a.id > cur.id)
}

/** Newest first, in the same order isNewerAction picks. */
export function byNewest(x: { createdAt: number; id: string }, y: { createdAt: number; id: string }): number {
  return y.createdAt - x.createdAt || (x.id < y.id ? 1 : -1)
}

/** Union by id, order preserved: what was there first stays first. */
export function mergeEvents(existing: NostrEvent[], incoming: NostrEvent[]): NostrEvent[] {
  const seen = new Set(existing.map((e) => e.id))
  const out = existing.slice()
  for (const e of incoming) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    out.push(e)
  }
  return out
}

/** Every spawn an identity has signed: few, and what says which chain is current (spec 8.7.3 rule 1). */
export function spawnsFilter(pubkey: string): Filter {
  return { kinds: [ACTION_KIND], authors: [pubkey], '#A': ['spawn'] }
}

/** Every event of the chain a spawn starts, whatever its actions are called. */
export function chainFilter(pubkey: string, spawnId: string, until?: number): Filter {
  return { kinds: [ACTION_KIND], authors: [pubkey], '#e': [spawnId], ...(until !== undefined ? { until } : {}) }
}

/** The id of the spawn the active chain starts from (spec 8.7.3 rule 1), or null with none. */
export function newestSpawnId(events: NostrEvent[], pubkey?: string): string | null {
  return newestSpawn(events, pubkey)?.id ?? null
}

/** The most extra questions one chain fetch asks to fill holes (chainGap). */
export const MAX_CHAIN_PAGES = 60

/** A chain fetch that could not fill a hole: some event of the chain is on no relay asked. */
export class ChainGapError extends Error {
  constructor(readonly events: NostrEvent[]) {
    super(PARTIAL_CHAIN_REASON)
  }
}

/** One relay's answers to two questions, as one answer: `answered` only when both were answered. */
export function combineAnswers(first: RelayAnswer[], second: RelayAnswer[]): RelayAnswer[] {
  const byUrl = new Map(second.map((a) => [a.url, a]))
  const out = first.map((a): RelayAnswer => {
    const b = byUrl.get(a.url)
    byUrl.delete(a.url)
    if (!b) return a
    const events = mergeEvents(a.events, b.events)
    if (a.outcome !== 'answered') return { ...a, events }
    return { ...b, events }
  })
  return [...out, ...byUrl.values()]
}

/** Every answered relay marked as not having said what the chain is (PARTIAL_CHAIN_REASON). */
export function markPartial(answers: RelayAnswer[]): RelayAnswer[] {
  return answers.map((a): RelayAnswer => (a.outcome === 'answered' ? { url: a.url, outcome: 'unreachable', reason: PARTIAL_CHAIN_REASON, events: a.events } : a))
}

/** Only the events `pubkey` signed. */
export function ownEvents(events: NostrEvent[], pubkey: string): NostrEvent[] {
  return events.every((e) => e.pubkey === pubkey) ? events : events.filter((e) => e.pubkey === pubkey)
}

/**
 * The fetch every chain read shares: the spawns, then the newest spawn's
 * chain by genesis, then, while the chain has a hole, the page ending at the
 * hole nearest the head, or the missing event by id when that page brought
 * nothing new. With the genesis already known the chain and the spawns are
 * asked at once, and the chain is asked again only if a newer spawn turned
 * up. `have` is what the caller already holds, which fills holes without
 * asking; `since` asks the chain only for events from that second on.
 */
async function gatherChain<T>(
  askAny: (f: Filter) => Promise<T>,
  eventsOf: (t: T) => NostrEvent[],
  combine: (a: T, b: T) => T,
  pubkey: string,
  knownSpawnId: string | undefined,
  have: NostrEvent[],
  byAuthor: (t: T, pubkey: string) => T,
  since?: number,
): Promise<{ got: T; whole: boolean }> {
  const ask = async (f: Filter): Promise<T> => byAuthor(await askAny(f), pubkey)
  let got: T
  let spawnId: string | null
  if (knownSpawnId) {
    const chainAsk = since !== undefined ? { ...chainFilter(pubkey, knownSpawnId), since } : chainFilter(pubkey, knownSpawnId)
    const [spawns, chain] = await Promise.all([ask(spawnsFilter(pubkey)), ask(chainAsk)])
    got = combine(spawns, chain)
    spawnId = newestSpawnId(eventsOf(got), pubkey)
    if (spawnId && spawnId !== knownSpawnId) got = combine(got, await ask(chainFilter(pubkey, spawnId)))
  } else {
    got = await ask(spawnsFilter(pubkey))
    spawnId = newestSpawnId(eventsOf(got), pubkey)
    if (!spawnId) return { got, whole: true }
    got = combine(got, await ask(chainFilter(pubkey, spawnId)))
  }
  if (!spawnId) return { got, whole: true }
  const genesis = spawnId
  const hole = (): ReturnType<typeof chainGap> => chainGap([...have, ...eventsOf(got)], genesis)
  for (let asked = 0; asked < MAX_CHAIN_PAGES; asked++) {
    const gap = hole()
    if (!gap) return { got, whole: true }
    const before = eventsOf(got).length
    got = combine(got, await ask(chainFilter(pubkey, genesis, gap.until)))
    if (eventsOf(got).length > before) continue
    asked++
    got = combine(got, await ask({ kinds: [ACTION_KIND], authors: [pubkey], ids: [gap.missingId] }))
    if (eventsOf(got).length === before) break
  }
  return { got, whole: hole() === null }
}

/**
 * Everything the relays have for one pubkey's current chain, raw: every
 * spawn it has signed, and every event of the chain the newest one starts.
 * Rejects with ChainGapError when a hole could not be filled.
 */
export async function fetchChainEvents(relays: Relays, pubkey: string, knownSpawnId?: string, have: NostrEvent[] = [], since?: number): Promise<NostrEvent[]> {
  const { got, whole } = await gatherChain((f) => relays.query(f), (e) => e, mergeEvents, pubkey, knownSpawnId, have, ownEvents, since)
  if (!whole) throw new ChainGapError(got)
  return got
}

/** How long the own-chain check waits for each relay's real answer, per question. */
export const CHAIN_CHECK_MS = 6000

/**
 * The same question, with each relay's answer kept: answered, refused or
 * unreachable, and every answer marked unreachable when the chain came back
 * with a hole. The self-check decides from these whether this identity has
 * a chain, has none, or cannot be told (selfCheck.ts).
 */
export async function askChainEvents(relays: Relays, holders: Holders, pubkey: string, knownSpawnId?: string, have: NostrEvent[] = []): Promise<RelayAnswer[]> {
  const { got, whole } = await gatherChain((f) => relays.queryEach(f, CHAIN_CHECK_MS), mergeAnswers, combineAnswers, pubkey, knownSpawnId, have,
    (answers, author) => answers.map((a) => ({ ...a, events: ownEvents(a.events, author) })))
  holders.noteFrom(pubkey, got)
  return whole ? got : markPartial(got)
}

/** How long confirming a head waits for the relays, per question. */
export const HEAD_CONFIRM_MS = 2500

/**
 * The identity's own chain from the canonical relay and every configured
 * relay, asked together, or null when none of them truly answered:
 *
 *   canonical answered                                        the events (pass, unless they move the head)
 *   canonical silent, another relay answered holding anchorId the events (degraded pass)
 *   no answer, nothing newer                                  null (refuse)
 *   any, one relay sent a newer move                          the events, which the caller adopts and refuses on
 *
 * A relay other than the canonical one counts toward a degraded pass only
 * when its answer holds `anchorId`, the event `since` was taken from, which
 * every relay that really holds this chain returns. Once the canonical
 * relay has answered, every relay that holds this identity's chain is
 * waited for until it answers or HEAD_CONFIRM_MS has passed since the
 * question's requests went out, and no other relay is. `reconnect` drops
 * these relays' sockets first, keeping one whose AUTH is still waiting on
 * the signer.
 */
export async function confirmChainEvents(
  relays: Relays,
  holders: Holders,
  pubkey: string,
  knownSpawnId: string | undefined,
  have: NostrEvent[],
  opts: { since?: number; anchorId?: string; reconnect?: boolean; maxWait?: number } = {},
): Promise<NostrEvent[] | null> {
  const canonical = normalizeURL(relays.canonical)
  const urls = [...new Set([canonical, ...relays.urls.map((r) => normalizeURL(r))])]
  const holding = holders.holders()
  const waitFor = urls.filter((url) => holding.has(url))
  const maxWait = opts.maxWait ?? HEAD_CONFIRM_MS
  if (opts.reconnect) relays.dropRelays(urls.filter((url) => !relays.authPending(url)))
  const deadline = new AbortController()
  let timer: ReturnType<typeof setTimeout> = setTimeout(() => deadline.abort(), maxWait * 4)
  let armed = false
  const sent = (): void => {
    if (armed) return
    armed = true
    clearTimeout(timer)
    timer = setTimeout(() => deadline.abort(), maxWait * 2 + 100)
  }
  const ask = async (): Promise<NostrEvent[] | null> => {
    const { got, whole } = await gatherChain(
      (f) => relays.queryEachSettled(urls, f, maxWait, canonical, waitFor, { onSent: sent, stop: deadline.signal, onLate: (a) => holders.noteFrom(pubkey, [a]) }),
      mergeAnswers, combineAnswers, pubkey, knownSpawnId, have,
      (answers, author) => answers.map((a) => ({ ...a, events: ownEvents(a.events, author) })), opts.since)
    holders.noteFrom(pubkey, got)
    if (!whole) return null
    const merged = mergeAnswers(got)
    if (got.some((a) => a.url === canonical && a.outcome === 'answered')) return merged
    const holdsChain = (a: RelayAnswer): boolean => opts.anchorId === undefined || a.events.some((e) => e.id === opts.anchorId)
    if (got.some((a) => a.url !== canonical && a.outcome === 'answered' && holdsChain(a))) return merged
    return extendsChain(merged, have) ? merged : null
  }
  try {
    return await ask().catch(() => null)
  } finally {
    clearTimeout(timer)
  }
}

/** Whether `events` hold a move past `have`: an action naming one of its events as previous, or a newer spawn. */
export function extendsChain(events: NostrEvent[], have: NostrEvent[]): boolean {
  const ids = new Set(have.map((e) => e.id))
  const spawnAt = newestSpawn(have)?.created_at ?? -Infinity
  return events.some((e) => {
    if (ids.has(e.id)) return false
    const link = actionLink(e)
    if (link) return ids.has(link.previousId)
    return e.tags.some((t) => t[0] === 'A' && t[1] === 'spawn') && e.created_at > spawnAt
  })
}

/** The chain, assembled. */
export async function fetchChain(relays: Relays, pubkey: string): Promise<ActionEvent[]> {
  return buildChain(await fetchChainEvents(relays, pubkey), pubkey)
}

/** Accepts an npub, an nprofile (its relay hints dropped) or 64-char hex; returns hex, or null when it is none of them. */
export function parsePubkey(input: string): string | null {
  const v = input.trim()
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase()
  if (!/^(npub|nprofile)1/i.test(v)) return null
  try {
    const decoded = nip19.decode(v.toLowerCase())
    if (decoded.type === 'npub') return decoded.data
    if (decoded.type === 'nprofile') return decoded.data.pubkey
    return null
  } catch {
    return null
  }
}
