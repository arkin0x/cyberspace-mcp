// Generates test/fixtures/onosendai-contents.json for cyberspace-mcp with
// ONOSENDAI's own code (ONOSENDAI #441, merged as 2311e07: src/lib/hidden.ts
// bagContents, bagContentsTags, bagTemplate, bagSettingsOf; src/lib/nftLink.ts
// findNftLinks, from #440, 5109448), for a bag's `contents` rows with the
// `nft` count of 2026-10-22: how many links ONOSENDAI finds in a text, the
// rows it writes for fixed bags under each setting, how it reads rows back
// into a bag's settings, and two bags it sealed with the test agent's key
// (contents on; money alone), with the rows it would write after each rewrite
// the test makes through the agent's tools. It checks the reverse direction
// too: cyberspace-mcp's bagTemplate writes the same rows, and ONOSENDAI reads
// the agent's bags into the same settings.
//
// Run from an ONOSENDAI checkout of that commit (so ./src/lib resolves to
// ONOSENDAI), with this repository's tsx:
//   cp scripts/gen-onosendai-contents-fixture.ts <onosendai>/gen.ts
//   (cd <onosendai> && <mcp>/node_modules/.bin/tsx gen.ts <mcp> <mcp>/test/fixtures/onosendai-contents.json)
import { writeFileSync, readFileSync } from 'node:fs'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { fromPayload } from 'sno-core/shards'
import * as ono from './src/lib/hidden'
import * as onoChests from './src/lib/chests'
import { findNftLinks } from './src/lib/nftLink'
import { attributed } from './src/lib/client'
import { regionKeyAt } from './src/lib/shardCrypto'
import { bytesToHex } from './src/lib/events'

const MCP = process.argv[2]
const OUT = process.argv[3]
const mcpBags = await import(`${MCP}/src/hidden/bags.ts`)
const mcpNft = await import(`${MCP}/src/hidden/nftLink.ts`)

type Template = { kind: number; created_at: number; tags: string[][]; content: string }
const T = 1_792_600_000
const agentSk = generateSecretKey()
const agent = getPublicKey(agentSk)
// The point test/placed.test.ts uses: z mod 256 is 100, so a few gibsons along z stay in the h8 and the h3 cube.
const BASE = (1n << 40n) + 100n
const plane = 0 as const
const pt = (dz: bigint) => ({ x: BASE, y: BASE, z: BASE + dz })
const sign = (t: Template) => finalizeEvent(attributed(t), agentSk)
const rumor = (t: Template) => ono.rumorOf(t, agent)
const message = (text: string, dz: bigint) => rumor(ono.messageInnerTemplate(text, pt(dz), plane, T))

const payload = JSON.parse(readFileSync(`${MCP}/test/fixtures/xor-stella-octangula.json`, 'utf8'))
const shard = fromPayload(payload, 'x'.repeat(64))!

// Links as the site makes them (32 lowercase hex, #, 43 base64url, the last of sixteen), and the look-alikes.
const hex = (b: string) => b.repeat(16)
const A = `https://nonfungible.cash/claim/${hex('6f')}#${'A'.repeat(42)}w`
const B = `https://nonfungible.cash/claim/${hex('0a')}#${'b_-'.repeat(14)}Q`
const C = `Https://NonFungible.CASH/claim/${hex('c3')}#${'Z9'.repeat(21)}0`
const D = `https://nonfungible.cash/claim/${hex('d4')}#${'k'.repeat(42)}E`
const TOKEN = 'cashuBo2FteBtodHRwczovL21pbnQubWluaWJpdHMuY2FzaC9CaXRjb2lu'
const lookalikes = [
  `https://nonfungible.cash/claim/${hex('6f')}#${'A'.repeat(43)}w`, // a 44 character key
  `https://nonfungible.cash/claim/${hex('6f')}#${'A'.repeat(42)}`, // a 42 character key
  `https://nonfungible.cash/claim/${hex('6f')}#${'A'.repeat(42)}B`, // a last character the encoder never writes
  `https://nonfungible.cash/claim/${hex('6F')}#${'A'.repeat(42)}w`, // an upper case id
  `https://nonfungible.cash/claim/${hex('6f').slice(2)}#${'A'.repeat(42)}w`, // a 30 character id
  `http://nonfungible.cash/claim/${hex('6f')}#${'A'.repeat(42)}w`, // http
  `https://www.nonfungible.cash/claim/${hex('6f')}#${'A'.repeat(42)}w`, // www
  `https://nonfungible.cash/link/${hex('6f')}#${'A'.repeat(42)}w`, // another path
  `xhttps://nonfungible.cash/claim/${hex('6f')}#${'A'.repeat(42)}w`, // a letter before
  `https://a.example/?u=https://nonfungible.cash/claim/${hex('6f')}#${'A'.repeat(42)}w`, // inside a query
  `https://a.example/https://nonfungible.cash/claim/${hex('6f')}#${'A'.repeat(42)}w`, // inside a path
  `https://nonfungible.cash/claim/${hex('6f')}#${'A'.repeat(42)}w=`, // padding after
  `https://nonfungible.cash/claim/${hex('6f')}#${'A'.repeat(42)}w&x`, // more fragment after
  `https://nonfungible.cash/claim/${hex('6f')}`, // no key
].join(' ')

// The recognizer, text by text: how many links ONOSENDAI counts in each.
const texts = [
  '', 'no link here', A, `${A} and ${A} again`, `${A} ${B} ${C}`, C, lookalikes, `${lookalikes} ${D}`,
  `[an NFT](${A})`, `"${A}"`, `\u201c${A}\u201d`, `link:${A}`, `\u2014${A}.`, `*${A}*`, `> ${A}`, `| ${A} |`, `\`${A}\``, `${A}, ${B}; ${C}!`, `\u200b${A}`,
  `a.example/?b=1;${A}`, `${A}\n${B}\r\n${A}`, `${A}${B}`, `${TOKEN} ${A}`, `${A}?`, `${A})`, `${A}/`, `${A}%20`,
]
const recognizer = texts.map((text) => ({ text, onosendai: findNftLinks(text).length }))
for (const r of recognizer) if (mcpNft.nftLinkCount(r.text) !== r.onosendai) throw new Error(`count differs for ${JSON.stringify(r.text)}`)

// A bag's things, as ONOSENDAI writes them: messages as rumors, the rest signed.
const brass = onoChests.forgeKey('Brass Key', 'Opens the vault under the stop.')
const sealed = onoChests.sealEntries([message(`Inside the chest: ${D}`, 5n)], brass.itemPubkey)
const things = {
  plain: message('A plain note.', 0n),
  nft: message(`For the finder: ${A}`, 1n),
  mixed: message(`${TOKEN} and ${B}, ${B} again, and ${C}`, 2n),
  lookalikes: message(lookalikes, 3n),
  shard: sign(ono.shardInnerTemplate(shard, pt(4n), plane, T)),
  key: sign(ono.keyInnerTemplate(brass, pt(4n), plane, T)),
  chest: sign(ono.chestInnerTemplate({ name: 'Vault', lockPubkey: brass.itemPubkey, senderPubkey: sealed.senderPubkey, requires: 'the Brass Key', payload: sealed.payload }, pt(5n), plane, T)),
}
const all = Object.values(things)
const nftOnly = [message(A, 0n)]
const coin = message(`Here is a coin: ${TOKEN}`, 1n)

// The rows ONOSENDAI writes for fixed bags under each setting, and the MCP's for the same.
const settings = (contents: boolean, money: boolean) => ({ heightTag: true, hint: null, riddle: '', contents, money })
const rowsOf = (t: { tags: string[][] }) => t.tags.filter((x) => x[0] === 'contents')
const region8 = regionKeyAt(pt(0n), 8, 20)
const region3 = regionKeyAt(pt(0n), 3, 20)
const cases: Array<{ name: string; inners: unknown[]; contents: boolean; money: boolean; onosendai: string[][] }> = []
for (const [name, inners] of [['everything', all], ['an NFT alone', nftOnly], ['an NFT and a coin', [...nftOnly, coin]], ['nothing counted', [things.lookalikes]], ['empty', []]] as const) {
  for (const [contents, money] of [[true, false], [false, true], [true, true], [false, false]] as const) {
    const onoRows = rowsOf(await ono.bagTemplate(inners as never, region8.key, region8.lookupId, 8, T, ono.HIDDEN_KIND, settings(contents, money)))
    const mcpRows = rowsOf(await mcpBags.bagTemplate(inners, region8.key, region8.lookupId, 8, T, 33330, settings(contents, money)))
    if (JSON.stringify(onoRows) !== JSON.stringify(mcpRows)) throw new Error(`rows differ for ${name} ${contents} ${money}: ${JSON.stringify(onoRows)} vs ${JSON.stringify(mcpRows)}`)
    cases.push({ name, inners: inners as unknown[], contents, money, onosendai: onoRows })
  }
}

// How ONOSENDAI reads rows back into a bag's settings, and the MCP's reading of the same.
const reads = [
  [['contents', 'nft', '2']], [['contents', 'nft']], [['contents', 'nft', '0']], [['contents', 'nft', '-1']], [['contents', 'nft', '1.5']],
  [['contents', 'message', '1'], ['contents', 'nft', '1']], [['contents', 'cashu']], [['contents', 'cashu'], ['contents', 'nft', '1']], [['contents', 'gold', '5']],
].map((rows) => {
  const ev = { id: '0'.repeat(64), pubkey: agent, created_at: T, kind: 33330, content: '', sig: '', tags: [['d', region8.lookupId], ['H', '8'], ...rows] }
  const s = ono.bagSettingsOf(ev, 8)
  const m = mcpBags.bagSettingsOf(ev, 8)
  if (s.contents !== m.contents || s.money !== m.money) throw new Error(`settings differ for ${JSON.stringify(rows)}`)
  return { rows, onosendai: { contents: s.contents, money: s.money } }
})

// Two bags ONOSENDAI sealed with the test agent's key, and the rows it would
// write after each rewrite the test makes through the agent's tools: hide a
// note, remove the plain note, move the NFT message (counts unchanged),
// remove the NFT message; and, with money alone, hide a note, then remove the coin.
const note = message('An agent note.', 6n)
const after = (inners: unknown[], contents: boolean, money: boolean) => ono.bagContentsTags(inners as never, { contents, money })
const contentsOn = finalizeEvent(attributed(await ono.bagTemplate(all, region8.key, region8.lookupId, 8, T, ono.HIDDEN_KIND, settings(true, false))), agentSk)
const moneyAlone = finalizeEvent(attributed(await ono.bagTemplate([...nftOnly, coin], region3.key, region3.lookupId, 3, T, ono.HIDDEN_KIND, settings(false, true))), agentSk)
for (const [bag, key, h, n] of [[contentsOn, region8.key, 8, all.length], [moneyAlone, region3.key, 3, 2]] as const) {
  if ((await ono.unbag(bag, key, undefined, undefined, h)).length !== n) throw new Error('ONOSENDAI did not read its own bag')
}
const withNote = [...all, note]
const noPlain = withNote.filter((e) => e !== things.plain)
const noNft = noPlain.filter((e) => e !== things.nft)
const expected = {
  contentsOn: {
    sealed: rowsOf(contentsOn),
    afterHide: after(withNote, true, false),
    afterRemovePlain: after(noPlain, true, false),
    afterMoveNft: after(noPlain, true, false),
    afterRemoveNft: after(noNft, true, false),
  },
  moneyAlone: {
    sealed: rowsOf(moneyAlone),
    afterHide: after([...nftOnly, coin, note], false, true),
    afterRemoveCoin: after([...nftOnly, note], false, true),
  },
}

writeFileSync(OUT, JSON.stringify({
  note: 'Made with ONOSENDAI #441 (merged as 2311e07: src/lib/hidden.ts bagContents, bagContentsTags, bagTemplate, bagSettingsOf; src/lib/nftLink.ts findNftLinks from #440) by scripts/gen-onosendai-contents-fixture.ts run in an ONOSENDAI checkout, with test keys and made-up links only (none is a real claim link). "recognizer" is how many nonfungible.cash claim links ONOSENDAI counts in each text. "cases" are the contents rows ONOSENDAI writes for fixed bags under each setting. "reads" are the settings ONOSENDAI reads from rows. "bags" are two kind 33330 bags ONOSENDAI sealed with the test agent key at the point placed.test.ts uses (h8 with contents on; h3 with money alone), and "expected" the rows ONOSENDAI writes for what is in them after each rewrite contentsInterop.test.ts makes through the tools.',
  onosendai: '2311e07 (#441)',
  agentSecretHex: bytesToHex(agentSk), agent,
  base: BASE.toString(), T,
  recognizer,
  cases,
  reads,
  ids: { plain: things.plain.id, nft: things.nft.id, coin: coin.id, note: 'An agent note.' },
  bags: { contentsOn, moneyAlone },
  expected,
}, null, 2) + '\n')
console.log('ok', JSON.stringify({ texts: recognizer.length, cases: cases.length, reads: reads.length, expected }))
