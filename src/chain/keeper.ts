// keeper.ts: the agent's own chain, as last seen, and the two rules around
// signing onto it: confirm the live head before every signature with no
// reuse (spec 8.7.3; the confirmation itself is resolve.ts
// confirmChainEvents, ported from ONOSENDAI), and reserve the head while a
// move is in flight so two movement calls can never both sign from it.
//
// The confirmHead loop follows ONOSENDAI src/store/useCyberspace.ts
// confirmHead (commit 75725d3): HEAD_CONFIRM_TRIES asks, the second over
// fresh sockets, each asking only for what is newer than the newest event
// the relays already hold; a newer move any relay returns is adopted, and
// the caller then sees a head that is not the one it meant to extend.

import { HEX_64, isAuthentic, type NostrEvent } from '../nostr/event.js'
import type { Relays } from '../nostr/relays.js'
import { placeFromHex, spawnPlace, type Place } from '../space/coords.js'
import type { StateDir } from '../state/dir.js'
import { buildChain, chainStatus, firstBreak, newestSpawn, type ActionEvent, type ChainStatus } from './events.js'
import type { Holders } from './holders.js'
import { askChainEvents, confirmChainEvents, mergeEvents } from './resolve.js'
import { decideSelfCheck, type CheckVerdict } from './selfCheck.js'

export type PublishStatus = 'ok' | 'queued' | 'failed'

interface ChainFile {
  version: 1
  events: NostrEvent[]
  published: Record<string, PublishStatus>
}

const FILE = 'chain.json'

/** Said when nothing counted after HEAD_CONFIRM_TRIES asks. */
export const HEAD_UNCONFIRMED_MESSAGE = 'Could not confirm the live head with the relays, so nothing was signed: the canonical relay did not answer and no other relay holding this chain did either. Signing from an unconfirmed head could fork the chain, and a fork kills it. Try again in a moment.'
const HEAD_CONFIRM_TRIES = 2

export class ChainKeeper {
  events: NostrEvent[] = []
  published: Record<string, PublishStatus> = {}
  private movingSince: number | null = null

  constructor(
    private readonly dir: StateDir,
    private readonly relays: Relays,
    private readonly holders: Holders,
    readonly pubkey: string,
    private readonly log: (line: string) => void = () => {},
  ) {
    if (!HEX_64.test(pubkey)) throw new Error('the keeper needs the identity\'s hex pubkey')
    const saved = dir.readJson<ChainFile | null>(FILE, null)
    if (saved?.version === 1 && Array.isArray(saved.events)) {
      // Only authentic events of this identity take part (spec 8.7.3); anything else in the file is gone.
      this.events = saved.events.filter((e) => e.pubkey === pubkey && isAuthentic(e))
      const ids = new Set(this.events.map((e) => e.id))
      for (const [id, status] of Object.entries(saved.published ?? {})) if (ids.has(id)) this.published[id] = status
    }
  }

  private save(): void {
    this.dir.writeJson(FILE, { version: 1, events: this.events, published: this.published } satisfies ChainFile)
  }

  chain(): ActionEvent[] {
    return buildChain(this.events, this.pubkey)
  }

  status(): ChainStatus {
    return chainStatus(this.chain())
  }

  head(): ActionEvent | null {
    const chain = this.chain()
    return chain.length ? chain[chain.length - 1] : null
  }

  genesisId(): string | undefined {
    return newestSpawn(this.events, this.pubkey)?.id
  }

  /** Where the identity stands: the head's position, or the spawn coordinate with no chain. */
  place(): Place {
    const head = this.head()
    return head ? placeFromHex(head.coordHex) : spawnPlace(this.pubkey)
  }

  /** Why the chain cannot be extended, in words, or null when it can. */
  breakWords(): string | null {
    const chain = this.chain()
    if (chain.length === 0) return null
    const status = chainStatus(chain)
    if (status === 'valid') return null
    const broken = firstBreak(chain)!
    return status === 'dead'
      ? `The chain is dead: ${broken.action.breaks}. The identity stands at its spawn coordinate and can do nothing on this chain until it respawns.`
      : `The chain is frozen at its last valid position: event ${broken.action.id.slice(0, 8)}... is ${broken.action.breaks}. Nothing signed after it counts until the identity respawns.`
  }

  /** The newest event of the chain the relays already hold (published, or adopted from them). */
  anchor(): NostrEvent | undefined {
    let newest: NostrEvent | undefined
    for (const e of this.events) if (this.published[e.id] === 'ok' && (newest === undefined || e.created_at > newest.created_at)) newest = e
    return newest
  }

  /**
   * Fold events the relays returned into the chain: only this identity's
   * authentic events, each marked as on the relays. Returns whether anything
   * new arrived.
   */
  adopt(incoming: NostrEvent[]): boolean {
    const own = incoming.filter((e) => e.pubkey === this.pubkey && isAuthentic(e))
    const before = this.events.length
    this.events = mergeEvents(this.events, own)
    let changed = this.events.length !== before
    for (const e of own) {
      if (this.published[e.id] !== 'ok') { this.published[e.id] = 'ok'; changed = true }
    }
    if (changed) this.save()
    return changed
  }

  /** Forget events this server signed that the relays' chain has overruled (a fork or an ended chain): they are never published. */
  dropLocal(ids: Set<string>): void {
    if (ids.size === 0) return
    this.events = this.events.filter((e) => !ids.has(e.id))
    for (const id of ids) delete this.published[id]
    this.save()
  }

  /** Record an event this server signed, before it is sent anywhere. */
  record(event: NostrEvent, status: PublishStatus = 'queued'): void {
    if (!this.events.some((e) => e.id === event.id)) this.events.push(event)
    this.published[event.id] = status
    this.save()
  }

  markPublished(id: string, status: PublishStatus): void {
    if (!this.events.some((e) => e.id === id)) return
    this.published[id] = status
    this.save()
  }

  /** Whether a move is in flight. */
  get moving(): boolean {
    return this.movingSince !== null
  }

  /** Reserve the head for one move. Throws, with a plain message, while another move holds it. */
  reserve(): () => void {
    if (this.movingSince !== null) {
      const seconds = Math.round((Date.now() - this.movingSince) / 1000)
      throw new Error(`A move is already in flight (for ${seconds} s). One key has one mover: wait for it to finish before asking for another.`)
    }
    this.movingSince = Date.now()
    return () => { this.movingSince = null }
  }

  /**
   * Confirm this server holds the identity's live head before a chain
   * action is signed. Null when confirmed; the refusal's words otherwise.
   * Every answer is folded in first, so the caller compares the head with
   * the one it meant to extend.
   */
  async confirmHead(): Promise<string | null> {
    for (let i = 0; i < HEAD_CONFIRM_TRIES; i++) {
      const anchor = this.anchor()
      const got = await confirmChainEvents(this.relays, this.holders, this.pubkey, this.genesisId(), this.events, {
        since: anchor?.created_at, anchorId: anchor?.id, reconnect: i > 0,
      }).catch((err) => { this.log(`confirm failed: ${err instanceof Error ? err.message : String(err)}`); return null })
      if (got) {
        this.adopt(got)
        return null
      }
    }
    return HEAD_UNCONFIRMED_MESSAGE
  }

  /** Whether this identity already has a chain on the relays: found (adopted), none, or unknown with a cause. */
  async selfCheck(): Promise<CheckVerdict> {
    const answers = await askChainEvents(this.relays, this.holders, this.pubkey, this.genesisId(), this.events)
    const verdict = decideSelfCheck(answers, this.relays.canonical)
    if (verdict.status === 'found') this.adopt(verdict.events)
    return verdict
  }
}
