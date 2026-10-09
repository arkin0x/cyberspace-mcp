// holders.ts: the relays that hold this identity's chain.
//
// Ported from ONOSENDAI src/lib/chainHolders.ts at commit 3756962 (branch
// feat/keys-and-chests), with the state directory in place of localStorage.
//
// Confirming a head before a signature waits for every relay that holds the
// chain, for up to 2.5 s from when its requests go out (resolve.ts
// HEAD_CONFIRM_MS), and for no other. A relay holds the chain once it has
// taken one of this identity's chain events (OK true on a publish) or sent
// one back in a fetch, in this session or an earlier one. The canonical
// relay always does. A relay is never dropped from the set.

import { normalizeURL } from 'nostr-tools/utils'
import type { NostrEvent } from '../nostr/event.js'
import type { RelayAnswer } from '../nostr/relayOutcome.js'
import type { StateDir } from '../state/dir.js'

const FILE = 'holders.json'

export class Holders {
  private set: Set<string>

  constructor(private readonly dir: StateDir, private readonly canonical: string) {
    const saved = dir.readJson<unknown>(FILE, [])
    this.set = new Set(Array.isArray(saved) ? saved.filter((u): u is string => typeof u === 'string').map((u) => normalizeURL(u)) : [])
  }

  /** The relays that hold the chain (normalized URLs), the canonical relay always among them. */
  holders(): Set<string> {
    return new Set([normalizeURL(this.canonical), ...this.set])
  }

  /** These relays hold the chain: one took a chain event, or sent one back. Saved at once. */
  note(urls: string[]): void {
    if (urls.length === 0) return
    const before = this.set.size
    for (const url of urls) this.set.add(normalizeURL(url))
    if (this.set.size === before) return
    this.dir.writeJson(FILE, [...this.set])
  }

  /** The relays whose answer to a chain question held one of `pubkey`'s events. */
  noteFrom(pubkey: string, answers: RelayAnswer[]): void {
    const holds = (events: NostrEvent[]): boolean => events.some((e) => e.pubkey === pubkey)
    this.note(answers.filter((a) => holds(a.events)).map((a) => a.url))
  }
}
