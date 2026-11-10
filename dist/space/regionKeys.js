// regionKeys.ts: the region keys the server holds and the bags it has
// opened, kept in the state directory under keys/. A key is derived by
// cyberspace-core for an aligned cube at a height (spec 7.2); holding it is
// what lets the agent read a bag there, say a line there and hear one. The
// passive scan derives the keys of the cubes around where the agent stands,
// heights 0 to SCAN_MAX_HEIGHT, the thirteen ONOSENDAI's scan derives
// (useDiscovery: heights 0 through SCAN_MAX_HEIGHT; h0 is the one gibson you
// stand on, and ONOSENDAI hides there too; arkinox, 2026-10-12: XOR could
// not see a quest bag at h0); a hop, a hide and a find add the keys they
// derived.
//
// Items and chests (Keys and Chests B1, and its 2026-10-10 addendum: keys ARE
// items) live here too, as ONOSENDAI's ITEMS panel keeps them (src/lib/
// inventory.ts), per identity: the items the agent holds (a key item is held
// by whoever read its secret: forged, found in a bag, or found in a chest),
// the contents it took out of chests (TAKE copies, it never empties a chest),
// and the chests it has seen, so it can open one later with an item found
// since (arkinox, 2026-10-12: "I don't think the MCP server gives the agent
// any knowledge of items or sealed chests or how to use them"). An item's
// secret is kept here, mode 600 like the agent's own key, and never reported
// by any tool.
import { bytesToHex } from '../nostr/event.js';
import { regionKeyAt } from '../hidden/crypto.js';
import { lookOf } from '../hidden/itemModel.js';
/** The widest cube the passive scan reaches, and the cube chat is sealed to (ONOSENDAI SCAN_MAX_HEIGHT). */
export const SCAN_MAX_HEIGHT = 12;
/** The narrowest: the cube of side 2^0, the gibson itself (ONOSENDAI scans from h0). */
export const SCAN_MIN_HEIGHT = 0;
/** The hard cap on what the core computes for a key, matching cyberspace-core's DEFAULT_MAX_COMPUTE_HEIGHT. */
export const MAX_COMPUTE_HEIGHT = 20;
/** How many keys and opened bags are kept; the least recently used go first. */
const KEYS_KEPT = 4000;
/**
 * A held item as a key item again, to be sealed as a copy: the same keypair,
 * name and sentence, and the item event's own tags (its picture, model,
 * motions, and whatever else it carried), so a copy put in a chest is the
 * item as it was. A row held before those tags were kept falls back to
 * the model and motions alone.
 */
export function keyItemOfHeld(held) {
    return {
        name: held.name, about: held.about, itemPubkey: held.itemPubkey, secretHex: held.secretHex, ...lookOf(held),
        ...(held.carried !== undefined ? { carried: held.carried.map((t) => [...t]) } : {}),
    };
}
/**
 * Who vouches for the message rumors inside a chest this agent has seen
 * (hidden/chests.ts readContents `sealer`): its author when that is a fact,
 * that is, for a chest found in a bag (checked against the bag's signer), or
 * one found inside another chest whose reading proved its author (`vouches`).
 */
export function sealerOfSeen(c) {
    return !c.inChest || c.vouches ? c.author : undefined;
}
/**
 * The entries of a noted bag that stand in `plane` (spec §7.6 Planes), and
 * how many it holds in the other plane, as far as this server knows. A bag
 * read from the other plane says what it holds in this one only as a count
 * (`unread`): find here to read them.
 */
export function bagInPlane(bag, plane) {
    const entries = bag.entries.filter((e) => e.plane === plane);
    const readHere = bag.plane === undefined || bag.plane === plane;
    return { entries, elsewhere: bag.entries.length - entries.length + (readHere ? bag.elsewhere ?? 0 : 0), unread: readHere ? 0 : bag.elsewhere ?? 0 };
}
/** The name of a plane, as reports say it. */
export function planeName(plane) {
    return plane === 0 ? 'dataspace' : 'ideaspace';
}
const KEYS_FILE = 'keys/regions.json';
const BAGS_FILE = 'keys/bags.json';
const ITEMS_FILE = 'keys/items.json';
const TAKEN_FILE = 'keys/taken.json';
const CHESTS_FILE = 'keys/chests.json';
const MINE_FILE = 'keys/mine.json';
/** How many seen chests are kept; the oldest seen go first. */
const CHESTS_KEPT = 1000;
function alignedBaseOf(p, height) {
    const h = BigInt(height);
    return { x: ((p.x >> h) << h).toString(), y: ((p.y >> h) << h).toString(), z: ((p.z >> h) << h).toString() };
}
export class KeyStore {
    dir;
    keys = new Map();
    bags = new Map();
    /** Key items held, by their public half. */
    items = new Map();
    /** Contents taken out of chests, by their event id. */
    taken = new Map();
    /** Chests seen, by their event id. */
    chests = new Map();
    /** The agent's own bags, by lookup id: never trimmed. */
    mine = new Map();
    /** The thing placed or moved most recently, kept with the own bags. */
    lastPlaced = null;
    /** Move rollbacks not yet settled. */
    putBacks = [];
    constructor(dir) {
        this.dir = dir;
        const own = dir.readJson(MINE_FILE, null);
        if (own?.version === 1)
            for (const b of own.bags)
                this.mine.set(b.lookupId, b);
        this.lastPlaced = own?.last ?? null;
        this.putBacks = own?.putBacks ?? [];
        const keys = dir.readJson(KEYS_FILE, null);
        if (keys?.version === 1)
            for (const k of keys.keys)
                this.keys.set(k.lookupId, k);
        const bags = dir.readJson(BAGS_FILE, null);
        if (bags?.version === 1)
            for (const b of bags.bags)
                this.bags.set(b.lookupId, b);
        const items = dir.readJson(ITEMS_FILE, null);
        if (items?.version === 1)
            for (const i of items.items)
                this.items.set(i.itemPubkey, i);
        const taken = dir.readJson(TAKEN_FILE, null);
        if (taken?.version === 1)
            for (const t of taken.taken)
                this.taken.set(t.id, t);
        const chests = dir.readJson(CHESTS_FILE, null);
        if (chests?.version === 1)
            for (const c of chests.chests)
                this.chests.set(c.id, c);
    }
    /**
     * Hold a key item: from now on a chest sealed to it opens. An item already
     * held keeps its row (ONOSENDAI addHeld), so a key read again, in a rescan
     * or inside a chest, is held once and its first holding stands. Returns
     * whether it was new. One thing is filled in on a row already held: a row
     * from before the item's own tags were kept gains them (and the model and
     * motions they name) the next time the item is read, and nothing else of
     * it changes.
     */
    holdItem(item) {
        const had = this.items.get(item.itemPubkey);
        if (had) {
            if (had.carried === undefined && item.carried !== undefined) {
                this.items.set(item.itemPubkey, { ...had, ...(had.model ? {} : lookOf(item)), carried: item.carried });
                this.dir.writeJson(ITEMS_FILE, { version: 1, items: [...this.items.values()] });
            }
            return false;
        }
        this.items.set(item.itemPubkey, item);
        this.dir.writeJson(ITEMS_FILE, { version: 1, items: [...this.items.values()] });
        return true;
    }
    /** Keep a content taken out of a chest. One row per content; returns whether it was new. */
    take(item) {
        if (this.taken.has(item.id))
            return false;
        this.taken.set(item.id, item);
        this.dir.writeJson(TAKEN_FILE, { version: 1, taken: [...this.taken.values()] });
        return true;
    }
    /**
     * Remember a chest seen, sealed. A chest seen again keeps where it was
     * first seen; it only gains `vouches` when a later sighting proves its
     * author (a first sighting may have been an unsigned copy, whose id is the
     * same hash).
     */
    noteChest(chest) {
        const seen = this.chests.get(chest.id);
        if (seen) {
            if (chest.vouches && !seen.vouches && seen.inChest) {
                seen.vouches = true;
                this.dir.writeJson(CHESTS_FILE, { version: 1, chests: [...this.chests.values()] });
            }
            return;
        }
        this.chests.set(chest.id, chest);
        if (this.chests.size > CHESTS_KEPT) {
            const oldest = [...this.chests.values()].sort((a, b) => a.seenAt - b.seenAt).slice(0, this.chests.size - CHESTS_KEPT);
            for (const c of oldest)
                this.chests.delete(c.id);
        }
        this.dir.writeJson(CHESTS_FILE, { version: 1, chests: [...this.chests.values()] });
    }
    /** Record what an opened chest holds, by id and type. */
    noteChestContents(chestId, contents) {
        const c = this.chests.get(chestId);
        if (!c || (c.contents && c.contents.length === contents.length && c.contents.every((x, i) => x.id === contents[i].id)))
            return;
        c.contents = contents;
        this.dir.writeJson(CHESTS_FILE, { version: 1, chests: [...this.chests.values()] });
    }
    /** The seen chests this item opens: those locked to its public key (ONOSENDAI chestsOpenedBy). */
    chestsOpenedBy(itemPubkey) {
        return [...this.chests.values()].filter((c) => c.lockPubkey === itemPubkey);
    }
    /** The held items as a chest opener needs them. */
    heldItems() {
        return [...this.items.values()].map((i) => ({ itemPubkey: i.itemPubkey, secretHex: i.secretHex }));
    }
    save() {
        this.dir.writeJson(KEYS_FILE, { version: 1, keys: [...this.keys.values()] });
    }
    saveBags() {
        this.dir.writeJson(BAGS_FILE, { version: 1, bags: [...this.bags.values()] });
    }
    trim(map) {
        if (map.size <= KEYS_KEPT)
            return;
        const oldest = [...map.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, map.size - KEYS_KEPT);
        for (const [k] of oldest)
            map.delete(k);
    }
    /** The key for the cube of `height` containing `position`: held already, or derived now and held. */
    keyAt(position, height, source = 'scan', now = Math.floor(Date.now() / 1000)) {
        const base = alignedBaseOf(position, height);
        for (const k of this.keys.values()) {
            if (k.height === height && k.base.x === base.x && k.base.y === base.y && k.base.z === base.z) {
                k.at = now;
                return k;
            }
        }
        const derived = regionKeyAt(position, height, MAX_COMPUTE_HEIGHT);
        const key = { lookupId: derived.lookupId, keyHex: bytesToHex(derived.key), height, base, source, at: now };
        this.keys.set(key.lookupId, key);
        this.trim(this.keys);
        this.save();
        return key;
    }
    /** The keys of the cubes around a position, heights 0 to `maxHeight` (the passive scan, spec 7.4, as ONOSENDAI scans). */
    scanAround(position, maxHeight = SCAN_MAX_HEIGHT, source = 'scan') {
        const out = [];
        for (let h = SCAN_MIN_HEIGHT; h <= maxHeight; h++)
            out.push(this.keyAt(position, h, source));
        return out;
    }
    byLookupId(lookupId) {
        return this.keys.get(lookupId);
    }
    /** Whether a cube of `height` at `base` contains `position`. */
    static contains(key, position) {
        const h = BigInt(key.height);
        return (position.x >> h) === (BigInt(key.base.x) >> h) && (position.y >> h) === (BigInt(key.base.y) >> h) && (position.z >> h) === (BigInt(key.base.z) >> h);
    }
    /** The held keys whose cube contains the position: what the agent can read where it stands. */
    keysContaining(position) {
        return [...this.keys.values()].filter((k) => KeyStore.contains(k, position)).sort((a, b) => a.height - b.height);
    }
    noteBag(bag) {
        this.bags.set(bag.lookupId, bag);
        this.trim(this.bags);
        this.saveBags();
    }
    forgetBag(lookupId) {
        if (this.bags.delete(lookupId))
            this.saveBags();
    }
    /**
     * Record a version of one of the agent's own bags: written (`bagId`), or
     * taken down (`deleted`). `at` is its created_at. The newest stands, so a
     * record never moves backwards.
     */
    noteOwnBag(key, at, change) {
        const was = this.mine.get(key.lookupId);
        const row = was ? { ...was } : { lookupId: key.lookupId, keyHex: key.keyHex, height: key.height, base: { ...key.base }, lastAt: 0 };
        if ('bagId' in change) {
            if (at >= row.lastAt) {
                row.lastAt = at;
                row.lastBagId = change.bagId;
                if (change.event)
                    row.lastEvent = change.event;
                else if (row.lastEvent && row.lastEvent.id !== change.bagId)
                    delete row.lastEvent;
            }
        }
        else {
            row.deletedAt = Math.max(row.deletedAt ?? 0, at);
        }
        this.mine.set(key.lookupId, row);
        this.saveMine();
    }
    saveMine() {
        this.dir.writeJson(MINE_FILE, { version: 1, bags: [...this.mine.values()], ...(this.lastPlaced ? { last: this.lastPlaced } : {}), ...(this.putBacks.length ? { putBacks: this.putBacks } : {}) });
    }
    /** Keep a move's rollback on disk before the move publishes anything. */
    holdPutBack(p) {
        this.putBacks = [...this.putBacks.filter((x) => x.rollback.id !== p.rollback.id), p];
        this.saveMine();
    }
    /** The rollback is settled: put back, or no longer needed. */
    settlePutBack(rollbackId) {
        this.putBacks = this.putBacks.filter((x) => x.rollback.id !== rollbackId);
        this.saveMine();
    }
    /** Remember the thing just placed or moved, by its bag and its entry key. */
    notePlaced(lookupId, entryKey, at) {
        this.lastPlaced = { lookupId, entryKey, at };
        this.saveMine();
    }
    /**
     * A deletion of an own bag was signed at `at`: the version kept whole is
     * forgotten when it is not newer, whatever the relays said (review of #32,
     * round 2: kept, it brought a deleted bag back once the outbox trimmed the
     * deletion). A relay that still holds the bag answers the read anyway, so
     * nothing is lost. `taken`: a relay took it, so it also counts as done.
     */
    noteOwnDeletion(lookupId, at, taken) {
        const row = this.mine.get(lookupId);
        if (!row)
            return;
        const next = { ...row };
        if (next.lastEvent && next.lastEvent.created_at <= at)
            delete next.lastEvent;
        if (taken)
            next.deletedAt = Math.max(next.deletedAt ?? 0, at);
        this.mine.set(lookupId, next);
        this.saveMine();
    }
    /** The least created_at the next version of an own bag may carry: newer than every version and deletion this server signed. */
    ownBagFloor(lookupId) {
        const b = this.mine.get(lookupId);
        return b ? Math.max(b.lastAt, b.deletedAt ?? 0) + 1 : 0;
    }
    /** An item the agent holds moved with the key item that carries it: the row follows the new event and place. */
    movedItem(oldEventId, newEventId, place) {
        let changed = false;
        for (const i of this.items.values()) {
            if (i.eventId === oldEventId) {
                i.eventId = newEventId;
                i.place = place;
                changed = true;
            }
        }
        if (changed)
            this.dir.writeJson(ITEMS_FILE, { version: 1, items: [...this.items.values()] });
    }
    /** The opened bags whose cube contains the position. */
    bagsContaining(position) {
        return [...this.bags.values()].filter((b) => {
            const h = BigInt(b.height);
            return (position.x >> h) === (BigInt(b.base.x) >> h) && (position.y >> h) === (BigInt(b.base.y) >> h) && (position.z >> h) === (BigInt(b.base.z) >> h);
        }).sort((a, b) => a.height - b.height);
    }
}
//# sourceMappingURL=regionKeys.js.map