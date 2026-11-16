// avatarVectors.test.ts: what this server draws and refuses for an avatar is
// the spec's (spec 8.10 since 2026-11: no proof of work, a 128 KiB limit).
// fixtures/avatar-vectors.json is the spec's golden file, copied unchanged
// from arkin0x/cyberspace at 1420330 (written by avatar-reference.py; sha256
// 3f2b9220...febf0e). Every `verdicts` row goes through verifyAvatar, the
// check paidShard and set_avatar read; every `content_limit` and `corpus`
// row through avatarTooLarge, the predicate set_avatar refuses by. No network.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AVATAR_CONTENT_MAX, AVATAR_KIND, avatarContentBytes, avatarTooLarge, paidShard, verifyAvatar } from '../src/avatar.js'

interface VectorEvent { kind: number; pubkey: string; created_at: number; tags: string[][]; content: string | null; id: string; content_recipe?: { prefix: string; fill: string; count: number; suffix: string } }
interface Vectors {
  constants: { kind: number; content_max: number }
  content_limit: Array<{ bytes: number; refused: boolean }>
  corpus: Array<{ name: string; bytes: number; vertices: number; faces: number; refused: boolean }>
  verdicts: Array<{ name: string; event: VectorEvent; verdict: { ok: boolean; reason: string } }>
}

const vectors = JSON.parse(readFileSync(new URL('./fixtures/avatar-vectors.json', import.meta.url), 'utf8')) as Vectors

/** The event with its content built from the recipe when the file gives one instead. */
function built(e: VectorEvent): VectorEvent & { content: string } {
  if (e.content !== null) return e as VectorEvent & { content: string }
  const r = e.content_recipe!
  return { ...e, content: r.prefix + r.fill.repeat(r.count) + r.suffix }
}

/** set_avatar's own size rule (avatarTooLarge): refused above AVATAR_CONTENT_MAX bytes of UTF-8. */
const refusedHere = avatarTooLarge

describe('the spec\'s avatar vectors', () => {
  it('the constants are the spec\'s', () => {
    expect(vectors.constants).toEqual({ kind: AVATAR_KIND, content_max: AVATAR_CONTENT_MAX })
  })

  it('every verdict row: verifyAvatar reaches the spec\'s verdict, and paidShard draws nothing it refuses', () => {
    expect(vectors.verdicts.length).toBeGreaterThan(0)
    for (const row of vectors.verdicts) {
      const ev = built(row.event)
      expect({ name: row.name, verdict: verifyAvatar(ev) }).toEqual({ name: row.name, verdict: row.verdict })
      if (!row.verdict.ok) expect({ name: row.name, shard: paidShard(ev) }).toEqual({ name: row.name, shard: null })
      if (row.verdict.reason === 'too-large') expect(refusedHere(avatarContentBytes(ev.content))).toBe(true)
    }
  })

  it('an avatar published with its work before 2026-11 is drawn: the nonce tag is not read', () => {
    const rows = vectors.verdicts.filter((r) => r.event.tags.some((t) => t[0] === 'nonce'))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(verifyAvatar(built(row.event))).toEqual({ ok: true, reason: 'ok' })
  })

  it('every content_limit and corpus row: refused here exactly when the spec refuses it', () => {
    for (const row of vectors.content_limit) expect({ bytes: row.bytes, refused: refusedHere(row.bytes) }).toEqual(row)
    expect(vectors.corpus.length).toBeGreaterThan(0)
    for (const row of vectors.corpus) expect({ name: row.name, refused: refusedHere(row.bytes) }).toEqual({ name: row.name, refused: row.refused })
  })
})
