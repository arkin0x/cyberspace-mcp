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
import { hopCeiling, type Calibration } from '../src/space/calibration.js'
import { placeOf, spawnPlace, type Place } from '../src/space/coords.js'
import { priceNextStep } from '../src/space/plan.js'
import { MAX_COMPUTE_HEIGHT } from '../src/space/regionKeys.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import type { FakeRelay } from './fakeRelay.js'
import { MANIFEST_URL, fakeFetch, servedFor } from './hyperspace/lineFixture.js'

export const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }
export const TIP = 6143
export const RIDE_LENGTH = 3
const CHEAP_K = 6
/**
 * The most the setup hop (dx 5 from the spawn) may be quoted at, in seconds.
 * The HOSAKA tests run under a 0.05 s session cap, and a hop is refused
 * before any work when its quote is above what the session has left. The
 * quote depends on the key: about 1 key in 100 lands that hop on a gibson of
 * terrain K 13 or more, quoted at 0.09 s and up with `cal`, so the setup hop
 * was refused and every later test in the file, which needs the agent on
 * the line, failed with it (CI, 2026-11-09). A tenth of that cap leaves
 * the setup hop always within it.
 */
const SETUP_HOP_MAX_SECONDS = 0.005
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

/** The setup hop's quote with `cal`, priced as the agent prices it (its ceilings: hopCeiling of cal, at most MAX_COMPUTE_HEIGHT; sidesteps to h24). */
function setupHopSeconds(home: Place, head: Place): number {
  const step = priceNextStep(home, head, { hop: Math.min(MAX_COMPUTE_HEIGHT, hopCeiling(cal.cantorMsByHeight)), sidestep: 24 }, cal)
  return step ? step.seconds : 0
}

/**
 * A key whose station (after a hop of dx 5) starts a cheap stretch of the
 * line, and that station's block. That hop is cheap too
 * (SETUP_HOP_MAX_SECONDS), so it fits the tests' tiny session cap.
 */
export function cheapKey(line: Line): { sk: Uint8Array; S: number } {
  for (let tries = 0; tries < 50_000; tries++) {
    const candidate = generateSecretKey()
    const home = spawnPlace(getPublicKey(candidate))
    const head = placeOf({ x: home.position.x + 5n, y: home.position.y, z: home.position.z }, home.plane)
    if (setupHopSeconds(home, head) > SETUP_HOP_MAX_SECONDS) continue
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
