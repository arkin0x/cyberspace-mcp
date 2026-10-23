// Generates test/fixtures/onosendai-audio.json for cyberspace-mcp with
// ONOSENDAI's own code (ONOSENDAI #463, hidden audio step 1:
// src/lib/audioItem.ts, hidden.ts, chests.ts), for DECK-0007: a kind 1063
// item written as a rumor, what ONOSENDAI reads out of each of a set of
// items (and which it refuses), and a bag it sealed holding one audio
// rumor inline and one inside a chest, with what its readers made of them.
// The file is never fetched: only the item is read.
//
// Run from an ONOSENDAI checkout of that branch (so ./src/lib resolves to
// ONOSENDAI), with this repository's tsx:
//   cp scripts/gen-onosendai-audio-fixture.ts <onosendai>/gen.ts
//   (cd <onosendai> && <mcp>/node_modules/.bin/tsx gen.ts <mcp>/test/fixtures/onosendai-audio.json; rm gen.ts)
import { writeFileSync } from 'node:fs'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as ono from './src/lib/hidden'
import * as onoChests from './src/lib/chests'
import * as audio from './src/lib/audioItem'
import { regionKeyAt } from './src/lib/shardCrypto'
import { bytesToHex } from './src/lib/events'

const OUT = process.argv[2]
const T = 1_792_600_000
const HEIGHT = 6
const hiderSk = generateSecretKey()
const hider = getPublicKey(hiderSk)
const at = { x: (1n << 60n) + 1234n, y: (1n << 61n) + 77n, z: (1n << 59n) + 3n }
const plane = 0 as const
const region = regionKeyAt(at, HEIGHT, 20)
const hash = 'ab'.repeat(32)
const base: audio.AudioItem = {
  title: 'Temple bell', about: 'Listen by the altar.', url: `https://blossom.example/${hash}`, mime: 'audio/mpeg', hash, originalHash: 'cd'.repeat(32), size: 4096,
  keyHex: 'ef'.repeat(32), nonceHex: '01'.repeat(12), autoplay: true, loop: false, retrigger: 'auto', fade: 9, walkOnly: true,
}
const template = audio.audioInnerTemplate(base, at, plane, T)
const variant = (name: string, tags: string[][]) => ({ name, tags, onosendai: audio.audioItemOf({ kind: 1063, content: template.content, tags }) })
const swap = (tag: string, value: string | null) => template.tags.flatMap((t) => (t[0] !== tag ? [t] : value === null ? [] : [[tag, value]]))
const readings = [
  variant('as written', template.tags),
  variant('a loop', [...swap('retrigger', null), ['loop']]),
  variant('no fade, no walk, no autoplay', swap('fade', null).filter((t) => t[0] !== 'walk' && t[0] !== 'autoplay')),
  variant('url with an extension', swap('url', `https://cdn.example/media/${hash}.mp3`)),
  variant('url not by its hash', swap('url', 'https://blossom.example/upload')),
  variant('http url', swap('url', `http://blossom.example/${hash}`)),
  variant('not encrypted', swap('encryption-algorithm', null)),
  variant('not audio', swap('m', 'image/png')),
  variant('short nonce', swap('decryption-nonce', '01'.repeat(8))),
  variant('fade not a count', swap('fade', '09')),
  variant('url on a private address', swap('url', `https://192.168.1.1/${hash}`)),
  variant('url with a query', swap('url', `https://blossom.example/${hash}?cmd=reboot`)),
  variant('url with a user', swap('url', `https://user:pw@blossom.example/${hash}`)),
  variant('url on a local name', swap('url', `https://router.local/${hash}`)),
]
const rumor = ono.rumorOf(template, hider)
const lockSk = generateSecretKey()
const inChest = ono.rumorOf(audio.audioInnerTemplate({ ...base, title: 'Dripping water', loop: true }, at, plane, T), hider)
const sealed = onoChests.sealEntries([inChest], getPublicKey(lockSk))
const chestItem = { name: 'Room', lockPubkey: getPublicKey(lockSk), senderPubkey: sealed.senderPubkey, requires: 'Door Key', payload: sealed.payload }
const chest = finalizeEvent(ono.chestInnerTemplate(chestItem, at, plane, T), hiderSk)
const bag = finalizeEvent(await ono.bagTemplate([rumor, chest], region.key, region.lookupId, HEIGHT, T + 1, ono.HIDDEN_KIND, { ...ono.DEFAULT_BAG_SETTINGS, contents: true }), hiderSk)
const read = await ono.unbag(JSON.parse(JSON.stringify(bag)), region.key, undefined, undefined, HEIGHT)
const opened = onoChests.readContents(onoChests.openWithSecret(chestItem, bytesToHex(lockSk)), chest.pubkey)
const strip = (a: audio.AudioItem | undefined) => a && { title: a.title, about: a.about, mime: a.mime, size: a.size, autoplay: a.autoplay, loop: a.loop, retrigger: a.retrigger, fade: a.fade, walkOnly: a.walkOnly }
writeFileSync(OUT, JSON.stringify({
  hider, height: HEIGHT, regionKeyHex: bytesToHex(region.key), lockSecretHex: bytesToHex(lockSk),
  template, rumor, readings: readings.map((r) => ({ name: r.name, tags: r.tags, onosendai: r.onosendai ? strip(r.onosendai) : null })),
  bag, contentsRows: bag.tags.filter((t) => t[0] === 'contents'),
  onosendaiRead: read.map((h) => ({ type: h.type, id: h.eventId, author: h.author, audio: strip(h.audio) ?? null })),
  onosendaiChest: opened.map((c) => ({ type: c.body.type, verified: c.verified, audio: strip(c.body.audio) ?? null })),
}, null, 2) + '\n')
console.log('wrote', OUT)
