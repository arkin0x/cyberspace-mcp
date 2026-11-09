// cpuSafety.test.ts: the CPU safety defaults (D3, 2026-11-09). A stranger's
// machine gets 15 s per call, 180 s per session, at most two threads for
// rides and avatars, and a daily cap of 1800 s counted in the state
// directory, so a stdio client that starts a fresh process per chat cannot
// spend more than that in a UTC day. The cap survives a restart, starts over
// at UTC midnight, and its refusal names the cap and how the human raises it.
// The flags that raise the caps keep working. Nothing leaves the process.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { Agent } from '../src/agent.js'
import { avatarThreads } from '../src/avatarMine.js'
import { Budget, DAILY_BUDGET_FILE, defaultThreads, type DailyRecord, type DailyStore } from '../src/budget.js'
import { parseArgs, settingsFrom } from '../src/config.js'
import { bytesToHex } from '../src/nostr/event.js'
import type { Calibration } from '../src/space/calibration.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork } from './fakeRelay.js'

const CANONICAL = 'wss://canonical.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }

function memoryStore(initial: unknown = null): DailyStore & { record: unknown } {
  const s = { record: initial, read: () => s.record, write: (r: DailyRecord) => { s.record = r } }
  return s
}

describe('the defaults', () => {
  it('are 15 s per call, 180 s per session, 1800 s per day, and min(2, cores - 1) threads', () => {
    const s = settingsFrom({ state: '/tmp/x', relays: [] }, {})
    expect(s.capCallSeconds).toBe(15)
    expect(s.capSessionSeconds).toBe(180)
    expect(s.capDailySeconds).toBe(1800)
    expect(s.threads).toBe(defaultThreads())
    expect([1, 2, 3, 4, 8, 64].map((c) => defaultThreads(c))).toEqual([1, 1, 2, 2, 2, 2])
    expect(avatarThreads()).toBe(defaultThreads())
    expect(avatarThreads(5)).toBe(5)
  })

  it('the flags and config.json still raise them, and --threads sets the threads', () => {
    const args = parseArgs(['--state', '/tmp/x', '--cap-call-seconds', '120', '--cap-session-seconds', '900', '--cap-daily-seconds', '7200', '--threads', '6'])
    const s = settingsFrom(args, {})
    expect([s.capCallSeconds, s.capSessionSeconds, s.capDailySeconds, s.threads]).toEqual([120, 900, 7200, 6])
    const f = settingsFrom({ state: '/tmp/x', relays: [] }, { capCallSeconds: 60, capSessionSeconds: 600, capDailySeconds: 3600, threads: 3 })
    expect([f.capCallSeconds, f.capSessionSeconds, f.capDailySeconds, f.threads]).toEqual([60, 600, 3600, 3])
    expect(() => parseArgs(['--threads', '0'])).toThrow(/positive/)
  })
})

describe('the daily cap', () => {
  const day1 = Date.parse('2026-11-09T23:00:00Z')

  it('refuses above it, naming the cap, when it starts over, and how the human raises it', () => {
    const b = new Budget(15, 180, { capDailySeconds: 20, store: memoryStore(), now: () => day1 })
    b.spendMove(12)
    expect(b.refusal(5)).toBeNull()
    const why = b.refusal(10)
    expect(why).toMatch(/daily cap of 20 s/)
    expect(why).toMatch(/8\.0 s left/)
    expect(why).toMatch(/00:00 UTC, in about 1\.0 h/)
    expect(why).toContain('--cap-daily-seconds')
    expect(why).toContain('capDailySeconds in config.json')
    expect(b.remainingSeconds()).toBe(8)
    expect(b.state()).toMatchObject({ capDailySeconds: 20, spentTodaySeconds: 12, remainingTodaySeconds: 8, dailyResetsAt: '2026-11-10T00:00:00.000Z' })
  })

  it('survives a restart, and a KEEP GOING renews the session but never the day', () => {
    const store = memoryStore()
    const first = new Budget(15, 180, { capDailySeconds: 30, store, now: () => day1 })
    first.spendMove(14)
    first.spendWork(10)
    expect(store.record).toEqual({ day: '2026-11-09', spentSeconds: 24 })
    // A fresh process: a fresh session, the same day.
    const second = new Budget(15, 180, { capDailySeconds: 30, store, now: () => day1 })
    expect(second.spentSeconds).toBe(0)
    expect(second.state().spentTodaySeconds).toBe(24)
    expect(second.refusal(7)).toMatch(/daily cap of 30 s/)
    second.renew()
    expect(second.refusal(7)).toMatch(/daily cap of 30 s/)
  })

  it('starts over at UTC midnight', () => {
    let now = day1
    const store = memoryStore({ day: '2026-11-09', spentSeconds: 1800 })
    const b = new Budget(15, 180, { capDailySeconds: 1800, store, now: () => now })
    expect(b.refusal(1)).toMatch(/daily cap of 1800 s/)
    now = Date.parse('2026-11-10T00:00:01Z')
    expect(b.refusal(1)).toBeNull()
    expect(b.state().spentTodaySeconds).toBe(0)
    b.spendWork(2)
    expect(store.record).toEqual({ day: '2026-11-10', spentSeconds: 2 })
    // A record of an earlier day read at startup counts for nothing today.
    expect(new Budget(15, 180, { capDailySeconds: 1800, store: memoryStore({ day: '2026-11-08', spentSeconds: 1800 }), now: () => now }).refusal(1)).toBeNull()
  })

  it('a clock set back never hands out a fresh allowance: a record of a later day is kept until that day is over', () => {
    let now = Date.parse('2026-11-09T10:00:00Z')
    const store = memoryStore({ day: '2026-11-10', spentSeconds: 1790 })
    const b = new Budget(15, 180, { capDailySeconds: 1800, store, now: () => now })
    expect(b.state().spentTodaySeconds).toBe(1790)
    expect(b.refusal(11)).toMatch(/daily cap of 1800 s/)
    expect(b.state().dailyResetsAt).toBe('2026-11-11T00:00:00.000Z')
    b.spendWork(1)
    expect(store.record).toEqual({ day: '2026-11-10', spentSeconds: 1791 })
    now = Date.parse('2026-11-11T00:00:01Z')
    expect(b.state().spentTodaySeconds).toBe(0)
  })

  it('a record more than a day ahead is a clock mistake: dropped, so it cannot block until that date', () => {
    const now = Date.parse('2026-11-09T10:00:00Z')
    const store = memoryStore({ day: '2027-03-01', spentSeconds: 1800 })
    const b = new Budget(15, 180, { capDailySeconds: 1800, store, now: () => now })
    expect(b.state().spentTodaySeconds).toBe(0)
    expect(b.refusal(5)).toBeNull()
    expect(b.state().dailyResetsAt).toBe('2026-11-10T00:00:00.000Z')
    b.spendWork(1)
    expect(store.record).toEqual({ day: '2026-11-09', spentSeconds: 1 })
  })

  it('is none without a cap (a library caller that sets none), and a malformed record reads as zero', () => {
    expect(new Budget(15, 180).state().capDailySeconds).toBeNull()
    expect(new Budget(15, 180).remainingSeconds()).toBe(180)
    expect(new Budget(15, 180, { capDailySeconds: 10, store: memoryStore({ day: 7 }), now: () => day1 }).state().spentTodaySeconds).toBe(0)
  })
})

describe('the daily cap in the server', () => {
  const running: Agent[] = []
  afterAll(async () => { for (const a of running) await a.stop() })

  it('is read from <state>/budget-daily.json at startup, so plan_hop refuses after a restart, and budget shows it', async () => {
    const network = new FakeNetwork()
    network.add(CANONICAL)
    const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-cpu-'))
    StateDir.open(dir)
    writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(generateSecretKey()), createdAt: 'test' }), { mode: 0o600 })
    const today = new Date().toISOString().slice(0, 10)
    writeFileSync(join(dir, DAILY_BUDGET_FILE), JSON.stringify({ day: today, spentSeconds: 1799.999 }))
    const a = await Agent.start({
      stateDir: dir, relays: [CANONICAL], capCallSeconds: 15, capSessionSeconds: 180, capDailySeconds: 1800, maxSidestepHeight: 24, allowRespawn: false,
      websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1000,
    })
    running.push(a)
    const plan = await a.planHop({ target: { dx: '4000', dy: '0', dz: '0' } })
    expect(plan.data.refused).toMatch(/daily cap of 1800 s/)
    const budget = a.budgetState()
    expect(budget.text).toMatch(/Today \(UTC, across restarts\): 1800\.0 s spent, 0\.0 s left of the 1800 s daily cap/)
    expect(JSON.parse(readFileSync(join(dir, DAILY_BUDGET_FILE), 'utf8')).spentSeconds).toBeCloseTo(1799.999)
  }, 30_000)
})
