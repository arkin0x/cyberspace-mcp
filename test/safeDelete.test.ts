// safeDelete.test.ts: builds, notes, the trash, scoped deletes, the delete
// preview with the operator's approval, and restore (arkinox, 2026-11-26,
// after "delete the aerocarnival course" took a 31-piece castle that shared
// an h9 bag with it, with no backup and no warning). Over the MCP client,
// against fake relays only, with throwaway keys: delete_build of one build
// rewrites a shared bag and keeps the other build's pieces; the trash holds
// what went (signed bags, opened pieces) and never a key; remove_placed of a
// whole mixed bag is refused; a preview changes nothing; a large delete
// waits for the operator's code by DM, refused by "no CODE", approved once,
// and void once the set of pieces changes; restore places the pieces again;
// the ledger follows place, move, constrain and delete.

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Agent } from '../src/agent.js'
import { DeleteApprovals, deleteRequestWords, readAnswer, withoutCodes } from '../src/approvals.js'
import { parseArgs, settingsFrom } from '../src/config.js'
import { HIDDEN_KIND } from '../src/hidden/bags.js'
import { regionKeyAt } from '../src/hidden/crypto.js'
import { wrapMessage } from '../src/nostr/dm.js'
import { bytesToHex, nowSeconds, type NostrEvent } from '../src/nostr/event.js'
import { openEntries } from '../src/placed.js'
import { createServer } from '../src/server.js'
import type { Calibration } from '../src/space/calibration.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork, type FakeRelay } from './fakeRelay.js'
import { dmsTo, settle, until } from './hosakaWorld.js'

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'
const GENERAL = 'wss://general.example'
const INBOX = 'wss://inbox.example/'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }

/** A point whose low bits leave room: everything within +100 on z stays in its h8 cube. */
const BASE = (1n << 40n) + 100n
const P = { x: BASE.toString(), y: BASE.toString(), z: BASE.toString(), plane: 0 }
const shard = (name: string, color = 1) => ({ v: 2, name, unit: 20, mode: 'solid', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], colors: [color, 2, 3, 4], faces: [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]] })
const at = (dz: number) => ({ coordinate: { ...P, z: (BASE + BigInt(dz)).toString() } })
const H8 = regionKeyAt({ x: BASE, y: BASE, z: BASE }, 8, 20)

type Call = (name: string, args?: Record<string, unknown>) => Promise<{ text: string; data: Record<string, unknown>; isError: boolean; raw: string }>

const agents: Agent[] = []
const clients: Client[] = []
afterAll(async () => { for (const c of clients) await c.close(); for (const a of agents) await a.stop() })

function stateWithKey(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-safedelete-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(generateSecretKey()), createdAt: 'test' }), { mode: 0o600 })
  return dir
}

async function connect(network: FakeNetwork, dir: string, extra: Partial<Parameters<typeof Agent.start>[0]> = {}): Promise<{ a: Agent; call: Call }> {
  const a = await Agent.start({
    stateDir: dir, relays: [CANONICAL, MINE], capCallSeconds: 30, capSessionSeconds: 120, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1200, ordersPollMs: 0, ...extra,
  })
  agents.push(a)
  const server = createServer(a)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientSide)
  clients.push(client)
  const call: Call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    return { text: (r.content as Array<{ text: string }>).map((c) => c.text ?? '').join('\n'), data: (r.structuredContent ?? {}) as Record<string, unknown>, isError: !!r.isError, raw: JSON.stringify(r) }
  }
  return { a, call }
}

/** The agent's h8 bag as the canonical relay holds it now, opened: each entry's shard name or message text. */
async function bagNames(relay: FakeRelay, pubkey: string): Promise<string[] | null> {
  const bag = relay.all().find((e) => e.kind === HIDDEN_KIND && e.pubkey === pubkey && e.tags.some((t) => t[0] === 'd' && t[1] === H8.lookupId))
  if (!bag) return null
  const entries = (await openEntries(bag, H8.key)) ?? []
  return entries.map((e) => {
    const ev = e as NostrEvent
    if (ev.kind === 3340) return `key:${ev.tags.find((t) => t[0] === 'title')?.[1] ?? '?'}`
    try { return String((JSON.parse(ev.content) as { name?: string }).name ?? ev.content) } catch { return ev.content }
  }).sort()
}

/** Every 64-hex secret the state directory holds outside the trash: region keys, item secrets, the agent's own key. */
function secretsIn(dir: string): string[] {
  const out = new Set<string>()
  const walk = (path: string): void => {
    for (const name of readdirSync(path)) {
      if (name === 'trash') continue
      const p = join(path, name)
      if (statSync(p).isDirectory()) { walk(p); continue }
      const text = readFileSync(p, 'utf8')
      for (const m of text.matchAll(/"(?:keyHex|secretHex|secret)"\s*:\s*"([0-9a-f]{64})"/g)) out.add(m[1])
    }
  }
  walk(dir)
  return [...out]
}

function trashFiles(dir: string): Array<{ path: string; text: string }> {
  const root = join(dir, 'trash')
  return readdirSync(root).flatMap((e) => readdirSync(join(root, e)).map((f) => ({ path: join(root, e, f), text: readFileSync(join(root, e, f), 'utf8') })))
}

interface Row { id: string; label: string; type: string }
const rowsOf = (r: { data: Record<string, unknown> }): Row[] => (r.data.bags as Array<{ entries: Row[] }>).flatMap((b) => b.entries)

describe('builds, the trash, scoped deletes and restore (no operator)', () => {
  let network: FakeNetwork
  let canonical: FakeRelay
  let dir: string
  let a: Agent
  let call: Call
  beforeEach(async () => {
    network = new FakeNetwork()
    canonical = network.add(CANONICAL)
    network.add(MINE)
    dir = stateWithKey()
    ;({ a, call } = await connect(network, dir))
  })

  /** Two builds in one h8 bag: the course (two shards, a message, a key) and the castle (three shards). */
  async function mixedBag(): Promise<void> {
    for (const [i, n] of ['ramp', 'loop'].entries()) expect((await call('place', { object: shard(n), ...at(i), height: 8, build: 'Aerocarnival Course' })).isError).toBe(false)
    expect((await call('hide', { contents: { message: 'start line here' }, ...at(2), height: 8, build: 'aerocarnival course' })).isError).toBe(false)
    expect((await call('forge_item', { name: 'Course Key', ...at(3), height: 8, build: 'aerocarnival course' })).isError).toBe(false)
    expect((await call('build_use', { build: 'castle' })).data.created).toBe(true)
    for (const [i, n] of ['keep', 'tower', 'gate'].entries()) expect((await call('place', { object: shard(n), ...at(10 + i), height: 8 })).isError).toBe(false)
  }

  it('records each placement under its build (labels match case-insensitively), the current build, or "unlabelled"', async () => {
    await mixedBag()
    await call('build_use', {})
    await call('place', { object: shard('stray'), ...at(20), height: 8 })
    const list = await call('builds')
    const builds = list.data.builds as Array<{ label: string; pieces: number }>
    expect(builds.map((b) => [b.label, b.pieces])).toEqual([['Aerocarnival Course', 4], ['castle', 3], ['unlabelled', 1]])
    expect(list.data.current).toBeNull()
    // The label is local state only: nothing published names it.
    for (const e of canonical.published) expect(JSON.stringify(e)).not.toMatch(/aerocarnival|castle/i)
    const one = await call('build', { build: 'castle' })
    expect(one.isError).toBe(false)
    expect((one.data.pieces as Array<{ state: string; label: string }>).map((p) => [p.label, p.state])).toEqual([['keep', 'there'], ['tower', 'there'], ['gate', 'there']])
  })

  it('delete_build takes one build out of a shared bag and keeps the other; the trash holds what went, never a key', async () => {
    await mixedBag()
    expect(await bagNames(canonical, a.pubkey)).toEqual(['gate', 'keep', 'key:Course Key', 'loop', 'ramp', 'start line here', 'tower'])
    const before = canonical.published.length
    // The preview changes nothing.
    const preview = await call('delete_build', { build: 'aerocarnival course' })
    expect(preview.isError).toBe(false)
    expect(preview.data.preview).toBe(true)
    expect(preview.text).toContain('nothing was changed')
    expect(preview.text).toMatch(/goes: .*ramp.*loop/)
    expect(preview.text).toMatch(/stays: .*keep.*tower.*gate/)
    const bags = preview.data.bags as Array<{ deletesBag: boolean; removes: Row[]; keeps: Array<Row & { build: string }> }>
    expect(bags).toHaveLength(1)
    expect(bags[0].deletesBag).toBe(false)
    expect(bags[0].keeps.map((k) => k.build)).toEqual(['castle', 'castle', 'castle'])
    expect(preview.data.approvalNeeded).toBe(false)
    expect(canonical.published.length).toBe(before)

    const done = await call('delete_build', { build: 'aerocarnival course', confirm: true })
    expect(done.isError, done.text).toBe(false)
    expect(done.data.deleted).toBe(true)
    expect(await bagNames(canonical, a.pubkey)).toEqual(['gate', 'keep', 'tower'])
    // No deletion of the bag: it still holds the castle.
    expect(canonical.published.some((e) => e.kind === 5 && e.tags.some((t) => t[0] === 'a' && t[1].endsWith(H8.lookupId)))).toBe(false)

    // The trash: one entry, mode 700/600, every file there, the plaintext and the signed bag, no secret.
    const trashId = String(done.data.trashId)
    const entry = join(dir, 'trash', trashId)
    expect(statSync(join(dir, 'trash')).mode & 0o777).toBe(0o700)
    expect(statSync(entry).mode & 0o777).toBe(0o700)
    expect(readdirSync(entry).sort()).toEqual(['bags.json', 'ledger.json', 'meta.json', 'objects.json', 'pieces.json'])
    for (const f of readdirSync(entry)) expect(statSync(join(entry, f)).mode & 0o777).toBe(0o600)
    const pieces = JSON.parse(readFileSync(join(entry, 'pieces.json'), 'utf8')) as Array<{ type: string; label: string; payload?: { name: string; colors: number[] }; text?: string; key?: { name: string; itemPubkey: string }; build: string; height: number; at: { z: string } }>
    expect(pieces.map((p) => p.label).sort()).toEqual(['Course Key', 'loop', 'ramp', 'start line here'])
    expect(pieces.find((p) => p.label === 'ramp')!.payload).toMatchObject({ name: 'ramp', colors: [1, 2, 3, 4] })
    expect(pieces.find((p) => p.type === 'message')!.text).toBe('start line here')
    expect(pieces.find((p) => p.type === 'key')!.key).toMatchObject({ name: 'Course Key' })
    expect(pieces.every((p) => p.build === 'Aerocarnival Course' && p.height === 8)).toBe(true)
    const signedBags = JSON.parse(readFileSync(join(entry, 'bags.json'), 'utf8')) as NostrEvent[]
    expect(signedBags).toHaveLength(1)
    expect(signedBags[0]).toMatchObject({ kind: HIDDEN_KIND, pubkey: a.pubkey })
    expect(signedBags[0].sig).toMatch(/^[0-9a-f]{128}$/)
    expect((await openEntries(signedBags[0], H8.key))!.length).toBe(7)
    const meta = JSON.parse(readFileSync(join(entry, 'meta.json'), 'utf8')) as { tool: string; build: string; bags: Array<{ removed: string[]; kept: Array<{ label: string }> }> }
    expect(meta).toMatchObject({ tool: 'delete_build', build: 'Aerocarnival Course' })
    expect(meta.bags[0].removed).toHaveLength(4)
    expect(meta.bags[0].kept.map((k) => k.label)).toEqual(['keep', 'tower', 'gate'])
    const secrets = secretsIn(dir)
    expect(secrets.length).toBeGreaterThan(2) // the agent's key, the h8 region key, the forged item's secret
    for (const f of trashFiles(dir)) for (const sec of secrets) expect(f.text.includes(sec), `${f.path} holds a secret`).toBe(false)

    // The ledger: the course's pieces removed, pointing at the trash; the castle untouched.
    const course = a.builds.find('aerocarnival course')!
    expect(course.pieces.every((p) => p.removedAt && p.trashId === trashId)).toBe(true)
    expect(a.builds.find('castle')!.pieces.every((p) => !p.removedAt)).toBe(true)
    expect((await call('trash')).data.entries).toEqual([expect.objectContaining({ id: trashId, tool: 'delete_build', build: 'Aerocarnival Course' })])
  })

  it('remove_placed of a whole bag that holds two builds is refused, and nothing is published', async () => {
    await mixedBag()
    const before = canonical.published.length
    const r = await call('remove_placed', { target: 'keep', whole_bag: true })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/holds things of 2 builds: "Aerocarnival Course" \(4 thing\(s\)\), "castle" \(3 thing\(s\)\)/)
    expect(r.text).toContain('delete_build')
    const byBag = await call('remove_placed', { bag: H8.lookupId.slice(0, 12) })
    expect(byBag.isError).toBe(true)
    expect(canonical.published.length).toBe(before)
    expect(await bagNames(canonical, a.pubkey)).toHaveLength(7)
  })

  it('with no operator (deleteApproval "none"), a large delete needs no approval; placed names each thing\'s build', async () => {
    expect(a.deleteApprovals.mode).toBe('none')
    for (let i = 0; i < 7; i++) await call('place', { object: shard(`step ${i}`), ...at(i), height: 8, build: 'stairs' })
    const list = await call('placed')
    expect(list.text).toContain('build "stairs"')
    expect((list.data.bags as Array<{ entries: Array<{ build: string }> }>)[0].entries.every((e) => e.build === 'stairs')).toBe(true)
    const preview = await call('delete_build', { build: 'stairs' })
    expect(preview.data.approvalNeeded).toBe(false)
    expect(preview.data.needs).toEqual(['7 things would go, more than 5'])
    const done = await call('delete_build', { build: 'stairs', confirm: true })
    expect(done.data.deleted, done.text).toBe(true)
    // Nothing else was in the bag: it was deleted (NIP-09).
    expect(done.text).toContain('nothing else was in it, so it was deleted')
    expect(await bagNames(canonical, a.pubkey)).toBeNull()
  })

  /** Start again on the same state directory with no ledger: what was placed is "placed before builds were kept". */
  async function forgetLedger(): Promise<void> {
    await a.stop()
    agents.splice(agents.indexOf(a), 1)
    rmSync(join(dir, 'builds.json'), { force: true })
    ;({ a, call } = await connect(network, dir))
    expect(a.builds.all()).toEqual([])
  }

  it('build_add records pieces placed before the ledger, by id and by bag', async () => {
    for (const [i, n] of ['keep', 'tower', 'gate'].entries()) await call('place', { object: shard(n), ...at(i), height: 8 })
    await forgetLedger()
    const ids = rowsOf(await call('placed')).map((r) => r.id)
    const byId = await call('build_add', { build: 'Castle', pieces: [ids[0].slice(0, 12)] })
    expect(byId.isError, byId.text).toBe(false)
    expect(a.builds.find('castle')!.pieces.map((p) => p.label)).toEqual(['keep'])
    const byBag = await call('build_add', { build: 'castle', bag: H8.lookupId.slice(0, 12) })
    expect(byBag.isError, byBag.text).toBe(false)
    expect((byBag.data.added as unknown[]).length).toBe(2)
    expect(byBag.data.already).toEqual([ids[0]])
    expect(a.builds.find('castle')!.pieces.map((p) => p.label).sort()).toEqual(['gate', 'keep', 'tower'])
    expect((await call('build', { build: 'castle' })).data.pieces).toEqual(ids.map(() => expect.objectContaining({ state: 'there' })))
    // Local state only: nothing was published by it.
    const before = canonical.published.length
    await call('build_add', { build: 'castle', match: 'gate' })
    expect(canonical.published.length).toBe(before)
  })

  it('build_add refuses a piece of another build unless move; a whole-bag remove of a bag mixing two builds is then refused', async () => {
    for (const [i, n] of ['ramp', 'loop', 'keep', 'tower', 'gate'].entries()) await call('place', { object: shard(n), ...at(i), height: 8 })
    await forgetLedger()
    const rows = rowsOf(await call('placed'))
    const id = (label: string): string => rows.find((r) => r.label === label)!.id
    expect((await call('build_add', { build: 'aerocarnival course', pieces: [id('ramp'), id('loop')] })).isError).toBe(false)
    // The whole bag now holds the course and pieces in no build: refused before castle is even named.
    expect((await call('remove_placed', { target: 'keep', whole_bag: true })).text).toMatch(/holds things of 2 builds: "aerocarnival course" \(2 thing\(s\)\), "unlabelled" \(3 thing\(s\)\)/)
    const refused = await call('build_add', { build: 'castle', bag: H8.lookupId.slice(0, 12) })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/2 of them already belong to another build: .*"ramp".*in "aerocarnival course"/)
    expect(a.builds.find('castle')).toBeNull()
    expect((await call('build_add', { build: 'castle', match: 'e' })).isError).toBe(false) // keep, tower, gate
    const moved = await call('build_add', { build: 'castle', pieces: [id('loop')], move: true })
    expect(moved.isError, moved.text).toBe(false)
    expect(moved.data.moved).toEqual([expect.objectContaining({ label: 'loop', from: 'aerocarnival course' })])
    expect(a.builds.find('aerocarnival course')!.pieces.map((p) => p.label)).toEqual(['ramp'])
    const before = canonical.published.length
    const whole = await call('remove_placed', { target: 'keep', whole_bag: true })
    expect(whole.isError).toBe(true)
    expect(whole.text).toMatch(/holds things of 2 builds: "aerocarnival course" \(1 thing\(s\)\), "castle" \(4 thing\(s\)\)/)
    expect(canonical.published.length).toBe(before)
    // And the scoped delete takes only the course out.
    expect((await call('delete_build', { build: 'aerocarnival course', confirm: true })).data.deleted).toBe(true)
    expect(await bagNames(canonical, a.pubkey)).toEqual(['gate', 'keep', 'loop', 'tower'])
  })

  it('a delete whose backup cannot be written does not run', async () => {
    await mixedBag()
    // A file where the trash directory should be: the backup cannot be made.
    writeFileSync(join(dir, 'trash'), 'in the way')
    const before = canonical.published.length
    const r = await call('delete_build', { build: 'castle', confirm: true })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('The backup could not be written to the trash')
    expect((await call('remove_placed', { target: 'tower' })).text).toContain('The backup could not be written')
    expect(canonical.published.length).toBe(before)
    expect(await bagNames(canonical, a.pubkey)).toHaveLength(7)
    expect(a.builds.find('castle')!.pieces.every((p) => !p.removedAt)).toBe(true)
  })

  it('remove_placed of one thing writes its backup first, and the ledger marks it removed', async () => {
    await mixedBag()
    const r = await call('remove_placed', { target: 'tower' })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('A backup is in the trash')
    const trashId = String(r.data.trashId)
    const pieces = JSON.parse(readFileSync(join(dir, 'trash', trashId, 'pieces.json'), 'utf8')) as Array<{ label: string }>
    expect(pieces.map((p) => p.label)).toEqual(['tower'])
    expect(a.builds.find('castle')!.pieces.find((p) => p.label === 'tower')).toMatchObject({ trashId })
  })

  it('restore_build places the pieces again (same payloads, new ids) in their build, and keeps the entry marked restored', async () => {
    await mixedBag()
    const oldIds = rowsOf(await call('placed')).filter((r) => ['ramp', 'loop', 'start line here'].includes(r.label)).map((r) => r.id)
    const done = await call('delete_build', { build: 'aerocarnival course', confirm: true })
    const trashId = String(done.data.trashId)
    // A second on: an item signed again in the same second as the first, with the same payload, would have the same id.
    await new Promise((r) => setTimeout(r, 1100))
    const r = await call('restore_build', { trash: trashId })
    expect(r.isError, r.text).toBe(false)
    expect((r.data.restored as unknown[]).length).toBe(3)
    expect(r.text).toMatch(/Not restored: key "Course Key": a key is a keypair/)
    // Merged into the bag that holds the castle.
    expect(await bagNames(canonical, a.pubkey)).toEqual(['gate', 'keep', 'loop', 'ramp', 'start line here', 'tower'])
    // The same payload: the restored ramp's vertices, colors and faces are the ones placed.
    const bag = canonical.all().find((e) => e.kind === HIDDEN_KIND && e.pubkey === a.pubkey && e.tags.some((t) => t[0] === 'd' && t[1] === H8.lookupId))!
    const ramp = ((await openEntries(bag, H8.key)) as NostrEvent[]).map((e) => { try { return JSON.parse(e.content) as Record<string, unknown> } catch { return {} } }).find((p) => p.name === 'ramp')
    const { name: _n, ...geometry } = shard('ramp')
    expect(ramp).toMatchObject(geometry)
    const now = rowsOf(await call('placed'))
    for (const label of ['ramp', 'loop', 'start line here']) expect(oldIds).not.toContain(now.find((x) => x.label === label)!.id)
    const course = a.builds.find('aerocarnival course')!
    expect(course.pieces.filter((p) => !p.removedAt).map((p) => p.label).sort()).toEqual(['loop', 'ramp', 'start line here'])
    const meta = JSON.parse(readFileSync(join(dir, 'trash', trashId, 'meta.json'), 'utf8')) as { restoredAt?: string }
    expect(meta.restoredAt).toBeTruthy()
    expect((await call('restore_build', { trash: trashId })).text).toContain('already restored')
  })

  it('the ledger follows a move and a constrain, and rename and notes work', async () => {
    const placed = await call('place', { object: shard('arch'), ...at(0), height: 8, build: 'bridge' })
    const first = String(placed.data.id)
    expect(a.builds.find('bridge')!.pieces[0]).toMatchObject({ id: first, lineage: first, label: 'arch', type: 'shard', height: 8 })
    const moved = await call('move_placed', { target: first, by: { dz: 5 } })
    expect(moved.isError, moved.text).toBe(false)
    const movedId = String((moved.data.moved as { id: string }).id)
    expect(a.builds.find('bridge')!.pieces[0]).toMatchObject({ id: movedId, lineage: first, at: { z: (BASE + 5n).toString() } })
    const c = await call('constrain_placed', { target: movedId, constrain: 'all' })
    expect(c.isError, c.text).toBe(false)
    const constrainedId = String((c.data.changed as Array<{ id: string }>)[0].id)
    expect(constrainedId).not.toBe(movedId)
    expect(a.builds.find('bridge')!.pieces[0]).toMatchObject({ id: constrainedId, lineage: first })
    expect((await call('build', { build: 'bridge' })).data.pieces).toEqual([expect.objectContaining({ id: constrainedId, state: 'there' })])

    expect((await call('build_rename', { build: 'bridge', label: 'Rainbow Bridge' })).isError).toBe(false)
    expect(a.builds.find('rainbow bridge')!.pieces).toHaveLength(1)
    await call('place', { object: shard('other'), ...at(30), height: 8, build: 'tower' })
    expect((await call('build_rename', { build: 'rainbow bridge', label: 'TOWER' })).text).toContain('Another build is already called "tower"')
    await call('build_notes', { build: 'rainbow bridge', set: 'for the operator\'s birthday' })
    const notes = await call('build_notes', { build: 'Rainbow Bridge', append: 'south end at the stop' })
    expect(notes.data.notes).toBe('for the operator\'s birthday\nsouth end at the stop')
    expect(JSON.stringify(canonical.published)).not.toContain('birthday')
  })

  it('the notes file: read, append a line, replace, and the 64 KB cap', async () => {
    expect((await call('notes')).text).toContain('empty')
    await call('notes', { append: 'castle at the h9 stop, for the operator' })
    await call('notes', { append: 'course beside it' })
    expect((await call('notes')).data.notes).toBe('castle at the h9 stop, for the operator\ncourse beside it\n')
    expect(statSync(join(dir, 'notes.md')).mode & 0o777).toBe(0o600)
    const big = await call('notes', { replace: 'x'.repeat(64 * 1024 + 1) })
    expect(big.isError).toBe(true)
    expect(big.text).toContain('at most 65536')
    expect((await call('notes')).data.notes).toBe('castle at the h9 stop, for the operator\ncourse beside it\n')
    expect((await call('notes', { replace: 'one line' })).isError).toBe(false)
    expect((await call('notes')).data.notes).toBe('one line')
  })
})

describe('the deleteApproval setting', () => {
  const npub = nip19.npubEncode(getPublicKey(generateSecretKey()))
  it('is "operator" when an operator is set, else "none"; asked for explicitly; anything else refused', () => {
    expect(settingsFrom(parseArgs(['--state', '/tmp/x']), {}).deleteApproval).toBe('none')
    expect(settingsFrom(parseArgs(['--state', '/tmp/x', '--operator', npub]), {}).deleteApproval).toBe('operator')
    expect(settingsFrom(parseArgs(['--state', '/tmp/x']), { operator: npub }).deleteApproval).toBe('operator')
    expect(settingsFrom(parseArgs(['--state', '/tmp/x']), { operator: npub, deleteApproval: 'none' }).deleteApproval).toBe('none')
    expect(settingsFrom(parseArgs(['--state', '/tmp/x', '--delete-approval', 'operator']), {}).deleteApproval).toBe('operator')
    expect(() => settingsFrom(parseArgs(['--state', '/tmp/x']), { deleteApproval: 'yes' })).toThrow(/"operator" or "none"/)
    expect(() => parseArgs(['--state', '/tmp/x', '--delete-approval', 'always'])).toThrow(/"operator" or "none"/)
  })
  it('takes a threshold, 5 by default', () => {
    expect(settingsFrom(parseArgs(['--state', '/tmp/x']), {}).deleteApprovalThreshold).toBe(5)
    expect(settingsFrom(parseArgs(['--state', '/tmp/x', '--delete-approval-threshold', '12']), {}).deleteApprovalThreshold).toBe(12)
    expect(settingsFrom(parseArgs(['--state', '/tmp/x']), { deleteApprovalThreshold: 0 }).deleteApprovalThreshold).toBe(0)
    expect(() => settingsFrom(parseArgs(['--state', '/tmp/x']), { deleteApprovalThreshold: -1 })).toThrow(/whole number/)
  })
})

describe('delete approval requests', () => {
  let clock = 1_000_000_000_000
  const fresh = () => new DeleteApprovals(StateDir.open(mkdtempSync(join(tmpdir(), 'del-approvals-'))), 'operator', () => clock)
  const t = () => Math.floor(clock / 1000)

  it('read strictly, and never across kinds: a DEL- code answers no payment, a PAY- code no delete', () => {
    const c = 'DEL-7KQ2XM'
    for (const x of [c, `yes ${c}`, `delete ${c}`, `ok ${c}.`]) expect(readAnswer(x, 'DEL'), x).toEqual({ code: c, yes: true })
    expect(readAnswer(`no ${c}`, 'DEL')).toEqual({ code: c, yes: false })
    for (const x of [`do not delete ${c}`, `pay ${c}`, `yes ${c} PAY-7KQ2XM`]) expect(readAnswer(x, 'DEL'), x).toBeNull()
    expect(readAnswer(c, 'PAY')).toBeNull()
    expect(readAnswer('PAY-7KQ2XM', 'DEL')).toBeNull()
    expect(withoutCodes(`reply ${c} or PAY-7KQ2XM`)).toBe('reply DEL-****** or PAY-******')
  })

  it('covers exactly the set previewed, used once; refused or lapsed is told once, then the set may ask again', () => {
    const a = fresh()
    const r = a.request({ pieces: ['b', 'a'], summary: 'two shards' })
    expect(r.code).toMatch(/^DEL-[2-9A-HJKMNP-Z]{6}$/)
    expect(deleteRequestWords(r)).toContain(r.code)
    expect(a.verdict(['a', 'b']).state).toBe('pending')
    expect(a.verdict(['a', 'b', 'c']).state).toBe('none')
    expect(a.answer(`yes ${r.code}`, t(), 'm1')?.state).toBe('approved')
    expect(a.use(r.code, ['a', 'b', 'c'])).toBe(false)
    expect(a.use(r.code, ['a', 'b'])).toBe(true)
    expect(a.use(r.code, ['a', 'b'])).toBe(false)
    expect(a.verdict(['a', 'b']).state).toBe('none')
    const r2 = a.request({ pieces: ['a'], summary: 'one' })
    expect(a.answer(`no ${r2.code}`, t(), 'm2')?.state).toBe('refused')
    const v = a.verdict(['a'])
    expect(v.state).toBe('refused')
    a.reported(r2.code)
    expect(a.verdict(['a']).state).toBe('none')
  })
})

// ---- the whole way: a delete held for the operator, by DM ----

describe('a large delete under deleteApproval "operator"', () => {
  const network = new FakeNetwork()
  const canonical = network.add(CANONICAL, { refuse: (ev) => (ev.kind === 1059 ? 'blocked: kind 1059 is not accepted here' : null) })
  network.add(MINE)
  const general = network.add(GENERAL, { requireAuth: false })
  const inbox = network.add(INBOX, { requireAuth: false })
  const opSk = generateSecretKey()
  const op = getPublicKey(opSk)
  let a: Agent
  let call: Call
  const outputs: string[] = []
  const said = async (name: string, args: Record<string, unknown> = {}) => { const r = await call(name, args); outputs.push(r.raw); return r }
  const dms = (): string[] => dmsTo(inbox, opSk)
  const dmFrom = (text: string): void => { inbox.seed(wrapMessage({ senderSk: opSk, recipient: a.pubkey, text, now: nowSeconds() }).toRecipient) }
  /** What the agent published that changes a bag: bag versions and deletions (not its DM inbox list, kind 10050). */
  const bagEvents = (): number => canonical.published.filter((e) => e.kind === HIDDEN_KIND || e.kind === 5).length
  const codes = (): string[] => dms().filter((d) => d.startsWith('May I delete')).map((d) => /DEL-[2-9A-HJKMNP-Z]{6}/.exec(d)![0])

  beforeAll(async () => {
    const dir = stateWithKey()
    ;({ a, call } = await connect(network, dir, { operator: op, lookupRelays: [GENERAL], ordersPollMs: 40, deleteApprovalThreshold: 2 }))
    general.seed(finalizeEvent({ kind: 10050, created_at: nowSeconds(), tags: [['relay', INBOX]], content: '' }, opSk) as NostrEvent)
    general.seed(finalizeEvent({ kind: 3, created_at: nowSeconds(), tags: [['p', a.pubkey]], content: '' }, opSk) as NostrEvent)
    await said('identity', { name: 'builder' })
    for (const [i, n] of ['a', 'b', 'c'].entries()) await said('place', { object: shard(n, i + 1), ...at(i), height: 8, build: 'big' })
  }, 60_000)

  it('is the default with an operator: held, the code only in the DM, "no" refuses, a changed set voids an approval, the code approves once', async () => {
    expect(a.deleteApprovals.mode).toBe('operator')
    const preview = await said('delete_build', { build: 'big' })
    expect(preview.data.approvalNeeded).toBe(true)
    expect(preview.text).toMatch(/3 things would go, more than 2/)
    const published = bagEvents()

    // Held: the server DMs the operator what would go, with a code; the tool answer has none.
    const held = await said('delete_build', { build: 'big', confirm: true })
    expect(held.isError).toBe(false)
    expect(held.data.held).toBe(true)
    await until(() => codes().length === 1, 'the delete request DM')
    const first = codes()[0]
    expect(dms().find((d) => d.includes(first))).toMatch(/May I delete 3 thing\(s\)[\s\S]*goes: shard "a"/)
    expect(bagEvents()).toBe(published)

    // "no CODE" refuses it.
    dmFrom(`no ${first}`)
    await until(() => a.deleteApprovals.verdict(preview.data.pieces as string[]).state === 'refused', 'the refusal')
    const refused = await said('delete_build', { build: 'big', confirm: true })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('your operator refused')
    expect(await bagNames(canonical, a.pubkey)).toEqual(['a', 'b', 'c'])

    // Asked again: a new code; approved; then the set changes (a fourth piece): the approval does not apply.
    await said('delete_build', { build: 'big', confirm: true })
    await until(() => codes().length === 2, 'the second request')
    const second = codes()[1]
    expect(second).not.toBe(first)
    dmFrom(`yes ${second}`)
    await until(() => a.deleteApprovals.verdict(preview.data.pieces as string[]).state === 'approved', 'the approval')
    await said('place', { object: shard('d', 4), ...at(3), height: 8, build: 'big' })
    const changed = await said('delete_build', { build: 'big', confirm: true })
    expect(changed.data.held).toBe(true)
    await until(() => codes().length === 3, 'the request for the new set')
    expect(await bagNames(canonical, a.pubkey)).toEqual(['a', 'b', 'c', 'd'])

    // The code for this set approves it, and the delete runs once.
    const third = codes()[2]
    const pieces = (changed.data.pieces as string[])
    dmFrom(third)
    await until(() => a.deleteApprovals.verdict(pieces).state === 'approved', 'the third approval')
    const done = await said('delete_build', { build: 'big', confirm: true })
    expect(done.isError, done.text).toBe(false)
    expect(done.data.deleted).toBe(true)
    expect(await bagNames(canonical, a.pubkey)).toBeNull()
    expect(a.deleteApprovals.use(third, pieces)).toBe(false)
    // Sent again, the same code approves nothing more.
    dmFrom(third)
    await settle(300)
    expect(a.deleteApprovals.verdict(pieces).state).toBe('none')

    // No code ever reached a tool's answer, the inbox included (the answers show it blanked).
    const read = await said('inbox')
    expect(read.text).toContain('DEL-******')
    for (const code of codes()) for (const o of outputs) expect(o).not.toContain(code)
    expect(a.operatorChannel.privateTexts().join('\n')).not.toMatch(/DEL-[2-9A-HJKMNP-Z]{6}/)
  }, 60_000)

  it('gates remove_placed of a whole bag of things in no build', async () => {
    await said('build_use', {})
    // Placed with no build and no current build: "unlabelled", which a whole-bag remove needs approval for.
    await said('hide', { contents: { message: 'lone note' }, ...at(50), height: 8 })
    const before = bagEvents()
    const held = await said('remove_placed', { target: 'lone note', whole_bag: true })
    expect(held.isError, held.text).toBe(false)
    expect(held.data.held).toBe(true)
    expect(held.text).toMatch(/no build/)
    expect(bagEvents()).toBe(before)
  }, 60_000)
})
