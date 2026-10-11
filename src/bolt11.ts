// bolt11.ts: what a Lightning invoice says about itself, read before the
// server pays one (arkinox, 2026-10-11). The wallet pays what the invoice
// says, not what HOSAKA's JSON beside it says, so every limit is enforced on
// the invoice's own amount, the payment hash recorded is the invoice's own,
// and an invoice past its own expiry is never sent to the wallet.
//
// Only what those checks need is decoded: the bech32 checksum, the network
// and amount in the human-readable part, the timestamp, and the payment hash
// (p) and expiry (x) fields. The node's signature is not checked: the
// invoice comes from HOSAKA's own answer to this server's own request, and
// the payee is HOSAKA's node either way. An invoice without an amount is
// refused, because the server never chooses an amount.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

/** The bech32 checksum polymod (BIP-173). */
export function bech32Polymod(values: number[]): number {
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i]
  }
  return chk
}

/** The human-readable part expanded for the checksum (BIP-173). */
export function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = []
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5)
  out.push(0)
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31)
  return out
}

export const BECH32_CHARSET = CHARSET

export interface Bolt11 {
  /** bc, tb, bcrt, tbs, sb: the network the invoice is for. */
  network: string
  /** The amount in millisats. Never null: an invoice without one is refused. */
  msats: number
  /** 64 hex characters. */
  paymentHash: string
  /** Seconds since the epoch. */
  timestamp: number
  /** Seconds after the timestamp the invoice may be paid (default 3600). */
  expirySeconds: number
  /** timestamp + expirySeconds. */
  expiresAt: number
}

const MULTIPLIER_MSATS: Record<string, bigint> = { m: 100_000_000n, u: 100_000n, n: 100n }

/** The amount in the human-readable part, in millisats, or null when the invoice names none. */
function hrpMsats(amount: string): bigint | null {
  if (amount === '') return null
  const m = /^([0-9]+)([munp]?)$/.exec(amount)
  if (!m || /^0[0-9]/.test(m[1])) throw new Error('the amount is malformed')
  const n = BigInt(m[1])
  if (m[2] === '') return n * 100_000_000_000n
  if (m[2] === 'p') {
    // A pico-bitcoin amount must be a whole number of millisats (BOLT 11).
    if (n % 10n !== 0n) throw new Error('the amount is not a whole number of millisats')
    return n / 10n
  }
  return n * MULTIPLIER_MSATS[m[2]]
}

/** Words of 5 bits to a number, most significant first. */
function wordsToNumber(words: number[]): number {
  let n = 0
  for (const w of words) n = n * 32 + w
  return n
}

/** Words of 5 bits to bytes, dropping the trailing pad bits. */
function wordsToBytes(words: number[]): Uint8Array {
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (const w of words) {
    acc = (acc << 5) | w
    bits += 5
    while (bits >= 8) {
      bits -= 8
      out.push((acc >>> bits) & 0xff)
    }
    acc &= (1 << bits) - 1
  }
  return Uint8Array.from(out)
}

/**
 * Decode a bolt11 invoice, or throw a sentence that says what is wrong with
 * it. The sentence never quotes the invoice.
 */
export function decodeBolt11(invoice: string): Bolt11 {
  if (typeof invoice !== 'string') throw new Error('the invoice is not text')
  const s = invoice.trim().toLowerCase().replace(/^lightning:/, '')
  if (!/^ln[a-z0-9]+$/.test(s)) throw new Error('the invoice is not a bolt11 string')
  const sep = s.lastIndexOf('1')
  if (sep < 3) throw new Error('the invoice has no data part')
  const hrp = s.slice(0, sep)
  const data: number[] = []
  for (const c of s.slice(sep + 1)) {
    const v = CHARSET.indexOf(c)
    if (v < 0) throw new Error('the invoice holds a character bech32 does not use')
    data.push(v)
  }
  if (bech32Polymod([...bech32HrpExpand(hrp), ...data]) !== 1) throw new Error('the invoice checksum does not match')
  const hm = /^ln(bcrt|bc|tbs|tb|sb)([0-9]*[munp]?)$/.exec(hrp)
  if (!hm) throw new Error('the invoice names an unknown network')
  const msats = hrpMsats(hm[2])
  if (msats === null) throw new Error('the invoice names no amount')
  if (msats <= 0n || msats > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('the invoice amount is out of range')
  // Data: 7 words of timestamp, tagged fields, 104 words of signature, 6 of checksum.
  const body = data.slice(0, data.length - 6)
  if (body.length < 7 + 104) throw new Error('the invoice is too short')
  const timestamp = wordsToNumber(body.slice(0, 7))
  const fields = body.slice(7, body.length - 104)
  let paymentHash: string | null = null
  let expirySeconds = 3600
  for (let i = 0; i < fields.length;) {
    if (i + 3 > fields.length) throw new Error('the invoice has a truncated field')
    const type = fields[i]
    const len = fields[i + 1] * 32 + fields[i + 2]
    const value = fields.slice(i + 3, i + 3 + len)
    if (value.length !== len) throw new Error('the invoice has a truncated field')
    i += 3 + len
    if (type === 1 && len === 52) {
      // p: the first well-formed payment hash counts (BOLT 11: a reader skips a p of the wrong length).
      if (paymentHash === null) paymentHash = Buffer.from(wordsToBytes(value)).toString('hex')
    } else if (type === 6) {
      expirySeconds = wordsToNumber(value)
    }
  }
  if (paymentHash === null || !/^[0-9a-f]{64}$/.test(paymentHash)) throw new Error('the invoice carries no payment hash')
  return { network: hm[1], msats: Number(msats), paymentHash, timestamp, expirySeconds, expiresAt: timestamp + expirySeconds }
}
