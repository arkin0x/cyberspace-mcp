// avatarSizes.ts: how far each nearby person's avatar reaches, for the rule
// that the agent's avatar never overlaps theirs (space/personalSpace.ts;
// arkinox, 2026-10-11: "avatar overlap feels wrong").
//
// A person's avatar is their newest kind 11333 (spec 8.10), drawn only when
// it has paid its work (paidShard, as ONOSENDAI's useAvatars draws it), else
// the default. Nothing here ever makes a tool wait: radius() answers from
// memory, the default for anyone not read yet, and asks the relays in the
// background, a batch at a time; an answer is kept five minutes, as
// ONOSENDAI's useAvatars refreshes.

import { AVATAR_KIND, paidShard } from './avatar.js'
import type { Filter } from 'nostr-tools/filter'
import type { NostrEvent } from './nostr/event.js'
import { DEFAULT_AVATAR_RADIUS, avatarRadius } from './space/personalSpace.js'
import type { ShardModel } from 'sno-core/shards'

/** How long a read avatar is trusted before it is read again. */
const FRESH_MS = 5 * 60_000
/** How long a failed read waits before it is tried again. */
const RETRY_MS = 30_000
/** Authors per query. */
const BATCH = 100

interface Known {
  radius: number
  name: string | null
  /** When it was read (or when the read failed), ms. */
  at: number
  /** The read failed: the default stands in until the retry. */
  failed?: boolean
}

export class AvatarSizes {
  private readonly known = new Map<string, Known>()
  private readonly wanted = new Set<string>()
  private readonly inflight = new Set<string>()
  private flushing: Promise<void> | null = null

  constructor(
    private readonly relays: { query(filter: Filter): Promise<NostrEvent[]> },
    private readonly log: (line: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /** How far this pubkey's avatar reaches from its center, in gibsons: from memory, the default until read. Starts a read in the background when due. */
  radius(pubkey: string): number {
    this.want([pubkey])
    return this.known.get(pubkey)?.radius ?? DEFAULT_AVATAR_RADIUS
  }

  /** The avatar's name and whether it has been read, for the words. */
  describe(pubkey: string): { name: string | null; read: boolean } {
    const k = this.known.get(pubkey)
    return { name: k?.name ?? null, read: !!k && !k.failed }
  }

  /** Ask for these pubkeys' avatars in the background, those not read lately. */
  want(pubkeys: string[]): void {
    const t = this.now()
    for (const pk of pubkeys) {
      const k = this.known.get(pk)
      if (this.inflight.has(pk)) continue
      if (k && t - k.at < (k.failed ? RETRY_MS : FRESH_MS)) continue
      this.wanted.add(pk)
    }
    if (this.wanted.size > 0 && !this.flushing) {
      // A microtask later, so the pubkeys asked for in one pass go out as one query.
      this.flushing = Promise.resolve().then(() => this.flush()).finally(() => { this.flushing = null })
    }
  }

  /** What this server just published as the agent's own avatar: known at once, no read needed. */
  set(pubkey: string, shard: ShardModel | null): void {
    this.known.set(pubkey, { radius: avatarRadius(shard), name: shard?.name ?? null, at: this.now() })
  }

  /** Tests: wait for the reads in flight. */
  async settled(): Promise<void> {
    while (this.flushing) await this.flushing
  }

  private async flush(): Promise<void> {
    while (this.wanted.size > 0) {
      const batch = [...this.wanted].slice(0, BATCH)
      for (const pk of batch) { this.wanted.delete(pk); this.inflight.add(pk) }
      try {
        const events = await this.relays.query({ kinds: [AVATAR_KIND], authors: batch })
        const newest = new Map<string, NostrEvent>()
        for (const ev of events) {
          if (ev.kind !== AVATAR_KIND || !batch.includes(ev.pubkey)) continue
          const have = newest.get(ev.pubkey)
          // Replaceable (NIP-01): the newest created_at, and on the same second the lowest id.
          if (!have || ev.created_at > have.created_at || (ev.created_at === have.created_at && ev.id < have.id)) newest.set(ev.pubkey, ev)
        }
        const at = this.now()
        for (const pk of batch) {
          const ev = newest.get(pk)
          // A shape that has not paid is drawn as the default, so it is the default's size.
          const shard = ev ? paidShard(ev) : null
          this.known.set(pk, { radius: avatarRadius(shard), name: shard?.name ?? null, at })
        }
      } catch (err) {
        this.log(`avatar read failed: ${err instanceof Error ? err.message : String(err)}`)
        const at = this.now()
        for (const pk of batch) if (!this.known.has(pk) || this.known.get(pk)!.failed) this.known.set(pk, { radius: DEFAULT_AVATAR_RADIUS, name: null, at, failed: true })
      } finally {
        for (const pk of batch) this.inflight.delete(pk)
      }
    }
  }
}
