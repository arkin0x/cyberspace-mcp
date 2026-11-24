// paymentApproval.test.ts: the operator approves each payment first, and
// hears of each one after (arkinox, 2026-11-23: "the current limits are
// fine, but I would want to know when any spend happens, and I'd want xor
// to ask before spending every time"). Enforced by the server, never the
// model: no payment without the operator's code; a wrong code, a stranger,
// an expired, refused or used approval pay nothing; the limits still hold.
// Fake relays, a fake HOSAKA and a fake wallet; throwaway keys.

import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Agent } from '../src/agent.js'
import { Approvals, readAnswer, withoutCodes } from '../src/approvals.js'
import { parseArgs, settingsFrom } from '../src/config.js'
import type { Line } from '../src/hyperspace/line.js'
import { wrapMessage } from '../src/nostr/dm.js'
import { nowSeconds, type NostrEvent } from '../src/nostr/event.js'
import { Secret } from '../src/nwc.js'
import { createServer } from '../src/server.js'
import { StateDir } from '../src/state/dir.js'
import { Wallet } from '../src/wallet.js'
import { FakeHosaka, RIDE_MSATS } from './fakeHosaka.js'
import { FakeNetwork } from './fakeRelay.js'
import { FakeWalletService, encodeBolt11 } from './fakeWallet.js'
import { MANIFEST_URL, cal, cheapKey, dirWithKey, dmsTo, fakeFetch, probeLine, served, settle, until } from './hosakaWorld.js'

describe('the setting', () => {
  it('is none by default, operator when asked, and refuses anything else', () => {
    expect(settingsFrom(parseArgs(['--state', '/tmp/x']), {}).paymentApproval).toBe('none')
    expect(settingsFrom(parseArgs(['--state', '/tmp/x']), { paymentApproval: 'operator' }).paymentApproval).toBe('operator')
    expect(settingsFrom(parseArgs(['--state', '/tmp/x', '--payment-approval', 'operator']), {}).paymentApproval).toBe('operator')
    expect(() => settingsFrom(parseArgs(['--state', '/tmp/x']), { paymentApproval: 'yes' })).toThrow(/"operator" or "none"/)
  })
})

describe('approval requests', () => {
  const hash = 'ab'.repeat(32)
  let clock = 1_000_000_000_000
  const fresh = (ttl = 30 * 60_000) => new Approvals(StateDir.open(mkdtempSync(join(tmpdir(), 'approvals-'))), 'operator', () => clock, ttl)
  const ask = (a: Approvals) => a.request({ depositId: 'dep1', paymentHash: hash, sats: 21, purpose: 'a ride', payee: 'HOSAKA' })
  const at = () => Math.floor(clock / 1000)

  it('waits for the code; a message without it, or naming another, answers nothing', () => {
    const a = fresh()
    const r = ask(a)
    expect(r.code).toMatch(/^PAY-[2-9A-HJKMNP-Z]{6}$/)
    expect(a.verdict('dep1', 21, hash).state).toBe('pending')
    expect(a.answer('yes go ahead', at(), 'm1')).toBeNull()
    expect(a.answer('yes PAY-AAAAAA', at(), 'm2')).toBeNull()
    expect(a.answer(`yes ${r.code}X`, at(), 'm3')).toBeNull()
    expect(a.verdict('dep1', 21, hash).state).toBe('pending')
    expect(a.answer(`yes ${r.code.toLowerCase()}`, at(), 'm4')?.state).toBe('approved')
    expect(a.verdict('dep1', 21, hash).state).toBe('approved')
  })

  it('one approval is one payment of exactly that amount and invoice, used once', () => {
    const a = fresh()
    const r = ask(a)
    a.answer(r.code, at(), 'm1')
    expect(a.verdict('dep1', 22, hash).state).toBe('mismatch')
    expect(a.use(r.code, 22, hash)).toBe(false)
    expect(a.use(r.code, 21, 'cd'.repeat(32))).toBe(false)
    expect(a.use(r.code, 21, hash)).toBe(true)
    expect(a.use(r.code, 21, hash)).toBe(false)
    expect(a.verdict('dep1', 21, hash).state).toBe('used')
    // Answering again does not bring it back.
    expect(a.answer(r.code, at(), 'm2')).toBeNull()
  })

  it('expires with nothing paid, and a late answer approves nothing', () => {
    const a = fresh(1000)
    const r = ask(a)
    clock += 1001
    expect(a.verdict('dep1', 21, hash).state).toBe('expired')
    expect(a.answer(r.code, at(), 'm1')).toBeNull()
    expect(a.use(r.code, 21, hash)).toBe(false)
  })

  it('"no <code>" refuses it; a message older than the request answers nothing', () => {
    const a = fresh()
    const r = ask(a)
    expect(a.answer(`${r.code}`, at() - 3600, 'old')).toBeNull()
    expect(a.answer(`no ${r.code}`, at(), 'm1')?.state).toBe('refused')
    expect(a.verdict('dep1', 21, hash).state).toBe('refused')
    expect(a.use(r.code, 21, hash)).toBe(false)
  })

  // Review of #107: "do not pay PAY-X" paid. Only the code alone, or one yes-word with it, approves.
  it('reads an answer strictly: the code alone or one yes-word approves, one no-word refuses, anything else answers nothing', () => {
    const c = 'PAY-7KQ2XM'
    for (const t of [c, `${c}.`, `yes ${c}`, `Yes, ${c}!`, `${c} ok`, `approve ${c}`, `pay ${c}`, c.toLowerCase()]) expect(readAnswer(t), t).toEqual({ code: c, yes: true })
    for (const t of [`no ${c}`, `No. ${c}`, `deny ${c}`, `${c} reject`, `cancel ${c}`]) expect(readAnswer(t), t).toEqual({ code: c, yes: false })
    for (const t of [`Do not pay ${c}, I have not decided yet`, `not now ${c}`, `nope ${c}`, `nah ${c}`, `never ${c}`, `hold ${c}`, `wait ${c}`, `decline ${c}`,
      `what is ${c} for?`, `${c}? why so much?`, `yes, no problem ${c}`, `approve ${c} not PAY-ABCDEF`, `yes ${c} ${c}`, 'yes', '']) {
      expect(readAnswer(t), t).toBeNull()
    }
    const a = fresh()
    const r = ask(a)
    expect(a.answer(`Do not pay ${r.code}, I have not decided yet`, at(), 'm')).toBeNull()
    expect(a.verdict('dep1', 21, hash).state).toBe('pending')
  })

  it('blanks every code in what the server keeps of its own DMs', () => {
    expect(withoutCodes('reply with PAY-7KQ2XM or "no PAY-7KQ2XM"')).toBe('reply with PAY-****** or "no PAY-******"')
  })

  it('answers nothing with approval off', () => {
    const a = new Approvals(StateDir.open(mkdtempSync(join(tmpdir(), 'approvals-'))), 'none')
    expect(a.answer('PAY-AAAAAA', 1, 'm')).toBeNull()
  })
})

describe('the wallet refuses, at the last step, a payment the operator did not approve', () => {
  it('pay() throws without a code, with a code not approved, and with one already used', async () => {
    const network = new FakeNetwork()
    const nwcRelay = network.add('wss://nwc.example')
    const service = new FakeWalletService(nwcRelay, () => 'ee'.repeat(32))
    service.publishInfo()
    const dir = StateDir.open(mkdtempSync(join(tmpdir(), 'wallet-approval-')))
    const w = new Wallet(dir, { nwc: new Secret(service.uri()), source: 'test', maxPaymentSats: 30, maxDailySats: 50, websocketImplementation: network.WebSocket, paymentApproval: 'operator', payTimeoutMs: 1500 })
    const bolt11 = encodeBolt11({ msats: 21_000, paymentHash: 'ab'.repeat(32), timestamp: nowSeconds(), expirySeconds: 3600 })
    const ctx = { depositId: 'd', rideKey: 'k', apiUrl: 'https://hosaka.test', jobId: 'j', toHeight: 1, expectedMsats: 21_000, expectedHash: null }
    await expect(w.pay(bolt11, ctx)).rejects.toThrow(/not approved this exact payment/)
    const r = w.approvals.request({ depositId: 'd', paymentHash: 'ab'.repeat(32), sats: 21, purpose: 'x', payee: 'y' })
    await expect(w.pay(bolt11, { ...ctx, approvalCode: r.code })).rejects.toThrow(/not approved/)
    expect(service.payments()).toHaveLength(0)
    w.stop()
  })
})

// ---- the whole way: a HOSAKA ride, the operator's DM, the payment, the notices ----

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'
const GENERAL = 'wss://general.example'
const INBOX = 'wss://inbox.example/'
const HOSAKA = 'https://hosaka.test'
const RIDE_SATS = RIDE_MSATS / 1000

const network = new FakeNetwork()
network.add(CANONICAL, { refuse: (ev) => (ev.kind === 1059 ? 'blocked: kind 1059 is not accepted here' : null) })
network.add(MINE)
const general = network.add(GENERAL, { requireAuth: false })
const inbox = network.add(INBOX, { requireAuth: false })
const nwcRelay = network.add('wss://nwc2.example')
let line: Line
const hosaka = new FakeHosaka(() => line)
const service = new FakeWalletService(nwcRelay, (bolt11) => hosaka.payBolt11(bolt11))
service.publishInfo()
const outputs: string[] = []
const sessions: Array<{ agent: Agent; client: Client }> = []
afterAll(async () => { for (const s of sessions) { await s.client.close(); await s.agent.stop() } })

async function open(stateDir: string, operator: string, limits = { maxPaymentSats: 30, maxDailySats: 50 }) {
  const agent = await Agent.start({
    stateDir, relays: [CANONICAL, MINE], operator, capCallSeconds: 30, capSessionSeconds: 0.05, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1500, lookupRelays: [GENERAL], ordersPollMs: 40,
    manifestUrl: MANIFEST_URL, lineFetch: fakeFetch(served), rideThreads: 0, hosakaUrl: HOSAKA, hosakaFetch: hosaka.fetch, hosakaPollMs: 20,
    nwc: new Secret(service.uri()), nwcSource: 'wallet.json nwc', ...limits, walletPayTimeoutMs: 1500, paymentApproval: 'operator',
  })
  const server = createServer(agent, () => {})
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientSide)
  const s = { agent, client }
  sessions.push(s)
  return s
}

async function call(s: { client: Client }, name: string, args: Record<string, unknown> = {}) {
  const r = await s.client.callTool({ name, arguments: args })
  outputs.push(JSON.stringify(r))
  return { text: (r.content as Array<{ text: string }>).map((c) => c.text).join('\n'), data: (r.structuredContent ?? {}) as Record<string, unknown>, isError: !!r.isError }
}

describe('a HOSAKA ride under paymentApproval "operator"', () => {
  let sk: Uint8Array
  let S: number
  let dir: string
  let s: Awaited<ReturnType<typeof open>>
  const opSk = generateSecretKey()
  const op = getPublicKey(opSk)
  const dms = (): string[] => dmsTo(inbox, opSk)
  const dmFrom = (fromSk: Uint8Array, text: string): void => { inbox.seed(wrapMessage({ senderSk: fromSk, recipient: s.agent.pubkey, text, now: nowSeconds() }).toRecipient) }
  const codeIn = (text: string): string => /PAY-[2-9A-HJKMNP-Z]{6}/.exec(text)![0]
  const state = (): string | null => ((s.agent.rideStatus().data.ride as { state?: string } | undefined)?.state) ?? null

  beforeAll(async () => {
    line = await probeLine()
    ;({ sk, S } = cheapKey(line))
    general.seed(finalizeEvent({ kind: 10050, created_at: nowSeconds(), tags: [['relay', INBOX]], content: '' }, opSk) as NostrEvent)
    general.seed(finalizeEvent({ kind: 3, created_at: nowSeconds(), tags: [['p', getPublicKey(sk)]], content: '' }, opSk) as NostrEvent)
    dir = dirWithKey(sk)
    s = await open(dir, op)
    await call(s, 'identity', { name: 'courier' })
    await call(s, 'hop', { target: { dx: 5, dy: 0, dz: 0 } })
    await call(s, 'station', { sync: true, budget_seconds: 30 })
    s.agent.budget.spentSeconds = 0
    await call(s, 'board')
  }, 90_000)

  it('the wallet tool says every payment waits for the operator, and never shows a code', async () => {
    const w = await call(s, 'wallet')
    expect(w.data).toMatchObject({ paymentApproval: 'operator', awaitingApproval: [] })
    expect(w.text).toContain('Your operator approves every payment first')
  })

  it('holds the payment and asks; a wrong code and a stranger with the right one pay nothing; the operator\'s code pays once, and they hear after', async () => {
    const to = S + 3
    const r = await call(s, 'ride', { to, prover: 'hosaka' })
    expect(r.isError).toBe(false)
    await until(() => dms().some((d) => d.startsWith('May I pay')), 'the approval request')
    const ask = dms().find((d) => d.startsWith('May I pay'))!
    expect(ask).toContain(`May I pay ${RIDE_SATS} sats?`)
    expect(ask).toContain('HOSAKA at https://hosaka.test')
    expect(ask).toContain('Today so far: 0 of 50 sats spent')
    const code = codeIn(ask)
    await settle(300)
    expect(service.payments()).toHaveLength(0)
    expect(state()).toBe('awaiting_payment')
    // The code is in no tool's answer.
    const status = await call(s, 'ride_status')
    expect(status.text).toMatch(/holds it until your operator approves it/)
    for (const o of [...outputs, JSON.stringify(await call(s, 'wallet'))]) expect(o).not.toContain(code)
    // Nor in what a public tool checks its words against, so no refusal can tell a model whether it guessed the code (review of #107).
    expect(s.agent.operatorChannel.privateTexts().join('\n')).not.toContain(code)
    // Every 40-character window of this probe holds some of the real code: it no longer matches, while the same words with the code blanked do.
    const at = ask.indexOf(code)
    const probe = ask.slice(at - 33, at + code.length + 1)
    expect((await call(s, 'comment', { target: 'deadbeefdeadbeef', text: probe })).text).not.toContain('repeats what')
    expect((await call(s, 'comment', { target: 'deadbeefdeadbeef', text: withoutCodes(probe) })).text).toContain('repeats what')
    // A reply that is not a clear yes approves nothing, even naming the code.
    dmFrom(opSk, `Do not pay ${code}, I have not decided yet`)
    // A wrong code, and a stranger who somehow has the right one.
    dmFrom(opSk, 'yes PAY-ZZZZZZ')
    dmFrom(generateSecretKey(), `yes ${code}`)
    await settle(500)
    expect(service.payments()).toHaveLength(0)
    // The operator's code.
    dmFrom(opSk, `yes ${code}`)
    await until(() => service.payments().length === 1, 'the approved payment')
    await until(() => state() === 'computing', 'computing')
    await until(() => dms().some((d) => d.startsWith('Paid HOSAKA')), 'the receipt')
    const receipt = dms().find((d) => d.startsWith('Paid HOSAKA'))!
    expect(receipt).toContain(`Spent in the last 24 hours: ${RIDE_SATS + 1} of 50 sats`)
    // The local log: mode 600, the outcome, nothing spendable.
    const logPath = join(dir, 'payments.log')
    expect(statSync(logPath).mode & 0o777).toBe(0o600)
    const logged = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(logged).toEqual([expect.objectContaining({ state: 'paid', sats: RIDE_SATS, approval: code, spentLast24hSats: RIDE_SATS + 1 })])
    expect(readFileSync(logPath, 'utf8')).not.toMatch(/lnbc|lntb|lnbcrt|preimage"\s*:\s*"[0-9a-f]/i)
    // The same code again approves nothing more.
    dmFrom(opSk, code)
    await settle(300)
    expect(service.payments()).toHaveLength(1)
    // Only what answered no request is an ordinary message: the wrong code, the unclear reply and the code sent again. The approval itself is not an order.
    expect((await call(s, 'orders_waiting')).data.orders).toBe(3)
    // Read as orders, they show the code blanked: the unclear reply named the live code, and the model never sees it (review of #107).
    const read = await call(s, 'inbox')
    expect(read.text).toContain('Do not pay PAY-******')
    expect(JSON.stringify(read)).not.toContain(code)
    hosaka.complete([...hosaka.jobs.values()].at(-1)!.id)
    await until(() => state() === 'ready', 'ready')
    expect((await call(s, 'ride', { to })).data.action).toBe('hyperjump')
  }, 90_000)

  it('a payment that fails is told to the operator: how much, what for, the result and the day\'s total', async () => {
    const to = S + 1
    const before = dms().length
    service.mode = 'fail'
    await call(s, 'ride', { to, prover: 'hosaka' })
    await until(() => dms().slice(before).some((d) => d.startsWith('May I pay')), 'the approval request')
    dmFrom(opSk, codeIn(dms().slice(before).find((d) => d.startsWith('May I pay'))!))
    await until(() => dms().slice(before).some((d) => d.startsWith('Payment FAILED')), 'the failure notice')
    const notice = dms().slice(before).find((d) => d.startsWith('Payment FAILED'))!
    expect(notice).toContain(`${RIDE_SATS} sats to HOSAKA`)
    expect(notice).toContain('Reason: PAYMENT_FAILED')
    expect(notice).toMatch(/Spent in the last 24 hours: \d+ of 50 sats/)
    service.mode = 'pay'
    const logged = readFileSync(join(dir, 'payments.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(logged.at(-1)).toMatchObject({ state: 'failed', sats: RIDE_SATS })
    await call(s, 'ride', { to, cancel: true })
  }, 90_000)

  it('the limits still hold on top: an approval cannot carry a payment past the day\'s limit', async () => {
    // Spent so far: one paid ride (21 + 1). A ride of 21 more would make 43, within 50; spend the day down first.
    const w = s.agent.wallet as unknown as { ledger: { payments: Array<{ sats: number; feesSats: number | null; state: string; at: number; depositId: string; rideKey: string; paymentHash: string }> } }
    w.ledger.payments.push({ sats: 20, feesSats: 0, state: 'paid', at: Date.now(), depositId: 'elsewhere', rideKey: 'elsewhere', paymentHash: '00'.repeat(32) } as never)
    const before = dms().length
    const paid = service.payments().length
    await call(s, 'ride', { to: S + 2, prover: 'hosaka' })
    // Over the limit: no approval is even asked for; the invoice goes to the operator as before, and the server pays nothing.
    await until(() => dms().slice(before).some((d) => d.startsWith('HOSAKA invoice')), 'the invoice to the operator')
    expect(dms().slice(before).some((d) => d.startsWith('May I pay'))).toBe(false)
    await settle(300)
    expect(service.payments()).toHaveLength(paid)
  }, 90_000)
})
