// Generates test/fixtures/onosendai-constrain.json for cyberspace-mcp with
// ONOSENDAI's own code (origin/v2 88da640, after #461 "walk constrain" and
// #476 "OPAQUE default": src/lib/hidden.ts, published.ts, walkConstrain.ts),
// so the WALK setting (DECK-0003 1.12) this server writes is ONOSENDAI's to
// the byte, and where:
//
//   - what ONOSENDAI hides and publishes for a shard whose payload chose a
//     word, chose none, or carries a malformed one: an inline item's content,
//     a sealed object's plaintext, a public object's content;
//   - what its EDIT writes for a placed shard hidden before the default
//     (deploy: toPayload(withConstrain(model, deployConstrain))), for each
//     word, with an opacity, and for a move that leaves the setting alone
//     (deployConstrain seeded from authoredConstrainOf).
//
// Run from an ONOSENDAI checkout of that commit (so ./src/lib resolves to
// ONOSENDAI and sno-core is its 0.1.19), with this repository's tsx:
//   cp scripts/gen-onosendai-constrain-fixture.ts <onosendai>/gen.ts
//   (cd <onosendai> && <mcp>/node_modules/.bin/tsx gen.ts <mcp> <mcp>/test/fixtures/onosendai-constrain.json)
import { readFileSync, writeFileSync } from 'node:fs'
import { fromPayload, toPayload, type ShardModel } from 'sno-core/shards'
import * as ono from './src/lib/hidden'
import * as published from './src/lib/published'
import { decryptForRegion } from './src/lib/shardCrypto'
import { authoredConstrainOf, withConstrain, type Constrain } from './src/lib/walkConstrain'

const MCP = process.argv[2]
const OUT = process.argv[3]
const T = 1_792_600_000
const at = { x: 1n << 40n, y: 1n << 40n, z: (1n << 40n) + 100n }
const plane = 0 as const
const keyHex = '11'.repeat(32)
const key = Uint8Array.from(Buffer.from(keyHex, 'hex'))

const stella = JSON.parse(readFileSync(`${MCP}/test/fixtures/xor-stella-octangula.json`, 'utf8')) as Record<string, unknown>
// The payloads an author might give: no field, each word, a malformed one, and an opacity.
const payloads: Record<string, Record<string, unknown>> = {
  none: stella,
  all: { ...stella, constrain: 'all' },
  off: { ...stella, constrain: 'off' },
  opaque: { ...stella, constrain: 'opaque' },
  malformed: { ...stella, constrain: 'ALL' },
  faint: { ...stella, opacity: 40 },
}
const model = (p: Record<string, unknown>, id = 'x'.repeat(64)): ShardModel => fromPayload(p, id)!

const written: Record<string, { inline: string; sealed: string; public: string }> = {}
for (const [name, p] of Object.entries(payloads)) {
  const s = model(p)
  const sealed = await ono.objectTemplate(s, key, 'd'.repeat(32), T)
  const enc = sealed.tags.find((t) => t[0] === 'encrypted')!
  written[name] = {
    inline: ono.shardInnerTemplate(s, at, plane, T).content,
    sealed: (await decryptForRegion(key, enc[2]))!,
    public: published.publicObjectTemplate({ ...s, id: 'fixed-d' }, T).content,
  }
}

// A shard hidden before the default: its payload as ONOSENDAI wrote it then (no field).
const before = JSON.stringify(toPayload(model(stella)))
const beforeFaint = JSON.stringify(toPayload(model({ ...stella, opacity: 40, constrain: 'all' })))
const edit = (content: string, c: Constrain | 'seeded', patch: Partial<ShardModel> = {}): string => {
  const m = { ...model(JSON.parse(content)), ...patch }
  return JSON.stringify(toPayload(withConstrain(m, c === 'seeded' ? authoredConstrainOf(m) : c)))
}
const edited = {
  before,
  all: edit(before, 'all'),
  off: edit(before, 'off'),
  opaque: edit(before, 'opaque'),
  moved: edit(before, 'seeded'),
  faint: edit(before, 'all', { opacity: 40 }),
  beforeFaint,
  faintToOpaque: edit(beforeFaint, 'opaque', { opacity: undefined }),
  faintMoved: edit(beforeFaint, 'seeded'),
}

writeFileSync(OUT, JSON.stringify({ onosendai: '88da640', T, keyHex, payloads, written, edited }, null, 2) + '\n')
console.log(`wrote ${OUT}`)
