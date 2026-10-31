// hopProofs.ts: the hops of this agent's own chain, checked at Level 1.
//
// Version 2 of the hop proof (spec 5.9 to 5.13, chain rules
// 2026-10-08-residue-openings) makes a hop cheap to check: one re-roll
// attempt, 16 residues in word arithmetic and 16 short Merkle climbs, never
// a Cantor root (about 15 ms at h20 on a desktop). So the server checks its
// own chain with cyberspace-core's verifyHopLevel1 as a sanity check: on
// load, and whenever the self-check adopts a chain from the relays. It
// reports what it finds in the log and changes nothing: the chain reader
// (events.ts) still decides where the identity stands.
//
// A hop with neither mn nor mp is a version 1 hop. One on the exemption
// list (grandfathered-v1-hops.txt, as cyberspace-core embeds it) stands. One
// that is not listed is reported and never treated as this agent's fault:
// until the census at the cutover fills the list, every version 1 hop this
// server signed before it is unlisted, and the census lists every audited
// one (spec 5.13). Anything else that fails Level 1 is reported by the step
// that failed.

import { hexToCoord, coordToXyz, isGrandfatheredV1Hop, verifyHopLevel1, type Xyz } from 'cyberspace-core'
import type { NostrEvent } from '../nostr/event.js'
import { buildChain } from './events.js'

/** What the check found, over the hops it reached. */
export interface HopProofReport {
  /** Hops checked at Level 1 (version 2) or classified as version 1, this pass and before. */
  checked: number
  /** Version 2 hops whose proof holds. */
  valid: number
  /** Version 1 hops on the exemption list. */
  listed: number
  /** Version 1 hops not on the list: reported, never a stop (see the header). Newest first. */
  unlisted: string[]
  /** Hops whose proof fails, with the steps verifyHopLevel1 names. Newest first. */
  failing: Array<{ id: string; failed: string[] }>
  /** Hops on the chain the time budget left unchecked; the next pass picks them up. */
  skipped: number
}

/** Level 1 of one hop event, from its own tags (spec 8.7.1). Empty means it holds. */
export function hopEventProblems(ev: NostrEvent): string[] {
  const tag = (name: string): string | undefined => ev.tags.find((t) => t[0] === name)?.[1]
  const c = tag('c')
  const C = tag('C')
  const previous = ev.tags.find((t) => t[0] === 'e' && t[3] === 'previous')?.[1]
  if (!c || !C || !previous) return ['form:links']
  const at = (hex: string): Xyz => coordToXyz(hexToCoord(hex))
  return verifyHopLevel1({
    from: at(c), to: at(C), previousEventIdHex: previous,
    proof: tag('proof'), nonce: tag('mn'), openings: tag('mp'),
    eventId: ev.id,
  })
}

/** Whether a hop event carries neither mn nor mp: a version 1 hop (spec 5.13). */
export function isVersion1Hop(ev: NostrEvent): boolean {
  return !ev.tags.some((t) => t[0] === 'mn' || t[0] === 'mp')
}

type Verdict = { kind: 'valid' } | { kind: 'listed' } | { kind: 'unlisted' } | { kind: 'failing'; failed: string[] }

/** By default a pass spends at most this long on proofs; the rest wait for the next pass. */
export const HOP_CHECK_BUDGET_MS = 2_000

/**
 * The checker, with a verdict per event id kept for the process: an event is
 * immutable, so each hop is checked once however many passes see it.
 */
export class HopProofCheck {
  private readonly verdicts = new Map<string, Verdict>()

  constructor(private readonly pubkey: string) {}

  /**
   * Check the hops of the chain these events resolve to, newest first,
   * yielding to the event loop between hops so the lock's heartbeat and the
   * relays keep running. A pass stops after `budgetMs` of work.
   */
  async check(events: NostrEvent[], budgetMs: number = HOP_CHECK_BUDGET_MS): Promise<HopProofReport> {
    const byId = new Map(events.map((e) => [e.id, e]))
    const hops = buildChain(events, this.pubkey).filter((a) => a.type === 'hop').reverse()
    const t0 = performance.now()
    let skipped = 0
    for (const action of hops) {
      if (this.verdicts.has(action.id)) continue
      const ev = byId.get(action.id)
      if (!ev) continue
      if (isVersion1Hop(ev)) {
        // A version 1 hop costs nothing to classify; the list decides.
        this.verdicts.set(action.id, isGrandfatheredV1Hop(ev.id) ? { kind: 'listed' } : { kind: 'unlisted' })
        continue
      }
      if (performance.now() - t0 > budgetMs) { skipped++; continue }
      const failed = hopEventProblems(ev)
      this.verdicts.set(action.id, failed.length === 0 ? { kind: 'valid' } : { kind: 'failing', failed })
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const report: HopProofReport = { checked: 0, valid: 0, listed: 0, unlisted: [], failing: [], skipped }
    for (const action of hops) {
      const v = this.verdicts.get(action.id)
      if (!v) continue
      report.checked++
      if (v.kind === 'valid') report.valid++
      else if (v.kind === 'listed') report.listed++
      else if (v.kind === 'unlisted') report.unlisted.push(action.id)
      else report.failing.push({ id: action.id, failed: v.failed })
    }
    return report
  }
}

/** The report as one log line, or null when there is no hop to speak of. */
export function hopReportWords(r: HopProofReport): string | null {
  if (r.checked === 0 && r.skipped === 0) return null
  const parts = [`hop proofs (Level 1, spec 5.11): ${r.checked} hop(s) checked, ${r.valid} version 2 valid`]
  if (r.listed) parts.push(`${r.listed} version 1 on the exemption list`)
  if (r.unlisted.length) parts.push(`${r.unlisted.length} version 1 not on the list (signed before the cutover; the census lists every audited one, so this is not the agent's fault): newest ${r.unlisted.slice(0, 3).map((id) => `${id.slice(0, 8)}...`).join(', ')}`)
  if (r.failing.length) parts.push(`${r.failing.length} FAILING: ${r.failing.slice(0, 3).map((f) => `${f.id.slice(0, 8)}... (${f.failed.join(', ')})`).join('; ')}`)
  if (r.skipped) parts.push(`${r.skipped} left for the next pass (time budget)`)
  return parts.join('; ')
}
