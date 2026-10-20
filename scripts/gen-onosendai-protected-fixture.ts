// Generates test/fixtures/onosendai-protected.json for cyberspace-mcp with
// ONOSENDAI's own code (ONOSENDAI #409, merged as 4a85a04:
// src/lib/hidden.ts, chests.ts), for the rules of 2026-10-20: NIP-70 `-` on
// every item sealed in a bag or a chest, and a hidden message written as an
// unsigned rumor. It checks the reverse direction too: a bag and a chest
// written by cyberspace-mcp's code, read back through ONOSENDAI's readers.
//
// Run from an ONOSENDAI checkout of that branch (so ./src/lib resolves to
// ONOSENDAI), with this repository's tsx:
//   cp scripts/gen-onosendai-protected-fixture.ts <onosendai>/gen.ts
//   (cd <onosendai> && <mcp>/node_modules/.bin/tsx gen.ts <mcp> <mcp>/test/fixtures/onosendai-protected.json)
import { writeFileSync, readFileSync } from 'node:fs'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { fromPayload } from 'sno-core/shards'
import * as ono from './src/lib/hidden'
import * as onoChests from './src/lib/chests'
import { attributed } from './src/lib/client'
import { bytesToHex } from './src/lib/events'

const MCP = process.argv[2]
const OUT = process.argv[3]
const mcpBags = await import(`${MCP}/src/hidden/bags.ts`)
const mcpChests = await import(`${MCP}/src/hidden/chests.ts`)
const mcpCrypto = await import(`${MCP}/src/hidden/crypto.ts`)
const mcpCoords = await import(`${MCP}/src/space/coords.ts`)
const mcpEvent = await import(`${MCP}/src/nostr/event.ts`)

const T = 1_792_500_000
const HEIGHT = 6
const hiderSk = generateSecretKey()
const hider = getPublicKey(hiderSk)
const agentSk = generateSecretKey()
const agent = getPublicKey(agentSk)
const spawn = mcpCoords.spawnPlace(agent)
const at = spawn.position
const plane = spawn.plane
const region = mcpCrypto.regionKeyAt(at, HEIGHT, 20)
const sign = (t: { kind: number; created_at: number; tags: string[][]; content: string }, sk = hiderSk) => finalizeEvent(attributed(t), sk)
// As ONOSENDAI's deploy writes one (useShards: rumorOf(template, pubkey)), with no client tag; its signer adds one to what it signs.
const rumor = (t: { kind: number; created_at: number; tags: string[][]; content: string }, pk = hider) => ono.rumorOf(t, pk)

const payload = JSON.parse(readFileSync(`${MCP}/test/fixtures/xor-stella-octangula.json`, 'utf8'))
const shard = fromPayload(payload, 'x'.repeat(64))!

// ONOSENDAI's templates for fixed inputs, so the MCP's are checked tag for tag.
const brass = onoChests.forgeKey('Brass Key', 'Opens the vault under the stop.')
const fixedChest = { name: 'Fixed Chest', lockPubkey: brass.itemPubkey, senderPubkey: brass.itemPubkey, requires: 'the Fixed', payload: 'PAYLOAD' }
const legacyMessage = { kind: 1, created_at: T - 10, content: 'hidden before 2026-10-20', tags: [['C', '00'.repeat(32)]] }
const legacySigned = finalizeEvent(legacyMessage, hiderSk)
const templates = {
  shard: ono.shardInnerTemplate(shard, at, plane, T),
  message: ono.messageInnerTemplate('A fixed message.', at, plane, T),
  messageRumor: ono.rumorOf(ono.messageInnerTemplate('A fixed message.', at, plane, T), hider),
  key: ono.keyInnerTemplate({ ...brass, name: 'Fixed', about: 'A fixed sentence.' }, at, plane, T),
  chest: ono.chestInnerTemplate(fixedChest, at, plane, T),
  chestInput: fixedChest,
  keyInput: { name: 'Fixed', about: 'A fixed sentence.', itemPubkey: brass.itemPubkey, secretHex: brass.secretHex },
  // A move, as both clients build one: the new place with `-`, from a version
  // that lacked it (a message hidden before 2026-10-20) and from one that had it.
  edited: [
    { name: 'legacy message moved', next: { kind: 1, created_at: T + 1, content: legacyMessage.content, tags: [['C', 'ff'.repeat(32)], ['-']] }, previous: { id: legacySigned.id, kind: 1, tags: legacySigned.tags } },
    { name: 'protected shard moved', next: { kind: 3330, created_at: T + 1, content: '{}', tags: [['C', 'ff'.repeat(32)], ['-']] }, previous: { id: 'ab'.repeat(32), kind: 3330, tags: [['C', '00'.repeat(32)], ['-'], ['client', 'ONOSENDAI']] } },
  ].map((c) => ({ ...c, onosendai: ono.editedTemplate(c.next, c.previous) })),
}

// ONOSENDAI hides: a message (a rumor), a shard, a key, a chest locked to the
// key holding a rumor message, a signed legacy message and the next key; and
// a signed message from before 2026-10-20 in the bag itself.
const next = onoChests.forgeKey('Silver Key', 'The next door.')
const inner = [
  rumor(ono.messageInnerTemplate('The vault remembers.', at, plane, T)),
  sign(legacyMessage),
  sign(ono.keyInnerTemplate(next, at, plane, T)),
]
const sealed = onoChests.sealEntries(inner, brass.itemPubkey)
const chest = sign(ono.chestInnerTemplate({ name: 'Vault', lockPubkey: brass.itemPubkey, senderPubkey: sealed.senderPubkey, requires: 'the Brass Key', payload: sealed.payload }, at, plane, T))
const bagEntries = [
  rumor(ono.messageInnerTemplate('Hidden as a rumor by ONOSENDAI.', at, plane, T)),
  sign(ono.shardInnerTemplate(shard, at, plane, T)),
  sign(ono.keyInnerTemplate(brass, at, plane, T)),
  chest,
  sign({ ...legacyMessage, content: 'signed, in the bag, from before', tags: [['C', ono.shardInnerTemplate(shard, at, plane, T).tags[0][1]]] }),
]
const bag = finalizeEvent(attributed(await ono.bagTemplate(bagEntries, region.key, region.lookupId, HEIGHT, T)), hiderSk)
const read = await ono.unbag(bag, region.key, undefined, undefined, HEIGHT)
const vault = read.find((h) => h.type === 'chest')!
const vaultRead = onoChests.readContents(onoChests.openWithSecret(vault.chest!, brass.secretHex), onoChests.sealerOf(vault))
const onosendaiRead = {
  items: read.map((h) => ({ type: h.type, id: h.eventId, author: h.author, signed: typeof h.inner?.sig === 'string' && h.inner.sig.length > 0, protected: ono.isProtectedTags(h.inner?.tags ?? []), label: h.text ?? h.shard?.name ?? h.key?.name ?? h.chest?.name })),
  vault: vaultRead.map((c) => ({ type: c.body.type, id: c.id, verified: c.verified, text: c.body.text ?? null })),
}
if (read.length !== 5 || vaultRead.length !== 3 || !vaultRead.every((c) => c.verified)) throw new Error('ONOSENDAI did not read its own bag as expected')

// The reverse: cyberspace-mcp's code writes a bag the way the agent does
// (rumorOf with its client tag, signed items), and a move of a legacy
// message; ONOSENDAI reads them.
const mcpRumor = (t: { kind: number; created_at: number; tags: string[][]; content: string }) => mcpBags.rumorOf(mcpEvent.attributed(t), agent)
const mcpSign = (t: { kind: number; created_at: number; tags: string[][]; content: string }) => mcpEvent.signEvent(t, agentSk)
const copper = mcpChests.forgeKey('Copper Key', 'Made by the agent.')
const mcpChestInner = [mcpRumor(mcpBags.messageInnerTemplate('Sealed by the agent.', at, plane, T)), mcpSign(mcpBags.shardInnerTemplate(shard, at, plane, T))]
const mcpSealed = mcpChests.sealEntries(mcpChestInner, copper.itemPubkey)
const mcpChest = mcpSign(mcpBags.chestInnerTemplate({ name: 'Agent Chest', lockPubkey: copper.itemPubkey, senderPubkey: mcpSealed.senderPubkey, requires: 'the Copper Key', payload: mcpSealed.payload }, at, plane, T))
const mcpLegacy = mcpSign({ kind: 1, created_at: T - 5, content: 'an agent note from before', tags: [['C', mcpBags.messageInnerTemplate('x', at, plane, T).tags[0][1]]] })
const mcpMoved = mcpRumor(mcpBags.editedTemplate({ kind: 1, created_at: T + 2, content: mcpLegacy.content, tags: [mcpLegacy.tags[0], ['-']] }, mcpLegacy))
const mcpBagEntries = [
  mcpRumor(mcpBags.messageInnerTemplate('Hidden as a rumor by the agent.', at, plane, T)),
  mcpSign(mcpBags.keyInnerTemplate(copper, at, plane, T)),
  mcpChest,
  mcpMoved,
]
const mcpBag = mcpSign(await mcpBags.bagTemplate(mcpBagEntries, region.key, region.lookupId, HEIGHT, T))
const onoRead = await ono.unbag(mcpBag, region.key, undefined, undefined, HEIGHT)
const onoChest = onoRead.find((h) => h.type === 'chest')!
const onoChestRead = onoChests.readContents(onoChests.openWithSecret(onoChest.chest!, copper.secretHex), onoChests.sealerOf(onoChest))
const reverse = {
  items: onoRead.map((h) => ({ type: h.type, id: h.eventId, author: h.author, signed: typeof h.inner?.sig === 'string' && h.inner.sig.length > 0, protected: ono.isProtectedTags(h.inner?.tags ?? []), lineage: ono.itemLineage(h.inner), label: h.text ?? h.shard?.name ?? h.key?.name ?? h.chest?.name })),
  chest: onoChestRead.map((c) => ({ type: c.body.type, verified: c.verified, text: c.body.text ?? null })),
  movedLineage: mcpLegacy.id,
}
if (onoRead.length !== 4 || onoChestRead.length !== 2 || !onoChestRead.every((c) => c.verified)) throw new Error('ONOSENDAI did not read the agent\'s bag as expected')

writeFileSync(OUT, JSON.stringify({
  note: 'Made with ONOSENDAI #409 (merged as 4a85a04: src/lib/hidden.ts, chests.ts, client.ts) by scripts/gen-onosendai-protected-fixture.ts run in an ONOSENDAI checkout, with test keys only. "templates" are ONOSENDAI\'s inner templates for fixed inputs, its rumor of the message, and two moves through its editedTemplate. "bag" is a kind 33330 ONOSENDAI sealed at the test agent\'s spawn, h6: a message as a rumor (tags C and -, as ONOSENDAI writes it), a shard, a key item (Brass Key), a chest locked to it (a rumor message, a signed message from before 2026-10-20, the next key), and a signed message from before. "onosendaiRead" is what ONOSENDAI\'s unbag and readContents made of it. "mcpBag" was written by cyberspace-mcp\'s code at generation time (a rumor message, a key, a chest holding a rumor and a shard, and a legacy signed message moved as a rumor); "reverse" is what ONOSENDAI\'s readers made of it.',
  onosendai: '4a85a04 (#409)',
  agentSecretHex: bytesToHex(agentSk), agent, hider,
  height: HEIGHT, lookupId: region.lookupId, regionKeyHex: bytesToHex(region.key), at: { x: at.x.toString(), y: at.y.toString(), z: at.z.toString(), plane },
  brassSecretHex: brass.secretHex, copperSecretHex: copper.secretHex,
  templates,
  bag,
  onosendaiRead,
  mcpBag,
  reverse,
}, null, 2) + '\n')
console.log('ok', JSON.stringify({ ono: onosendaiRead.items.map((i) => i.type), vault: onosendaiRead.vault.map((c) => c.verified), reverse: reverse.items.map((i) => `${i.type}:${i.signed ? 'signed' : 'rumor'}`) }))
