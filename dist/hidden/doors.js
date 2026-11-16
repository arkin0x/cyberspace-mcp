// doors.ts: a locked door and its room (DECK-0004 §3.7), ported from
// ONOSENDAI src/lib/doors.ts (origin/v2 4db7253e) so a door this server
// writes opens in ONOSENDAI exactly as one ONOSENDAI writes.
//
// A door is a chest (kind 3341) with one `["door", "<height>"]` tag and,
// optionally, `look` tags (§3.6): the closed look drawn until its user opens
// it, and the open look after. Its sealed plaintext is one entry,
// `["room", "<door secret, 64 lowercase hex>"]`. What its author hides in
// the room (the aligned region of the door's height that holds its C, in its
// plane) at exactly that height goes into a room bag: an ordinary kind 33330
// keyed by
//
//   room_key       = SHA-256( UTF-8("cyberspace:door") || location_key || door_secret )
//   room_lookup_id = SHA-256( room_key )
//
// signed by the door's signer, with no height, hint, sector or contents tag
// and an empty content.
//
// The door secret is knowledge, as an item is. This server keeps the secrets
// of the doors it sealed in its state directory (keys/doors.json, mode 600, like
// the agent's key and its items), so it can hide more in a room later; it
// never shows one in a tool's answer and never writes one anywhere else. A
// finder learns it only by opening the door. One secret per room: a second
// door of the same signer, height, region and plane reuses it (§3.7.5); a
// room in the other plane gets a secret of its own.
import { createHash, randomBytes } from 'node:crypto';
/** The domain prefix of a room key (§3.7.2): 15 ASCII bytes. */
export const DOOR_KDF_PREFIX = 'cyberspace:door';
/** The largest look written, in bytes of its payload (ONOSENDAI looks.ts MAX_LOOK_BYTES; §3.6 Size). */
export const MAX_LOOK_BYTES = 16_384;
const HEX64 = /^[0-9a-f]{64}$/;
/** A room's key: SHA-256 of the prefix, the room region's location key and the door secret (§3.7.2). */
export function roomKey(locationKey, doorSecret) {
    if (locationKey.length !== 32 || doorSecret.length !== 32)
        throw new Error('A room key needs a 32-byte location key and a 32-byte door secret.');
    return new Uint8Array(createHash('sha256').update(Buffer.from(DOOR_KDF_PREFIX, 'utf8')).update(locationKey).update(doorSecret).digest());
}
/** A room bag's `d`: SHA-256 of its key, 64 lowercase hex (§3.7.2). */
export function roomLookupId(key) {
    return createHash('sha256').update(key).digest('hex');
}
/** A room bag as published (§3.7.2): no height, no hint, no sector, no contents, an empty content. */
export const ROOM_BAG_SETTINGS = { heightTag: false, hint: null, riddle: '', contents: false, money: false };
/** A new door secret: 32 bytes from the platform's secure source, as hex. One per room (§3.7.5). */
export function newDoorSecret() {
    return randomBytes(32).toString('hex');
}
/** A door's plaintext entries (§3.7.1): exactly one room entry. */
export function roomEntries(secretHex) {
    if (!HEX64.test(secretHex))
        throw new Error('A door secret is 64 lowercase hex characters.');
    return [['room', secretHex]];
}
/** The door secret in a door's decrypted plaintext: the first well-formed room entry, or null. */
export function doorSecretOf(plaintext) {
    let parsed;
    try {
        parsed = JSON.parse(plaintext);
    }
    catch {
        return null;
    }
    if (!Array.isArray(parsed))
        return null;
    for (const e of parsed)
        if (Array.isArray(e) && e[0] === 'room' && typeof e[1] === 'string' && HEX64.test(e[1]))
            return e[1];
    return null;
}
/** Whether a point is inside the room of a door standing at `door` with height `h` (the same plane is the caller's to check). */
export function inRoom(door, h, p) {
    const s = BigInt(h);
    return (p.x >> s) === (door.x >> s) && (p.y >> s) === (door.y >> s) && (p.z >> s) === (door.z >> s);
}
/** The aligned base of the region of height `h` holding a point. */
export function regionBase(at, h) {
    const s = BigInt(h);
    return { x: (at.x >> s) << s, y: (at.y >> s) << s, z: (at.z >> s) << s };
}
const DOORS_FILE = 'keys/doors.json';
/** The doors this server sealed, with their secrets, kept in the state directory (mode 600). */
export class DoorStore {
    dir;
    doors;
    constructor(dir) {
        this.dir = dir;
        const f = dir.readJson(DOORS_FILE, null);
        this.doors = f?.version === 1 && Array.isArray(f.doors) ? f.doors.filter((d) => HEX64.test(d.secret)) : [];
    }
    /** The room a placement at this point, plane and height falls in: one of this server's doors of exactly that height (§3.7.4), or null. */
    roomAt(at, plane, height) {
        return this.doors.find((d) => d.height === height && d.plane === plane && inRoom(toPos(d.at), d.height, at)) ?? null;
    }
    /** The secret for a new door here: the room's own when it already has a door of this signer (§3.7.5), else a fresh one. */
    secretFor(at, plane, height) {
        return this.roomAt(at, plane, height)?.secret ?? newDoorSecret();
    }
    /** Keep a door once its bag is written. */
    add(door) {
        this.doors.push(door);
        this.save();
    }
    /** One of these doors, by its event id. */
    byId(id) {
        return this.doors.find((d) => d.doorId === id) ?? null;
    }
    /** The other doors of a door's room: the same signer (all of these are), height, region and plane (§3.7.5). */
    siblings(door) {
        return this.doors.filter((d) => d !== door && d.height === door.height && d.plane === door.plane && inRoom(toPos(door.at), door.height, toPos(d.at)));
    }
    /** Remember a room's bag, on every door of the room. */
    noteRoom(door, lookupId) {
        let changed = false;
        for (const d of [door, ...this.siblings(door)])
            if (d.roomLookupId !== lookupId) {
                d.roomLookupId = lookupId;
                changed = true;
            }
        if (changed)
            this.save();
    }
    /** Whether a bag is the room bag of one of these doors. */
    isRoomBag(lookupId) {
        return this.doors.some((d) => d.roomLookupId === lookupId);
    }
    /** Forget a door once it is removed. */
    remove(id) {
        const i = this.doors.findIndex((d) => d.doorId === id);
        if (i >= 0) {
            this.doors.splice(i, 1);
            this.save();
        }
    }
    save() {
        this.dir.writeJson(DOORS_FILE, { version: 1, doors: this.doors });
    }
}
const toPos = (p) => ({ x: BigInt(p.x), y: BigInt(p.y), z: BigInt(p.z) });
//# sourceMappingURL=doors.js.map