// liveSub.test.ts: a subscription that outlives its socket (after
// ONOSENDAI's liveSub): the reissued filter moves since forward with a
// minute of overlap, the backoff climbs and clamps, and the registry reopens
// a subscription the transport reports closed.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { BACKOFF_MS, LiveRegistry, RESUME_OVERLAP_S, backoffFor, resumedFilter, type Transport } from '../src/nostr/liveSub.js'

describe('resuming a subscription', () => {
  it('moves since to just before the last event seen, never backward', () => {
    expect(resumedFilter({ kinds: [1] }, null)).toEqual({ kinds: [1] })
    expect(resumedFilter({ kinds: [1], since: 100 }, 1000)).toEqual({ kinds: [1], since: 1000 - RESUME_OVERLAP_S })
    expect(resumedFilter({ kinds: [1], since: 5000 }, 1000)).toEqual({ kinds: [1], since: 5000 })
  })

  it('backs off along the table and clamps at its end', () => {
    expect(backoffFor(1)).toBe(BACKOFF_MS[0])
    expect(backoffFor(3)).toBe(BACKOFF_MS[2])
    expect(backoffFor(99)).toBe(BACKOFF_MS[BACKOFF_MS.length - 1])
  })
})

describe('the registry', () => {
  afterEach(() => vi.useRealTimers())

  it('reopens a subscription the transport reports closed, after the backoff', async () => {
    vi.useFakeTimers()
    const opens: Array<{ since?: number }> = []
    let closeIt: ((reason: string) => void) | null = null
    let deliver: ((ev: { created_at: number }) => void) | null = null
    const transport: Transport = {
      open: async (filter, handlers, onClose) => {
        opens.push({ since: filter.since })
        closeIt = onClose
        deliver = (ev) => handlers.onEvent(ev as never)
        return () => {}
      },
    }
    const registry = new LiveRegistry(transport)
    const stop = registry.subscribe({ kinds: [1] }, { onEvent: () => {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(opens).toHaveLength(1)
    deliver!({ created_at: 5000 })
    closeIt!('relay connection closed')
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0] + 1)
    expect(opens).toHaveLength(2)
    expect(opens[1].since).toBe(5000 - RESUME_OVERLAP_S)
    stop()
    expect(registry.list()).toHaveLength(0)
  })
})
