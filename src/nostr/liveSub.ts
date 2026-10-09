// liveSub.ts: a subscription that outlives its socket.
//
// Ported from ONOSENDAI src/lib/liveSub.ts at commit f77da38 (branch
// feat/keys-and-chests), unchanged but for the event type.
//
// A relay socket dies for reasons the process never sees: a NAT forgets an
// idle connection, a relay restarts. This keeps each live subscription as a
// record and reopens it whenever the transport reports it closed, with
// backoff. `since` is moved forward to just before the last event seen, with
// a minute of overlap: a repeat is cheaper than a gap, and every consumer
// merges by id. The transport is injected so the loop runs against the fake
// relay in tests.

import type { Filter } from 'nostr-tools/filter'
import type { NostrEvent } from './event.js'

export interface Handlers {
  onEvent: (ev: NostrEvent) => void
  onEose?: () => void
}

/** What the transport must do: open one subscription and tell us when it closes. */
export interface Transport {
  /** Authenticate and open; resolves to a closer. `onClose` fires when the relay ended it. */
  open: (filter: Filter, handlers: Handlers, onClose: (reason: string) => void) => Promise<() => void>
}

/** Seconds of overlap when a subscription is reissued. */
export const RESUME_OVERLAP_S = 60
/** How long a reopen waits after each successive close, in milliseconds. */
export const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

export interface Live {
  id: number
  filter: Filter
  handlers: Handlers
  lastSeen: number | null
  events: number
  reopens: number
  attempts: number
  closed: boolean
  closer: (() => void) | null
  timer: ReturnType<typeof setTimeout> | null
  opening: boolean
}

/** The filter to reissue with: `since` moved up to just before the last event seen. */
export function resumedFilter(filter: Filter, lastSeen: number | null): Filter {
  if (lastSeen === null) return filter
  const since = Math.max(filter.since ?? 0, lastSeen - RESUME_OVERLAP_S)
  return { ...filter, since }
}

export function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(0, attempts - 1), BACKOFF_MS.length - 1)]
}

export class LiveRegistry {
  private records = new Map<number, Live>()
  private nextId = 1

  constructor(private transport: Transport) {}

  /** Open a subscription that will be kept open. Returns its closer. */
  subscribe(filter: Filter, handlers: Handlers): () => void {
    const live: Live = {
      id: this.nextId++, filter, handlers, lastSeen: null, events: 0, reopens: 0,
      attempts: 0, closed: false, closer: null, timer: null, opening: false,
    }
    this.records.set(live.id, live)
    void this.open(live)
    return () => this.close(live)
  }

  list(): Live[] {
    return [...this.records.values()]
  }

  /** Close every record. */
  closeAll(): void {
    for (const live of [...this.records.values()]) this.close(live)
  }

  private async open(live: Live): Promise<void> {
    if (live.closed || live.opening) return
    live.opening = true
    const generation = live.reopens
    try {
      const closer = await this.transport.open(
        resumedFilter(live.filter, live.lastSeen),
        {
          onEvent: (ev) => {
            if (live.closed) return
            live.events++
            live.attempts = 0
            if (live.lastSeen === null || ev.created_at > live.lastSeen) live.lastSeen = ev.created_at
            live.handlers.onEvent(ev)
          },
          onEose: live.handlers.onEose,
        },
        () => {
          if (live.closed || live.reopens !== generation) return
          live.closer = null
          this.scheduleReopen(live)
        },
      )
      if (live.closed) { closer(); return }
      live.closer = closer
    } catch {
      this.scheduleReopen(live)
    } finally {
      live.opening = false
    }
  }

  private scheduleReopen(live: Live): void {
    if (live.closed || live.timer) return
    live.attempts++
    live.timer = setTimeout(() => {
      live.timer = null
      live.reopens++
      void this.open(live)
    }, backoffFor(live.attempts))
  }

  private close(live: Live): void {
    live.closed = true
    if (live.timer) { clearTimeout(live.timer); live.timer = null }
    live.closer?.()
    live.closer = null
    this.records.delete(live.id)
  }
}
