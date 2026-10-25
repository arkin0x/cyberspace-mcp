// constrainInterop.test.ts: the WALK setting (DECK-0003 1.12) this server
// writes is ONOSENDAI's, to the byte and in the same place (arkinox,
// 2026-10-23, ONOSENDAI #476: "ALL shards should publish with the OPAQUE
// option on by default"). fixtures/onosendai-constrain.json was made with
// ONOSENDAI's own code at origin/v2 88da640
// (scripts/gen-onosendai-constrain-fixture.ts): what it hides inline, seals
// by reference and publishes for each payload, and what its EDIT writes for
// a shard placed before the default. And the rewrite of a placed payload
// keeps every other field exactly as found.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { objectTemplate, payloadBytes, shardInnerTemplate } from '../src/hidden/bags.js'
import { decryptForRegion } from '../src/hidden/crypto.js'
import { hexToBytes } from '../src/nostr/event.js'
import { publicObjectTemplate } from '../src/publicObject.js'
import { validateSnoPayload } from '../src/sno.js'
import { authoredConstrain, blocks, readConstrain, rewritePayload, withAuthoredConstrain } from '../src/walkConstrain.js'

interface Fixture {
  T: number
  keyHex: string
  payloads: Record<string, Record<string, unknown>>
  written: Record<string, { inline: string; sealed: string; public: string }>
  edited: Record<'before' | 'all' | 'off' | 'opaque' | 'moved' | 'faint' | 'beforeFaint' | 'faintToOpaque' | 'faintMoved', string>
}

const fx = JSON.parse(readFileSync(new URL('./fixtures/onosendai-constrain.json', import.meta.url), 'utf8')) as Fixture
const at = { x: 1n << 40n, y: 1n << 40n, z: (1n << 40n) + 100n }

function shardOf(p: unknown) {
  const v = validateSnoPayload(p)
  if (!v.ok) throw new Error(v.errors.join(' '))
  return v
}

describe('what place, hide and publish_object write, against ONOSENDAI 88da640', () => {
  it('an inline item, a sealed object and a public object carry ONOSENDAI\'s payload exactly: "opaque" when the payload chose none or a malformed word, the word when it chose one', async () => {
    const key = hexToBytes(fx.keyHex)
    for (const [name, payload] of Object.entries(fx.payloads)) {
      const { shard } = shardOf(payload)
      expect(shardInnerTemplate(shard, at, 0, fx.T).content, name).toBe(fx.written[name].inline)
      const sealed = await objectTemplate(shard, key, 'd'.repeat(32), fx.T)
      expect(await decryptForRegion(key, sealed.tags.find((t) => t[0] === 'encrypted')![2]), name).toBe(fx.written[name].sealed)
      expect(publicObjectTemplate(shard, 'fixed-d', fx.T).content, name).toBe(fx.written[name].public)
      // The size that decides inline or by reference counts the field too, as ONOSENDAI's wantsReference does.
      expect(payloadBytes(shard), name).toBe(new TextEncoder().encode(fx.written[name].inline).length)
    }
    expect(JSON.parse(fx.written.none.inline).constrain).toBe('opaque')
    expect(JSON.parse(fx.written.off.inline).constrain).toBe('off')
    expect(JSON.parse(fx.written.all.inline).constrain).toBe('all')
  })

  it('validation keeps a chosen word and names a malformed constrain or opacity as repaired, never as unknown', () => {
    expect(shardOf(fx.payloads.all).shard.extra).toEqual({ constrain: 'all' })
    expect(shardOf(fx.payloads.none).shard).not.toHaveProperty('extra')
    const bad = shardOf({ ...fx.payloads.none, constrain: 'ALL', opacity: 0, note: 'x' })
    expect(bad.ignored).toEqual(['note'])
    expect(bad.repaired).toEqual(['opacity', 'constrain'])
    expect(bad.shard).not.toHaveProperty('extra')
    expect(shardOf(fx.payloads.faint).shard.opacity).toBe(40)
    expect(shardOf({ ...fx.payloads.none, opacity: 100 }).repaired).toEqual([])
  })
})

describe('what an EDIT of a placed shard writes, against ONOSENDAI 88da640', () => {
  it('each word, an opacity, and a move that leaves the setting alone (the default for one that chose none)', () => {
    const e = fx.edited
    expect(rewritePayload(e.before, { constrain: 'all' })).toBe(e.all)
    expect(rewritePayload(e.before, { constrain: 'off' })).toBe(e.off)
    expect(rewritePayload(e.before, { constrain: 'opaque' })).toBe(e.opaque)
    expect(rewritePayload(e.before)).toBe(e.moved)
    expect(rewritePayload(e.before, { constrain: 'all', opacity: 40 })).toBe(e.faint)
    // Back to fully opaque is no field (DECK-0003 1.11 canonical form).
    expect(rewritePayload(e.beforeFaint, { constrain: 'opaque', opacity: 100 })).toBe(e.faintToOpaque)
    // A move keeps the author's word and opacity.
    expect(rewritePayload(e.beforeFaint)).toBe(e.faintMoved)
  })
})

describe('rewritePayload keeps what it does not change', () => {
  const base = JSON.parse(fx.edited.before) as Record<string, unknown>

  it('a palette named by an event, unknown fields and a __proto__ key stay exactly as found', () => {
    const nevent = 'nevent1' + 'q'.repeat(60)
    const raw = `{"v":2,"name":"Named palette","unit":0,"mode":"solid","vertices":[[0,0,0],[1,0,0],[0,1,0]],"palette":"${nevent}","colors":[0,1,2],"faces":[[0,1,2]],"note":{"deep":[1,2]},"__proto__":{"x":1}}`
    const out = rewritePayload(raw, { constrain: 'all' })!
    const read = JSON.parse(out) as Record<string, unknown>
    expect(read.palette).toBe(nevent)
    expect(read.note).toEqual({ deep: [1, 2] })
    expect(Object.prototype.hasOwnProperty.call(read, '__proto__')).toBe(true)
    expect(read.constrain).toBe('all')
    expect(out.startsWith(raw.slice(0, -1))).toBe(true)
  })

  it('a malformed opacity is not written again; a payload that is not SNO is refused (null)', () => {
    const out = JSON.parse(rewritePayload(JSON.stringify({ ...base, opacity: 0 }), { constrain: 'all' })!) as Record<string, unknown>
    expect(out).not.toHaveProperty('opacity')
    expect(rewritePayload('not json')).toBeNull()
    expect(rewritePayload(JSON.stringify({ ...base, faces: 'x' }))).toBeNull()
  })

  it('reads as DECK-0003 1.12 says: absent and anything but the three words are off to a walker, and not a choice to an author', () => {
    for (const raw of [undefined, 'none', 'OFF', 'ALL', 1, true, null, {}]) {
      expect(readConstrain(raw)).toBe('off')
      expect(authoredConstrain(raw)).toBe('opaque')
    }
    expect(authoredConstrain('off')).toBe('off')
    const { shard } = shardOf(fx.payloads.none)
    expect(blocks(withAuthoredConstrain(shard))).toBe(true)
    expect(blocks({ ...withAuthoredConstrain(shard), opacity: 40 })).toBe(false)
    expect(blocks({ ...withAuthoredConstrain(shard), mode: 'lines' })).toBe(false)
    expect(blocks(shard)).toBe(false)
  })
})
