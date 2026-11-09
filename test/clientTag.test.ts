// clientTag.test.ts: the NIP-89 client tag (D5, 2026-11-09). The kind 0
// profile carries ["client", "cyberspace-mcp"], so arrivals of
// cyberspace-mcp agents can be counted apart from ONOSENDAI's (which signs
// ["client", "ONOSENDAI"]); by name only, as ONOSENDAI writes its own, since
// NIP-89's third element is a kind 31990 handler address and there is none.
// Every event the agent signs gets it in one place, signEvent (event.ts), so
// this also scans the source for a way around it, as ONOSENDAI's
// clientTagGuard.test.ts does: a raw finalizeEvent anywhere else must be one
// of the events that is never attributed (relay auth, the NIP-17 seal and
// wrap, which must reveal nothing, and a wallet request signed with the
// wallet connection's own key, never the agent's).

import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { Agent } from '../src/agent.js'
import { attributed, bytesToHex, CLIENT_NAME } from '../src/nostr/event.js'
import type { Calibration } from '../src/space/calibration.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork } from './fakeRelay.js'

const SRC = new URL('../src/', import.meta.url).pathname
const CANONICAL = 'wss://canonical.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sources(path))
    else if (name.endsWith('.ts')) out.push(path)
  }
  return out
}

describe('the client tag', () => {
  const running: Agent[] = []
  afterAll(async () => { for (const a of running) await a.stop() })

  it('is ["client", "cyberspace-mcp"], added once, and never to an auth event', () => {
    expect(CLIENT_NAME).toBe('cyberspace-mcp')
    expect(attributed({ kind: 0, created_at: 1, tags: [], content: '{}' }).tags).toEqual([['client', 'cyberspace-mcp']])
    expect(attributed({ kind: 0, created_at: 1, tags: [['client', 'cyberspace-mcp']], content: '{}' }).tags).toEqual([['client', 'cyberspace-mcp']])
    expect(attributed({ kind: 22242, created_at: 1, tags: [], content: '' }).tags).toEqual([])
  })

  it('is on the kind 0 profile identity publishes, exactly once', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL)
    const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-client-'))
    StateDir.open(dir)
    writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(generateSecretKey()), createdAt: 'test' }), { mode: 0o600 })
    const a = await Agent.start({
      stateDir: dir, relays: [CANONICAL], capCallSeconds: 30, capSessionSeconds: 120, maxSidestepHeight: 24, allowRespawn: false,
      websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1000, name: 'counted',
    })
    running.push(a)
    await a.identity({})
    const profile = canonical.published.find((e) => e.kind === 0 && e.pubkey === a.pubkey)
    expect(profile).toBeDefined()
    expect(profile!.tags.filter((t) => t[0] === 'client')).toEqual([['client', 'cyberspace-mcp']])
  }, 30_000)

  it('cannot be signed around: a raw finalizeEvent outside signEvent is only for events that are never attributed', () => {
    const allowed: Record<string, RegExp> = {
      // The one signing path: signEvent attributes the template.
      'nostr/event.ts': /finalizeEvent\(attributed\(template\)/,
      // NIP-42 relay auth (kind 22242): a proof handed to one relay, never published.
      'agent.ts': /signAuth: async \(t\) => finalizeEvent\(t, this\.sk\)/,
      'doctor.ts': /signAuth: async \(t\) => finalizeEvent\(t, secret\)/,
      // The NIP-17 seal (empty tags by the NIP) and the gift wrap (reveals nothing).
      'nostr/dm.ts': /finalizeEvent\(\{ kind: (SEAL_KIND|WRAP_KIND),/,
      // Relay auth and wallet requests, signed with the wallet connection's own key, never the agent's.
      'nwc.ts': /finalizeEvent\(t, sk\)|finalizeEvent\(\{ kind: NWC_REQUEST_KIND,/,
    }
    for (const file of sources(SRC)) {
      const name = relative(SRC, file)
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!/\b(finalizeEvent|schnorr\.sign)\s*\(/.test(line) || /^\s*(\/\/|\*)/.test(line)) continue
        expect(allowed[name], `${name}: ${line.trim()}`).toBeDefined()
        expect(allowed[name].test(line), `${name}: ${line.trim()}`).toBe(true)
      }
    }
  })
})
