// wallet.test.ts: the agent's wallet on its own (arkinox, 2026-10-11): the
// bolt11 reader, the connection string kept secret, the configuration, the
// NWC client against a fake wallet service on a fake relay (NIP-44 v2 and
// NIP-04), and the limits and the ledger that keep a payment from happening
// twice or above what the human allowed. No real wallet, relay or invoice.
//
// What would fail silently without these tests: a limit checked against
// HOSAKA's JSON instead of the invoice; a payment retried after an answer
// was lost; a restart that forgets a payment was going out; a daily limit
// that forgets yesterday's unknown payment; a connection string in an error
// message, a log line or a JSON dump.

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { decodeBolt11 } from '../src/bolt11.js'
import { parseArgs, settingsFrom } from '../src/config.js'
import { NwcClient, NwcError, NwcUnknownOutcome, parseNwc, Secret } from '../src/nwc.js'
import { StateDir } from '../src/state/dir.js'
import { Wallet, type PayContext } from '../src/wallet.js'
import { FakeNetwork } from './fakeRelay.js'
import { FakeWalletService, encodeBolt11, hashOf } from './fakeWallet.js'

const NWC_RELAY = 'wss://nwc.example'

/** A fake payee that knows one preimage per invoice it issued. */
class Payee {
  private readonly preimages = new Map<string, string>()
  paid: string[] = []
  invoice(sats: number, expirySeconds = 600): { bolt11: string; hash: string } {
    const preimage = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')
    const hash = hashOf(preimage)
    const bolt11 = encodeBolt11({ msats: sats * 1000, paymentHash: hash, expirySeconds })
    this.preimages.set(bolt11, preimage)
    return { bolt11, hash }
  }
  readonly pay = (bolt11: string): string | null => {
    this.paid.push(bolt11)
    return this.preimages.get(bolt11) ?? null
  }
}

function world(encryption: 'nip44_v2' | 'nip04' = 'nip44_v2'): { network: FakeNetwork; service: FakeWalletService; payee: Payee; logs: string[] } {
  const network = new FakeNetwork()
  const relay = network.add(NWC_RELAY)
  const payee = new Payee()
  const service = new FakeWalletService(relay, payee.pay)
  service.encryption = encryption
  service.publishInfo()
  return { network, service, payee, logs: [] }
}

function newWallet(w: ReturnType<typeof world>, opts: { maxPaymentSats?: number; maxDailySats?: number; now?: () => number; dir?: string; payTimeoutMs?: number } = {}): { wallet: Wallet; dir: string } {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'cyberspace-mcp-wallet-'))
  const wallet = new Wallet(StateDir.open(dir), {
    nwc: new Secret(w.service.uri()), source: 'test', maxPaymentSats: opts.maxPaymentSats ?? 2000, maxDailySats: opts.maxDailySats ?? 5000,
    websocketImplementation: w.network.WebSocket, maxWaitMs: 1000, log: (l) => w.logs.push(l), now: opts.now, payTimeoutMs: opts.payTimeoutMs ?? 1500,
  })
  return { wallet, dir }
}

function ctx(inv: { hash: string }, sats: number, over: Partial<PayContext> = {}): PayContext {
  return { depositId: `dep-${inv.hash.slice(0, 8)}`, rideKey: `ride-${inv.hash.slice(0, 8)}`, apiUrl: 'https://hosaka.test', jobId: 'job1', toHeight: 10, expectedMsats: sats * 1000, expectedHash: inv.hash, ...over }
}

describe('bolt11', () => {
  it('reads the BOLT 11 specification\'s own example: amount, payment hash, timestamp and expiry', () => {
    // "Please send $3 for a cup of coffee to the same peer, within one minute" (BOLT 11, Examples).
    const inv = decodeBolt11('lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp')
    expect(inv.network).toBe('bc')
    expect(inv.msats).toBe(250_000_000)
    expect(inv.paymentHash).toBe('0001020304050607080900010203040506070809000102030405060708090102')
    expect(inv.timestamp).toBe(1496314658)
    expect(inv.expirySeconds).toBe(60)
  })

  it('round-trips the test encoder, and refuses a bad checksum, no amount, and garbage, without quoting the invoice', () => {
    const hash = 'ab'.repeat(32)
    const bolt11 = encodeBolt11({ msats: 21_000, paymentHash: hash, timestamp: 1_700_000_000, expirySeconds: 600 })
    expect(decodeBolt11(bolt11)).toMatchObject({ msats: 21_000, paymentHash: hash, timestamp: 1_700_000_000, expiresAt: 1_700_000_600 })
    expect(decodeBolt11(encodeBolt11({ msats: 1, paymentHash: hash })).msats).toBe(1)
    const flipped = bolt11.slice(0, -1) + (bolt11.endsWith('q') ? 'p' : 'q')
    expect(() => decodeBolt11(flipped)).toThrow(/checksum/)
    const noAmount = encodeBolt11({ msats: 21_000, paymentHash: hash }).replace(/^lnbc210n/, 'lnbc')
    expect(() => decodeBolt11(noAmount)).toThrow()
    for (const bad of ['', 'hello', 'lnbc1', bolt11.toUpperCase().slice(0, 20)]) {
      try {
        decodeBolt11(bad)
        throw new Error('decoded garbage')
      } catch (err) {
        expect((err as Error).message).not.toContain(bolt11.slice(10))
      }
    }
  })
})

describe('the connection string is a secret', () => {
  const uri = 'nostr+walletconnect://' + 'a'.repeat(64) + '?relay=wss%3A%2F%2Fnwc.example&secret=' + 'b'.repeat(64)

  it('never prints: String, JSON, inspect and template strings all say [redacted]', () => {
    const s = new Secret(uri)
    for (const shown of [String(s), `${s}`, JSON.stringify({ s }), inspect({ s }), inspect(s)]) {
      expect(shown).not.toContain('b'.repeat(64))
      expect(shown).toContain('[redacted]')
    }
    expect(parseNwc(s, 'test')).toMatchObject({ walletPubkey: 'a'.repeat(64), relays: ['wss://nwc.example/'] })
  })

  it('a malformed string is refused in words that never quote it', () => {
    const cases = [
      'nostr+walletconnect://' + 'a'.repeat(64) + '?secret=' + 'b'.repeat(64),
      'nostr+walletconnect://nothex?relay=wss%3A%2F%2Fnwc.example&secret=' + 'b'.repeat(64),
      'nostr+walletconnect://' + 'a'.repeat(64) + '?relay=wss%3A%2F%2Fnwc.example&secret=' + 'b'.repeat(63),
      'https://' + 'b'.repeat(64),
    ]
    for (const c of cases) {
      let message = ''
      try { parseNwc(new Secret(c), 'wallet.json nwc') } catch (err) { message = (err as Error).message }
      expect(message).toMatch(/wallet\.json nwc/)
      expect(message).not.toContain('b'.repeat(40))
      expect(message).not.toContain('nwc.example')
    }
  })

  it('comes from --nwc, then wallet.json, then config.json; limits default to 2000 and 5000 sats; errors never echo it', () => {
    const other = uri.replace('b'.repeat(64), 'c'.repeat(64))
    const defaults = settingsFrom(parseArgs(['--state', '/x']), {})
    expect(defaults).toMatchObject({ nwc: null, maxPaymentSats: 2000, maxDailySats: 5000 })
    expect(Buffer.from(parseNwc(settingsFrom(parseArgs(['--state', '/x']), { nwc: other }, { nwc: uri }).nwc!, 't').clientSecret).toString('hex')).toBe('b'.repeat(64))
    expect(settingsFrom(parseArgs(['--state', '/x']), { nwc: other }).nwcSource).toBe('config.json nwc')
    const flagged = settingsFrom(parseArgs(['--state', '/x', '--nwc', uri, '--max-payment-sats', '100', '--max-daily-sats', '0']), { nwc: other, maxPaymentSats: 5 })
    expect(flagged).toMatchObject({ nwcSource: '--nwc', maxPaymentSats: 100, maxDailySats: 0 })
    expect(JSON.stringify(flagged)).not.toContain('b'.repeat(64))
    expect(settingsFrom(parseArgs(['--state', '/x']), { maxPaymentSats: 7, maxDailySats: 70 })).toMatchObject({ maxPaymentSats: 7, maxDailySats: 70 })
    expect(() => parseArgs(['--max-daily-sats', '-1'])).toThrow(/whole number of sats/)
    for (const argv of [['--nwc', uri.replace('?relay=wss%3A%2F%2Fnwc.example', '?')], [`--nwc=${uri}`], [uri]]) {
      let message = ''
      try { parseArgs(argv) } catch (err) { message = (err as Error).message }
      expect(message).not.toBe('')
      expect(message).not.toContain('b'.repeat(64))
    }
    expect(() => settingsFrom(parseArgs(['--state', '/x']), {}, { nwc: 'nonsense' })).toThrow(/wallet\.json nwc/)
  })
})

describe('the NWC client, against a fake wallet service', () => {
  it('reads the info event, then get_balance and pay_invoice in NIP-44 v2; the requests are signed with the connection\'s key, never another', async () => {
    const w = world()
    const client = new NwcClient(parseNwc(new Secret(w.service.uri()), 'test'), { websocketImplementation: w.network.WebSocket, maxWaitMs: 1000 })
    try {
      expect(await client.getInfo()).toEqual({ methods: ['pay_invoice', 'get_balance'], encryption: 'nip44_v2' })
      expect(await client.getBalanceMsats()).toBe(100_000_000)
      const inv = w.payee.invoice(21)
      const paid = await client.payInvoice(inv.bolt11)
      expect(hashOf(paid.preimage)).toBe(inv.hash)
      expect(paid.feesPaidMsats).toBe(1000)
      expect(w.service.requests.map((r) => [r.method, r.encryption])).toEqual([['get_balance', 'nip44_v2'], ['pay_invoice', 'nip44_v2']])
    } finally {
      client.close()
    }
  })

  it('falls back to NIP-04 for a wallet whose info event names no encryption, and reports the wallet\'s errors and its silence apart', async () => {
    const w = world('nip04')
    const client = new NwcClient(parseNwc(new Secret(w.service.uri()), 'test'), { websocketImplementation: w.network.WebSocket, maxWaitMs: 1000 })
    try {
      expect((await client.getInfo()).encryption).toBe('nip04')
      expect(await client.getBalanceMsats()).toBe(100_000_000)
      expect(w.service.requests.at(-1)!.encryption).toBe('nip04')
      w.service.mode = 'fail'
      await expect(client.payInvoice(w.payee.invoice(5).bolt11)).rejects.toBeInstanceOf(NwcError)
      w.service.mode = 'silent'
      await expect(client.payInvoice(w.payee.invoice(5).bolt11, 300)).rejects.toBeInstanceOf(NwcUnknownOutcome)
    } finally {
      client.close()
    }
  })
})

describe('the wallet: limits, the ledger, never twice', () => {
  it('pays within the limits and records the payment hash and the preimage\'s hash, never the preimage', async () => {
    const w = world()
    const { wallet, dir } = newWallet(w)
    try {
      const inv = w.payee.invoice(21)
      const out = await wallet.pay(inv.bolt11, ctx(inv, 21))
      expect(out.state).toBe('paid')
      expect(out.record).toMatchObject({ sats: 21, feesSats: 1, paymentHash: inv.hash, preimageHash: inv.hash, jobId: 'job1' })
      expect(wallet.spentLast24hSats()).toBe(22)
      const ledger = readFileSync(join(dir, 'payments.json'), 'utf8')
      expect(ledger).not.toContain(inv.bolt11)
      expect(ledger).not.toContain(w.service.clientSecretHex)
    } finally {
      wallet.stop()
    }
  })

  it('refuses above one payment\'s limit, above the rolling daily limit, at a limit of 0, and when the invoice disagrees with HOSAKA', async () => {
    const w = world()
    let now = Date.now()
    const { wallet } = newWallet(w, { maxPaymentSats: 100, maxDailySats: 150, now: () => now })
    try {
      const big = w.payee.invoice(101)
      expect(wallet.decide(big.bolt11, ctx(big, 101))).toMatchObject({ pay: false, reason: expect.stringMatching(/above the limit of 100 sats for one payment/) })
      const a = w.payee.invoice(100)
      expect((await wallet.pay(a.bolt11, ctx(a, 100))).state).toBe('paid')
      const b = w.payee.invoice(60)
      expect(wallet.decide(b.bolt11, ctx(b, 60))).toMatchObject({ pay: false, reason: expect.stringMatching(/daily limit of 150 sats/) })
      await expect(wallet.pay(b.bolt11, ctx(b, 60))).rejects.toThrow(/not paid/)
      // Rolling: a day later the first payment no longer counts.
      now += 24 * 60 * 60 * 1000 + 1000
      const c = w.payee.invoice(60, 3 * 24 * 3600)
      expect(wallet.decide(c.bolt11, ctx(c, 60))).toMatchObject({ pay: true, sats: 60 })
      expect(wallet.decide(c.bolt11, ctx(c, 61))).toMatchObject({ pay: false, reason: expect.stringMatching(/not the 61000 msats HOSAKA says/) })
      expect(wallet.decide(c.bolt11, ctx(c, 60, { expectedHash: 'f'.repeat(64) }))).toMatchObject({ pay: false, reason: expect.stringMatching(/payment hash/) })
      expect(w.service.payments().length).toBe(1)
    } finally {
      wallet.stop()
    }
    const off = newWallet(world(), { maxDailySats: 0 }).wallet
    const inv = w.payee.invoice(1)
    expect(off.decide(inv.bolt11, ctx(inv, 1))).toMatchObject({ pay: false, reason: expect.stringMatching(/turns paying off/) })
    off.stop()
  })

  it('never pays one invoice twice, nor one ride twice, whatever the first outcome', async () => {
    const w = world()
    const { wallet } = newWallet(w)
    try {
      const inv = w.payee.invoice(21)
      expect((await wallet.pay(inv.bolt11, ctx(inv, 21))).state).toBe('paid')
      expect(wallet.decide(inv.bolt11, ctx(inv, 21, { depositId: 'other' }))).toMatchObject({ pay: false, reason: expect.stringMatching(/never paid twice/) })
      const second = w.payee.invoice(21)
      expect(wallet.decide(second.bolt11, ctx(second, 21, { rideKey: ctx(inv, 21).rideKey }))).toMatchObject({ pay: false, reason: expect.stringMatching(/same ride/) })
      // A definite failure: that invoice is not tried again, but another invoice for the same ride may be paid.
      w.service.mode = 'fail'
      const f = w.payee.invoice(5)
      const failed = await wallet.pay(f.bolt11, ctx(f, 5))
      expect(failed).toMatchObject({ state: 'failed', reason: expect.stringMatching(/PAYMENT_FAILED/) })
      expect(wallet.decide(f.bolt11, ctx(f, 5)).pay).toBe(false)
      const g = w.payee.invoice(5)
      expect(wallet.decide(g.bolt11, ctx(g, 5, { rideKey: ctx(f, 5).rideKey })).pay).toBe(true)
      // An answer that says nothing definite is unknown: counted, and never retried for that ride.
      w.service.mode = 'internal-error'
      const u = w.payee.invoice(7)
      const unknown = await wallet.pay(u.bolt11, ctx(u, 7))
      expect(unknown.state).toBe('unknown')
      expect(wallet.spentLast24hSats()).toBe(21 + 1 + 7)
      const u2 = w.payee.invoice(7)
      expect(wallet.decide(u2.bolt11, ctx(u2, 7, { rideKey: ctx(u, 7).rideKey }))).toMatchObject({ pay: false, reason: expect.stringMatching(/unknown/) })
    } finally {
      wallet.stop()
    }
  })

  it('a payment going out when the process stopped is read back as unknown, counted, and never sent again', async () => {
    const w = world()
    w.service.mode = 'pay-silently'
    const first = newWallet(w, { payTimeoutMs: 300 })
    const inv = w.payee.invoice(30)
    // Stop the process mid-payment: the record is on disk as sending before the request goes out.
    const going = first.wallet.pay(inv.bolt11, ctx(inv, 30))
    for (let i = 0; i < 100 && w.service.payments().length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    expect(w.service.payments().length).toBe(1)
    const onDisk = JSON.parse(readFileSync(join(first.dir, 'payments.json'), 'utf8')) as { payments: Array<{ state: string }> }
    expect(onDisk.payments.map((p) => p.state)).toEqual(['sending'])
    // A new process on the same state directory, before the old one heard anything.
    const second = newWallet(w, { dir: first.dir })
    try {
      expect(second.wallet.attemptFor(ctx(inv, 30).depositId)?.state).toBe('unknown')
      expect(second.wallet.spentLast24hSats()).toBe(30)
      expect(second.wallet.decide(inv.bolt11, ctx(inv, 30)).pay).toBe(false)
      expect(w.service.payments().length).toBe(1)
    } finally {
      second.wallet.stop()
      expect((await going).state).toBe('unknown')
      first.wallet.stop()
    }
  })

  it('the wallet tool says connected, the balance, the spend and the limits, and nothing of the connection string', async () => {
    const w = world()
    const { wallet } = newWallet(w)
    try {
      const r = await wallet.status()
      expect(r.data).toMatchObject({ connected: true, reachable: true, canPay: true, balanceSats: 100_000, spentLast24hSats: 0, limits: { maxPaymentSats: 2000, maxDailySats: 5000 } })
      const shown = JSON.stringify(r) + w.logs.join('\n')
      expect(shown).not.toContain(w.service.clientSecretHex)
      expect(shown).not.toContain('walletconnect')
    } finally {
      wallet.stop()
    }
    const none = new Wallet(StateDir.open(mkdtempSync(join(tmpdir(), 'cyberspace-mcp-wallet-'))), { nwc: null, source: 'x', maxPaymentSats: 2000, maxDailySats: 5000 })
    const r = await none.status()
    expect(r.data.connected).toBe(false)
    expect(r.text).toMatch(/No wallet is connected[\s\S]*goes to your operator by DM/)
  })
})
