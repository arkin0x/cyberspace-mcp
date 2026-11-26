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
import { bagTemplate } from '../src/hidden/bags.js'
import { bytesToHex, hexToBytes, nowSeconds, signEvent, type NostrEvent } from '../src/nostr/event.js'
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
      if (name === 'trash' || name === 'builds.json') continue
      const p = join(path, name)
      if (statSync(p).isDirectory()) { walk(p); continue }
      const text = readFileSync(p, 'utf8')
      for (const m of text.matchAll(/"(?:keyHex|secretHex|secret)"\s*:\s*"([0-9a-f]{64})"/g)) out.add(m[1])
    }
  }
  walk(dir)
  return [...out]
}

/** Every file of the trash, and builds.json: what must never hold a secret in the clear. */
function trashFiles(dir: string): Array<{ path: string; text: string }> {
  const root = join(dir, 'trash')
  const trash = readdirSync(root).flatMap((e) => readdirSync(join(root, e)).map((f) => ({ path: join(root, e, f), text: readFileSync(join(root, e, f), 'utf8') })))
  return [...trash, { path: join(dir, 'builds.json'), text: readFileSync(join(dir, 'builds.json'), 'utf8') }]
}

/** The agent's secret key, from its key file (to sign a version of its bag as another session would). */
function skOf(dir: string): Uint8Array {
  return hexToBytes((JSON.parse(readFileSync(join(dir, 'key'), 'utf8')) as { secret: string }).secret)
}

/** The entries of the agent's h8 bag on the canonical relay, opened, as JSON strings by id. */
async function entriesNow(relay: FakeRelay, pubkey: string, lookup = H8): Promise<Map<string, string>> {
  const bag = relay.all().find((e) => e.kind === HIDDEN_KIND && e.pubkey === pubkey && e.tags.some((t) => t[0] === 'd' && t[1] === lookup.lookupId))
  const out = new Map<string, string>()
  for (const e of (bag ? await openEntries(bag, lookup.key) : null) ?? []) out.set((e as NostrEvent).id ?? JSON.stringify(e), JSON.stringify(e))
  return out
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

  it('restore_build puts the original entries back verbatim (same ids), a key and its chest and a coin included, merged into the bag', async () => {
    await mixedBag()
    const TOKEN = 'cashuAeyJ0b2tlbiI6W3sibWludCI6Imh0dHBzOi8vbWludC5leGFtcGxlIn1dfQ'
    await call('hide', { contents: { message: `${TOKEN} for the winner` }, ...at(5), height: 8, build: 'aerocarnival course' })
    expect((await call('seal_chest', { name: 'Prize', lock: 'Course Key', contents: [{ message: 'you win' }], ...at(4), height: 8, build: 'aerocarnival course' })).isError).toBe(false)
    const before = await entriesNow(canonical, a.pubkey)
    expect(before.size).toBe(9)
    const done = await call('delete_build', { build: 'aerocarnival course', confirm: true })
    expect(done.data.deleted, done.text).toBe(true)
    expect(done.text).toContain('restore_build can put back')
    expect((await entriesNow(canonical, a.pubkey)).size).toBe(3)
    const trashId = String(done.data.trashId)
    // No coin and no secret in the clear: not in the trash, not in builds.json.
    const secrets = secretsIn(dir)
    for (const f of trashFiles(dir)) {
      expect(f.text.includes(TOKEN), `${f.path} holds the coin`).toBe(false)
      for (const sec of secrets) expect(f.text.includes(sec), `${f.path} holds a secret`).toBe(false)
    }
    const r = await call('restore_build', { trash: trashId })
    expect(r.isError, r.text).toBe(false)
    expect((r.data.restored as unknown[]).length).toBe(6)
    expect(r.data.failed).toEqual([])
    // Every original entry is back, byte for byte: the same ids, the key item and its chest exactly as sealed, the coin's message whole.
    const after = await entriesNow(canonical, a.pubkey)
    expect(after.size).toBe(9)
    for (const [id, json] of before) expect(after.get(id), id).toBe(json)
    expect(await bagNames(canonical, a.pubkey)).toContain('key:Course Key')
    const course = a.builds.find('aerocarnival course')!
    const labels = course.pieces.filter((p) => !p.removedAt).map((p) => p.label)
    expect(labels.filter((l) => !l.startsWith('[a Cashu token, not kept]')).sort()).toEqual(['Course Key', 'Prize', 'loop', 'ramp', 'start line here'])
    expect(labels).toHaveLength(6)
    expect(readFileSync(join(dir, 'builds.json'), 'utf8')).not.toContain(TOKEN)
    const meta = JSON.parse(readFileSync(join(dir, 'trash', trashId, 'meta.json'), 'utf8')) as { restoredAt?: string; restored: unknown[] }
    expect(meta.restoredAt).toBeTruthy()
    expect(meta.restored).toHaveLength(6)
    expect((await call('restore_build', { trash: trashId })).text).toContain('already back')
  })

  it('a piece from a locked room goes back only into that room, and never into the open once its door is gone', async () => {
    expect((await call('forge_item', { name: 'Vault Key', ...at(120), height: 3, build: 'vault' })).isError).toBe(false)
    expect((await call('seal_door', { name: 'Vault door', lock: 'Vault Key', room_height: 4, height: 5, ...at(0), build: 'vault' })).isError).toBe(false)
    const placed = await call('place', { object: shard('statue'), ...at(0), height: 4, build: 'vault' })
    expect(placed.text).toContain('inside the room of your door')
    const roomLookup = String(placed.data.lookupId)
    const removed = await call('remove_placed', { target: 'statue' })
    expect(removed.isError, removed.text).toBe(false)
    const pieces = JSON.parse(readFileSync(join(dir, 'trash', String(removed.data.trashId), 'pieces.json'), 'utf8')) as Array<{ room?: boolean; lookupId: string }>
    expect(pieces).toEqual([expect.objectContaining({ room: true, lookupId: roomLookup })])
    // With the door held: back into the room bag, as it was.
    const back = await call('restore_build', { trash: String(removed.data.trashId) })
    expect(back.isError, back.text).toBe(false)
    const where = (await call('placed')).data.bags as Array<{ lookupId: string; entries: Row[] }>
    expect(where.find((b) => b.entries.some((e) => e.label === 'statue'))!.lookupId).toBe(roomLookup)
    // The door gone from this server: the statue is not put in the open cube.
    const again = await call('remove_placed', { target: 'statue' })
    const door = rowsOf(await call('placed')).find((r) => r.label === 'Vault door')!
    ;(a as unknown as { doors: { remove(id: string): void } }).doors.remove(door.id)
    const refused = await call('restore_build', { trash: String(again.data.trashId) })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/inside a locked room whose door this server no longer holds/)
    expect(rowsOf(await call('placed')).some((r) => r.label === 'statue')).toBe(false)
  }, 30_000)

  it('a restore cut short is tried again for the rest only', async () => {
    await call('place', { object: shard('low'), ...at(0), height: 3, build: 'two cubes' })
    await call('place', { object: shard('high'), ...at(0), height: 8, build: 'two cubes' })
    const done = await call('delete_build', { build: 'two cubes', confirm: true })
    expect(done.data.deleted, done.text).toBe(true)
    const trashId = String(done.data.trashId)
    // The canonical relay falls silent once the first bag of the restore is out: the second cannot be read, so it is not restored.
    let cut = false
    canonical.onPublished.push((ev) => { if (!cut && ev.kind === HIDDEN_KIND) { cut = true; canonical.policy.silent = true } })
    const first = await call('restore_build', { trash: trashId })
    canonical.policy.silent = false
    canonical.onPublished.length = 0
    expect(first.isError, first.text).toBe(false)
    expect((first.data.restored as unknown[]).length).toBe(1)
    expect((first.data.failed as Array<{ why: string }>)[0].why).toMatch(/canonical relay did not answer/)
    expect(first.text).toContain('tries only the rest')
    const again = await call('restore_build', { trash: trashId })
    expect(again.isError, again.text).toBe(false)
    expect((again.data.restored as Array<{ label: string }>).map((d) => d.label)).toEqual([(first.data.failed as Array<{ label: string }>)[0].label])
    expect(again.text).toContain('Already back before this call: 1')
    expect(JSON.parse(readFileSync(join(dir, 'trash', trashId, 'meta.json'), 'utf8')).restoredAt).toBeTruthy()
    expect(a.builds.find('two cubes')!.pieces.filter((p) => !p.removedAt).map((p) => p.label).sort()).toEqual(['high', 'low'])
  }, 30_000)

  it('two builds placed before the ledger share a bag: a whole-bag remove and delete_build "unlabelled" are refused', async () => {
    for (const [i, n] of ['ramp', 'loop', 'keep', 'tower'].entries()) await call('place', { object: shard(n), ...at(i), height: 8 })
    await forgetLedger()
    const before = canonical.published.length
    const whole = await call('remove_placed', { target: 'keep', whole_bag: true })
    expect(whole.isError).toBe(true)
    expect(whole.text).toMatch(/holds 4 thing\(s\) in no build.*build_add/)
    expect((await call('remove_placed', { bag: H8.lookupId.slice(0, 12) })).isError).toBe(true)
    const all = await call('delete_build', { build: 'unlabelled', confirm: true })
    expect(all.isError).toBe(true)
    expect(all.text).toContain('"unlabelled" is not one build')
    expect(canonical.published.length).toBe(before)
    // The way through: name the builds, then the scoped delete takes one.
    await call('build_add', { build: 'course', match: 'r' }) // ramp, tower: a name match takes what it says
    await call('build_add', { build: 'castle', pieces: rowsOf(await call('placed')).filter((r) => ['loop', 'keep'].includes(r.label)).map((r) => r.id) })
    expect((await call('remove_placed', { target: 'keep', whole_bag: true })).text).toMatch(/holds things of 2 builds/)
  })

  it('a move across a cube\'s edge carries the ledger to the new bag', async () => {
    const placed = await call('place', { object: shard('wanderer'), ...at(0), height: 8, build: 'roamers' })
    const first = String(placed.data.id)
    const moved = await call('move_placed', { target: first, by: { dz: 200 } })
    expect(moved.isError, moved.text).toBe(false)
    expect(moved.data.sameBag).toBe(false)
    const to = moved.data.to as { lookupId: string; z: string }
    const piece = a.builds.find('roamers')!.pieces[0]
    expect(piece).toMatchObject({ id: (moved.data.moved as { id: string }).id, lineage: first, lookupId: to.lookupId, height: 8, at: { z: (BASE + 200n).toString() } })
    expect(piece.lookupId).not.toBe(H8.lookupId)
    expect((await call('build', { build: 'roamers' })).data.pieces).toEqual([expect.objectContaining({ state: 'there' })])
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
    await call('place', { object: shard('loose'), ...at(40), height: 8 })
    expect((await call('build_rename', { build: 'unlabelled', label: 'mine' })).text).toContain('cannot be renamed')
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
  let dir: string
  /** A short life for a delete request, so one can lapse within the test. */
  const TTL_MS = 5000
  const outputs: string[] = []
  const said = async (name: string, args: Record<string, unknown> = {}) => { const r = await call(name, args); outputs.push(r.raw); return r }
  const dms = (): string[] => dmsTo(inbox, opSk)
  const dmFrom = (text: string): void => { inbox.seed(wrapMessage({ senderSk: opSk, recipient: a.pubkey, text, now: nowSeconds() }).toRecipient) }
  /** What the agent published that changes a bag: bag versions and deletions (not its DM inbox list, kind 10050). */
  const bagEvents = (): number => canonical.published.filter((e) => e.kind === HIDDEN_KIND || e.kind === 5).length
  const codes = (): string[] => dms().filter((d) => d.startsWith('May I delete')).map((d) => /DEL-[2-9A-HJKMNP-Z]{6}/.exec(d)![0])

  beforeAll(async () => {
    dir = stateWithKey()
    ;({ a, call } = await connect(network, dir, { operator: op, lookupRelays: [GENERAL], ordersPollMs: 40, deleteApprovalThreshold: 2, deleteApprovalTtlMs: TTL_MS }))
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
    expect(held.text).toContain('call inbox')
    expect(bagEvents()).toBe(before)
    // Approved, the same call runs: the bag is deleted, and its backup written.
    await until(() => codes().length === 4, 'the whole-bag request')
    dmFrom(`yes ${codes()[3]}`)
    const ran = await said('remove_placed', { target: 'lone note', whole_bag: true })
    expect(ran.isError, ran.text).toBe(false)
    expect(ran.data.deletedBag).toBe(true)
    expect(ran.data.trashId).toBeTruthy()
    expect(bagEvents()).toBeGreaterThan(before)
  }, 60_000)

  it('a request the operator does not answer in time lapses: nothing is deleted, and a late yes approves nothing', async () => {
    for (const n of ['p', 'q', 'r']) await said('place', { object: shard(n), ...at(60), height: 3, build: 'late' })
    const held = await said('delete_build', { build: 'late', confirm: true })
    expect(held.data.held).toBe(true)
    await until(() => codes().length === 5, 'the request')
    const code = codes()[4]
    await settle(TTL_MS + 300)
    dmFrom(`yes ${code}`)
    const lapsed = await said('delete_build', { build: 'late', confirm: true })
    expect(lapsed.isError).toBe(true)
    expect(lapsed.text).toMatch(/did not answer the request for this delete within/)
    expect(a.builds.find('late')!.pieces.every((p) => !p.removedAt)).toBe(true)
    for (const o of outputs) expect(o).not.toContain(code)
  }, 30_000)

  it('a bag whose key is held but which does not open is held for approval, and the preview says it could not be read', async () => {
    await said('build_use', { build: 'sealed shut' })
    await said('hide', { contents: { message: 'soon unreadable' }, ...at(70), height: 3 })
    const H3 = regionKeyAt({ x: BASE, y: BASE, z: BASE + 70n }, 3, 20)
    // Another session's newer version of the bag, sealed with a key this server does not hold for it.
    const wrong = regionKeyAt({ x: BASE + (1n << 30n), y: BASE, z: BASE }, 3, 20).key
    const now = canonical.all().find((e) => e.kind === HIDDEN_KIND && e.tags.some((t) => t[0] === 'd' && t[1] === H3.lookupId))!
    canonical.seed(signEvent(await bagTemplate([], wrong, H3.lookupId, 3, now.created_at + 5, HIDDEN_KIND), skOf(dir)))
    const list = await said('placed')
    const bag = (list.data.bags as Array<{ lookupId: string; keyHeld: boolean; opened: boolean; entries: unknown[] }>).find((b) => b.lookupId === H3.lookupId)!
    expect(bag).toMatchObject({ keyHeld: true, opened: false, entries: [] })
    expect(list.text).toContain('does not open with the key this server holds')
    const before = bagEvents()
    const held = await said('remove_placed', { bag: H3.lookupId.slice(0, 12) })
    expect(held.isError, held.text).toBe(false)
    expect(held.data.held).toBe(true)
    expect(held.text).toMatch(/could not be read \(it does not open with the key this server holds for it\)/)
    expect(bagEvents()).toBe(before)
    expect((await said('build_add', { build: 'x', bag: H3.lookupId.slice(0, 12) })).text).toContain('does not open')
  }, 30_000)

  it('deletes split small still add up: within the hour, past the threshold, the next one waits for approval', async () => {
    await said('build_use', { build: 'singles' })
    for (const n of ['s1', 's2', 's3']) await said('place', { object: shard(n), ...at(80), height: 2 })
    const start = a.deleteApprovals.recentDeleted()
    expect(start).toBe(0)
    expect((await said('remove_placed', { target: 's1' })).data.trashId).toBeTruthy()
    expect((await said('remove_placed', { target: 's2' })).data.trashId).toBeTruthy()
    expect(a.deleteApprovals.recentDeleted()).toBe(2)
    const third = await said('remove_placed', { target: 's3' })
    expect(third.isError, third.text).toBe(false)
    expect(third.data.held).toBe(true)
    expect(third.text).toMatch(/2 thing\(s\) were deleted in the last hour without approval; with these 1 that makes 3, more than 2/)
    expect(rowsOf(await said('placed')).some((r) => r.label === 's3')).toBe(true)
    // The window is kept in state: a restart still counts it.
    expect(JSON.parse(readFileSync(join(dir, 'delete-approvals.json'), 'utf8')).deleted).toHaveLength(2)
  }, 30_000)
})
