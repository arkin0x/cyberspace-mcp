// builder.test.ts: the only module that writes kind 3333 writes it right.
// The hop proof matches the spec's worked example (section 5.7), every
// tag the chain rules read appears exactly once, the sector tags agree with
// C, a spawn's C is its pubkey, and the resolver reads the events back as
// a valid chain, a frozen one, and a dead one.

import { describe, expect, it } from 'vitest'
import { computeHopProof, computeMovementProof, deriveRegionKeys, AXIS_CENTER } from 'cyberspace-core'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { ACTION_KIND, chainTemplateProblem, hopTemplate, sidestepTemplate, spawnTemplate } from '../src/chain/builder.js'
import { buildChain, chainStatus, firstBreak, parseAction } from '../src/chain/events.js'
import { signEvent } from '../src/nostr/event.js'
import { placeFromHex, sectorTags } from '../src/space/coords.js'

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

  it('builds a hop with every read tag exactly once and the sector tags of its C', () => {
    const spawn = signEvent(spawnTemplate(pubkey, 1_700_000_000), sk)
    const to = { x: home.position.x + 3n, y: home.position.y, z: home.position.z }
    const proof = computeHopProof(home.position.x, home.position.y, home.position.z, to.x, to.y, to.z, home.plane, spawn.id)
    const t = hopTemplate({ createdAt: 1_700_000_001, genesisId: spawn.id, previousId: spawn.id, prevCoordHex: pubkey, to, plane: home.plane, proofHash: proof.proofHash })
    expect(chainTemplateProblem(t, pubkey)).toBeNull()
    for (const name of ['A', 'c', 'C', 'proof', 'X', 'Y', 'Z', 'S']) expect(t.tags.filter((x) => x[0] === name)).toHaveLength(1)
    expect(t.tags.filter((x) => x[0] === 'e' && x[3] === 'genesis')).toHaveLength(1)
    expect(t.tags.filter((x) => x[0] === 'e' && x[3] === 'previous')).toHaveLength(1)
    const hop = signEvent(t, sk)
    const chain = buildChain([spawn, hop], pubkey)
    expect(chain).toHaveLength(2)
    expect(chainStatus(chain)).toBe('valid')
    expect(chain[1].position).toEqual(to)
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
  })
})

describe('the resolver (spec 8.7.3)', () => {
  const sk = generateSecretKey()
  const pubkey = getPublicKey(sk)
  const home = placeFromHex(pubkey)
  const spawn = signEvent(spawnTemplate(pubkey, 1_700_000_000), sk)
  const step = (previousId: string, prevCoordHex: string, dx: bigint, createdAt: number) => {
    const to = { x: home.position.x + dx, y: home.position.y, z: home.position.z }
    return signEvent(hopTemplate({ createdAt, genesisId: spawn.id, previousId, prevCoordHex, to, plane: home.plane, proofHash: 'ab'.repeat(32) }), sk)
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
