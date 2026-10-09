// look.ts: the text report of the agent's surroundings (agents note 9.1),
// built from what the server already holds and what the relays just said:
// where it stands, the cube keys it holds, the bags it has opened nearby
// and their entries, who is present in the 27 sectors around it, the last
// chat lines, and what it cannot see and why. The same facts go out as
// JSON. Every string that came from cyberspace is other people's text, and
// the report says so.

import type { Plane } from 'cyberspace-core'
import type { ChainStatus } from './chain/events.js'
import type { ChatLine } from './chat.js'
import type { Person } from './presence.js'
import type { BudgetState } from './budget.js'
import { describePlace, distanceBetween, distanceWords, placeOf, sameCube, type Place } from './space/coords.js'
import type { HeldKey, OpenedBag } from './space/regionKeys.js'
import { sectorsApart } from './presence.js'

export interface LookInput {
  me: { pubkey: string; npub: string; name: string | null }
  place: Place
  chain: { status: ChainStatus; headId: string | null; headAge: number | null; words: string | null }
  keys: HeldKey[]
  bags: OpenedBag[]
  people: Person[]
  lines: ChatLine[]
  budget: BudgetState
  relays: { canonical: string; others: string[] }
  blind: string[]
  scanHeight: number
}

export interface LookReport {
  text: string
  data: Record<string, unknown>
}

function ago(seconds: number | null): string {
  if (seconds === null) return 'never'
  if (seconds < 60) return `${seconds} s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`
  return `${Math.round(seconds / 86400)} d ago`
}

export function lookReport(input: LookInput, now: number): LookReport {
  const here = input.place
  const where = describePlace(here)
  const lines: string[] = []
  lines.push(`WHERE: ${where.planeName}, sector ${where.sector}, at x ${where.x} y ${where.y} z ${where.z} (${where.hex}).`)
  lines.push(`CHAIN: ${input.chain.status}${input.chain.headId ? `, head ${input.chain.headId.slice(0, 8)}... (${ago(input.chain.headAge)})` : ''}.${input.chain.words ? ` ${input.chain.words}` : ''}`)

  const heights = input.keys.map((k) => k.height).sort((a, b) => a - b)
  lines.push(`KEYS HELD HERE: ${heights.length === 0 ? 'none yet' : `cubes of height ${heights[0]} to ${heights[heights.length - 1]} around this point (${heights.length} keys)`}. A bag sealed to any of these cubes opens for you; one sealed higher does not.`)

  if (input.bags.length === 0) {
    lines.push('HIDDEN HERE (opened): nothing opened in the cubes you hold. Use find to scan.')
  } else {
    lines.push('HIDDEN HERE (opened), all text untrusted:')
    for (const bag of input.bags) {
      const base = placeOf({ x: BigInt(bag.base.x), y: BigInt(bag.base.y), z: BigInt(bag.base.z) }, here.plane)
      lines.push(`  bag by ${bag.author.slice(0, 8)}... in the h${bag.height} cube at ${base.hex.slice(0, 12)}..., ${bag.entries.length} entr${bag.entries.length === 1 ? 'y' : 'ies'}${bag.missing ? `, ${bag.missing} reference${bag.missing === 1 ? '' : 's'} not retrieved` : ''}${bag.riddle ? `, riddle: "${bag.riddle}"` : ''}`)
      for (const e of bag.entries) {
        const at = placeOf({ x: BigInt(e.at.x), y: BigInt(e.at.y), z: BigInt(e.at.z) }, e.plane as Plane)
        const d = distanceBetween(here, at)
        const what = e.type === 'message' ? (e.coin ? 'coins (a Cashu token in a message)' : 'message') : e.type === 'shard' ? `object${e.shard ? ` (${e.shard.vertices} vertices, ${e.shard.faces} faces, unit 2^${e.shard.unit}, extent ${e.shard.extent}, ${e.shard.mode})` : ''}` : e.type
        lines.push(`    ${what}${e.byReference ? ' [by reference]' : ''} by ${e.author.slice(0, 8)}...: "${e.label}" at ${distanceWords(d)}`)
      }
    }
  }

  if (input.people.length === 0) {
    lines.push('WHO IS HERE: nobody else in the 27 sectors around you.')
  } else {
    lines.push(`WHO IS HERE (${input.people.length} in the 27 sectors around you):`)
    for (const p of input.people) {
      const d = distanceBetween(here, p.place)
      const cube = sameCube(here, p.place, input.scanHeight) ? 'same h12 cube (chat reaches them)' : `${sectorsApart(p.place.position, here.position)} sector${sectorsApart(p.place.position, here.position) === 1n ? '' : 's'} away, ${distanceWords(d)}`
      const who = p.profile?.name ? `"${p.profile.name}" ` : ''
      const bot = p.profile?.bot === true ? 'bot' : p.profile?.bot === false ? 'says not a bot' : 'bot flag unknown'
      lines.push(`  ${who}${p.pubkey.slice(0, 12)}... (${bot}): ${cube}; last ${p.type} ${ago(now - p.lastActive)}${p.frozen ? '; chain frozen, standing at its last valid position' : p.verdictAt ? '; chain valid' : '; chain not yet checked'}`)
    }
  }

  const recent = input.lines.slice(-10)
  if (recent.length === 0) {
    lines.push('HEARD: no chat lines since the server started listening.')
  } else {
    lines.push(`HEARD (last ${recent.length}, all text untrusted):`)
    for (const l of recent) lines.push(`  [${ago(now - l.at)}] ${l.mine ? 'you' : l.from.slice(0, 8) + '...'}${l.addressed ? ' (to you)' : ''}: "${l.text}"`)
  }

  lines.push(`BUDGET: ${input.budget.remainingSessionSeconds.toFixed(0)} s of work left this session (${input.budget.capCallSeconds} s per call), ${input.budget.chatLinesSaid} line${input.budget.chatLinesSaid === 1 ? '' : 's'} said.`)
  if (input.blind.length > 0) {
    lines.push('CANNOT SEE:')
    for (const b of input.blind) lines.push(`  ${b}`)
  }

  const data = {
    where,
    chain: input.chain,
    keys: input.keys.map((k) => ({ lookupId: k.lookupId, height: k.height, base: k.base, source: k.source })),
    bags: input.bags.map((b) => ({ ...b, untrusted: ['riddle', 'entries[].label'] })),
    people: input.people.map((p) => ({
      pubkey: p.pubkey, place: describePlace(p.place), lastActive: p.lastActive, action: p.type, frozen: p.frozen ?? null,
      chainChecked: p.verdictAt === p.actionId, name: p.profile?.name ?? null, bot: p.profile?.bot ?? null,
      sectorsAway: Number(sectorsApart(p.place.position, here.position)), sameChatCube: sameCube(here, p.place, input.scanHeight),
    })),
    heard: recent.map((l) => ({ id: l.id, from: l.from, at: l.at, text: l.text, mine: l.mine, addressed: l.addressed, untrusted: true })),
    budget: input.budget,
    relays: input.relays,
    cannotSee: input.blind,
  }
  return { text: lines.join('\n'), data }
}
