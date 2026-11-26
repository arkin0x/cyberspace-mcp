// trash.ts: a backup of everything a delete takes, written before the
// delete is signed (arkinox, 2026-11-26: one remove_placed of a bag took a
// 31-piece castle "with no backup and no warning").
//
// Each delete writes <state>/trash/<UTC time>-<label>/ (directory mode 700,
// files 600), every file fsynced before anything is signed or sent:
//
//   bags.json     the signed bag events (kind 33330) as they were: ciphertext,
//                 as every relay already holds them;
//   objects.json  the signed kind 33331 objects of removed pieces placed by
//                 reference (sealed: ciphertext too);
//   pieces.json   what each removed piece was, opened: its type, name, place,
//                 plane and cube height; a shard's whole SNO payload; a
//                 message's text; a public object's address;
//   ledger.json   the build ledger's entries for the removed pieces;
//   meta.json     what was asked, when, which bags, which pieces went and
//                 which stayed; written last, so an entry without it is
//                 one whose writing failed (and its delete never ran).
//
// Never a secret: no region key, no item's secret (a key item's own event
// carries it, so a key is kept by its name and public key only), no door
// secret, and no Cashu token (bearer money, blanked in a message's text).
// Nothing here ever deletes an entry: restore marks one restored and keeps it.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { Plane } from 'cyberspace-core'
import type { BuildPiece } from './builds.js'
import type { NostrEvent } from './nostr/event.js'
import type { StateDir } from './state/dir.js'
import { Refusal } from './tool.js'

export const TRASH_DIR = 'trash'
/** A Cashu token (cashuA... / cashuB...), as items.ts reads one: bearer money, never kept in the trash. */
const CASHU = /\bcashu[AB][A-Za-z0-9_\-=+/]+/g

/** One removed piece as the trash keeps it: enough to see what it was and to place a shard or message again. */
export interface TrashPiece {
  id: string
  lineage: string | null
  type: string
  label: string
  /** The build it belonged to ("unlabelled" for none). */
  build: string
  lookupId: string
  height: number
  at: { x: string; y: string; z: string }
  plane: Plane
  anyPlane?: true
  byReference?: 'sealed' | 'public'
  objectAddress?: string
  /** A shard's whole SNO payload. */
  payload?: unknown
  /** A message's text, any Cashu token blanked. */
  text?: string
  /** The message held a Cashu token, which was not kept. */
  heldCashuToken?: true
  /** A key item: its name, sentence and public key (never its secret). */
  key?: { name: string; about: string; itemPubkey: string }
  /** A chest or door: what a finder sees (its sealed contents cannot be made again). */
  chest?: { name: string; requires: string; lockPubkey: string; door?: number }
  audio?: { title: string }
}

/** A thing a bag kept: named in meta.json so the operator can see what stayed. */
export interface TrashKept { id: string; type: string; label: string; build: string }

/** meta.json: what a delete was asked, which bags it touched, what went and what stayed, and any restore. */
export interface TrashMeta {
  version: 1
  /** The entry's directory name: its id. */
  id: string
  createdAt: string
  createdAtSeconds: number
  /** The tool and what it was given, as the model asked. */
  tool: string
  asked: Record<string, unknown>
  /** The build it was for, when one was named. */
  build?: string
  bags: Array<{ lookupId: string; bagId: string | null; height: number; base: { x: string; y: string; z: string } | null; wholeBag: boolean; removed: string[]; kept: TrashKept[] }>
  removed: TrashKept[]
  restoredAt?: string
  restored?: Array<{ from: string; id: string | null; type: string; label: string; ok: boolean; why?: string }>
}

/** One trash entry, every file read back. */
export interface TrashEntry {
  meta: TrashMeta
  pieces: TrashPiece[]
  bags: NostrEvent[]
  objects: NostrEvent[]
  ledger: Array<{ build: { id: string; label: string }; piece: BuildPiece }>
}

/** A message's text with every Cashu token blanked, and whether it held one. */
export function withoutTokens(text: string): { text: string; held: boolean } {
  const held = new RegExp(CASHU.source).test(text)
  return { text: held ? text.replace(CASHU, '[a Cashu token, not kept]') : text, held }
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'delete'
}

/** 2026-11-26T15:30:12.345Z as 20261126T153012345Z: sortable, and safe in a file name. */
function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:.]/g, '')
}

/** The trash directory: writes one entry per delete, lists and reads them, marks one restored. Never deletes. */
export class Trash {
  constructor(private readonly dir: StateDir, private readonly now: () => number = Date.now) {}

  private get root(): string {
    return this.dir.file(TRASH_DIR)
  }

  /** Write a file whole and fsync it, mode 600; a file already there is never overwritten. */
  private writeSynced(path: string, value: unknown): void {
    const fd = openSync(path, 'wx', 0o600)
    try {
      writeSync(fd, JSON.stringify(value, null, 2) + '\n')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  /** fsync a directory, so the files just made in it survive a crash (not every platform allows it; the files themselves are synced either way). */
  private syncDir(path: string): void {
    try {
      const fd = openSync(path, 'r')
      try { fsyncSync(fd) } finally { closeSync(fd) }
    } catch { /* a platform that cannot sync a directory */ }
  }

  /**
   * Write one backup, every file fsynced, meta.json last. Returns its id.
   * Throws a Refusal when anything fails: the caller must not delete then.
   */
  write(entry: Omit<TrashEntry, 'meta'> & { meta: Omit<TrashMeta, 'version' | 'id' | 'createdAt' | 'createdAtSeconds'> }, label: string): string {
    try {
      this.dir.guard('write the trash')
      mkdirSync(this.root, { recursive: true, mode: 0o700 })
      const ms = this.now()
      const base = `${stamp(ms)}-${slug(label)}`
      let id = base
      for (let n = 2; existsSync(join(this.root, id)); n++) id = `${base}-${n}`
      const path = join(this.root, id)
      mkdirSync(path, { mode: 0o700 })
      this.writeSynced(join(path, 'bags.json'), entry.bags)
      this.writeSynced(join(path, 'objects.json'), entry.objects)
      this.writeSynced(join(path, 'pieces.json'), entry.pieces)
      this.writeSynced(join(path, 'ledger.json'), entry.ledger)
      const meta: TrashMeta = { version: 1, id, createdAt: new Date(ms).toISOString(), createdAtSeconds: Math.floor(ms / 1000), ...entry.meta }
      this.writeSynced(join(path, 'meta.json'), meta)
      this.syncDir(path)
      this.syncDir(this.root)
      return id
    } catch (err) {
      throw new Refusal(`The backup could not be written to the trash (${err instanceof Error ? err.message : String(err)}), so nothing was deleted: a delete never runs without its backup.`)
    }
  }

  /** Every complete entry (one with its meta.json), newest first. */
  list(): TrashMeta[] {
    let names: string[]
    try { names = readdirSync(this.root) } catch { return [] }
    const out: TrashMeta[] = []
    for (const name of names) {
      try {
        const meta = JSON.parse(readFileSync(join(this.root, name, 'meta.json'), 'utf8')) as TrashMeta
        if (meta?.version === 1 && meta.id === name) out.push(meta)
      } catch { /* not an entry, or one whose writing failed */ }
    }
    return out.sort((a, b) => (a.id < b.id ? 1 : -1))
  }

  /** One entry whole, by its id (or the unique start of it). */
  read(given: string): TrashEntry {
    const want = String(given ?? '').trim()
    if (!want) throw new Refusal('Say which trash entry: its id, as trash lists it.')
    const all = this.list()
    const hits = all.filter((m) => m.id === want).length ? all.filter((m) => m.id === want) : all.filter((m) => m.id.startsWith(want))
    if (hits.length === 0) throw new Refusal(`No trash entry has the id ${want}. trash lists them.`)
    if (hits.length > 1) throw new Refusal(`${hits.length} trash entries start ${want}; give more of the id.`)
    const path = join(this.root, hits[0].id)
    const read = <T>(name: string, fallback: T): T => { try { return JSON.parse(readFileSync(join(path, name), 'utf8')) as T } catch { return fallback } }
    return { meta: hits[0], pieces: read('pieces.json', []), bags: read('bags.json', []), objects: read('objects.json', []), ledger: read('ledger.json', []) }
  }

  /** Mark an entry restored (its meta.json written again, atomically). The entry itself is kept. */
  markRestored(id: string, restored: NonNullable<TrashMeta['restored']>): TrashMeta {
    const entry = this.read(id)
    const meta: TrashMeta = { ...entry.meta, restoredAt: new Date(this.now()).toISOString(), restored: [...(entry.meta.restored ?? []), ...restored] }
    this.dir.guard('write the trash')
    const target = join(this.root, entry.meta.id, 'meta.json')
    const tmp = `${target}.${process.pid}.tmp`
    const fd = openSync(tmp, 'w', 0o600)
    try {
      writeSync(fd, JSON.stringify(meta, null, 2) + '\n')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, target)
    return meta
  }
}
