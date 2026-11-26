// trash.ts: a backup of everything a delete takes, written before the
// delete is signed (arkinox, 2026-11-26: one remove_placed of a bag took a
// 31-piece castle "with no backup and no warning").
//
// Each delete writes <state>/trash/<UTC time>-<label>/ (directory mode 700,
// files 600), every file fsynced before anything is signed or sent:
//
//   bags.json     the signed bag events (kind 33330) as they were: the
//                 ciphertext of the WHOLE bag, every entry in it (items with
//                 their secrets, messages with their coins, what stayed too),
//                 as every relay already holds it. It opens with the region
//                 key, which keys/mine.json in this same state directory
//                 keeps, and which anyone who derives that cube's key has;
//                 restore_build opens it (deriving the key again, never
//                 storing it here) and puts the original entries back;
//   objects.json  the signed kind 33331 objects of removed pieces placed by
//                 reference (sealed to the place: ciphertext too);
//   pieces.json   what each removed piece was, opened, to read without a
//                 key: its type, name, place, plane, cube height and entry,
//                 whether it was behind a locked door; a shard's whole SNO
//                 payload; a message's text; a public object's address;
//   ledger.json   the build ledger's entries for the removed pieces;
//   meta.json     what was asked, when, which bags, which pieces went and
//                 which stayed; written last, so an entry without it is
//                 one whose writing failed (and its delete never ran).
//
// No secret in the clear: no region key, no item's secret (a key item's
// own event carries it, so pieces.json names a key by its name and public
// key only), no door secret, and no Cashu token (bearer money, blanked in a
// message's text and in names). They are only in bags.json's ciphertext,
// as on the relays (review of 485a2df: say so plainly).
// Nothing here ever deletes an entry: restore marks pieces restored and keeps it.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from './tool.js';
export const TRASH_DIR = 'trash';
/** A Cashu token (cashuA... / cashuB...), as items.ts reads one: bearer money, never kept in the trash. */
const CASHU = /\bcashu[AB][A-Za-z0-9_\-=+/]+/g;
/**
 * What restore_build can and cannot bring back, said in every preview, every
 * delete answer and every approval DM (review of 485a2df: plainly).
 */
export const RESTORE_WORDS = 'restore_build can put back, from the trash: everything that was carried in the bag itself (messages, coins, shards, items, chests, doors, audio) exactly as it was, with the same ids; a shard sealed by reference as a new sealed object with the same contents but a new id and address (comments and reactions on the old one do not follow); a public object placed by its address, while it is still published; a thing from a locked room only back into that room, while this server still holds its door. It cannot put back what was in a bag this server could not open, and a restored door does not take new placements into its room (its secret is not kept).';
/** A message's text with every Cashu token blanked, and whether it held one. */
export function withoutTokens(text) {
    const held = new RegExp(CASHU.source).test(text);
    return { text: held ? text.replace(CASHU, '[a Cashu token, not kept]') : text, held };
}
function slug(label) {
    return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'delete';
}
/** 2026-11-26T15:30:12.345Z as 20261126T153012345Z: sortable, and safe in a file name. */
function stamp(ms) {
    return new Date(ms).toISOString().replace(/[-:.]/g, '');
}
/** The trash directory: writes one entry per delete, lists and reads them, marks one restored. Never deletes. */
export class Trash {
    dir;
    now;
    constructor(dir, now = Date.now) {
        this.dir = dir;
        this.now = now;
    }
    get root() {
        return this.dir.file(TRASH_DIR);
    }
    /** Write a file whole and fsync it, mode 600; a file already there is never overwritten. */
    writeSynced(path, value) {
        const fd = openSync(path, 'wx', 0o600);
        try {
            writeSync(fd, JSON.stringify(value, null, 2) + '\n');
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
    }
    /** fsync a directory, so the files just made in it survive a crash (not every platform allows it; the files themselves are synced either way). */
    syncDir(path) {
        try {
            const fd = openSync(path, 'r');
            try {
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
        }
        catch { /* a platform that cannot sync a directory */ }
    }
    /**
     * Write one backup, every file fsynced, meta.json last. Returns its id.
     * Throws a Refusal when anything fails: the caller must not delete then.
     */
    write(entry, label) {
        try {
            this.dir.guard('write the trash');
            mkdirSync(this.root, { recursive: true, mode: 0o700 });
            const ms = this.now();
            const base = `${stamp(ms)}-${slug(label)}`;
            let id = base;
            for (let n = 2; existsSync(join(this.root, id)); n++)
                id = `${base}-${n}`;
            const path = join(this.root, id);
            mkdirSync(path, { mode: 0o700 });
            this.writeSynced(join(path, 'bags.json'), entry.bags);
            this.writeSynced(join(path, 'objects.json'), entry.objects);
            this.writeSynced(join(path, 'pieces.json'), entry.pieces);
            this.writeSynced(join(path, 'ledger.json'), entry.ledger);
            const meta = { version: 1, id, createdAt: new Date(ms).toISOString(), createdAtSeconds: Math.floor(ms / 1000), ...entry.meta };
            this.writeSynced(join(path, 'meta.json'), meta);
            this.syncDir(path);
            this.syncDir(this.root);
            return id;
        }
        catch (err) {
            throw new Refusal(`The backup could not be written to the trash (${err instanceof Error ? err.message : String(err)}), so nothing was deleted: a delete never runs without its backup.`);
        }
    }
    /** Every complete entry (one with its meta.json), newest first. */
    list() {
        let names;
        try {
            names = readdirSync(this.root);
        }
        catch {
            return [];
        }
        const out = [];
        for (const name of names) {
            try {
                const meta = JSON.parse(readFileSync(join(this.root, name, 'meta.json'), 'utf8'));
                if (meta?.version === 1 && meta.id === name)
                    out.push(meta);
            }
            catch { /* not an entry, or one whose writing failed */ }
        }
        return out.sort((a, b) => (a.id < b.id ? 1 : -1));
    }
    /** One entry whole, by its id (or the unique start of it). */
    read(given) {
        const want = String(given ?? '').trim();
        if (!want)
            throw new Refusal('Say which trash entry: its id, as trash lists it.');
        const all = this.list();
        const hits = all.filter((m) => m.id === want).length ? all.filter((m) => m.id === want) : all.filter((m) => m.id.startsWith(want));
        if (hits.length === 0)
            throw new Refusal(`No trash entry has the id ${want}. trash lists them.`);
        if (hits.length > 1)
            throw new Refusal(`${hits.length} trash entries start ${want}; give more of the id.`);
        const path = join(this.root, hits[0].id);
        const read = (name, fallback) => { try {
            return JSON.parse(readFileSync(join(path, name), 'utf8'));
        }
        catch {
            return fallback;
        } };
        return { meta: hits[0], pieces: read('pieces.json', []), bags: read('bags.json', []), objects: read('objects.json', []), ledger: read('ledger.json', []) };
    }
    /** Record pieces restored (or not), as each lands; once every piece has landed the entry is marked restored. meta.json is written again atomically; the entry is kept. */
    markRestored(id, restored) {
        const entry = this.read(id);
        const at = new Date(this.now()).toISOString();
        const all = [...(entry.meta.restored ?? []), ...restored.map((r) => ({ ...r, at }))];
        const back = new Set(all.filter((r) => r.ok).map((r) => r.from));
        const complete = entry.pieces.length > 0 && entry.pieces.every((p) => back.has(p.id));
        const meta = { ...entry.meta, restored: all, ...(complete && !entry.meta.restoredAt ? { restoredAt: at } : {}) };
        this.dir.guard('write the trash');
        const target = join(this.root, entry.meta.id, 'meta.json');
        const tmp = `${target}.${process.pid}.tmp`;
        const fd = openSync(tmp, 'w', 0o600);
        try {
            writeSync(fd, JSON.stringify(meta, null, 2) + '\n');
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        renameSync(tmp, target);
        return meta;
    }
}
//# sourceMappingURL=trash.js.map