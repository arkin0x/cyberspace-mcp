// events.ts: the movement chain as it is read back off the wire.
//
// Ported from ONOSENDAI src/lib/events.ts at commit 8e4d0e3 (branch
// feat/keys-and-chests): parseAction, actionLink, newestSpawn, buildChain
// with the fork rule and the frozen position, firstBreak, chainGap, lookBack
// and the helpers they share. The templates that build events are not here:
// they are in builder.ts, the one module that writes kind 3333. Trimmed from
// the original: the RuleChange dating (when each rule took effect, which
// ONOSENDAI uses to apologize for a chain that was valid when signed) and
// the two ONOSENDAI-bug markers (breakBug); every decision the original
// makes about a chain is kept, and the words of each break with it.
//
// Everything the server knows about where an identity is comes down to a
// per-pubkey linear chain of signed kind 3333 events (spec 8): one spawn,
// then hops and sidesteps, each naming the one before it. The chain rules
// this file implements are CHAIN_RULES_REVISION, as the spec states them at
// origin/master 5bc9a4d.
//
// A candidate to move into cyberspace-core, so that ONOSENDAI and this server
// resolve every chain with one implementation.

import { coordToXyz, hexToCoord, sectorTag, xyzToSectorId, type Plane } from 'cyberspace-core'
import { HEX_64, type NostrEvent } from '../nostr/event.js'
import { sectorTags, type Position } from '../space/coords.js'
import { ACTION_KIND } from './builder.js'

/** The chain rules this server implements (spec 8.12). */
export const CHAIN_RULES_REVISION = '2026-09-28-virtual-brackets'

/**
 * The actions this server recognizes (spec 8.8, 8.9): the base protocol's
 * three movement actions and two bracket actions, and DECK-0001's two, which
 * every verifier must implement because a hyperjump moves an identity.
 */
export const RECOGNIZED_ACTIONS = ['spawn', 'hop', 'sidestep', 'enter-hyperspace', 'hyperjump', 'enter-virtual', 'exit-virtual'] as const

export type RecognizedAction = (typeof RECOGNIZED_ACTIONS)[number]

/** A recognized name, or `other` for every event on a chain that is not a well-formed recognized action in its place. */
export type ActionType = RecognizedAction | 'other'

/**
 * The part an event plays in its chain, decided by walking the chain from
 * its spawn (spec 8.9, 8.11): base (moves to its C), enter (a game begins,
 * c held), virtual (the game's own move), exit (back to the held position),
 * skipped (a name not recognized, outside a bracket; position carried
 * across), broken (a recognized name out of place or malformed, or any event
 * with no A tag).
 */
export type ChainRole = 'base' | 'enter' | 'virtual' | 'exit' | 'skipped' | 'broken'

export interface Placed {
  coordHex: string
  position: Position
  plane: Plane
  /** The S tag for this place. */
  sector: string
}

/** The aligned cube a game is played in (spec 8.11.1). */
export interface GameRegion {
  coordHex: string
  height: number
  base: Position
  plane: Plane
}

/** A kind 3333 event with its tags read back into what they mean. */
export interface ActionEvent {
  id: string
  pubkey: string
  createdAt: number
  type: ActionType
  /** The A tag as written. */
  name: string
  role: ChainRole
  /** Where the identity is in cyberspace once this action stands. Never a place inside a game. */
  coordHex: string
  position: Position
  plane: Plane
  /** Where this event's own C points, when that is not the identity's position. */
  declared?: Placed
  prevCoordHex: string | null
  genesisId: string | null
  previousId: string | null
  proofHash: string | null
  sector: string
  game?: { pubkey: string; relayHint: string }
  region?: GameRegion
  entryId?: string
  bracketId?: string
  /** Set when this event breaks a chain rule this server can see: the rule, in words. */
  breaks?: string
  /** Set on the spawn, with `breaks`, when the chain forks: the event two or more actions name as previous, and those actions, oldest first. */
  fork?: { previousId: string; branchIds: string[] }
  fromHeight?: number
  toHeight?: number
  asOf?: number
  mp?: string
  mn?: string
}

/** The names a bracket may not contain (spec 8.11.4 rule 3). */
const BASE_INSIDE_BRACKET: ReadonlySet<string> = new Set(RECOGNIZED_ACTIONS.filter((n) => n !== 'spawn' && n !== 'exit-virtual'))

function isRecognized(name: string): name is RecognizedAction {
  return (RECOGNIZED_ACTIONS as readonly string[]).includes(name)
}

/** A 64-hex coordinate as a place, or null when it is not one. */
function placeOf(coordHex: string | undefined, sector?: string): Placed | null {
  if (!coordHex || !HEX_64.test(coordHex)) return null
  const { x, y, z, plane } = coordToXyz(hexToCoord(coordHex))
  const position = { x, y, z }
  return { coordHex, position, plane, sector: sector ?? sectorTag(xyzToSectorId(x, y, z)) }
}

/** The region tag (spec 8.11.1): an aligned base and a canonical height in [0, 85], or null. */
function regionOf(ev: NostrEvent): GameRegion | null {
  const t = ev.tags.find((x) => x[0] === 'region')
  if (!t) return null
  const [, coordHex, hStr] = t
  if (!coordHex || !HEX_64.test(coordHex)) return null
  if (hStr === undefined || !/^(0|[1-9][0-9]*)$/.test(hStr)) return null
  const height = Number.parseInt(hStr, 10)
  if (height > 85) return null
  const { x, y, z, plane } = coordToXyz(hexToCoord(coordHex))
  const h = BigInt(height)
  const low = (1n << h) - 1n
  if ((x & low) !== 0n || (y & low) !== 0n || (z & low) !== 0n) return null
  return { coordHex, height, base: { x, y, z }, plane }
}

/** The first tag of that name's value. A rule that needs a tag exactly once also asks tagCount. */
function tag(ev: NostrEvent, name: string): string | undefined {
  return ev.tags.find((t) => t[0] === name)?.[1]
}

function tagCount(ev: NostrEvent, name: string): number {
  let n = 0
  for (const t of ev.tags) if (t[0] === name) n++
  return n
}

/** Whether an event carries ["A", "spawn"], which makes it a spawn (spec 8.7.3 rule 1), whatever else it carries. */
function carriesSpawn(ev: NostrEvent): boolean {
  return ev.tags.some((t) => t[0] === 'A' && t[1] === 'spawn')
}

/** The fork rule, as a fork's break says it (spec 8.7.3 rule 4). */
export const FORK_RULE_WORDS = 'A chain may only ever have one next action after each event, so a fork ends the whole chain, whichever branch came first or is valid, and the identity stands at its spawn coordinate (spec 8.7.3 rule 4)'

const countWord = (n: number): string => ['no', 'one', 'two', 'three', 'four', 'five'][n] ?? String(n)

/** Why an event breaks the one-A-tag rule, or null when it carries exactly one (spec 8.8). */
function aTagsWrong(ev: NostrEvent): string | null {
  const names = ev.tags.filter((t) => t[0] === 'A').map((t) => t[1] ?? '')
  if (names.length === 1) {
    if (names[0] !== '') return null
    return 'an event whose A tag is empty, so it names no action at all. The A tag has to say what the event does, and an empty one counts as an A tag that says nothing (spec 8.8)'
  }
  if (names.length === 0) return 'an event on the chain with no A tag, so it names no action at all. Every event on a chain has to carry exactly one A tag, the name of what it does (spec 8.8)'
  const said = names.map((n) => (n.length > 20 ? `${n.slice(0, 20)}...` : n)).join(', ')
  return `an event carrying ${countWord(names.length)} A tags (${said}). Every event on a chain has to carry exactly one A tag, even when the copies agree, so that every reader agrees on what it does (spec 8.8)`
}

const LINK_TAGS = ['e:genesis', 'e:previous'] as const

/** The tags the chain rules read on each recognized action, beyond the A tag and the sector tags (spec 8.8). */
const READ_TAGS: Record<RecognizedAction | 'links', readonly string[]> = {
  links: LINK_TAGS,
  spawn: ['C'],
  hop: [...LINK_TAGS, 'c', 'C', 'proof'],
  sidestep: [...LINK_TAGS, 'c', 'C', 'proof', 'mr', 'mp', 'mn', 'hx', 'hy', 'hz'],
  'enter-hyperspace': [...LINK_TAGS, 'c', 'C', 'proof'],
  hyperjump: [...LINK_TAGS, 'c', 'C', 'from_height', 'B', 'proof', 'mp', 'mn'],
  'enter-virtual': [...LINK_TAGS, 'c', 'C', 'region'],
  'exit-virtual': [...LINK_TAGS, 'C', 'e:entry'],
}

function readCount(ev: NostrEvent, key: string): number {
  if (!key.startsWith('e:')) return tagCount(ev, key)
  const marker = key.slice(2)
  let n = 0
  for (const t of ev.tags) if (t[0] === 'e' && t[3] === marker) n++
  return n
}

/** Why an event carries a tag the chain rules read more than once, or null. */
function readTagsWrong(ev: NostrEvent, read: RecognizedAction | 'links', label: string): string | null {
  const doubled = READ_TAGS[read].map((k) => [k, readCount(ev, k)] as const).filter(([, n]) => n > 1)
  if (doubled.length === 0) return null
  const said = doubled.map(([k, n]) => `${countWord(n)} ${k.startsWith('e:') ? `e tags marked ${k.slice(2)}` : `${k} tags`}`).join(' and ')
  return `${an(label)} carrying ${said}. Every tag the chain rules read has to appear exactly once, even when the copies agree, so that every reader reads the same thing (spec 8.8)`
}

function marked(ev: NostrEvent, marker: string): string | undefined {
  return ev.tags.find((t) => t[0] === 'e' && t[3] === marker)?.[1]
}

/**
 * Read a kind 3333 event as a recognized action, or refuse it. Strict about
 * shape and silent about everything else: a malformed event is dropped
 * rather than thrown. Proofs are not checked here. An action this server
 * does not recognize is refused here too; buildChain still follows the links
 * through it (actionLink).
 */
export function parseAction(ev: NostrEvent): ActionEvent | null {
  if (ev.kind !== ACTION_KIND) return null
  const type = tag(ev, 'A')
  if (type === undefined || !isRecognized(type)) return null
  const coordHex = tag(ev, 'C')
  if (!coordHex || !HEX_64.test(coordHex)) return null

  const { x, y, z, plane } = coordToXyz(hexToCoord(coordHex))
  const sector = tag(ev, 'S') ?? sectorTag(xyzToSectorId(x, y, z))
  const base = {
    id: ev.id,
    pubkey: ev.pubkey,
    createdAt: ev.created_at,
    name: type,
    role: 'base' as ChainRole,
    coordHex,
    position: { x, y, z },
    plane,
    sector,
  }

  if (type === 'spawn') {
    if (coordHex !== ev.pubkey) return null
    return { ...base, type, prevCoordHex: null, genesisId: null, previousId: null, proofHash: null }
  }

  const c = tag(ev, 'c')
  const genesisId = marked(ev, 'genesis')
  const previousId = marked(ev, 'previous')
  if (!genesisId || !HEX_64.test(genesisId)) return null
  if (!previousId || !HEX_64.test(previousId)) return null

  if (type === 'exit-virtual') {
    const entryId = marked(ev, 'entry')
    if (!entryId || !HEX_64.test(entryId)) return null
    const prevCoordHex = c && HEX_64.test(c) ? c : null
    return { ...base, type, role: 'exit', prevCoordHex, genesisId, previousId, proofHash: null, entryId }
  }

  if (!c || !HEX_64.test(c)) return null
  const prevCoordHex = c
  const links = { prevCoordHex, genesisId, previousId }

  if (type === 'enter-virtual') {
    const games = ev.tags.filter((t) => t[0] === 'p' && t[3] === 'game')
    if (games.length !== 1 || !HEX_64.test(games[0][1] ?? '')) return null
    const region = regionOf(ev)
    if (!region) return null
    const held = placeOf(prevCoordHex)!
    return {
      ...base,
      ...held,
      type,
      role: 'enter',
      ...(coordHex !== prevCoordHex ? { declared: placeOf(coordHex, sector)! } : {}),
      ...links,
      proofHash: null,
      game: { pubkey: games[0][1], relayHint: games[0][2] ?? '' },
      region,
    }
  }

  const proofHash = tag(ev, 'proof')
  if (!proofHash || !HEX_64.test(proofHash)) return null
  const mn = tag(ev, 'mn')
  if (mn !== undefined && !/^[0-9a-f]{16}$/.test(mn)) return null
  if (type === 'sidestep') {
    if (!/^[0-9a-f]{64}(:[0-9a-f]{64}){2}$/.test(tag(ev, 'mr') ?? '')) return null
    if (!tag(ev, 'mp')) return null
    for (const t of ['hx', 'hy', 'hz']) if (!/^\d+$/.test(tag(ev, t) ?? '')) return null
  }
  if (type === 'enter-hyperspace') {
    if (prevCoordHex !== coordHex) return null
  }
  if (type === 'hyperjump') {
    const fromStr = tag(ev, 'from_height')
    const toStr = tag(ev, 'B')
    if (fromStr === undefined || !/^\d+$/.test(fromStr)) return null
    if (toStr === undefined || !/^\d+$/.test(toStr)) return null
    if (tag(ev, 'mp') === undefined) return null
    const asOfStr = tag(ev, 'as_of')
    return {
      ...base,
      type,
      ...links,
      proofHash,
      fromHeight: Number.parseInt(fromStr, 10),
      toHeight: Number.parseInt(toStr, 10),
      asOf: asOfStr !== undefined && /^\d+$/.test(asOfStr) ? Number.parseInt(asOfStr, 10) : undefined,
      mp: tag(ev, 'mp'),
      ...(mn !== undefined ? { mn } : {}),
    }
  }
  if (type === 'sidestep' && mn !== undefined) return { ...base, type, ...links, proofHash, mn }
  return { ...base, type, ...links, proofHash }
}

/** The links of any kind 3333 event that can sit on a chain, whatever its action. */
export interface ActionLink {
  id: string
  pubkey: string
  createdAt: number
  /** The A tag as written: the first when there are several, and empty when there is none. */
  name: string
  genesisId: string
  previousId: string
}

/**
 * The links of an event, recognized or not. Null for another kind, a spawn
 * (which names no previous event, wherever it is published), and one without
 * both e links. An event with no A tag, or with several, still has its links
 * read: resolution follows the chain by links alone, before any tag is
 * checked (spec 8.7.3).
 */
export function actionLink(ev: NostrEvent): ActionLink | null {
  if (ev.kind !== ACTION_KIND) return null
  if (carriesSpawn(ev)) return null
  const name = tag(ev, 'A') ?? ''
  const genesisId = marked(ev, 'genesis')
  const previousId = marked(ev, 'previous')
  if (!genesisId || !HEX_64.test(genesisId)) return null
  if (!previousId || !HEX_64.test(previousId)) return null
  return { id: ev.id, pubkey: ev.pubkey, createdAt: ev.created_at, name, genesisId, previousId }
}

/** Newest first, ties broken by id, the NIP-01 ordering. */
function newer(a: { createdAt: number; id: string }, b: { createdAt: number; id: string }): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/**
 * The newest spawn among `events` (spec 8.7.3 rule 1), valid or not: every
 * kind 3333 event carrying ["A", "spawn"], even beside another A tag, newest
 * first, ties to the larger id. An invalid newest spawn still wins, and there
 * is no fallback to an older one. `pubkey`, when given, is whose spawns count.
 */
export function newestSpawn(events: NostrEvent[], pubkey?: string): NostrEvent | null {
  let best: NostrEvent | null = null
  for (const e of events) {
    if (e.kind !== ACTION_KIND || !carriesSpawn(e)) continue
    if (pubkey !== undefined && e.pubkey !== pubkey) continue
    if (!best || newer({ createdAt: e.created_at, id: e.id }, { createdAt: best.created_at, id: best.id }) < 0) best = e
  }
  return best
}

/**
 * A spawn as the first entry of its chain: as parsed when it is a valid
 * spawn, and otherwise BROKEN, standing at the identity's spawn coordinate,
 * because no event of the chain is valid. Null only for an author that is
 * not a 32-byte key.
 */
function spawnEntry(ev: NostrEvent | null): ActionEvent | null {
  if (!ev) return null
  const parsed = parseAction(ev)
  const home = placeOf(ev.pubkey)
  const aWrong = aTagsWrong(ev)
  const tagsWrong = readTagsWrong(ev, 'spawn', 'spawn')
  if (parsed && parsed.type === 'spawn' && !aWrong && !tagsWrong) {
    const sectors = sectorTagsWrong(ev, 'spawn', parsed.position)
    if (!sectors || !home) return parsed
    return { ...parsed, ...home, type: 'other', role: 'broken', breaks: sectors }
  }
  if (!home) return null
  const C = tag(ev, 'C')
  const claimed = placeOf(C, tag(ev, 'S'))
  let breaks: string
  if (aWrong) {
    breaks = aWrong
  } else if (tagsWrong) {
    breaks = tagsWrong
  } else if (claimed && C !== ev.pubkey) {
    const [said, own] = shownApart(C!, ev.pubkey)
    breaks = `a spawn whose C (${said}) is not the coordinate the public key decodes to (${own}). A spawn always places an identity at its own key's coordinate, never anywhere else (spec 8.3)`
  } else {
    breaks = 'a spawn that is missing its C tag, or has it malformed, so it places the identity nowhere (spec 8.3)'
  }
  return {
    id: ev.id,
    pubkey: ev.pubkey,
    createdAt: ev.created_at,
    type: 'other',
    name: 'spawn',
    role: 'broken',
    ...home,
    ...(claimed && claimed.coordHex !== home.coordHex ? { declared: claimed } : {}),
    prevCoordHex: null,
    genesisId: null,
    previousId: null,
    proofHash: null,
    breaks,
  }
}

/**
 * Reassemble one pubkey's active chain from whatever the relays handed back
 * (spec 8.7.3): the newest spawn wins, only events whose genesis names it can
 * be part of the chain, the chain is followed forward through previous
 * links, and at a fork the whole chain is dead from its spawn (rule 4). The
 * links are followed through every event, recognized or not (spec 8.9).
 * From the first event that breaks a rule on, the position stops following
 * the events: every entry from there stands at the last valid position.
 *
 * Every event handed in must already be authentic (spec 8.2, 8.7.3), because
 * resolution never checks a signature. Returns the spawn alone when nothing
 * follows it, and nothing when there is no spawn at all.
 */
export function buildChain(events: NostrEvent[], pubkey?: string): ActionEvent[] {
  const spawn = spawnEntry(newestSpawn(events, pubkey))
  if (!spawn) return []

  const byPrev = new Map<string, Array<{ link: ActionLink; ev: NostrEvent }>>()
  for (const ev of events) {
    const link = actionLink(ev)
    if (!link || link.genesisId !== spawn.id || link.pubkey !== spawn.pubkey) continue
    const list = byPrev.get(link.previousId) ?? []
    list.push({ link, ev })
    byPrev.set(link.previousId, list)
  }

  const chain: ActionEvent[] = [spawn]
  const seen = new Set([spawn.id])
  let head: ActionEvent = spawn
  let open: ActionEvent | null = null
  let frozenAt: Placed | null = spawn.breaks ? { coordHex: spawn.coordHex, position: spawn.position, plane: spawn.plane, sector: spawn.sector } : null
  let fork: { previousId: string; branches: ActionLink[] } | null = null
  for (;;) {
    const children = [...new Map((byPrev.get(head.id) ?? []).map((c) => [c.link.id, c])).values()]
    if (children.length > 1) {
      fork = { previousId: head.id, branches: children.map((c) => c.link).sort((a, b) => -newer(a, b)) }
      break
    }
    const next = children.filter((c) => !seen.has(c.link.id))[0]
    if (!next) break
    let entry = placeInChain(next.ev, next.link, head, open)
    if (entry.type === 'hyperjump' && !entry.breaks) {
      const ride = rideBreak(entry, lookBack(chain, chain.length), next.ev)
      if (ride) entry = { ...entry, breaks: ride }
    }
    if (entry.breaks && !frozenAt) frozenAt = { coordHex: head.coordHex, position: head.position, plane: head.plane, sector: head.sector }
    if (entry.role === 'enter') open = entry
    else if (entry.role === 'exit') open = null
    chain.push(frozenAt ? standingAt(entry, frozenAt) : entry)
    seen.add(entry.id)
    head = entry
  }
  if (fork && !spawn.breaks) {
    const home: Placed = { coordHex: spawn.coordHex, position: spawn.position, plane: spawn.plane, sector: spawn.sector }
    const ids = fork.branches.map((b) => `${b.id.slice(0, 8)}...`)
    const listed = ids.length === 2 ? `${ids[0]} and ${ids[1]}` : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`
    const shared = chain.length - 1
    for (let i = 1; i < chain.length; i++) chain[i] = standingAt(chain[i], home)
    chain[0] = {
      ...chain[0],
      breaks: `a fork: ${countWord(ids.length)} events (${listed}) ${ids.length === 2 ? 'both name' : 'all name'} row ${shared} (event ${fork.previousId.slice(0, 8)}...) as the action before them. ${FORK_RULE_WORDS}`,
      fork: { previousId: fork.previousId, branchIds: fork.branches.map((b) => b.id) },
    }
  }
  return chain
}

/** Why a ride breaks the rules about where it may start, or null (DECK-0001 4.2, 4.3). */
function rideBreak(ride: ActionEvent, stood: ActionEvent | null, ev: NostrEvent): string | null {
  if (stood?.type === 'enter-hyperspace') {
    const asOfTags = tagCount(ev, 'as_of')
    if (asOfTags > 1) return `a first ride after boarding carrying ${countWord(asOfTags)} as_of tags. Every tag the chain rules read has to appear exactly once (DECK-0001 8)`
    if (asOfTags === 1 && ride.asOf === undefined) return 'a first ride after boarding whose as_of tag is not a block height (DECK-0001 4.2)'
    if (ride.asOf === undefined) return 'a first ride after boarding with no as_of tag (DECK-0001 4.2, 4.3)'
    if (ride.asOf < ride.toHeight!) return `a first ride whose as_of (${ride.asOf}) is below the block it rides to (${ride.toHeight}) (DECK-0001 4.2)`
    return null
  }
  if (stood?.type === 'hyperjump') {
    if (ride.fromHeight !== stood.toHeight) return `a ride that leaves from block ${ride.fromHeight}, but the ride before it stopped at block ${stood.toHeight} (DECK-0001 4.3)`
    return null
  }
  return 'a ride (hyperjump) that does not follow a boarding or another ride (DECK-0001 4.3)'
}

/** An entry at or after the first break, standing where the chain froze. */
function standingAt(entry: ActionEvent, at: Placed): ActionEvent {
  if (entry.coordHex === at.coordHex) return entry
  const claimed = entry.declared ?? { coordHex: entry.coordHex, position: entry.position, plane: entry.plane, sector: entry.sector }
  return { ...entry, ...at, declared: claimed }
}

/** Two different coordinates, each cut to the stretch where they differ. */
export function shownApart(a: string, b: string): [string, string] {
  let d = 0
  while (d < a.length && a[d] === b[d]) d++
  const start = Math.min(d, Math.max(0, a.length - 8))
  const cut = (h: string): string => `${start > 0 ? '...' : ''}${h.slice(start, start + 8)}${start + 8 < h.length ? '...' : ''}`
  const plane = HEX_64.test(a) && HEX_64.test(b) && planeBitOnly(a, b)
  return plane ? [`${cut(a)}, the same x, y and z in the other plane`, cut(b)] : [cut(a), cut(b)]
}

const an = (name: string): string => `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`

function startsElsewhere(name: string, c: string | null, stood: string): string {
  if (!c) return `it names no c, no place it starts from, but every ${name} has to start exactly where the chain stood, ${tailOf(stood)} (spec 8.9 rule 2, 8.11.5)`
  const [from, at] = shownApart(c, stood)
  return `it starts from ${from}, but the action before it left the identity at ${at}. Every ${name} has to start exactly where the chain stood, or it would be a teleport (spec 8.9 rule 2, 8.11.5)`
}

const tailOf = (hex: string): string => `...${hex.slice(-8)}`

/** Why an event's sector tags break the rules, or null (spec 10). */
function sectorTagsWrong(ev: NostrEvent, name: string, at: Position): string | null {
  const want = sectorTags(at)
  const missing = want.filter(([k]) => tag(ev, k) === undefined).map(([k]) => k)
  if (missing.length > 0) {
    return `${an(name)} without its sector tag${missing.length === 1 ? '' : 's'} ${missing.join(', ')}. Every move has to carry its X, Y, Z and S sector tags, so that relays can find it by where it is (spec 10)`
  }
  const doubled = want.map(([k]) => [k, tagCount(ev, k)] as const).filter(([, n]) => n > 1)
  if (doubled.length > 0) {
    const said = doubled.map(([k, n]) => `${countWord(n)} ${k} tags`).join(' and ')
    return `${an(name)} carrying ${said}. Each sector tag has to appear exactly once, like the A tag (spec 10)`
  }
  const wrong = want.filter(([k, v]) => tag(ev, k) !== v)
  if (wrong.length === 0) return null
  const said = wrong.map(([k, v]) => `${k} says ${tag(ev, k)} where its coordinate is in ${v}`).join('; ')
  return `${an(name)} whose sector tags do not agree with its own coordinate: ${said} (spec 10)`
}

function planeBitOnly(a: string, b: string): boolean {
  const p = coordToXyz(hexToCoord(a))
  const q = coordToXyz(hexToCoord(b))
  return p.plane !== q.plane && p.x === q.x && p.y === q.y && p.z === q.z
}

function withSectorCheck(ev: NostrEvent, a: ActionEvent, name: string): ActionEvent {
  const at = placeOf(tag(ev, 'C'))
  const wrong = at ? sectorTagsWrong(ev, name, at.position) : null
  return wrong ? { ...a, breaks: wrong } : a
}

/** One event's entry in the chain, given the entry before it and the bracket open at that point. */
function placeInChain(ev: NostrEvent, link: ActionLink, before: ActionEvent, open: ActionEvent | null): ActionEvent {
  const placed = placeByName(ev, link, before, open)
  const aWrong = aTagsWrong(ev)
  const read: RecognizedAction | 'links' = open
    ? (link.name === 'exit-virtual' ? 'exit-virtual' : 'links')
    : (isRecognized(link.name) ? link.name : 'links')
  const tagsWrong = aWrong ? null : readTagsWrong(ev, read, read === 'links' ? 'event' : read === 'enter-hyperspace' ? 'boarding' : link.name)
  const wrong = aWrong ?? tagsWrong
  if (!wrong) return placed
  return { ...placed, role: placed.role === 'skipped' || link.name === '' ? 'broken' : placed.role, breaks: wrong }
}

function placeByName(ev: NostrEvent, link: ActionLink, before: ActionEvent, open: ActionEvent | null): ActionEvent {
  const parsed = parseAction(ev)
  const carried: Placed = { coordHex: before.coordHex, position: before.position, plane: before.plane, sector: before.sector }
  const declared = placeOf(tag(ev, 'C'), tag(ev, 'S'))
  const prev = tag(ev, 'c')
  const prevCoordHex = prev && HEX_64.test(prev) ? prev : null
  const unread = (role: ChainRole, breaks?: string, bracketId?: string): ActionEvent => ({
    id: link.id,
    pubkey: link.pubkey,
    createdAt: link.createdAt,
    type: 'other',
    name: link.name,
    role,
    ...carried,
    ...(declared ? { declared } : {}),
    prevCoordHex,
    genesisId: link.genesisId,
    previousId: link.previousId,
    proofHash: null,
    ...(bracketId ? { bracketId } : {}),
    ...(breaks ? { breaks } : {}),
  })

  if (open) {
    if (link.name === 'exit-virtual') {
      if (parsed?.type === 'exit-virtual' && parsed.entryId === open.id && parsed.coordHex === open.coordHex) {
        return withSectorCheck(ev, { ...parsed, role: 'exit', bracketId: open.id }, 'exit from a game')
      }
      return unread('broken', parsed?.type === 'exit-virtual'
        ? 'an exit from a game that either names a different entry than the game in progress, or does not put the identity back exactly where it entered (spec 8.11.4 rules 2 and 6)'
        : 'an exit from a game that is missing a tag the chain rules read, or has one malformed', open.id)
    }
    if (BASE_INSIDE_BRACKET.has(link.name)) {
      return unread('broken', `${an(link.name)} signed inside a game. Inside a game only the game's own actions may stand, never a move through cyberspace (spec 8.11.4 rule 3)`, open.id)
    }
    return unread('virtual', undefined, open.id)
  }
  if (parsed && parsed.type === 'enter-virtual') {
    const entry: ActionEvent = { ...parsed, bracketId: parsed.id }
    if (parsed.prevCoordHex !== before.coordHex) return { ...entry, breaks: startsElsewhere('entry into a game', parsed.prevCoordHex, before.coordHex) }
    if (parsed.declared) {
      const [C, c] = shownApart(parsed.declared.coordHex, parsed.coordHex)
      return { ...entry, breaks: `an entry into a game whose C (${C}) is not its own c (${c}). Entering a game does not move the identity (spec 8.11.1)` }
    }
    return withSectorCheck(ev, entry, 'entry into a game')
  }
  if (parsed && parsed.type === 'exit-virtual') return unread('broken', 'an exit from a game when no game was open (spec 8.11.4 rule 6)')
  if (parsed) {
    if (parsed.prevCoordHex !== before.coordHex) {
      return { ...parsed, breaks: startsElsewhere(parsed.type === 'enter-hyperspace' ? 'boarding' : parsed.type, parsed.prevCoordHex, before.coordHex) }
    }
    if (parsed.type === 'hyperjump' && parsed.fromHeight === parsed.toHeight) {
      return { ...parsed, breaks: `a zero-length ride: it rides from block ${parsed.fromHeight} to block ${parsed.toHeight}, the same block, so it goes nowhere (DECK-0001 5.6)` }
    }
    if (parsed.type === 'hyperjump' && !parsed.mp) {
      return { ...parsed, breaks: 'a ride whose mp tag is empty, so it carries none of the openings its proof needs (DECK-0001 5.2, 5.5)' }
    }
    return withSectorCheck(ev, parsed, parsed.type === 'enter-hyperspace' ? 'boarding' : parsed.type)
  }
  return isRecognized(link.name)
    ? unread('broken', `${an(link.name)} that is missing a tag the chain rules read, or has one malformed`)
    : unread('skipped')
}

/**
 * The first event of `chain` that breaks a rule this server can see, and
 * where it is: a verifier treats the chain as invalid from there. Null when
 * the chain shows no such event.
 */
export function firstBreak(chain: ActionEvent[]): { index: number; action: ActionEvent; lastValid: ActionEvent | null } | null {
  const index = chain.findIndex((a) => a.breaks !== undefined)
  return index < 0 ? null : { index, action: chain[index], lastValid: index > 0 ? chain[index - 1] : null }
}

/**
 * The hole nearest the head in the chain a spawn starts, as far as `events`
 * hold it: of the events naming that spawn as their genesis, the newest one
 * whose previous is neither the spawn nor in hand. Null when every link is
 * in hand.
 */
export function chainGap(events: NostrEvent[], spawnId: string): { until: number; missingId: string } | null {
  const ids = new Set(events.map((e) => e.id))
  let gap: ActionLink | null = null
  for (const ev of events) {
    const l = actionLink(ev)
    if (!l || l.genesisId !== spawnId || l.previousId === spawnId || ids.has(l.previousId)) continue
    if (!gap || l.createdAt > gap.createdAt || (l.createdAt === gap.createdAt && l.id > gap.id)) gap = l
  }
  return gap ? { until: gap.createdAt, missingId: gap.previousId } : null
}

/** Where a chain currently puts its identity, and what the next action names as its previous. */
export function chainHead(chain: ActionEvent[]): ActionEvent | null {
  return chain.length ? chain[chain.length - 1] : null
}

/**
 * The action that rules looking back from index `at` see (spec 8.9 rule 4,
 * 8.11.4 rule 8): the nearest recognized action before it, with skipped and
 * broken events passed over and a closed bracket standing for the action
 * before its enter-virtual.
 */
export function lookBack(chain: ActionEvent[], at: number): ActionEvent | null {
  let j = Math.min(at, chain.length) - 1
  while (j >= 0) {
    const a = chain[j]
    if (a.role === 'skipped' || (a.role === 'broken' && !a.bracketId)) { j--; continue }
    if (a.role === 'exit' || a.role === 'virtual' || a.role === 'broken') {
      const enter = chain.findIndex((e) => e.id === a.bracketId)
      if (enter < 0) return null
      if (a.role === 'exit') { j = enter - 1; continue }
      return chain[enter]
    }
    return a
  }
  return null
}

/** What a chain is: none (no spawn), valid, frozen (invalid from some event, standing at the last valid position), or dead (a fork or an invalid spawn). */
export type ChainStatus = 'none' | 'valid' | 'frozen' | 'dead'

export function chainStatus(chain: ActionEvent[]): ChainStatus {
  if (chain.length === 0) return 'none'
  if (chain[0].breaks !== undefined) return 'dead'
  return firstBreak(chain) ? 'frozen' : 'valid'
}
