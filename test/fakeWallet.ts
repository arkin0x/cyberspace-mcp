// fakeWallet.ts: a Nostr Wallet Connect wallet service (NIP-47) for the
// tests, listening on a fake relay, and a bolt11 encoder for fake invoices.
// Nothing here touches a real wallet or a real relay. The service publishes
// its info event, reads kind 23194 requests addressed to it in whichever
// encryption the request names, and answers kind 23195 in the same one; how
// it answers pay_invoice is the test's to choose: pay (asking the fake
// HOSAKA for the preimage, as a real payment would make the payee reveal
// it), fail, stay silent, or pay and then lose its answer.

import { createHash } from 'node:crypto'
import * as nip04 from 'nostr-tools/nip04'
import { v2 as nip44 } from 'nostr-tools/nip44'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { BECH32_CHARSET, bech32HrpExpand, bech32Polymod } from '../src/bolt11.js'
import { bytesToHex, nowSeconds, type NostrEvent } from '../src/nostr/event.js'
import type { FakeRelay } from './fakeRelay.js'

function bytesToWords(bytes: Uint8Array): number[] {
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out.push((acc >>> bits) & 31)
    }
    acc &= (1 << bits) - 1
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31)
  return out
}

function numberToWords(n: number, min = 1): number[] {
  const out: number[] = []
  while (n > 0) {
    out.unshift(n % 32)
    n = Math.floor(n / 32)
  }
  while (out.length < min) out.unshift(0)
  return out
}

function tagged(type: number, words: number[]): number[] {
  return [type, Math.floor(words.length / 32), words.length % 32, ...words]
}

/** A bolt11 invoice with a zero signature: everything bolt11.ts reads is real, the node's signature is not. */
export function encodeBolt11(opts: { msats: number; paymentHash: string; timestamp?: number; expirySeconds?: number; network?: string; description?: string }): string {
  const amount = opts.msats % 100 === 0 ? `${opts.msats / 100}n` : `${opts.msats * 10}p`
  const hrp = `ln${opts.network ?? 'bc'}${amount}`
  const data = [
    ...numberToWords(opts.timestamp ?? nowSeconds(), 7),
    ...tagged(1, bytesToWords(Buffer.from(opts.paymentHash, 'hex'))),
    ...tagged(13, bytesToWords(Buffer.from(opts.description ?? 'HOSAKA ride', 'utf8'))),
    ...tagged(6, numberToWords(opts.expirySeconds ?? 3600)),
    ...new Array<number>(104).fill(0),
  ]
  const mod = bech32Polymod([...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31)
  return `${hrp}1${[...data, ...checksum].map((w) => BECH32_CHARSET[w]).join('')}`
}

export type PayMode = 'pay' | 'fail' | 'silent' | 'pay-silently' | 'internal-error'

export class FakeWalletService {
  readonly sk = generateSecretKey()
  readonly pubkey = getPublicKey(this.sk)
  /** The connection's client secret, as the wallet issued it. */
  readonly clientSecretHex = bytesToHex(generateSecretKey())
  readonly clientPubkey: string
  methods = ['pay_invoice', 'get_balance']
  /** The encryption the info event advertises: nip44_v2 (and nip04), or nip04 alone (no tag). */
  encryption: 'nip44_v2' | 'nip04' = 'nip44_v2'
  balanceMsats = 100_000_000
  mode: PayMode = 'pay'
  /** Every request, decrypted, in order. */
  readonly requests: Array<{ method: string; params: Record<string, unknown>; encryption: string }> = []

  constructor(private readonly relay: FakeRelay, private readonly payee: (bolt11: string) => string | null) {
    this.clientPubkey = getPublicKey(Buffer.from(this.clientSecretHex, 'hex'))
    relay.onPublished.push((ev) => this.handle(ev))
  }

  /** The connection string a human would paste. */
  uri(): string {
    return `nostr+walletconnect://${this.pubkey}?relay=${encodeURIComponent(this.relay.url)}&secret=${this.clientSecretHex}&lud16=agent%40example.com`
  }

  publishInfo(): void {
    const tags = this.encryption === 'nip44_v2' ? [['encryption', 'nip44_v2 nip04']] : []
    this.relay.seed(finalizeEvent({ kind: 13194, created_at: nowSeconds(), tags, content: this.methods.join(' ') }, this.sk) as NostrEvent)
  }

  payments(): string[] {
    return this.requests.filter((r) => r.method === 'pay_invoice').map((r) => String(r.params.invoice))
  }

  private handle(ev: NostrEvent): void {
    if (ev.kind !== 23194 || !ev.tags.some((t) => t[0] === 'p' && t[1] === this.pubkey) || ev.pubkey !== this.clientPubkey) return
    const enc = ev.tags.find((t) => t[0] === 'encryption')?.[1] === 'nip44_v2' ? 'nip44_v2' : 'nip04'
    const plain = enc === 'nip44_v2'
      ? nip44.decrypt(ev.content, nip44.utils.getConversationKey(this.sk, ev.pubkey))
      : nip04.decrypt(this.sk, ev.pubkey, ev.content)
    const req = JSON.parse(plain) as { method: string; params: Record<string, unknown> }
    this.requests.push({ ...req, encryption: enc })
    const answer = (body: Record<string, unknown>): void => {
      const text = JSON.stringify(body)
      const content = enc === 'nip44_v2' ? nip44.encrypt(text, nip44.utils.getConversationKey(this.sk, ev.pubkey)) : nip04.encrypt(this.sk, ev.pubkey, text)
      const res = finalizeEvent({ kind: 23195, created_at: nowSeconds(), tags: [['p', ev.pubkey], ['e', ev.id]], content }, this.sk) as NostrEvent
      setTimeout(() => this.relay.inject(res), 5)
    }
    if (req.method === 'get_balance') {
      answer({ result_type: 'get_balance', error: null, result: { balance: this.balanceMsats } })
      return
    }
    if (req.method === 'pay_invoice') {
      if (this.mode === 'silent') return
      if (this.mode === 'fail') {
        answer({ result_type: 'pay_invoice', error: { code: 'PAYMENT_FAILED', message: 'no route found' }, result: null })
        return
      }
      if (this.mode === 'internal-error') {
        answer({ result_type: 'pay_invoice', error: { code: 'INTERNAL', message: 'something broke midway' }, result: null })
        return
      }
      const preimage = this.payee(String(req.params.invoice))
      if (!preimage) {
        answer({ result_type: 'pay_invoice', error: { code: 'PAYMENT_FAILED', message: 'the payee refused the payment' }, result: null })
        return
      }
      if (this.mode === 'pay-silently') return
      answer({ result_type: 'pay_invoice', error: null, result: { preimage, fees_paid: 1000 } })
      return
    }
    answer({ result_type: req.method, error: { code: 'NOT_IMPLEMENTED', message: 'unknown method' }, result: null })
  }
}

/** sha256 of a hex preimage, hex. */
export function hashOf(preimageHex: string): string {
  return createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex')
}
