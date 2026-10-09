// websocket.test.ts: nostr-tools' AbstractRelay and Node's native WebSocket
// recurse to a stack overflow on a failed connection (onerror calls close,
// close re-dispatches error). The guarded socket's idempotent close breaks
// the loop: a connection to a port nothing listens on (loopback, never a
// relay) is rejected once, close is quiet, and the process is still here.

import { describe, expect, it } from 'vitest'
import { AbstractRelay } from 'nostr-tools/abstract-relay'
import { GuardedWebSocket } from '../src/nostr/websocket.js'

describe('the guarded WebSocket', () => {
  it('lets a failed connection reject once instead of overflowing the stack', async () => {
    let closes = 0
    const relay = new AbstractRelay('ws://127.0.0.1:1', { verifyEvent: () => true, enablePing: false, enableReconnect: false, websocketImplementation: GuardedWebSocket as unknown as typeof WebSocket })
    relay.onnotice = () => {}
    relay.onclose = () => { closes++ }
    await expect(relay.connect({ timeout: 2000 })).rejects.toBeDefined()
    expect(() => relay.close()).not.toThrow()
    await new Promise((r) => setTimeout(r, 50))
    expect(closes).toBeLessThan(10)
  })

  it('close is a no-op the second time', () => {
    const ws = new GuardedWebSocket('ws://127.0.0.1:1')
    ws.onerror = () => {}
    ws.onclose = () => {}
    expect(() => { ws.close(); ws.close(); ws.close() }).not.toThrow()
  })
})
