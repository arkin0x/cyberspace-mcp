// hosakaWorld.ts: what the HOSAKA ride tests share: the fixture line, a key
// whose station starts a cheap stretch of it (so a real proof is computed
// in milliseconds), a state directory holding that key, the operator's DMs
// as they read them, and waiting for the background to get somewhere.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as nip17 from 'nostr-tools/nip17'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { LineStore, type Line } from '../src/hyperspace/line.js'
import { lineTerrainK } from '../src/hyperspace/ride.js'
import { bytesToHex } from '../src/nostr/event.js'
import type { Calibration } from '../src/space/calibration.js'
import { placeOf, spawnPlace } from '../src/space/coords.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import type { FakeRelay } from './fakeRelay.js'
import { MANIFEST_URL, fakeFetch, servedFor } from './hyperspace/lineFixture.js'

export const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }
export const TIP = 6143
export const RIDE_LENGTH = 3
const CHEAP_K = 6
export const served = servedFor(3)
export { MANIFEST_URL, fakeFetch }

/** The fixture line, verified once per test file. */
export async function probeLine(): Promise<Line> {
  const probe = LineStore.open(join(mkdtempSync(join(tmpdir(), 'cyberspace-mcp-hosaka-probe-')), 'line'), { manifestUrl: MANIFEST_URL, fetch: fakeFetch(served) })
  const sync = await probe.sync({ budgetSeconds: 60 })
  if (sync.asOf !== TIP) throw new Error(`the fixture line did not verify: ${sync.failure}`)
  return probe.line
}

function cheapAbove(line: Line, s: number): boolean {
  if (s + RIDE_LENGTH > TIP) return false
  for (let h = s + 1; h <= s + RIDE_LENGTH; h++) if (lineTerrainK(line.blockHash(h)!) > CHEAP_K) return false
  return true
}

/** A key whose station (after a hop of dx 5) starts a cheap stretch of the line, and that station's block. */
export function cheapKey(line: Line): { sk: Uint8Array; S: number } {
  for (let tries = 0; tries < 50_000; tries++) {
    const candidate = generateSecretKey()
    const home = spawnPlace(getPublicKey(candidate))
    const head = placeOf({ x: home.position.x + 5n, y: home.position.y, z: home.position.z }, home.plane)
    const station = line.station(head.hex, TIP)
    if (station && cheapAbove(line, station.stop.height)) return { sk: candidate, S: station.stop.height }
  }
  throw new Error('no key found whose station starts a cheap stretch of the line')
}

export function dirWithKey(sk: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-hosaka-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
  return dir
}

/** The DMs the operator can read on their inbox, oldest first. */
export function dmsTo(inbox: FakeRelay, opSk: Uint8Array): string[] {
  const op = getPublicKey(opSk)
  return inbox.published
    .filter((e) => e.kind === 1059 && e.tags.some((t) => t[0] === 'p' && t[1] === op))
    .map((w) => nip17.unwrapEvent(w as Parameters<typeof nip17.unwrapEvent>[0], opSk))
    .sort((a, b) => a.created_at - b.created_at)
    .map((r) => r.content)
}

/** Wait until `ok` holds, checking every 10 ms, or fail after `ms`. */
export async function until(ok: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Let the background run a few more steps. */
export function settle(ms = 200): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
