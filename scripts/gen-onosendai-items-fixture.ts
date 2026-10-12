// Generates test/fixtures/onosendai-items.json for cyberspace-mcp with
// ONOSENDAI's own code (origin/v2 b615675: src/lib/hidden.ts, chests.ts,
// inventory.ts, client.ts, comments.ts), and checks the reverse direction: a key and a
// chest sealed by cyberspace-mcp's code read back through ONOSENDAI's.
import { writeFileSync, readFileSync } from 'node:fs'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { fromPayload } from 'sno-core/shards'
import * as ono from './src/lib/hidden'
import * as onoChests from './src/lib/chests'
import * as onoInv from './src/lib/inventory'
import { attributed } from './src/lib/client'
import * as onoComments from './src/lib/comments'
import { regionKeyAt as onoRegionKeyAt } from './src/lib/shardCrypto'
import { bytesToHex, hexToBytes } from './src/lib/events'

const MCP = process.argv[2]
const OUT = process.argv[3]
const mcpBags = await import(`${MCP}/src/hidden/bags.ts`)
const mcpChests = await import(`${MCP}/src/hidden/chests.ts`)
const mcpCrypto = await import(`${MCP}/src/hidden/crypto.ts`)
const mcpCoords = await import(`${MCP}/src/space/coords.ts`)
const mcpComments = await import(`${MCP}/src/hidden/comments.ts`)

const T = 1_760_250_000
const HEIGHT = 6
const hiderSk = generateSecretKey()
const agentSk = generateSecretKey()
const agent = getPublicKey(agentSk)
const spawn = mcpCoords.spawnPlace(agent)
const at = spawn.position
const plane = spawn.plane
const region = mcpCrypto.regionKeyAt(at, HEIGHT, 20)
const sign = (t: { kind: number; created_at: number; tags: string[][]; content: string }, sk = hiderSk) => finalizeEvent(attributed(t), sk)

const payload = JSON.parse(readFileSync(`${MCP}/test/fixtures/xor-stella-octangula.json`, 'utf8'))
const shard = fromPayload(payload, 'x'.repeat(64))!

// ONOSENDAI forges an item and hides it.
const brass = onoChests.forgeKey('Brass Key', 'Opens the vault under the stop.')
const keyEvent = sign(ono.keyInnerTemplate(brass, at, plane, T))
// A chest locked to that item: a message, a coin, a shard, and the next item, forged inline (chaining).
const next = onoChests.forgeKey('Silver Key', 'The next door.')
const contents = [
  sign(ono.messageInnerTemplate('The vault remembers.', at, plane, T)),
  sign(ono.messageInnerTemplate('Here is a coin: cashuBexampletokenAAAA', at, plane, T)),
  sign(ono.shardInnerTemplate(shard, at, plane, T)),
  sign(ono.keyInnerTemplate(next, at, plane, T)),
]
const sealedToItem = onoChests.sealEntries(contents, brass.itemPubkey)
const chestToItem = sign(ono.chestInnerTemplate({ name: 'Vault', lockPubkey: brass.itemPubkey, senderPubkey: sealedToItem.senderPubkey, requires: 'the Brass Key', payload: sealedToItem.payload }, at, plane, T))
// A gift to the agent's own npub.
const sealedToAgent = onoChests.sealEntries([sign(ono.messageInnerTemplate('A gift for you, agent.', at, plane, T))], agent)
const chestToAgent = sign(ono.chestInnerTemplate({ name: 'Gift', lockPubkey: agent, senderPubkey: sealedToAgent.senderPubkey, requires: 'being the one it was sealed for', payload: sealedToAgent.payload }, at, plane, T))
// One sealed to an item the agent never finds.
const elsewhere = onoChests.forgeKey('Lost Key')
const sealedElsewhere = onoChests.sealEntries([sign(ono.messageInnerTemplate('You will not read this.', at, plane, T))], elsewhere.itemPubkey)
const chestElsewhere = sign(ono.chestInnerTemplate({ name: 'Locked', lockPubkey: elsewhere.itemPubkey, senderPubkey: sealedElsewhere.senderPubkey, requires: '', payload: sealedElsewhere.payload }, at, plane, T))
const bag = finalizeEvent(attributed(await ono.bagTemplate([keyEvent, chestToItem, chestToAgent, chestElsewhere], region.key, region.lookupId, HEIGHT, T)), hiderSk)

// A bag at h0, the single gibson the agent spawns on, keyed by ONOSENDAI's own derivation (as its deploy bar allows and its scan reads).
const h0 = onoRegionKeyAt(at, 0, 20)
const h0Message = sign(ono.messageInnerTemplate('Found at the gibson itself.', at, plane, T))
const bagH0 = finalizeEvent(attributed(await ono.bagTemplate([h0Message], h0.key, h0.lookupId, 0, T)), hiderSk)
if ((await ono.unbag(bagH0, h0.key, undefined, undefined, 0)).length !== 1) throw new Error('ONOSENDAI did not read its own h0 bag')

// ONOSENDAI reads its own bag: the baseline the MCP must match.
const read = await ono.unbag(bag, region.key, undefined, undefined, HEIGHT)
if (read.length !== 4) throw new Error('ONOSENDAI did not read its own bag')

// Templates for fixed inputs, so the MCP's are checked tag for tag.
const fixedKey = { name: 'Fixed', about: 'A fixed sentence.', itemPubkey: brass.itemPubkey, secretHex: brass.secretHex }
const fixedChest = { name: 'Fixed Chest', lockPubkey: brass.itemPubkey, senderPubkey: sealedToItem.senderPubkey, requires: 'the Fixed', payload: sealedToItem.payload }
const templates = {
  key: ono.keyInnerTemplate(fixedKey, at, plane, T),
  chest: ono.chestInnerTemplate(fixedChest, at, plane, T),
  keyInput: { ...fixedKey, secretHex: undefined },
  chestInput: fixedChest,
}

// The reverse: cyberspace-mcp forges and seals, ONOSENDAI reads.
const mcpKey = mcpChests.forgeKey('Copper Key', 'Made by the agent.')
const mcpKeyEvent = finalizeEvent(mcpBags.keyInnerTemplate(mcpKey, at, plane, T), agentSk)
const mcpInner = [finalizeEvent(mcpBags.messageInnerTemplate('Sealed by the agent.', at, plane, T), agentSk), finalizeEvent(mcpBags.shardInnerTemplate(shard, at, plane, T), agentSk)]
const mcpSealed = mcpChests.sealEntries(mcpInner, mcpKey.itemPubkey)
const mcpChest = finalizeEvent(mcpBags.chestInnerTemplate({ name: 'Agent Chest', lockPubkey: mcpKey.itemPubkey, senderPubkey: mcpSealed.senderPubkey, requires: 'the Copper Key', payload: mcpSealed.payload }, at, plane, T), agentSk)
const mcpBag = finalizeEvent(await mcpBags.bagTemplate([mcpKeyEvent, mcpChest], region.key, region.lookupId, HEIGHT, T), agentSk)
const onoRead = await ono.unbag(mcpBag, region.key, undefined, undefined, HEIGHT)
const onoKey = onoRead.find((h) => h.type === 'key')!
const onoChest = onoRead.find((h) => h.type === 'chest')!
const held = onoInv.heldFromFind(getPublicKey(hiderSk), onoKey, T)!
const opener = onoChests.openerFor(onoChest.chest!, onoInv.openingKeys({ [held.id]: held }), getPublicKey(hiderSk))
if (!opener || opener.by !== 'key') throw new Error('ONOSENDAI found no opener for the agent\'s chest')
const opened = onoChests.readContents(onoChests.openWithSecret(onoChest.chest!, opener.key.secretHex))
const reverse = {
  keyName: onoKey.key!.name, keyAbout: onoKey.key!.about, keyItemPubkey: onoKey.key!.itemPubkey, keyMatches: onoKey.key!.itemPubkey === mcpKey.itemPubkey,
  chestName: onoChest.chest!.name, chestRequires: onoChest.chest!.requires, chestLock: onoChest.chest!.lockPubkey,
  contents: opened.map((c) => ({ type: c.body.type, verified: c.verified, text: c.body.text ?? null, shardName: c.body.shard?.name ?? null })),
}
if (!reverse.keyMatches || opened.length !== 2) throw new Error('reverse check failed')

// Comments: ONOSENDAI's templates for fixed inputs (an item in the bag, a chest, a thing inside a chest), and a comment this server seals, read by ONOSENDAI.
const subject = { author: getPublicKey(hiderSk), lookupId: region.lookupId }
const vaultInside = onoChests.readContents(onoChests.openWithSecret(read.find((h) => h.eventId === chestToItem.id)!.chest!, brass.secretHex))
const coin = vaultInside[1]
const commentCases = [
  { name: 'key in the bag', parent: { id: keyEvent.id, kind: onoComments.itemKind('key'), pubkey: subject.author } },
  { name: 'chest in the bag', parent: { id: chestToItem.id, kind: onoComments.itemKind('chest'), pubkey: subject.author } },
  { name: 'coin inside the Vault', parent: { id: coin.id, kind: onoComments.itemKind('message'), pubkey: subject.author } },
].map((c) => ({ ...c, template: onoComments.commentTemplate(subject, c.parent, 'CIPHERTEXT', T) }))
const mcpCommentEvent = finalizeEvent(await mcpComments.sealedComment(subject, commentCases[2].parent, 'Found a coin in the Vault.', T, region.key), agentSk)
const onoWords = await onoComments.openComments([mcpCommentEvent], region.key)
const onoThread = onoComments.threadComments([mcpCommentEvent], { author: subject.author, lookupId: subject.lookupId, itemId: coin.id }, onoWords)
if (onoThread.length !== 1 || onoThread[0].text !== 'Found a coin in the Vault.') throw new Error('ONOSENDAI did not thread the agent\'s comment')
const comments = { subject, cases: commentCases, mcpComment: mcpCommentEvent, onosendaiRead: { count: onoThread.length, text: onoThread[0].text, sealed: onoThread[0].sealed, pubkey: onoThread[0].pubkey, parentId: onoThread[0].parentId } }

writeFileSync(OUT, JSON.stringify({
  note: 'Made with ONOSENDAI origin/v2 b615675 (src/lib/hidden.ts, chests.ts, inventory.ts, client.ts, comments.ts) by a generator run outside this repository, with test keys only. "bag" is a kind 33330 sealed by ONOSENDAI at the test agent\'s spawn, h6: a key item (Brass Key), a chest locked to it (a message, a coin, a shard, the next key), a chest sealed to the agent\'s pubkey, and a chest locked to an item nobody here holds. "h0" is a bag ONOSENDAI sealed at h0, the agent\'s spawn gibson alone, with ONOSENDAI\'s own region key derivation. "templates" are ONOSENDAI\'s key and chest templates for fixed inputs. "reverse" is what ONOSENDAI\'s readers (unbag, heldFromFind, openingKeys, openerFor, openWithSecret, readContents) made of "mcpBag", a key and a chest sealed by cyberspace-mcp\'s own code at generation time. "comments" holds ONOSENDAI\'s commentTemplate for fixed inputs and what ONOSENDAI\'s openComments and threadComments made of a comment sealed by cyberspace-mcp\'s code.',
  onosendai: 'b615675',
  agentSecretHex: bytesToHex(agentSk), agent, hider: getPublicKey(hiderSk),
  height: HEIGHT, lookupId: region.lookupId, regionKeyHex: bytesToHex(region.key), at: { x: at.x.toString(), y: at.y.toString(), z: at.z.toString(), plane },
  bag,
  h0: { lookupId: h0.lookupId, bag: bagH0, text: 'Found at the gibson itself.', messageId: h0Message.id },
  expect: {
    key: { name: brass.name, about: brass.about, itemPubkey: brass.itemPubkey, eventId: keyEvent.id },
    nextKey: { name: next.name, itemPubkey: next.itemPubkey },
    vault: { id: chestToItem.id, name: 'Vault', requires: 'the Brass Key', texts: ['The vault remembers.', 'Here is a coin: cashuBexampletokenAAAA'], shardName: shard.name },
    gift: { id: chestToAgent.id, name: 'Gift', text: 'A gift for you, agent.' },
    locked: { id: chestElsewhere.id, name: 'Locked', lock: elsewhere.itemPubkey },
  },
  templates,
  mcpBag,
  reverse,
  comments,
}, null, 2) + '\n')
console.log('ok', JSON.stringify(reverse.contents.map((c) => c.type)))
void hexToBytes
