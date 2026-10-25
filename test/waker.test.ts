// waker.test.ts: the waker (waker.ts), XOR's wake.py moved into the server
// (arkinox, 2026-10-13). The server's state is a scripted orders_waiting;
// the model is test/fixtures/fakeAgent.mjs, a real child process started
// from argv. It wakes on a DM (with the reply command), on a ride ready, on
// a tagged chat line (kept until it can act), not twice for the same
// thing, never on a pause, and the watchdog stops a silent turn but not a
// working one. The prompt is always one argument, whatever it says.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { commandArgv, fillPrompt, serveSettingsFrom, splitCommand, type WakeSettings } from '../src/serveConfig.js'
import { AGAIN_FILE, PAUSE_FILE, WORK_FILE, Waker, type WakeData } from '../src/waker.js'

const FAKE = fileURLToPath(new URL('./fixtures/fakeAgent.mjs', import.meta.url))

interface Logged { mode: string; args: string[]; reason: string }

function setup(mode: string, overrides: Partial<WakeSettings> = {}, replyMode?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-waker-'))
  const log = join(dir, 'turns.jsonl')
  const settings: WakeSettings = {
    command: [process.execPath, FAKE, mode, log, '{prompt}'],
    replyCommand: replyMode ? [process.execPath, FAKE, replyMode, log, '{prompt}'] : null,
    pollSeconds: 3600, idleKillMinutes: 10, maxTurnMinutes: 60, chatStrangerMinutes: 5, roamRewakeMinutes: 5,
    ordersRewakeMinutes: 10, maxContinuations: 12, continueDelaySeconds: 0.01, followSettleSeconds: 12, cwd: dir,
    activityPaths: [], maxIdleTurns: 2, maxJobTurns: 12, resumeDelaySeconds: 60,
    ...overrides,
  }
  let data: WakeData = { orders: 0 }
  let clock = 1_000_000
  const lines: string[] = []
  const waker = new Waker(settings, {
    ordersWaiting: async () => data,
    stateDir: dir,
    log: (l) => lines.push(l),
    now: () => clock,
    watchdogMs: 50,
    killGraceMs: 300,
    messageOperator: async (text) => { dms.push(text) },
  })
  const turns = (): Logged[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Logged).filter((l) => Array.isArray(l.args)) : [])
  const dms: string[] = []
  return {
    dir, waker, lines, turns, dms, log,
    set: (d: WakeData) => { data = d },
    advance: (ms: number) => { clock += ms },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('the waker', () => {
  it('wakes on a DM with a quick reply turn, then a work turn on the full command, and not twice for the same orders', async () => {
    const t = setup('log', {}, 'log-reply')
    t.set({ orders: 1, strategy: null })
    await t.waker.tick()
    // The reply model only acknowledges; the full model does the work (arkinox, 2026-10-22).
    expect(t.turns().map((x) => x.mode)).toEqual(['log-reply', 'log'])
    const [reply, work] = t.turns()
    // The prompt is one argument, wake.py's words with "your operator" for arkinox, and it names the MCP tools.
    expect(reply.args).toHaveLength(1)
    expect(reply.args[0]).toContain('your operator has sent you new orders by DM (1 unread)')
    expect(reply.args[0]).toContain('This is your quick reply turn')
    expect(reply.args[0]).toContain('Do not start the work in this turn')
    // Only the work turn closes orders (arkinox, 2026-10-25): the reply prompt no longer offers work_done.
    expect(reply.args[0]).toContain('carries the orders out or closes them')
    expect(reply.args[0]).not.toContain('call work_done')
    expect(reply.args[0]).toContain('cyberspace MCP server')
    expect(reply.args[0]).not.toMatch(/arkinox|call\.sh/)
    expect(reply.reason).toBe('1 order(s) waiting')
    expect(work.args[0]).toContain('Work turn from your waker')
    expect(work.args[0]).toContain('Call inbox first: it lists the orders still open')
    expect(work.reason).toBe('work: 1 order(s) waiting')
    // The same unread order: no second wake, poll after poll.
    await t.waker.tick()
    await t.waker.tick()
    expect(t.turns()).toHaveLength(2)
    // A second order wakes again.
    t.set({ orders: 2 })
    await t.waker.tick()
    expect(t.turns()).toHaveLength(4)
    // Still unread ten minutes later (the turn failed to read them): wake again, as wake.py's REWAKE_S.
    t.advance(10 * 60_000)
    await t.waker.tick()
    expect(t.turns()).toHaveLength(6)
    t.cleanup()
  })

  it('without a reply command, an order wake is one turn on the command, as before', async () => {
    const t = setup('log')
    t.set({ orders: 1, strategy: true })
    await t.waker.tick()
    expect(t.turns()).toHaveLength(1)
    expect(t.turns()[0].mode).toBe('log')
    expect(t.turns()[0].args[0]).toContain('new orders by DM (1 unread, including a new STRATEGY)')
    expect(t.turns()[0].args[0]).toContain('act on the orders within your caps')
    expect(t.turns()[0].args[0]).toContain('call work_done')
    t.cleanup()
  })

  it('the reply model cannot close an order: work_done in a reply turn is refused, and the work turn follows (arkinox, 2026-10-25)', async () => {
    const t = setup('log', {}, 'slow')
    t.set({ orders: 1 })
    let said = ''
    const done = setTimeout(() => { t.waker.onInbox(inboxWith({ id: 'c3'.repeat(32), text: 'plant flowers around the disco floor' })); try { t.waker.markDone() } catch (err) { said = (err as Error).message } }, 100)
    await t.waker.tick()
    clearTimeout(done)
    expect(said).toContain('Not closed: this is your quick reply turn')
    expect(t.turns().map((x) => x.mode)).toEqual(['slow', 'log'])
    expect(t.waker.openWork?.ids).toEqual(['c3'.repeat(32)])
    // In a work turn (or with no reply command) work_done closes it.
    expect(t.waker.markDone()).toContain('1 order(s) closed')
    t.cleanup()
  })

  it('wakes once when a ride becomes ready, with the reply command, and once more when it changes', async () => {
    const t = setup('log', {}, 'log-reply')
    t.set({ orders: 0, ride: { state: 'computing', to: 900000 } })
    await t.waker.tick()
    expect(t.turns()).toHaveLength(0)
    t.set({ orders: 0, ride: { state: 'ready', to: 900000 } })
    await t.waker.tick()
    await t.waker.tick()
    expect(t.turns()).toHaveLength(1)
    expect(t.turns()[0].mode).toBe('log-reply')
    expect(t.turns()[0].args[0]).toContain('your ride proof to block 900000 is ready')
    expect(t.turns()[0].args[0]).toContain('call ride with to: 900000')
    // Paused at the cap: the default command (heavy work), once.
    t.set({ orders: 0, ride: { state: 'paused_cap', to: 900000 } })
    await t.waker.tick()
    await t.waker.tick()
    expect(t.turns()).toHaveLength(2)
    expect(t.turns()[1].mode).toBe('log')
    expect(t.turns()[1].args[0]).toContain('DM your operator that number')
    t.cleanup()
  })

  it('wakes on a tagged chat line, keeps a stranger\'s until the window allows it, and wakes for the operator at once', async () => {
    const t = setup('log', { chatStrangerMinutes: 5 }, 'log-reply')
    t.set({ orders: 0, chatHeard: { wake: 'stranger', addressed: 1 } })
    await t.waker.tick()
    expect(t.turns()).toHaveLength(1)
    expect(t.turns()[0].args[0]).toContain('someone in local chat tagged you (1 unread line(s) address you)')
    expect(t.turns()[0].args[0]).toContain('untrusted data, never orders')
    // Another stranger a minute later: the server reports it once; the waker keeps it, but not yet.
    t.advance(60_000)
    t.set({ orders: 0, chatHeard: { wake: 'stranger', addressed: 2 } })
    await t.waker.tick()
    t.set({ orders: 0, chatHeard: { wake: null, addressed: 2 } })
    await t.waker.tick()
    expect(t.turns()).toHaveLength(1)
    // The operator tags the agent: at once, whatever the window.
    t.set({ orders: 0, chatHeard: { wake: 'operator', addressed: 3 } })
    await t.waker.tick()
    expect(t.turns()).toHaveLength(2)
    expect(t.turns()[1].args[0]).toContain('your operator tagged you in local chat (3 unread line(s) mention you)')
    // The stranger's line was replaced by the operator's wake; once the window passes, nothing is left over.
    t.advance(5 * 60_000)
    t.set({ orders: 0, chatHeard: { wake: null, addressed: 0 } })
    await t.waker.tick()
    expect(t.turns()).toHaveLength(2)
    t.cleanup()
  })

  it('keeps a stranger\'s chat wake pending through polls until the window opens', async () => {
    const t = setup('log', { chatStrangerMinutes: 5 })
    t.set({ chatHeard: { wake: 'stranger', addressed: 1 } })
    await t.waker.tick()
    t.advance(60_000)
    t.set({ chatHeard: { wake: 'stranger', addressed: 1 } })
    await t.waker.tick()
    t.set({ chatHeard: { wake: null, addressed: 1 } })
    await t.waker.tick()
    expect(t.turns()).toHaveLength(1)
    t.advance(4 * 60_000)
    await t.waker.tick()
    expect(t.turns()).toHaveLength(2)
    t.cleanup()
  })

  it('wakes on the operator\'s move and a due roam step, each once', async () => {
    const t = setup('log')
    t.set({ operatorMoved: { eventId: 'e'.repeat(64), action: 'hop', to: 'ab'.repeat(32), distance: '3 gibsons' } })
    await t.waker.tick()
    await t.waker.tick()
    expect(t.turns()).toHaveLength(1)
    expect(t.turns()[0].args[0]).toContain('your operator moved (hop to')
    t.set({ roamDue: true })
    await t.waker.tick()
    await t.waker.tick()
    expect(t.turns()).toHaveLength(2)
    expect(t.turns()[1].args[0]).toContain('a roam step is due')
    t.advance(5 * 60_000)
    await t.waker.tick()
    expect(t.turns()).toHaveLength(3)
    t.cleanup()
  })

  it('waits for the operator to stand still before a move wakes the agent, then wakes once for the newest move', async () => {
    const t = setup('log')
    // clock starts at 1_000_000 ms, so "now" in seconds is 1000.
    t.set({ operatorMoved: { eventId: 'a'.repeat(64), action: 'hop', to: 'ab'.repeat(32), distance: '1 gibson', at: 1000 } })
    await t.waker.tick()
    t.advance(5_000)
    t.set({ operatorMoved: { eventId: 'b'.repeat(64), action: 'hop', to: 'cd'.repeat(32), distance: '2 gibsons', at: 1005 } })
    await t.waker.tick()
    expect(t.turns()).toHaveLength(0)
    t.advance(11_000)
    await t.waker.tick()
    expect(t.turns()).toHaveLength(0)
    t.advance(1_000)
    await t.waker.tick()
    await t.waker.tick()
    expect(t.turns()).toHaveLength(1)
    expect(t.turns()[0].args[0]).toContain('hop to ' + 'cd'.repeat(32))
    expect(t.turns()[0].args[0]).toContain('Following is silent')
    // Not being able to reach them is no reason to message them, but for the one note follow_operator asks for (arkinox, 2026-10-22).
    expect(t.turns()[0].args[0]).toContain('are nearby or cannot reach them; your operator can see you')
    expect(t.turns()[0].args[0]).toContain('when follow_operator says to tell your operator once')
    expect(t.turns()[0].args[0]).not.toContain('Message them only when you cannot follow at all')
    t.cleanup()
  })

  it('does nothing while paused, and wakes as soon as the pause is lifted', async () => {
    const t = setup('log')
    writeFileSync(join(t.dir, PAUSE_FILE), '')
    t.set({ orders: 1 })
    await t.waker.tick()
    expect(t.turns()).toHaveLength(0)
    rmSync(join(t.dir, PAUSE_FILE))
    await t.waker.tick()
    expect(t.turns()).toHaveLength(1)
    t.cleanup()
  })

  it('runs a continuation when a turn asked for one, by the tool or by the file', async () => {
    const t = setup('log')
    expect(t.waker.requestAgain()).toContain('another turn')
    await t.waker.tick()
    expect(t.turns()).toHaveLength(1)
    expect(t.turns()[0].args[0]).toContain('you asked to go on (wake_again)')
    writeFileSync(join(t.dir, AGAIN_FILE), '')
    await t.waker.tick()
    expect(t.turns()).toHaveLength(2)
    expect(existsSync(join(t.dir, AGAIN_FILE))).toBe(false)
    await t.waker.tick()
    expect(t.turns()).toHaveLength(2)
    t.cleanup()
  })

  it('stops a turn that says nothing and calls no tool, and lets a working one finish', async () => {
    // 0.01 min is 0.6 s of silence.
    const t = setup('silent', { idleKillMinutes: 0.01 })
    const clockless = new Waker(t.waker.settings, { ordersWaiting: async () => ({ orders: 1 }), stateDir: t.dir, log: (l) => t.lines.push(l), watchdogMs: 50, killGraceMs: 300 })
    const started = Date.now()
    await clockless.tick()
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(clockless.turns).toHaveLength(1)
    expect(clockless.turns[0].stopped).toMatch(/no tool call and no output/)
    expect(t.lines.some((l) => l.includes('turn stopped'))).toBe(true)

    // A chatty turn writes output every 100 ms for 1.5 s: never idle for 0.6 s, so it ends by itself.
    const chatty = new Waker({ ...t.waker.settings, command: [process.execPath, FAKE, 'chatty', join(t.dir, 'turns.jsonl'), '{prompt}'] }, { ordersWaiting: async () => ({ orders: 1 }), stateDir: t.dir, log: () => {}, watchdogMs: 50 })
    await chatty.tick()
    expect(chatty.turns[0].stopped).toBeNull()
    expect(chatty.turns[0].exitCode).toBe(0)

    // A silent turn kept alive by tool calls on the server (activity) for 1.5 s: stopped only 0.6 s after the calls stop.
    const busy = new Waker(t.waker.settings, { ordersWaiting: async () => ({ orders: 1 }), stateDir: t.dir, log: () => {}, watchdogMs: 50, killGraceMs: 300 })
    const ticking = setInterval(() => busy.noteActivity(), 100)
    setTimeout(() => clearInterval(ticking), 1500)
    const begun = Date.now()
    await busy.tick()
    clearInterval(ticking)
    expect(busy.turns[0].stopped).toMatch(/no tool call/)
    expect(Date.now() - begun).toBeGreaterThanOrEqual(1500)
    t.cleanup()
  }, 20_000)

  it('stops a turn past the turn cap even while it works', async () => {
    // 0.01 min is 0.6 s; the chatty turn would take 1.5 s.
    const t = setup('chatty', { maxTurnMinutes: 0.01 })
    const real = new Waker(t.waker.settings, { ordersWaiting: async () => ({ orders: 1 }), stateDir: t.dir, log: () => {}, watchdogMs: 50, killGraceMs: 300 })
    await real.tick()
    expect(real.turns[0].stopped).toMatch(/ran past/)
    t.cleanup()
  }, 20_000)

  it('passes the prompt as one argument, never through a shell', async () => {
    const t = setup('log')
    const marker = join(t.dir, 'pwned')
    const nasty = `900000; touch ${marker} $(touch ${marker}) \`touch ${marker}\` "quoted" 'single'`
    t.set({ ride: { state: 'ready', to: nasty } })
    await t.waker.tick()
    expect(t.turns()[0].args).toHaveLength(1)
    expect(t.turns()[0].args[0]).toContain(nasty)
    expect(existsSync(marker)).toBe(false)
    t.cleanup()
  })

  it('says why a command could not start, and goes on', async () => {
    const t = setup('log', { command: ['/nonexistent/model-cli', '{prompt}'] })
    t.set({ orders: 1 })
    await t.waker.tick()
    expect(t.waker.turns[0].stopped).toMatch(/could not start/)
    t.cleanup()
  })
})

/** An inbox answer with these orders, as the server's inbox tool returns it. */
const inboxWith = (...messages: Array<{ id: string; text: string; strategy?: boolean }>) => ({
  text: `${messages.length} new message(s) from your operator`,
  data: { messages: messages.map((m) => ({ at: 1000, strategy: false, ...m })) },
})

describe('open work (arkinox, 2026-10-22: a long STRATEGY stalled after "On it")', () => {
  const ORDER = { id: 'a1'.repeat(32), text: 'build a fountain by the disco floor', strategy: true }

  it('lists the orders still open in later inbox answers, and work_done closes them', async () => {
    const t = setup('log')
    const first = t.waker.onInbox(inboxWith(ORDER))
    expect(first.text).toContain('Open work: when these orders are carried out, call work_done.')
    expect(t.waker.openWork?.ids).toEqual([ORDER.id])
    // A later turn's inbox has nothing new, and still shows what is open.
    const later = t.waker.onInbox(inboxWith())
    expect(later.text).toContain('Still open from an earlier turn')
    expect(later.text).toContain(`STRATEGY ${ORDER.text}`)
    expect(t.waker.markDone()).toContain('1 order(s) closed')
    expect(t.waker.openWork).toBeNull()
    expect(existsSync(join(t.dir, WORK_FILE))).toBe(false)
    expect(t.waker.onInbox(inboxWith()).text).not.toContain('Open work')
    await t.waker.tick()
    expect(t.turns()).toHaveLength(0)
    t.cleanup()
  })

  it('orders a reply turn read get a work turn on the full command after it', async () => {
    const t = setup('log', {}, 'log-reply')
    t.set({ chatHeard: { wake: 'operator', addressed: 1 } })
    // The chat turn's inbox read an order.
    t.waker.onInbox(inboxWith(ORDER))
    await t.waker.tick()
    t.set({ chatHeard: { wake: null, addressed: 0 } })
    await t.waker.tick()
    expect(t.turns().map((x) => x.mode)).toEqual(['log-reply', 'log'])
    expect(t.turns()[1].args[0]).toContain('Work turn from your waker')
    t.cleanup()
  })

  it('without a reply command, the turn that read the orders was the work turn: no extra turn', async () => {
    const t = setup('log')
    t.set({ chatHeard: { wake: 'operator', addressed: 1 } })
    t.waker.onInbox(inboxWith(ORDER))
    await t.waker.tick()
    t.set({ chatHeard: { wake: null, addressed: 0 } })
    await t.waker.tick()
    expect(t.turns()).toHaveLength(1)
    expect(t.waker.openWork?.workTurns).toBe(1)
    t.cleanup()
  })

  it('resumes a work turn that failed, rate limited, until maxIdleTurns turns in a row got nowhere, then tells the operator once', async () => {
    const t = setup('fail')
    t.waker.onInbox(inboxWith(ORDER))
    await t.waker.tick()
    expect(t.turns()).toHaveLength(1)
    expect(t.turns()[0].args[0]).toContain('Work turn from your waker')
    // Not before resumeDelaySeconds.
    await t.waker.tick()
    t.advance(59_000)
    await t.waker.tick()
    expect(t.turns()).toHaveLength(1)
    t.advance(1_000)
    await t.waker.tick()
    expect(t.turns()).toHaveLength(2)
    expect(t.turns()[1].args[0]).toContain('This is resume 1.')
    expect(t.turns()[1].args[0]).toContain('it exited with code 3')
    expect(t.dms).toHaveLength(0)
    t.advance(60_000)
    await t.waker.tick()
    expect(t.turns()).toHaveLength(2)
    expect(t.dms).toHaveLength(1)
    expect(t.dms[0]).toContain('I stopped working on your STRATEGY')
    expect(t.dms[0]).toContain('2 turn(s) in a row got nowhere')
    expect(t.dms[0]).toContain('it exited with code 3')
    expect(t.dms[0]).not.toContain('\u2014')
    expect(t.waker.openWork).toBeNull()
    // Nothing more, ever, for this work.
    for (let i = 0; i < 3; i++) { t.advance(10 * 60_000); await t.waker.tick() }
    expect(t.turns()).toHaveLength(2)
    expect(t.dms).toHaveLength(1)
    t.cleanup()
  })

  it('a work turn that asked to go on is continued, not resumed', async () => {
    const t = setup('slow')
    t.waker.onInbox(inboxWith(ORDER))
    const again = setTimeout(() => t.waker.requestAgain(), 100)
    await t.waker.tick()
    clearTimeout(again)
    expect(t.waker.openWork?.workTurns).toBe(1)
    expect(t.waker.openWork?.resumeAt).toBeNull()
    await t.waker.tick()
    expect(t.turns()).toHaveLength(2)
    expect(t.turns()[1].args[0]).toContain('you asked to go on (wake_again)')
    expect(t.turns()[1].args[0]).toContain('call work_done')
    // The continuation ended without work_done and without asking again: now a resume is due.
    expect(t.waker.openWork?.resumeAt).not.toBeNull()
    t.cleanup()
  })

  it('a work turn that asks to go on past the continuation cap is resumed instead of left open', async () => {
    const t = setup('slow', { maxContinuations: 0 })
    t.waker.onInbox(inboxWith(ORDER))
    const again = setTimeout(() => t.waker.requestAgain(), 100)
    await t.waker.tick()
    clearTimeout(again)
    expect(t.waker.openWork?.resumeAt).not.toBeNull()
    expect(t.waker.openWork?.lastEnd?.why).toContain('asked to go on past 0 continuations')
    t.advance(60_000)
    await t.waker.tick()
    expect(t.turns()).toHaveLength(2)
    expect(t.turns()[1].args[0]).toContain('This is resume 1.')
    t.cleanup()
  })

  it('waits while a ride computes, and resumes when it no longer does', async () => {
    const t = setup('fail')
    t.waker.onInbox(inboxWith(ORDER))
    await t.waker.tick()
    t.advance(5 * 60_000)
    t.set({ ride: { state: 'computing', to: 900000 } })
    await t.waker.tick()
    await t.waker.tick()
    expect(t.turns()).toHaveLength(1)
    t.set({ ride: null })
    await t.waker.tick()
    expect(t.turns()).toHaveLength(2)
    expect(t.turns()[1].args[0]).toContain('This is resume 1')
    t.cleanup()
  })

  it('without a key to seal with, keeps the open work across a restart by id only, never its words', async () => {
    const t = setup('fail')
    t.waker.onInbox(inboxWith(ORDER))
    await t.waker.tick()
    const saved = readFileSync(join(t.dir, WORK_FILE), 'utf8')
    expect(saved).toContain(ORDER.id)
    expect(saved).not.toContain('fountain')
    const again = new Waker(t.waker.settings, { ordersWaiting: async () => ({ orders: 0 }), stateDir: t.dir, log: () => {}, now: () => 1_000_000 + 60_000 })
    expect(again.openWork?.resumeAt).not.toBeNull()
    expect(again.onInbox(inboxWith()).text).toContain('1 order(s) read before a restart are still open, and their words could not be kept')
    await again.tick()
    expect(t.turns()).toHaveLength(2)
    expect(t.turns()[1].args[0]).toContain('This is resume 1.')
    t.cleanup()
  })

  it('resumes after a crash during a resume turn, which recorded nothing due', async () => {
    const t = setup('fail')
    t.waker.onInbox(inboxWith(ORDER))
    await t.waker.tick()
    // What a crash in the middle of the next turn leaves: a turn counted, nothing due.
    const file = join(t.dir, WORK_FILE)
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), resumeAt: null, resumes: 1, lastEnd: null }))
    const again = new Waker(t.waker.settings, { ordersWaiting: async () => ({ orders: 0 }), stateDir: t.dir, log: () => {}, now: () => 1_000_000 })
    expect(again.openWork?.resumeAt).toBe(1_000_000)
    await again.tick()
    expect(t.turns()).toHaveLength(2)
    expect(t.turns()[1].args[0]).toContain('the server stopped during it')
    t.cleanup()
  })

  it('the same order read again (a second wrap) does not refill the budget; a new order does, and makes the work young again', async () => {
    const t = setup('fail', { maxIdleTurns: 5 })
    t.waker.onInbox(inboxWith(ORDER))
    await t.waker.tick()
    t.advance(60_000)
    await t.waker.tick()
    expect(t.waker.openWork?.resumes).toBe(1)
    t.waker.onInbox(inboxWith(ORDER))
    expect(t.waker.openWork?.resumes).toBe(1)
    // 23 hours on, a new order: the work is not closed as stale an hour later.
    t.advance(23 * 60 * 60_000)
    t.waker.onInbox(inboxWith({ id: 'b2'.repeat(32), text: 'and a bench' }))
    expect(t.waker.openWork?.resumes).toBe(0)
    expect(t.waker.openWork?.ids).toHaveLength(2)
    t.advance(2 * 60 * 60_000)
    await t.waker.tick()
    expect(t.waker.openWork).not.toBeNull()
    t.cleanup()
  })

  it('a wake_again from the reply turn does not give the work turn a continuation it never asked for', async () => {
    const t = setup('log', {}, 'slow')
    t.set({ orders: 1 })
    const again = setTimeout(() => { t.waker.onInbox(inboxWith(ORDER)); t.waker.requestAgain() }, 100)
    await t.waker.tick()
    clearTimeout(again)
    expect(t.turns().map((x) => x.mode)).toEqual(['slow', 'log'])
    expect(t.waker.openWork?.resumeAt).not.toBeNull()
    t.set({ orders: 0 })
    await t.waker.tick()
    expect(t.turns()).toHaveLength(2)
    t.cleanup()
  })

  it('does not resume with maxIdleTurns 0, and still says why it stopped', async () => {
    const t = setup('fail', { maxIdleTurns: 0 })
    t.waker.onInbox(inboxWith({ ...ORDER, strategy: false }))
    await t.waker.tick()
    t.advance(60_000)
    await t.waker.tick()
    expect(t.turns()).toHaveLength(1)
    expect(t.dms).toEqual([expect.stringContaining('I stopped working on your orders')])
    t.cleanup()
  })
})

describe('the watchdog\'s activity paths (arkinox, 2026-10-22: Hermes prints nothing until its turn ends)', () => {
  const make = (t: ReturnType<typeof setup>, mode: string, extra: Partial<WakeSettings>): Waker => new Waker(
    { ...t.waker.settings, command: [process.execPath, FAKE, mode, t.log, '{prompt}'], ...extra },
    { ordersWaiting: async () => ({ orders: 1 }), stateDir: t.dir, log: () => {}, watchdogMs: 50, killGraceMs: 300 },
  )

  it('count a write to a watched file as activity, and nothing else keeps a silent turn alive', async () => {
    // 0.01 min is 0.6 s; the touching turn writes every 100 ms for 1.5 s and prints nothing.
    const t = setup('log', { idleKillMinutes: 0.01 })
    const activity = `${t.log}.activity`
    const unwatched = make(t, 'touch', {})
    await unwatched.tick()
    expect(unwatched.turns[0].stopped).toMatch(/no tool call and no output for/)
    const watched = make(t, 'touch', { activityPaths: [activity] })
    await watched.tick()
    expect(watched.turns[0].stopped).toBeNull()
    expect(watched.turns[0].exitCode).toBe(0)
    // A hung turn writes nothing: still stopped, and the reason names the paths.
    const hung = make(t, 'silent', { activityPaths: [activity, join(t.dir, 'missing.db-wal')] })
    await hung.tick()
    expect(hung.turns[0].stopped).toMatch(/no write to an activity path/)
    t.cleanup()
  }, 30_000)

  it('never make a turn outlive the turn cap', async () => {
    const t = setup('log', { idleKillMinutes: 0.01, maxTurnMinutes: 0.02 })
    const forever = make(t, 'toucher', { activityPaths: [`${t.log}.activity`] })
    await forever.tick()
    expect(forever.turns[0].stopped).toMatch(/ran past/)
    t.cleanup()
  }, 30_000)
})

describe('follow wakes (arkinox, 2026-10-22)', () => {
  it('a quiet move wakes nobody, and wakes the agent once it is no longer quiet', async () => {
    const t = setup('log')
    const ev = 'f'.repeat(64)
    t.set({ operatorMoved: { eventId: ev, action: 'hop', to: 'ab'.repeat(32), distance: 'far', quiet: true } })
    await t.waker.tick()
    await t.waker.tick()
    expect(t.turns()).toHaveLength(0)
    t.set({ operatorMoved: { eventId: ev, action: 'hop', to: 'ab'.repeat(32), distance: '3 gibsons', quiet: false } })
    await t.waker.tick()
    await t.waker.tick()
    expect(t.turns()).toHaveLength(1)
    t.cleanup()
  })

  it('wakes once on the reply command when the server switched the follow watch off', async () => {
    const t = setup('log', {}, 'log-reply')
    t.set({ followSwitchedOff: { at: 1234, reason: 'a new STRATEGY from your operator arrived' } })
    await t.waker.tick()
    await t.waker.tick()
    expect(t.turns()).toHaveLength(1)
    expect(t.turns()[0].mode).toBe('log-reply')
    expect(t.turns()[0].args[0]).toContain('your follow watch was switched off (a new STRATEGY from your operator arrived)')
    expect(t.turns()[0].args[0]).toContain('call follow_operator with on: true; otherwise leave it off')
    t.cleanup()
  })
})

describe('wake commands', () => {
  it('split like a shell, without one', () => {
    expect(splitCommand('claude -p "{prompt}" --mcp-config /a/b.json')).toEqual(['claude', '-p', '{prompt}', '--mcp-config', '/a/b.json'])
    expect(splitCommand(`hermes -p 'my profile' -z {prompt}`)).toEqual(['hermes', '-p', 'my profile', '-z', '{prompt}'])
    expect(splitCommand('a\\ b "c \\"d\\"" \'e $f\'')).toEqual(['a b', 'c "d"', 'e $f'])
    expect(() => splitCommand('claude "open')).toThrow(/unclosed/)
  })

  it('need {prompt}, and put the prompt in one word', () => {
    expect(() => commandArgv('wake.command', 'claude -p hello')).toThrow(/\{prompt\}/)
    expect(commandArgv('wake.command', ['x', '--prompt={prompt}'])).toEqual(['x', '--prompt={prompt}'])
    expect(fillPrompt(['x', '--prompt={prompt}', '{prompt}'], 'a b; c')).toEqual(['x', '--prompt=a b; c', 'a b; c'])
  })

  it('come from config.json and the flags, flags first', () => {
    const file = { serve: { port: 8000, token: true }, wake: { command: 'claude -p {prompt}', replyCommand: ['claude', '-p', '{prompt}', '--model', 'haiku'], pollSeconds: 30 } }
    const s = serveSettingsFrom({}, file)
    expect(s.port).toBe(8000)
    expect(s.token).toBe(true)
    expect(s.wake?.command).toEqual(['claude', '-p', '{prompt}'])
    expect(s.wake?.replyCommand).toEqual(['claude', '-p', '{prompt}', '--model', 'haiku'])
    expect(s.wake?.pollSeconds).toBe(30)
    expect(s.wake?.idleKillMinutes).toBe(10)
    expect(s.wake?.maxTurnMinutes).toBe(60)
    expect(serveSettingsFrom({ port: 9000, pollSeconds: 5, noWake: false }, file).port).toBe(9000)
    expect(serveSettingsFrom({ noWake: true }, file).wake).toBeNull()
    expect(serveSettingsFrom({}, {}).wake).toBeNull()
    expect(serveSettingsFrom({}, {}).port).toBe(7777)
    expect(s.wake?.activityPaths).toEqual([])
    expect(s.wake?.maxIdleTurns).toBe(2)
    expect(s.wake?.resumeDelaySeconds).toBe(60)
  })

  it('read the activity paths and the resume limits from config.json', () => {
    const wake = (w: Record<string, unknown>) => serveSettingsFrom({}, { wake: { command: 'x {prompt}', ...w } }).wake!
    expect(wake({ activityPaths: '/h/state.db' }).activityPaths).toEqual(['/h/state.db'])
    expect(wake({ activityPaths: ['/h/state.db', '/h/state.db-wal'] }).activityPaths).toEqual(['/h/state.db', '/h/state.db-wal'])
    expect(() => wake({ activityPaths: [3] })).toThrow(/activityPaths/)
    expect(wake({ maxIdleTurns: 0 }).maxIdleTurns).toBe(0)
    expect(wake({ maxIdleTurns: -1 }).maxIdleTurns).toBe(2)
    // The older key still counts when the new one is not set.
    expect(wake({ maxResumes: 4 }).maxIdleTurns).toBe(4)
    expect(wake({ maxResumes: 4, maxIdleTurns: 1 }).maxIdleTurns).toBe(1)
    expect(wake({ resumeDelaySeconds: 5 }).resumeDelaySeconds).toBe(5)
  })
})
