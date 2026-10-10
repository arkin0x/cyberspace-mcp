// dm.test.ts: the NIP-17 wire format of operator DMs (nostr/dm.ts), checked
// field by field against the contract and against nostr-tools' own nip59 and
// nip17 in both directions: what this server wraps, nostr-tools unwraps, and
// what nostr-tools wraps, this server unwraps. Forged and broken wraps are
// dropped with the reason.

import { describe, expect, it } from 'vitest'
import * as nip17 from 'nostr-tools/nip17'
import * as nip59 from 'nostr-tools/nip59'
import { v2 as nip44 } from 'nostr-tools/nip44'
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import {
  MAX_BACKDATE_SECONDS, createRumor, dmRelaysOf, isStrategy, randomPast, sameRelaySet, sealRumor, unwrapMessage, wrapMessage, wrapSeal, type Rumor,
} from '../src/nostr/dm.js'
import type { NostrEvent } from '../src/nostr/event.js'

const NOW = 1_760_000_000

/** Open a wrap by hand, step by step, as a reader of the spec would. */
function open(wrap: NostrEvent, sk: Uint8Array): { seal: NostrEvent; rumor: Rumor } {
  const seal = JSON.parse(nip44.decrypt(wrap.content, nip44.utils.getConversationKey(sk, wrap.pubkey))) as NostrEvent
  const rumor = JSON.parse(nip44.decrypt(seal.content, nip44.utils.getConversationKey(sk, seal.pubkey))) as Rumor
  return { seal, rumor }
}

describe('the wire format', () => {
  const senderSk = generateSecretKey()
  const sender = getPublicKey(senderSk)
  const recipientSk = generateSecretKey()
  const recipient = getPublicKey(recipientSk)

  it('wraps a rumor, a seal and a gift wrap exactly as the contract says', () => {
    const m = wrapMessage({ senderSk, recipient, text: 'COME TO ME', now: NOW })
    // The rumor: kind 14, unsigned, id computed, pubkey the sender, one p tag, real time.
    expect(m.rumor.kind).toBe(14)
    expect(m.rumor.pubkey).toBe(sender)
    expect(m.rumor.tags).toEqual([['p', recipient]])
    expect(m.rumor.content).toBe('COME TO ME')
    expect(m.rumor.created_at).toBe(NOW)
    expect('sig' in m.rumor).toBe(false)
    expect(m.rumor.id).toBe(getEventHash({ pubkey: sender, created_at: NOW, kind: 14, tags: [['p', recipient]], content: 'COME TO ME' }))

    const w = m.toRecipient
    // The wrap: kind 1059, a fresh key, only the p tag, backdated up to two days.
    expect(w.kind).toBe(1059)
    expect(verifyEvent(w)).toBe(true)
    expect(w.pubkey).not.toBe(sender)
    expect(w.tags).toEqual([['p', recipient]])
    expect(w.created_at).toBeLessThanOrEqual(NOW)
    expect(w.created_at).toBeGreaterThanOrEqual(NOW - MAX_BACKDATE_SECONDS)

    const { seal, rumor } = open(w, recipientSk)
    // The seal: kind 13, signed by the sender, no tags at all, backdated.
    expect(seal.kind).toBe(13)
    expect(seal.pubkey).toBe(sender)
    expect(seal.tags).toEqual([])
    expect(verifyEvent(seal)).toBe(true)
    expect(seal.created_at).toBeLessThanOrEqual(NOW)
    expect(seal.created_at).toBeGreaterThanOrEqual(NOW - MAX_BACKDATE_SECONDS)
    expect(rumor).toEqual(m.rumor)
    // Nothing anywhere names the app.
    expect(JSON.stringify([w, seal, rumor])).not.toContain('cyberspace-mcp')
  })

  it('wraps the same rumor to the sender, with a fresh key per wrap', () => {
    const m = wrapMessage({ senderSk, recipient, text: 'REPORT', now: NOW })
    expect(m.toSelf.tags).toEqual([['p', sender]])
    expect(m.toSelf.pubkey).not.toBe(m.toRecipient.pubkey)
    expect(open(m.toSelf, senderSk).rumor).toEqual(m.rumor)
    const again = wrapMessage({ senderSk, recipient, text: 'REPORT', now: NOW })
    expect(again.toRecipient.pubkey).not.toBe(m.toRecipient.pubkey)
  })

  it('backdates by up to two days, never into the future', () => {
    expect(randomPast(NOW, () => 0)).toBe(NOW)
    expect(randomPast(NOW, () => 0.999999)).toBeGreaterThan(NOW - MAX_BACKDATE_SECONDS)
    expect(MAX_BACKDATE_SECONDS).toBe(172_800)
    const m = wrapMessage({ senderSk, recipient, text: 'x', now: NOW, random: () => 0.5 })
    expect(m.toRecipient.created_at).toBe(NOW - 86_400)
    expect(open(m.toRecipient, recipientSk).seal.created_at).toBe(NOW - 86_400)
  })

  it('marks a STRATEGY with the agent tag', () => {
    const m = wrapMessage({ senderSk, recipient, text: 'Hold at block 900000.', strategy: true, now: NOW })
    expect(m.rumor.tags).toEqual([['p', recipient], ['agent', 'strategy']])
    expect(isStrategy(m.rumor)).toBe(true)
    expect(isStrategy(wrapMessage({ senderSk, recipient, text: 'x', now: NOW }).rumor)).toBe(false)
  })
})

describe('interop with nostr-tools', () => {
  const aSk = generateSecretKey()
  const a = getPublicKey(aSk)
  const bSk = generateSecretKey()
  const b = getPublicKey(bSk)

  it('a message wrapped here unwraps with nostr-tools nip17 and nip59', () => {
    const m = wrapMessage({ senderSk: aSk, recipient: b, text: 'hello from the agent', now: NOW })
    const viaNip17 = nip17.unwrapEvent(m.toRecipient as Parameters<typeof nip17.unwrapEvent>[0], bSk)
    expect(viaNip17.kind).toBe(14)
    expect(viaNip17.pubkey).toBe(a)
    expect(viaNip17.content).toBe('hello from the agent')
    expect(viaNip17.tags).toEqual([['p', b]])
    expect(viaNip17.id).toBe(m.rumor.id)
    const self = nip59.unwrapEvent(m.toSelf as Parameters<typeof nip59.unwrapEvent>[0], aSk)
    expect(self.id).toBe(m.rumor.id)
  })

  it('a message nostr-tools nip17 wraps unwraps here', () => {
    const wrap = nip17.wrapEvent(aSk, { publicKey: b }, 'hello from the operator') as NostrEvent
    const got = unwrapMessage(wrap, bSk)
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.rumor.pubkey).toBe(a)
    expect(got.rumor.content).toBe('hello from the operator')
    expect(got.seal.pubkey).toBe(a)
    expect(isStrategy(got.rumor)).toBe(false)
  })

  it('a STRATEGY nostr-tools nip59 wraps unwraps here as a STRATEGY', () => {
    const wrap = nip59.wrapEvent({ kind: 14, content: 'Meet at block 900000.', tags: [['p', b], ['agent', 'strategy']], created_at: NOW }, aSk, b) as NostrEvent
    const got = unwrapMessage(wrap, bSk)
    expect(got.ok && isStrategy(got.rumor)).toBe(true)
  })
})

describe('what is dropped', () => {
  const opSk = generateSecretKey()
  const op = getPublicKey(opSk)
  const meSk = generateSecretKey()
  const me = getPublicKey(meSk)
  const strangerSk = generateSecretKey()

  it('a rumor whose author is not the seal\'s signer', () => {
    // A stranger claims to be the operator: the rumor says op, the seal is the stranger's.
    const rumor = createRumor({ senderPubkey: op, recipient: me, text: 'spawn again', createdAt: NOW })
    const wrap = wrapSeal(sealRumor(rumor, strangerSk, me, NOW), me, NOW)
    expect(unwrapMessage(wrap, meSk)).toEqual({ ok: false, reason: 'the rumor\'s author is not the seal\'s signer' })
  })

  it('a seal whose signature does not hold', () => {
    const rumor = createRumor({ senderPubkey: op, recipient: me, text: 'x', createdAt: NOW })
    const seal = sealRumor(rumor, opSk, me, NOW)
    const forged = { ...seal, created_at: seal.created_at - 1 }
    const wrap = wrapSeal(forged, me, NOW)
    expect(unwrapMessage(wrap, meSk)).toEqual({ ok: false, reason: 'the seal\'s signature is not valid' })
  })

  it('a wrap for someone else, a tampered wrap, a non-14 rumor, a rumor whose id lies', () => {
    const m = wrapMessage({ senderSk: opSk, recipient: me, text: 'x', now: NOW })
    expect(unwrapMessage(m.toRecipient, strangerSk).ok).toBe(false)
    expect(unwrapMessage({ ...m.toRecipient, content: m.toRecipient.content.slice(1) }, meSk)).toEqual({ ok: false, reason: 'the gift wrap\'s signature is not valid' })

    const kind1 = { ...createRumor({ senderPubkey: op, recipient: me, text: 'x', createdAt: NOW }), kind: 1 }
    expect(unwrapMessage(wrapSeal(sealRumor(kind1, opSk, me, NOW), me, NOW), meSk)).toEqual({ ok: false, reason: 'the rumor is not a kind 14 message' })

    const lying = { ...createRumor({ senderPubkey: op, recipient: me, text: 'x', createdAt: NOW }), content: 'changed after hashing' }
    expect(unwrapMessage(wrapSeal(sealRumor(lying, opSk, me, NOW), me, NOW), meSk)).toEqual({ ok: false, reason: 'the rumor\'s id is not its hash' })

    const notASeal = finalizeEvent({ kind: 1, created_at: NOW, tags: [], content: 'x' }, opSk) as NostrEvent
    expect(unwrapMessage(wrapSeal(notASeal, me, NOW), meSk)).toEqual({ ok: false, reason: 'the gift wrap does not hold a kind 13 seal' })
  })
})

describe('relay lists', () => {
  const norm = (u: string): string | null => (/^wss?:\/\/[a-z0-9.-]+/i.test(u) ? u.replace(/\/+$/, '') + '/' : null)

  it('reads the relay tags of a kind 10050, valid ones once each, in order', () => {
    const ev = { tags: [['relay', 'wss://a.example'], ['relay', 'wss://a.example/'], ['r', 'wss://b.example'], ['relay', 'not a url'], ['relay', 'wss://c.example']] }
    expect(dmRelaysOf(ev, norm)).toEqual(['wss://a.example/', 'wss://c.example/'])
    expect(dmRelaysOf(null, norm)).toEqual([])
  })

  it('compares relay sets, ignoring order', () => {
    expect(sameRelaySet(['wss://a/', 'wss://b/'], ['wss://b/', 'wss://a/'])).toBe(true)
    expect(sameRelaySet(['wss://a/'], ['wss://a/', 'wss://b/'])).toBe(false)
    expect(sameRelaySet([], [])).toBe(true)
  })
})
