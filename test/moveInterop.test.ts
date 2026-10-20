// moveInterop.test.ts: moves and removals as ONOSENDAI reads them.
// fixtures/onosendai-moves.json was made with ONOSENDAI's own code (origin/v2
// d4f386a, src/lib/hidden.ts, run outside this repository): its
// editedTemplate and itemLineage for fixed inputs, and what its unbag read
// from bags this server wrote while hiding, moving (inside a bag, across a
// cube edge, a shard by reference resealed to the new region) and removing.
// This server's editedTemplate must be ONOSENDAI's tag for tag, and its own
// reader must make of those bags exactly what ONOSENDAI made of them.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { editedTemplate, itemLineage, unbag, type Reference } from '../src/hidden/bags.js'
import { hexToBytes, type EventTemplate, type NostrEvent } from '../src/nostr/event.js'

interface Fixture {
  edited: Array<{ name: string; previous: { id: string; kind: number; tags: string[][] }; next: EventTemplate; onosendai: EventTemplate; lineage: string | null }>
  mcp: { agent: string; regions: Record<string, { keyHex: string; height: number }>; events: NostrEvent[] }
  onosendaiRead: { bags: Array<{ lookupId: string; height: number; items: Array<{ type: string; lineage: string | null; at: { x: string; y: string; z: string }; plane: number; label: string; byReference: boolean; dTag: string | null }> }>; deletions: string[][][] }
}

const fx = JSON.parse(readFileSync(new URL('./fixtures/onosendai-moves.json', import.meta.url), 'utf8')) as Fixture

describe('moves, against ONOSENDAI (d4f386a)', () => {
  it('editedTemplate and itemLineage are ONOSENDAI\'s, tag for tag', () => {
    for (const c of fx.edited) {
      expect(editedTemplate(c.next, c.previous), c.name).toEqual(c.onosendai)
      expect(itemLineage(c.previous), c.name).toBe(c.lineage)
    }
  })

  it('reads the bags this server wrote while moving and removing exactly as ONOSENDAI read them', async () => {
    const objects = new Map(fx.mcp.events.filter((e) => e.kind === 33331).map((e) => [`33331:${e.pubkey}:${e.tags.find((t) => t[0] === 'd')![1]}`, e]))
    const resolve = async (ref: Reference): Promise<NostrEvent | null> => objects.get(ref[1]) ?? null
    const bags = fx.mcp.events.filter((e) => e.kind === 33330)
    expect(bags.length).toBe(fx.onosendaiRead.bags.length)
    for (const want of fx.onosendaiRead.bags) {
      const bag = bags.find((b) => b.tags.some((t) => t[0] === 'd' && t[1] === want.lookupId))!
      const items = await unbag(bag, hexToBytes(fx.mcp.regions[want.lookupId].keyHex), resolve, undefined, want.height)
      expect(items.map((h) => ({
        type: h.type, lineage: h.ref ? null : itemLineage(h.inner), at: { x: String(h.at.x), y: String(h.at.y), z: String(h.at.z) }, plane: h.plane,
        label: h.text ?? h.shard?.name ?? h.key?.name ?? h.chest?.name, byReference: !!h.ref, dTag: h.inner.tags.find((t) => t[0] === 'd')?.[1] ?? null,
      }))).toEqual(want.items.map(({ type, lineage, at, plane, label, byReference, dTag }) => ({ type, lineage, at, plane, label, byReference, dTag })))
    }
    // The moved things carry the lineage d ONOSENDAI names them by; the ones never moved carry none.
    const all = fx.onosendaiRead.bags.flatMap((b) => b.items)
    expect(all.filter((i) => !i.byReference && i.dTag !== null).map((i) => i.label).sort()).toEqual(['Box', 'Brass Key', 'crossing note', 'tetra'])
    // The emptied bag went as ONOSENDAI deletes one: its address, its id, its kind.
    expect(fx.onosendaiRead.deletions).toHaveLength(1)
    expect(fx.onosendaiRead.deletions[0].slice(0, 3).map((t) => t[0])).toEqual(['a', 'e', 'k'])
    expect(fx.onosendaiRead.deletions[0][0][1].startsWith(`33330:${fx.mcp.agent}:`)).toBe(true)
  })
})
