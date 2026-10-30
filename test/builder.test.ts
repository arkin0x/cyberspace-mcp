// builder.test.ts: the only module that writes kind 3333 writes it right.
// The hop proof matches the spec's worked example (section 5.7), every
// tag the chain rules read appears exactly once, the sector tags agree with
// C, a spawn's C is its pubkey, and the resolver reads the events back as
// a valid chain, a frozen one, and a dead one.
//
// The boarding and ride templates (DECK-0001 3.1, 5.2) are held to the
// rides people have published: hyperjumpTemplate, handed a published ride's
// own tags as its inputs, must write that ride back tag for tag, in order,
// plus the mn tag every new ride carries (DECK-0001 5.8) and those sixteen
// older rides do not. Four of the sixteen are on disk (test/hyperspace/
// fixtures), id and signature checked here, so the copies' origin does not
// matter. No published boarding is on disk anywhere offline, so the boarding
// template is held to ONOSENDAI's code (src/lib/events.ts at 18eded9), to
// the coordinate the published ride 9c5d55cd departs from (its c, which is
// the C of its boarding edb4553a), and to the chain reader's rule that a
// boarding's c equals its C.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { computeHopProof, computeHopProofV2, computeMovementProof, deriveRegionKeys, hexToCoord, coordToXyz, verifyHopLevel1, AXIS_CENTER } from 'cyberspace-core'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { ACTION_KIND, chainTemplateProblem, enterHyperspaceTemplate, hopTemplate, hyperjumpTemplate, sidestepTemplate, spawnTemplate, type HyperjumpInput } from '../src/chain/builder.js'
import { CHAIN_RULES_REVISION, buildChain, chainStatus, firstBreak, parseAction } from '../src/chain/events.js'
import { hopEventProblems, isVersion1Hop } from '../src/chain/hopProofs.js'
import { fakeHopProof } from './fakeHop.js'
import { isAuthentic, signEvent, tagValue, type EventTemplate, type NostrEvent } from '../src/nostr/event.js'
import { placeFromHex, positionHex, sectorTags } from '../src/space/coords.js'

const ZERO_ID = '0'.repeat(64)

describe('the spec worked example (section 5.7)', () => {
  it('computes the proof hash and the lookup id the spec gives', () => {
    const proof = computeHopProof(0n, 0n, 0n, 4104n, 0n, 0n, 0, ZERO_ID)
    expect(proof.terrainK).toBe(11)
    expect(proof.proofHash).toBe('ed9d09ca697b2da29c9d042207ac8ef7aab40f6dde550e6467452aa0e2e8cac6')
    const region = computeMovementProof(0n, 0n, 0n, 4104n, 0n, 0n)
    expect(deriveRegionKeys(region.combined).lookupIdHex).toBe('8d2463eb22301d97a1f7e33b90e473ba2eec69079f418a72609c3e4d2981669b')
  })
})

describe('version 2 of the hop proof, against the spec\'s golden vectors (5.10; arkin0x/cyberspace 8b45430, hop-residue-vectors.json as cyberspace-core 0692a12 carries it)', () => {
  // The prover cases, as computeHopProofV2 must reproduce them through hopTemplate: the 5.7 movement and a three-axis hop.
  const vectors = [
    {
      name: 'golden-5.7', prev: ZERO_ID,
      c: '0'.repeat(64), C: '0000000000000000000000000000000000000000000000000000008000001000',
      seal: 'c5524980e1b021dc49fb64d14a521456a48693d0711a886516c1f4ab733db5cb', mn: '0000000000000057',
      mpSha256: '3d5d88eba8a384d134bba7ba00ea48b7188802c482f011fbef3b8100ccbc4e93', mpLength: 11264,
    },
    {
      name: 'multi-axis-earth', prev: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      c: 'e000000000000000000000000000000000000000000000000000000049349b8e', C: 'e000000000000000000000000000000000000000000000000000000202800080',
      seal: 'bc6d570133a294ba315e9b383c4cc8f8369325d72c1d132d9a90d89c66efcbe8', mn: '0000000000000058',
      mpSha256: '115f290d04b21c7bbca6c58f4f280a8c34cc2dbf538d0ec75faa2f64aa546ab4', mpLength: 9216,
    },
  ]
  for (const v of vectors) {
    it(`${v.name}: the hop this server builds carries the vector's proof, mn and mp, and verifies at Level 1`, () => {
      const from = coordToXyz(hexToCoord(v.c))
      const to = coordToXyz(hexToCoord(v.C))
      const proof = computeHopProofV2(from.x, from.y, from.z, to.x, to.y, to.z, to.plane, v.prev)
      const t = hopTemplate({ createdAt: 1, genesisId: 'a'.repeat(64), previousId: v.prev, prevCoordHex: v.c, to, plane: to.plane, seal: proof.tags.proof, mnHex: proof.tags.mn, mpHex: proof.tags.mp })
      expect(tagValue(t, 'C')).toBe(v.C)
      expect(tagValue(t, 'proof')).toBe(v.seal)
      expect(tagValue(t, 'mn')).toBe(v.mn)
      expect(tagValue(t, 'mp')).toHaveLength(v.mpLength)
      expect(createHash('sha256').update(tagValue(t, 'mp')!).digest('hex')).toBe(v.mpSha256)
      expect(verifyHopLevel1({ from, to, previousEventIdHex: v.prev, proof: v.seal, nonce: v.mn, openings: tagValue(t, 'mp'), eventId: 'f'.repeat(64) })).toEqual([])
    })
  }

  it('the chain rules are the residue openings revision (spec 8.12)', () => {
    expect(CHAIN_RULES_REVISION).toBe('2026-10-08-residue-openings')
  })
})

describe('the chain event builder', () => {
  const sk = generateSecretKey()
  const pubkey = getPublicKey(sk)
  const home = placeFromHex(pubkey)

  it('builds a spawn at the pubkey with its sector tags, and nothing else the rules read', () => {
    const t = spawnTemplate(pubkey, 1_700_000_000)
    expect(t.kind).toBe(ACTION_KIND)
    expect(t.tags).toEqual([['A', 'spawn'], ['C', pubkey], ...sectorTags(home.position)])
    expect(chainTemplateProblem(t, pubkey)).toBeNull()
    const ev = signEvent(t, sk)
    expect(parseAction(ev)?.type).toBe('spawn')
  })

  it('builds a version 2 hop: proof (the seal), mn and mp after C, in spec 8.4\'s order, every read tag exactly once, and it verifies with core', () => {
    const spawn = signEvent(spawnTemplate(pubkey, 1_700_000_000), sk)
    const to = { x: home.position.x + 3n, y: home.position.y, z: home.position.z }
    const proof = computeHopProofV2(home.position.x, home.position.y, home.position.z, to.x, to.y, to.z, home.plane, spawn.id)
    const t = hopTemplate({ createdAt: 1_700_000_001, genesisId: spawn.id, previousId: spawn.id, prevCoordHex: pubkey, to, plane: home.plane, seal: proof.tags.proof, mnHex: proof.tags.mn, mpHex: proof.tags.mp })
    expect(chainTemplateProblem(t, pubkey)).toBeNull()
    // Tag for tag, in order: what ONOSENDAI's hopTemplate writes (spec 8.4 at 8b45430).
    expect(t.tags.map((x) => x[0])).toEqual(['A', 'e', 'e', 'c', 'C', 'proof', 'mn', 'mp', 'X', 'Y', 'Z', 'S'])
    expect(t.tags.slice(0, 8)).toEqual([
      ['A', 'hop'], ['e', spawn.id, '', 'genesis'], ['e', spawn.id, '', 'previous'], ['c', pubkey], ['C', positionHex(to, home.plane)],
      ['proof', proof.tags.proof], ['mn', proof.tags.mn], ['mp', proof.tags.mp],
    ])
    expect(t.tags.slice(8)).toEqual(sectorTags(to))
    for (const name of ['A', 'c', 'C', 'proof', 'mn', 'mp', 'X', 'Y', 'Z', 'S']) expect(t.tags.filter((x) => x[0] === name)).toHaveLength(1)
    expect(t.tags.filter((x) => x[0] === 'e' && x[3] === 'genesis')).toHaveLength(1)
    expect(t.tags.filter((x) => x[0] === 'e' && x[3] === 'previous')).toHaveLength(1)
    const hop = signEvent(t, sk)
    const chain = buildChain([spawn, hop], pubkey)
    expect(chain).toHaveLength(2)
    expect(chainStatus(chain)).toBe('valid')
    expect(chain[1].position).toEqual(to)
    expect(chain[1].mn).toBe(proof.tags.mn)
    expect(chain[1].mp).toBe(proof.tags.mp)
    // The proof is the proof of this very event: Level 1 from its own c, C, e previous, proof, mn, mp and id, nothing the builder was handed.
    expect(hopEventProblems(hop)).toEqual([])
    expect(isVersion1Hop(hop)).toBe(false)
    // And buildChain does not check it: a wrong proof still resolves, which is why the agent checks every hop it signs at Level 1.
    const forged = signEvent(hopTemplate({ createdAt: 1_700_000_001, genesisId: spawn.id, previousId: spawn.id, prevCoordHex: pubkey, to, plane: home.plane, ...fakeHopProof('ab') }), sk)
    expect(chainStatus(buildChain([spawn, forged], pubkey))).toBe('valid')
    expect(hopEventProblems(forged).length).toBeGreaterThan(0)
  })

  it('never builds a version 1 hop: a missing or malformed seal, mn or mp is refused before anything is built', () => {
    const base = { createdAt: 2, genesisId: 'a'.repeat(64), previousId: 'b'.repeat(64), prevCoordHex: pubkey, to: home.position, plane: home.plane }
    const good = fakeHopProof()
    expect(() => hopTemplate({ ...base, ...good })).not.toThrow()
    expect(() => hopTemplate({ ...base, ...good, seal: 'ab' })).toThrow(/seal/)
    expect(() => hopTemplate({ ...base, ...good, mnHex: '' })).toThrow(/re-roll nonce/)
    expect(() => hopTemplate({ ...base, ...good, mnHex: '0123456789ABCDEF' })).toThrow(/re-roll nonce/)
    expect(() => hopTemplate({ ...base, ...good, mpHex: '' })).toThrow(/residue openings/)
    expect(() => hopTemplate({ ...base, ...good, mpHex: good.mpHex.slice(1) })).toThrow(/residue openings/)
    expect(() => hopTemplate({ ...base, ...good, mpHex: good.mpHex.replace(/^0/, 'g') })).toThrow(/residue openings/)
    // Built by hand around the template, a hop without mn and mp (version 1's shape) is named before it is signed.
    const t = hopTemplate({ ...base, ...good })
    const v1 = { ...t, tags: t.tags.filter((x) => x[0] !== 'mn' && x[0] !== 'mp') }
    expect(chainTemplateProblem(v1, pubkey)).toMatch(/mn appears 0 times/)
    expect(chainTemplateProblem({ ...t, tags: [...t.tags, ['mp', good.mpHex]] }, pubkey)).toMatch(/mp appears 2 times/)
    expect(chainTemplateProblem({ ...t, tags: t.tags.map((x) => (x[0] === 'mn' ? ['mn', 'zz'] : x)) }, pubkey)).toMatch(/mn is not a re-roll nonce/)
    expect(chainTemplateProblem({ ...t, tags: t.tags.map((x) => (x[0] === 'mp' ? ['mp', 'abc'] : x)) }, pubkey)).toMatch(/mp is not 16 residue openings/)
  })

  it('the reader keeps a hop\'s mn and mp, still reads a version 1 hop (the exemption list decides it, not the parser), and breaks on a doubled mn', () => {
    const spawn = signEvent(spawnTemplate(pubkey, 1_700_000_000), sk)
    const to = { x: home.position.x + 1n, y: home.position.y, z: home.position.z }
    const t = hopTemplate({ createdAt: 1_700_000_001, genesisId: spawn.id, previousId: spawn.id, prevCoordHex: pubkey, to, plane: home.plane, ...fakeHopProof() })
    const v1 = signEvent({ ...t, tags: t.tags.filter((x) => x[0] !== 'mn' && x[0] !== 'mp') }, sk)
    expect(isVersion1Hop(v1)).toBe(true)
    const read = parseAction(v1)!
    expect(read.type).toBe('hop')
    expect(read.mn).toBeUndefined()
    expect(read.mp).toBeUndefined()
    expect(chainStatus(buildChain([spawn, v1], pubkey))).toBe('valid')
    // Not on the (empty, before the census) list, so Level 1 names the missing tags.
    expect(hopEventProblems(v1)).toEqual(['form:mn', 'form:mp'])
    const doubled = signEvent({ ...t, tags: [...t.tags, ['mn', '0'.repeat(16)]] }, sk)
    const chain = buildChain([spawn, doubled], pubkey)
    expect(chainStatus(chain)).toBe('frozen')
    expect(chain[1].breaks).toMatch(/two mn tags/)
  })

  it('refuses a template with a doubled read tag or a wrong sector tag before it is signed', () => {
    const t = spawnTemplate(pubkey, 1)
    expect(chainTemplateProblem({ ...t, tags: [...t.tags, ['S', '0-0-0']] }, pubkey)).toMatch(/S appears 2 times/)
    const wrong = { ...t, tags: t.tags.map((x) => (x[0] === 'X' ? ['X', '1'] : x)) }
    expect(chainTemplateProblem(wrong, pubkey)).toMatch(/X says 1/)
    expect(chainTemplateProblem(spawnTemplate(pubkey, 1), 'a'.repeat(64))).toMatch(/must equal the pubkey/)
  })

  it('builds a sidestep with the three Merkle tags, the nonce and the heights', () => {
    const t = sidestepTemplate({
      createdAt: 2, genesisId: 'a'.repeat(64), previousId: 'b'.repeat(64), prevCoordHex: pubkey,
      to: { x: AXIS_CENTER, y: 1n, z: 2n }, plane: 1, proofHash: 'c'.repeat(64),
      merkleRoots: ['d'.repeat(64), 'e'.repeat(64), 'f'.repeat(64)], openings: ['ab', '', ''], mnHex: '0123456789abcdef', lcaHeights: [21, 0, 0],
    })
    expect(chainTemplateProblem(t, pubkey)).toBeNull()
    expect(t.tags.find((x) => x[0] === 'mr')?.[1]).toBe(['d'.repeat(64), 'e'.repeat(64), 'f'.repeat(64)].join(':'))
    expect(t.tags.find((x) => x[0] === 'hx')?.[1]).toBe('21')
    // Its own tags in ONOSENDAI's order (8e4d0e3), unchanged by the version 2 hop: one mp and one mn, its own, never a hop's.
    expect(t.tags.map((x) => x[0])).toEqual(['A', 'e', 'e', 'c', 'C', 'proof', 'mr', 'mp', 'mn', 'hx', 'hy', 'hz', 'X', 'Y', 'Z', 'S'])
    expect(t.tags.find((x) => x[0] === 'proof')?.[1]).toBe('c'.repeat(64))
  })
})

describe('the resolver (spec 8.7.3)', () => {
  const sk = generateSecretKey()
  const pubkey = getPublicKey(sk)
  const home = placeFromHex(pubkey)
  const spawn = signEvent(spawnTemplate(pubkey, 1_700_000_000), sk)
  const step = (previousId: string, prevCoordHex: string, dx: bigint, createdAt: number) => {
    const to = { x: home.position.x + dx, y: home.position.y, z: home.position.z }
    return signEvent(hopTemplate({ createdAt, genesisId: spawn.id, previousId, prevCoordHex, to, plane: home.plane, ...fakeHopProof() }), sk)
  }

  it('a fork kills the chain: the identity stands at its spawn coordinate', () => {
    const a = step(spawn.id, pubkey, 1n, 1_700_000_001)
    const b = step(spawn.id, pubkey, 2n, 1_700_000_002)
    const chain = buildChain([spawn, a, b], pubkey)
    expect(chainStatus(chain)).toBe('dead')
    expect(chain[0].fork?.branchIds.sort()).toEqual([a.id, b.id].sort())
    expect(chain[0].position).toEqual(home.position)
  })

  it('an action that does not start where the chain stood freezes it at the last valid position', () => {
    const a = step(spawn.id, pubkey, 1n, 1_700_000_001)
    const teleport = step(a.id, pubkey, 5n, 1_700_000_002) // c says the spawn, but the chain stood at a
    const chain = buildChain([spawn, a, teleport], pubkey)
    expect(chainStatus(chain)).toBe('frozen')
    expect(firstBreak(chain)?.index).toBe(2)
    expect(chain[2].position).toEqual(chain[1].position)
  })

  it('the newest spawn wins and older chains are history', () => {
    const a = step(spawn.id, pubkey, 1n, 1_700_000_001)
    const respawn = signEvent(spawnTemplate(pubkey, 1_700_000_010), sk)
    const chain = buildChain([spawn, a, respawn], pubkey)
    expect(chain).toHaveLength(1)
    expect(chain[0].id).toBe(respawn.id)
  })
})

/** Arkinox's ride 9c5d55cd (2026-09-09, block 36527 to block 29898), the reference ride, as published. */
const RIDE_9C5D55CD = JSON.parse(readFileSync(new URL('./hyperspace/fixtures/ride-9c5d55cd.json', import.meta.url), 'utf8')) as NostrEvent
/** The three rides test/hyperspace/ride.test.ts recomputes openings of (43628b38, 5222e768, 6c98e331), whole, from the same 2026-09-28 audit corpus the ride above was copied from. */
const RIDES_THREE = JSON.parse(readFileSync(new URL('./hyperspace/fixtures/rides-43628b38-5222e768-6c98e331.json', import.meta.url), 'utf8')) as NostrEvent[]
const PUBLISHED_RIDES = [RIDE_9C5D55CD, ...RIDES_THREE]

/** The coordinate ride 9c5d55cd departs from: its c tag, which is the C of its boarding edb4553a (dataspace, on Earth). */
const BOARDING_COORD = tagValue(RIDE_9C5D55CD, 'c')!
/** The stop ride 9c5d55cd arrives at: the landfall of block 29898. */
const STOP_29898 = tagValue(RIDE_9C5D55CD, 'C')!

const marked = (ev: Pick<NostrEvent, 'tags'>, marker: string): string => ev.tags.find((t) => t[0] === 'e' && t[3] === marker)![1]
const asTemplate = (ev: NostrEvent): EventTemplate => ({ kind: ev.kind, created_at: ev.created_at, content: ev.content, tags: ev.tags })
/** The template with one tag's value replaced; the tag's place is kept, so only the value is under test. */
const withTag = (t: EventTemplate, name: string, value: string): EventTemplate => ({ ...t, tags: t.tags.map((x) => (x[0] === name ? [name, value] : x)) })

/**
 * A published ride's own tags read back as the template's inputs: exactly
 * what the ride runner would hand the builder had it computed this ride. mn
 * is the one input the ride does not carry, because it was published before
 * the re-roll price.
 */
function inputsOf(ride: NostrEvent, mnHex: string): HyperjumpInput {
  const asOf = tagValue(ride, 'as_of')
  return {
    createdAt: ride.created_at,
    genesisId: marked(ride, 'genesis'),
    previousId: marked(ride, 'previous'),
    prevCoordHex: tagValue(ride, 'c')!,
    toCoordHex: tagValue(ride, 'C')!,
    fromHeight: Number(tagValue(ride, 'from_height')),
    toHeight: Number(tagValue(ride, 'B')),
    ...(asOf !== undefined ? { asOf: Number(asOf) } : {}),
    rootHex: tagValue(ride, 'proof')!,
    mp: tagValue(ride, 'mp')!,
    mnHex,
  }
}

describe('the boarding template (DECK-0001 3.1)', () => {
  const sk = generateSecretKey()
  const pubkey = getPublicKey(sk)
  const home = placeFromHex(pubkey)
  const links = { createdAt: 1_700_000_001, genesisId: 'a'.repeat(64), previousId: 'b'.repeat(64), proofHash: 'c'.repeat(64) }

  it('writes c and C as the one coordinate it is handed, then the proof and the sector tags of that coordinate, in ONOSENDAI\'s order', () => {
    const t = enterHyperspaceTemplate({ ...links, coordHex: BOARDING_COORD })
    expect(t.kind).toBe(ACTION_KIND)
    expect(t.content).toBe('')
    expect(t.created_at).toBe(links.createdAt)
    expect(t.tags).toEqual([
      ['A', 'enter-hyperspace'],
      ['e', links.genesisId, '', 'genesis'],
      ['e', links.previousId, '', 'previous'],
      ['c', BOARDING_COORD],
      ['C', BOARDING_COORD],
      ['proof', links.proofHash],
      ...sectorTags(placeFromHex(BOARDING_COORD).position),
    ])
    expect(chainTemplateProblem(t, RIDE_9C5D55CD.pubkey)).toBeNull()
    // The published ride that follows this boarding departs from exactly this coordinate (DECK-0001 5.2).
    expect(tagValue(t, 'C')).toBe(tagValue(RIDE_9C5D55CD, 'c'))
  })

  it('keeps the plane bit: a boarding in ideaspace names the ideaspace coordinate in c, C and nowhere else (ONOSENDAI\'s boardPlane regression)', () => {
    const idea = positionHex(home.position, 1)
    const data = positionHex(home.position, 0)
    expect(idea).not.toBe(data)
    const t = enterHyperspaceTemplate({ ...links, coordHex: idea })
    expect(tagValue(t, 'c')).toBe(idea)
    expect(tagValue(t, 'C')).toBe(idea)
    expect(placeFromHex(tagValue(t, 'C')!).plane).toBe(1)
    // The sector tags do not see the plane, so both planes share them; the plane lives in C alone.
    expect(t.tags.slice(-4)).toEqual(sectorTags(home.position))
  })

  it('chained after a spawn, the reader sees a boarding that stands where the spawn did', () => {
    const spawn = signEvent(spawnTemplate(pubkey, 1_700_000_000), sk)
    const t = enterHyperspaceTemplate({ createdAt: 1_700_000_001, genesisId: spawn.id, previousId: spawn.id, coordHex: pubkey, proofHash: 'c'.repeat(64) })
    expect(chainTemplateProblem(t, pubkey)).toBeNull()
    const board = signEvent(t, sk)
    expect(parseAction(board)?.type).toBe('enter-hyperspace')
    const chain = buildChain([spawn, board], pubkey)
    expect(chainStatus(chain)).toBe('valid')
    expect(chain[1].type).toBe('enter-hyperspace')
    expect(chain[1].coordHex).toBe(pubkey)
    expect(chain[1].position).toEqual(home.position)
  })

  it('the self-check names a boarding whose C is not its c, which the reader would refuse', () => {
    const t = enterHyperspaceTemplate({ ...links, coordHex: pubkey })
    const moved = withTag(t, 'C', STOP_29898)
    expect(chainTemplateProblem(moved, pubkey)).toMatch(/^a boarding's C must equal its c/)
    // The same event as the reader sees it: not a boarding at all.
    expect(parseAction(signEvent(moved, sk))).toBeNull()
  })

  it('refuses inputs that are not 32-byte hex before building anything', () => {
    expect(() => enterHyperspaceTemplate({ ...links, coordHex: 'not hex' })).toThrow(/coordinate it starts from/)
    expect(() => enterHyperspaceTemplate({ ...links, coordHex: pubkey, proofHash: 'ab' })).toThrow(/entry proof hash/)
    expect(() => enterHyperspaceTemplate({ ...links, genesisId: 'ab', coordHex: pubkey })).toThrow(/genesis/)
  })
})

describe('the ride template (DECK-0001 5.2) writes the published rides back', () => {
  /** A nonce of the form every new ride carries; its value is the ride runner's business (DECK-0001 5.5). */
  const MN = '0123456789abcdef'

  it('the four published rides on disk are authentic hyperjumps, and none carries mn (DECK-0001 5.8)', () => {
    expect(PUBLISHED_RIDES.map((r) => r.id.slice(0, 8))).toEqual(['9c5d55cd', '43628b38', '5222e768', '6c98e331'])
    for (const ride of PUBLISHED_RIDES) {
      expect(isAuthentic(ride), ride.id).toBe(true)
      expect(parseAction(ride)?.type, ride.id).toBe('hyperjump')
      expect(ride.tags.some((t) => t[0] === 'mn'), ride.id).toBe(false)
    }
  })

  for (const ride of PUBLISHED_RIDES) {
    it(`${ride.id.slice(0, 8)}: handed the ride's own tags, the template writes every tag back in order, and adds the mn a new ride must carry`, () => {
      const t = hyperjumpTemplate(inputsOf(ride, MN))
      expect(t.kind).toBe(ride.kind)
      expect(t.created_at).toBe(ride.created_at)
      expect(t.content).toBe(ride.content)
      // A new ride: the published tags, with mn between mp and the sector tags, where ONOSENDAI puts it.
      expect(t.tags.filter((x) => x[0] !== 'mn')).toEqual(ride.tags)
      expect(t.tags.filter((x) => x[0] === 'mn')).toEqual([['mn', MN]])
      const at = t.tags.findIndex((x) => x[0] === 'mn')
      expect(t.tags[at - 1][0]).toBe('mp')
      expect(t.tags[at + 1][0]).toBe('X')
      expect(chainTemplateProblem(t, ride.pubkey)).toBeNull()
      // The grandfathered ride itself: the reader admits it (the 5.8 list), the builder never writes one like it.
      expect(chainTemplateProblem(asTemplate(ride), ride.pubkey)).toBe('mn appears 0 times; every tag the chain rules read appears exactly once')
    })
  }

  it('carries the re-roll nonce after the openings and before the sector (ONOSENDAI events.test.ts)', () => {
    const hj = hyperjumpTemplate({
      createdAt: 1, genesisId: ZERO_ID, previousId: ZERO_ID, prevCoordHex: ZERO_ID, toCoordHex: STOP_29898,
      fromHeight: 100, toHeight: 398, asOf: 400, rootHex: '11'.repeat(32), mp: 'ab', mnHex: '000000000000002a',
    })
    expect(hj.tags.map((t) => t[0])).toEqual(['A', 'e', 'e', 'c', 'C', 'from_height', 'B', 'as_of', 'proof', 'mp', 'mn', 'X', 'Y', 'Z', 'S'])
    expect(tagValue(hj, 'mn')).toBe('000000000000002a')
    expect(parseAction(signEvent(hj, generateSecretKey()))?.mn).toBe('000000000000002a')
  })

  it('a later ride, with no station bound to declare, simply has no as_of tag', () => {
    const hj = hyperjumpTemplate({ createdAt: 1, genesisId: ZERO_ID, previousId: ZERO_ID, prevCoordHex: ZERO_ID, toCoordHex: STOP_29898, fromHeight: 398, toHeight: 100, rootHex: '11'.repeat(32), mp: 'ab', mnHex: MN })
    expect(hj.tags.map((t) => t[0])).toEqual(['A', 'e', 'e', 'c', 'C', 'from_height', 'B', 'proof', 'mp', 'mn', 'X', 'Y', 'Z', 'S'])
    expect(chainTemplateProblem(hj, ZERO_ID)).toBeNull()
  })

  it('refuses a zero-length ride before building it (arkinox, 2026-10-07; DECK-0001 5.6)', () => {
    const input = inputsOf(RIDE_9C5D55CD, MN)
    expect(() => hyperjumpTemplate({ ...input, fromHeight: 5, toHeight: 5 })).toThrow(/zero-length/)
    expect(() => hyperjumpTemplate({ ...input, fromHeight: 5, toHeight: 6 })).not.toThrow()
  })

  it('refuses a malformed nonce, root, stop coordinate or link before building anything', () => {
    const input = inputsOf(RIDE_9C5D55CD, MN)
    expect(() => hyperjumpTemplate({ ...input, mnHex: '2a' })).toThrow(/re-roll nonce as 16 lowercase hex/)
    expect(() => hyperjumpTemplate({ ...input, mnHex: '0123456789ABCDEF' })).toThrow(/re-roll nonce as 16 lowercase hex/)
    expect(() => hyperjumpTemplate({ ...input, rootHex: 'ab' })).toThrow(/Merkle root/)
    expect(() => hyperjumpTemplate({ ...input, toCoordHex: 'ab' })).toThrow(/stop it goes to/)
    expect(() => hyperjumpTemplate({ ...input, prevCoordHex: 'ab' })).toThrow(/coordinate it starts from/)
    expect(() => hyperjumpTemplate({ ...input, previousId: 'ab' })).toThrow(/previous/)
  })
})

describe('the self-check names each way a ride is malformed, before it is signed', () => {
  const good = hyperjumpTemplate(inputsOf(RIDE_9C5D55CD, '0123456789abcdef'))
  const who = RIDE_9C5D55CD.pubkey

  it('the published ride with mn added passes; the actions the reader knows but this server never signs are still refused', () => {
    expect(chainTemplateProblem(good, who)).toBeNull()
    expect(chainTemplateProblem(withTag(good, 'A', 'enter-virtual'), who)).toMatch(/is not one this server builds/)
    expect(chainTemplateProblem(withTag(good, 'A', 'exit-virtual'), who)).toMatch(/is not one this server builds/)
  })

  it('from_height and B must be block heights in base 10', () => {
    expect(chainTemplateProblem(withTag(good, 'from_height', '36527.5'), who)).toBe('from_height is not a block height in base 10')
    expect(chainTemplateProblem(withTag(good, 'from_height', '-1'), who)).toBe('from_height is not a block height in base 10')
    expect(chainTemplateProblem(withTag(good, 'B', '0x74ca'), who)).toBe('B is not a block height in base 10')
    expect(chainTemplateProblem(withTag(good, 'B', ''), who)).toBe('B has no value')
    expect(chainTemplateProblem({ ...good, tags: good.tags.filter((x) => x[0] !== 'from_height') }, who)).toBe('from_height appears 0 times; every tag the chain rules read appears exactly once')
  })

  it('as_of, when carried, is one block height in base 10, not below the block ridden to (DECK-0001 4.2, 5.2)', () => {
    expect(chainTemplateProblem(withTag(good, 'as_of', 'tip'), who)).toBe('as_of is not a block height in base 10')
    expect(chainTemplateProblem(withTag(good, 'as_of', ''), who)).toBe('as_of is not a block height in base 10')
    expect(chainTemplateProblem({ ...good, tags: [...good.tags, ['as_of', '966225']] }, who)).toBe('as_of appears 2 times; a first ride names its station bound exactly once')
    // The ride goes to block 29898: a bound of 29897 could not have found that stop; a bound of 29898 could.
    expect(chainTemplateProblem(withTag(good, 'as_of', '29897'), who)).toBe('as_of (29897) is below the block the ride goes to (29898); the station bound covers the destination')
    expect(chainTemplateProblem(withTag(good, 'as_of', '29898'), who)).toBeNull()
  })

  it('a ride that goes nowhere is named, even hand-built around the template\'s refusal', () => {
    expect(chainTemplateProblem(withTag(good, 'B', '36527'), who)).toBe('a zero-length ride: from_height and B are both block 36527; a ride always goes to a different block')
    expect(chainTemplateProblem(withTag(good, 'B', '036527'), who)).toMatch(/^a zero-length ride/)
  })

  it('mp must carry the openings and mn must be the 16-hex nonce, exactly once', () => {
    expect(chainTemplateProblem(withTag(good, 'mp', ''), who)).toBe('mp has no value')
    expect(chainTemplateProblem(withTag(good, 'mn', '2a'), who)).toBe('mn is not a re-roll nonce of 16 lowercase hex characters')
    expect(chainTemplateProblem(withTag(good, 'mn', '0123456789ABCDEF'), who)).toBe('mn is not a re-roll nonce of 16 lowercase hex characters')
    expect(chainTemplateProblem({ ...good, tags: [...good.tags, ['mn', '0123456789abcdef']] }, who)).toBe('mn appears 2 times; every tag the chain rules read appears exactly once')
  })

  it('the sector tags must be those of the stop the ride arrives at, not the one it leaves', () => {
    const departure = sectorTags(placeFromHex(BOARDING_COORD).position)
    const arrival = sectorTags(placeFromHex(STOP_29898).position)
    expect(departure).not.toEqual(arrival)
    const wrong = { ...good, tags: [...good.tags.slice(0, -4), ...departure] }
    expect(chainTemplateProblem(wrong, who)).toMatch(/^X says \d+ where C is in \d+$/)
  })
})

describe('templates and reader agree on a boarded chain', () => {
  const sk = generateSecretKey()
  const pubkey = getPublicKey(sk)
  const spawn = signEvent(spawnTemplate(pubkey, 1_700_000_000), sk)
  const board = signEvent(enterHyperspaceTemplate({ createdAt: 1_700_000_001, genesisId: spawn.id, previousId: spawn.id, coordHex: pubkey, proofHash: 'c'.repeat(64) }), sk)
  const ride = (previousId: string, prevCoordHex: string, fromHeight: number, toHeight: number, asOf?: number): NostrEvent => {
    const t = hyperjumpTemplate({ createdAt: 1_700_000_002, genesisId: spawn.id, previousId, prevCoordHex, toCoordHex: STOP_29898, fromHeight, toHeight, ...(asOf !== undefined ? { asOf } : {}), rootHex: 'd'.repeat(64), mp: 'ab', mnHex: '0123456789abcdef' })
    expect(chainTemplateProblem(t, pubkey)).toBeNull()
    return signEvent(t, sk)
  }

  it('spawn, boarding, first ride with its as_of: valid, and the identity stands at the stop', () => {
    const first = ride(board.id, pubkey, 36527, 29898, 966225)
    const chain = buildChain([spawn, board, first], pubkey)
    expect(chainStatus(chain)).toBe('valid')
    expect(chain.map((a) => a.type)).toEqual(['spawn', 'enter-hyperspace', 'hyperjump'])
    expect(chain[2].coordHex).toBe(STOP_29898)
    expect(chain[2].asOf).toBe(966225)
    expect(chain[2].mn).toBe('0123456789abcdef')
  })

  it('a first ride without as_of is well formed to the builder, and the reader breaks the chain there: the station bound is the ride runner\'s to supply', () => {
    const first = ride(board.id, pubkey, 36527, 29898)
    const chain = buildChain([spawn, board, first], pubkey)
    expect(chainStatus(chain)).toBe('frozen')
    expect(firstBreak(chain)?.index).toBe(2)
    expect(chain[2].breaks).toMatch(/no as_of tag/)
  })

  it('a ride straight after a spawn is well formed to the builder, and the reader breaks the chain there: only the agent knows whether it boarded', () => {
    const stray = ride(spawn.id, pubkey, 36527, 29898, 966225)
    const chain = buildChain([spawn, stray], pubkey)
    expect(chainStatus(chain)).toBe('frozen')
    expect(chain[1].breaks).toMatch(/does not follow a boarding or another ride/)
  })
})
