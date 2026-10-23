// audioInterop.test.ts: hidden audio (DECK-0007), against ONOSENDAI #463.
// fixtures/onosendai-audio.json was made with ONOSENDAI's own code
// (scripts/gen-onosendai-audio-fixture.ts): a kind 1063 item it wrote as a
// rumor, what its reader makes of that item and of nine variants (which it
// refuses: a URL not by the file's hash, http, no encryption, not audio, a
// short nonce), and a bag it sealed with one audio rumor inline and one in
// a chest. This server reads each the same way, and never the file's URL
// or key: an agent cannot hear the file, and the key is the file.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getEventHash } from 'nostr-tools/pure'
import { AUDIO_KIND, audioItemOf, audioLabel, innerAuthentic, unbag, type AudioMeta, type Rumor } from '../src/hidden/bags.js'
import { openWithSecret, readContents } from '../src/hidden/chests.js'
import { itemKind } from '../src/hidden/comments.js'
import { contentLine, contentRow } from '../src/items.js'
import { hexToBytes, type NostrEvent } from '../src/nostr/event.js'

interface Fixture {
  hider: string; height: number; regionKeyHex: string; lockSecretHex: string
  template: { kind: number; created_at: number; tags: string[][]; content: string }
  rumor: Rumor
  readings: Array<{ name: string; tags: string[][]; onosendai: AudioMeta | null }>
  bag: NostrEvent
  contentsRows: string[][]
  onosendaiRead: Array<{ type: string; id: string; author: string; audio: AudioMeta | null }>
  onosendaiChest: Array<{ type: string; verified: boolean; audio: AudioMeta | null }>
}

const fx = JSON.parse(readFileSync(new URL('./fixtures/onosendai-audio.json', import.meta.url), 'utf8')) as Fixture
/** JSON has no undefined: ONOSENDAI's absent fade comes back as a missing key, as this server's does. */
const meta = (a: AudioMeta | null | undefined) => (a ? JSON.parse(JSON.stringify(a)) as AudioMeta : null)

describe('hidden audio, against ONOSENDAI #463', () => {
  it('the item is a rumor by the hider, vouched for by its bag, with `-`', () => {
    expect(fx.rumor.kind).toBe(AUDIO_KIND)
    expect('sig' in fx.rumor).toBe(false)
    expect(getEventHash(fx.rumor)).toBe(fx.rumor.id)
    expect(fx.rumor.tags).toContainEqual(['-'])
    expect(innerAuthentic(fx.rumor, fx.hider)).toBe(true)
    expect(innerAuthentic(fx.rumor, '00'.repeat(32))).toBe(false)
    expect(innerAuthentic({ ...fx.rumor, id: 'ff'.repeat(32) }, fx.hider)).toBe(false)
  })

  it('reads every item ONOSENDAI reads, refuses every one it refuses, and keeps neither the URL nor the key', () => {
    // What the fixture pins, so a regenerated one that lost a case fails here.
    expect(fx.readings.filter((r) => r.onosendai === null).map((r) => r.name)).toEqual(['url not by its hash', 'http url', 'not encrypted', 'not audio', 'short nonce', 'url on a private address', 'url with a query', 'url with a user', 'url on a local name'])
    for (const r of fx.readings) {
      const mine = audioItemOf({ kind: AUDIO_KIND, content: fx.template.content, tags: r.tags })
      expect(meta(mine), r.name).toEqual(meta(r.onosendai))
      if (mine) for (const secret of ['ef'.repeat(32), '01'.repeat(12), 'https://']) expect(JSON.stringify(mine), r.name).not.toContain(secret)
    }
    const read = audioItemOf(fx.template)!
    expect(JSON.stringify(read)).not.toContain('ef'.repeat(32))
    expect(JSON.stringify(read)).not.toContain('https://')
  })

  it('opens ONOSENDAI\'s bag to the same items, the audio inline and the audio in its chest, vouched for', async () => {
    const items = await unbag(fx.bag, hexToBytes(fx.regionKeyHex), undefined, undefined, fx.height)
    expect(items.map((h) => ({ type: h.type, id: h.eventId, author: h.author, audio: meta(h.audio) }))).toEqual(fx.onosendaiRead.map((r) => ({ ...r, audio: meta(r.audio) })))
    const chest = items.find((h) => h.type === 'chest')!.chest!
    const inside = readContents(openWithSecret(chest, fx.lockSecretHex), items.find((h) => h.type === 'chest')!.inner.pubkey)
    expect(inside.map((c) => ({ type: c.body.type, verified: c.verified, audio: meta(c.body.audio) }))).toEqual(fx.onosendaiChest.map((r) => ({ ...r, audio: meta(r.audio) })))
    // ONOSENDAI counted it under `audio`, last.
    expect(fx.contentsRows).toEqual([['contents', 'chest', '1'], ['contents', 'audio', '1']])
  })

  it('an agent is told what it is in words, never the key', () => {
    const a = audioItemOf(fx.template)!
    expect(audioLabel(a)).toBe('Temple bell (one-shot, every entry, walk only)')
    expect(itemKind('audio')).toBe(AUDIO_KIND)
    const entry = { id: fx.rumor.id, event: { ...fx.rumor, sig: '' } as NostrEvent, verified: true, body: { type: 'audio' as const, audio: a } }
    const line = contentLine(contentRow(entry, { chestsOpenedBy: () => [] } as never))
    expect(line).toContain('audio "Temple bell (one-shot, every entry, walk only)"')
    expect(line).toContain('cannot hear it')
    expect(line).not.toContain('ef'.repeat(32))
  })
})
