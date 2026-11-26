// placed.ts: what the agent has placed, and taking it down or moving it
// (arkinox, 2026-10-20: "xor doesn't know how to delete shards or bags he's
// placed ... and how to edit their shards if you tell them 'move this 12
// gibsons toward Z+'").
//
// The semantics are ONOSENDAI's, so what an agent removes or moves reads in
// ONOSENDAI exactly as if a person had done it there (origin/v2 9a1072f and
// later, src/store/useShards.ts deleteInstance and deploy's EDIT, PR #369):
//
//   - DELETE of one thing rewrites the region's bag (kind 33330, d = lookup
//     id) without it, from the bag as the relays hold it now, so nothing
//     else in the bag is lost; when it was the last thing, the envelope
//     itself is deleted (NIP-09 kind 5 naming the bag's address and id).
//   - A shard hidden by reference is also its own kind 33331, sealed to the
//     place. Once no bag of the agent's names it, and the relays hold this
//     very version, it is taken down too (NIP-09). An object someone else
//     published (a LIVE LINK) is never taken down, and neither is a public
//     object of the agent's own: removing a placement does not unpublish it.
//   - A MOVE signs the item again at its new place with `["d", <first
//     version's id>]` (its lineage), so comments and reactions follow it; a
//     reference keeps its object's `d` and is never retracted by a move. A
//     move inside one bag is one rewrite; to another region, the new bag is
//     written first and the old one rewritten without it after. A shard by
//     reference that changes region is sealed again to the new region under
//     the same `d`, and the old version signed again is kept to put back if
//     the new bag reaches no relay.
//   - A change of a shard's WALK setting (constrain_placed, ONOSENDAI's
//     EDIT row CONSTRAIN MOVEMENT IN WALK MODE, #461 and #476) writes that
//     placement's payload again where it is (DECK-0003 1.12, "One placement,
//     one setting"): an inline shard is signed again with its lineage and its
//     bag rewritten in one step; a shard by reference is its own sealed
//     object, sealed again to the same place under the same `d`, so the bag,
//     which names it by its address, is not touched. A public object placed
//     by reference is its author's, so its setting is theirs too: refused.
//
// Every rewrite reads the bag first: the newest version any relay that
// answered returns, or that this server signed and still has in its outbox.
// It refuses when no relay answered, when the bag does not open with the
// key, and when this server signed a newer version than any it can see,
// because writing over a bag it cannot see whole is how things get lost.
// One bag is changed by one call at a time (withBags).
import { coordToXyz, hexToCoord } from 'cyberspace-core';
import { HIDDEN_KIND, OBJECT_KIND, bagGrowthRefusal, PROTECTED_TAG, SHARD_KIND, bagSettingsOf, bagTemplate, ciphertextOf, editedTemplate, entryKey, hintPlaneFor, isReference, itemLineage, messagePreview, namesNoPlane, planeOfEntry, resealedObject, rumorOf, sealedCopy, sealedAsRumor, unbag, } from './hidden/bags.js';
import { decryptForRegion } from './hidden/crypto.js';
import { hintFits } from './hidden/hint.js';
import { attributed, hexToBytes, nowSeconds } from './nostr/event.js';
import { mergeAnswers } from './nostr/relayOutcome.js';
import { normalizeURL } from 'nostr-tools/utils';
import { objectHandle } from './render.js';
import { parseCoordinate, placeOf } from './space/coords.js';
import { Refusal } from './tool.js';
import { readOpacity } from 'sno-core/shards';
import { CONSTRAIN_WORDS, authoredConstrainOf, chosenConstrain, chosenConstrainOf, rawConstrain, rewritePayload, walkWords, withAuthoredConstrain } from './walkConstrain.js';
import { toPayload } from 'sno-core/shards';
import { UNLABELLED, groupKey } from './builds.js';
import { randomBytes } from 'node:crypto';
/** A fresh d for an object sealed again on restore. */
function randomBytes16() {
    return randomBytes(16).toString('hex');
}
import { RESTORE_WORDS, withoutTokens } from './trash.js';
import { DEFAULT_DELETE_APPROVAL_THRESHOLD } from './approvals.js';
/** The words an agent may use for "the thing I placed most recently". */
const LAST_WORDS = new Set(['last', 'latest', 'newest', 'recent', 'most recent', 'the last one', 'it', 'this', 'that']);
/** The most of the agent's bags one listing asks a relay for: what strfry gives at most by default; a full answer is read as possibly cut short. */
const MAX_OWN_BAGS = 500;
/** The kinds a target's type names, for "the shard", "the message". */
const TYPE_WORDS = { shard: 'shard', object: 'shard', message: 'message', note: 'message', key: 'key', item: 'key', chest: 'chest', audio: 'audio', sound: 'audio' };
/** How long a put-back waits between its tries, in ms. */
const PUT_BACK_RETRY_MS = [500, 1500];
/** The most shards one constrain_placed call changes: each is a signature, and a sealed one a publish of its own. */
export const MAX_CONSTRAIN_PER_CALL = 100;
/** The most shards one constrain_placed call tries, changed or refused, so a call the relays keep refusing still ends soon (review of #46, N1). */
export const MAX_CONSTRAIN_ATTEMPTS_PER_CALL = 2 * MAX_CONSTRAIN_PER_CALL;
export { DEFAULT_DELETE_APPROVAL_THRESHOLD };
/** The entries of an envelope, opened with its region key; null when it does not open (the wrong key, or not a list). */
export async function openEntries(outer, regionKey) {
    const ct = ciphertextOf(outer);
    if (!ct)
        return null;
    const json = await decryptForRegion(regionKey, ct);
    if (json === null)
        return null;
    let arr;
    try {
        arr = JSON.parse(json);
    }
    catch {
        return null;
    }
    if (!Array.isArray(arr))
        return null;
    return arr.filter((e) => isReference(e) || (!!e && !Array.isArray(e) && typeof e === 'object' && typeof e.kind === 'number'));
}
/** Union of bag entries by identity, order kept (ONOSENDAI mergeEntries). */
function mergeEntries(a, b) {
    const seen = new Set(a.map(entryKey));
    const out = a.slice();
    for (const e of b) {
        const k = entryKey(e);
        if (!seen.has(k)) {
            seen.add(k);
            out.push(e);
        }
    }
    return out;
}
/**
 * The event a reference entry names, as the signed event it always is: an
 * object hidden by reference is published on its own, so it was signed here
 * or verified with its signature when it was read (bags.ts fromReference).
 * Only an item carried inline, a message, is ever a rumor. For a row whose
 * entry is a reference only.
 */
function referenced(inner) {
    return inner;
}
function dOf(ev) {
    return ev.tags.find((t) => t[0] === 'd')?.[1] ?? '';
}
/** Newer by created_at; on a tie the lower id, as a relay keeps (NIP-01). */
function newer(a, b) {
    return !b || a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id);
}
/** The point a bag entry sits at: an inline item's C tag, a reference's coordinate, or null. */
function entryPoint(e) {
    const hex = isReference(e) ? e[3] : e.tags?.find((t) => t[0] === 'C')?.[1];
    if (!hex || !/^[0-9a-f]{64}$/.test(hex))
        return null;
    const { x, y, z, plane } = coordToXyz(hexToCoord(hex));
    return { position: { x, y, z }, plane };
}
/** What placed calls a thing: a message's first words, or a shard's, key's, chest's or audio's name. */
export function labelOf(h) {
    return h.type === 'message' ? messagePreview(h.text ?? '', 60) : h.type === 'shard' ? (h.shard?.name ?? 'shard') : h.type === 'key' ? (h.key?.name ?? 'key') : h.type === 'audio' ? (h.audio?.title ?? 'audio') : (h.chest?.name ?? 'chest');
}
function words(p) {
    return `x ${p.x} y ${p.y} z ${p.z}`;
}
function relayWords(entry) {
    const refused = Object.entries(entry.refused ?? {}).map(([u, r]) => `${u}: ${r}`);
    return [
        entry.accepted.length ? `accepted by ${entry.accepted.join(', ')}` : 'no relay accepted it yet (the outbox retries)',
        refused.length ? `refused by ${refused.join('; ')} (verbatim)` : '',
    ].filter(Boolean).join('; ');
}
export class Placements {
    host;
    locks = new Map();
    constructor(host) {
        this.host = host;
        // Bags hidden before this record existed (2026-10-20): every bag of the
        // agent's that find or hide noted, with the key still held, is its own.
        for (const b of host.keys.bags.values()) {
            if (b.author !== host.pubkey || host.keys.mine.has(b.lookupId))
                continue;
            const key = host.keys.byLookupId(b.lookupId);
            if (key)
                host.keys.noteOwnBag(key, b.createdAt, { bagId: b.bagId });
        }
        // A move the server stopped in the middle of: its new bag recorded means it finished, and the rollback is not needed; else the old object goes back.
        for (const p of [...host.keys.putBacks]) {
            if (host.keys.mine.get(p.newLookupId)?.lastBagId !== p.newBagId) {
                host.outbox.add(p.rollback);
                host.log(`placed: a move stopped midway; its shard's old object ${p.rollback.id.slice(0, 8)}... goes back out through the outbox`);
            }
            host.keys.settlePutBack(p.rollback.id);
        }
    }
    /** The canonical relay, as relays name themselves in answers and outbox entries. */
    get canonical() {
        return normalizeURL(this.host.relays.canonical);
    }
    /** Whether a deletion in the outbox counts: the canonical relay took it, or may still take it (not dropped, not refused there). A lesser relay taking it is not enough (review of #32, round 3). */
    liveDeletion(o) {
        return !o.dropped && o.refused?.[this.canonical] === undefined;
    }
    /** The least created_at the next version of an own bag may carry: newer than every version this server signed and every deletion of it it sent. */
    floor(lookupId) {
        const address = `${HIDDEN_KIND}:${this.host.pubkey}:${lookupId}`;
        const deletions = this.host.outbox.entries.filter((o) => o.event.kind === 5 && o.event.pubkey === this.host.pubkey && o.event.tags.some((t) => t[0] === 'a' && t[1] === address)).map((o) => o.event.created_at + 1);
        return Math.max(this.host.keys.ownBagFloor(lookupId), ...deletions);
    }
    // ---- one bag at a time ------------------------------------------------------
    /** Run `fn` holding every bag of `ids`: one change to a bag at a time, in lookup id order so two calls never wait on each other. */
    async withBags(ids, fn) {
        const releases = [];
        try {
            for (const id of [...new Set(ids)].sort())
                releases.push(await this.lock(id));
            return await fn();
        }
        finally {
            for (const r of releases.reverse())
                r();
        }
    }
    lock(id) {
        const prev = this.locks.get(id) ?? Promise.resolve();
        let release;
        const mine = new Promise((r) => { release = r; });
        const tail = prev.then(() => mine);
        this.locks.set(id, tail);
        return prev.then(() => () => {
            release();
            if (this.locks.get(id) === tail)
                this.locks.delete(id);
        });
    }
    // ---- reading the agent's own bags ------------------------------------------
    /**
     * The newest version of one of the agent's bags among these events, the
     * outbox, and the newest version this server signed (kept whole in
     * keys/mine.json), or null when there is none or it was deleted since. So
     * a rewrite never builds on an older copy than one this server wrote.
     */
    newestOwn(lookupId, fromRelays) {
        const me = this.host.pubkey;
        const mineHere = (e) => e.kind === HIDDEN_KIND && e.pubkey === me && dOf(e) === lookupId;
        let best = null;
        for (const e of fromRelays)
            if (mineHere(e) && newer(e, best))
                best = e;
        for (const o of this.host.outbox.entries)
            if (!o.dropped && mineHere(o.event) && newer(o.event, best))
                best = o.event;
        const kept = this.host.keys.mine.get(lookupId)?.lastEvent;
        if (kept && mineHere(kept) && newer(kept, best))
            best = kept;
        if (!best)
            return null;
        // Taken down since: a deletion a relay took (the record), or one in the outbox that a relay took or may still take.
        const address = `${HIDDEN_KIND}:${me}:${lookupId}`;
        const deletedAt = Math.max(this.host.keys.mine.get(lookupId)?.deletedAt ?? 0, ...this.host.outbox.entries.filter((o) => o.event.kind === 5 && o.event.pubkey === me && o.event.tags.some((t) => t[0] === 'a' && t[1] === address) && this.liveDeletion(o)).map((o) => o.event.created_at));
        return deletedAt >= best.created_at ? null : best;
    }
    /**
     * Which of these versions, held only by this server, a deletion on the
     * relays took down: a kind 5 by the agent naming the bag's address or the
     * version's id, at least as new (review of #32, round 2: another session's
     * deletion, or one the outbox no longer carries). By lookup id. Each one
     * found is recorded, so the next version is newer than the deletion and no
     * relay takes it down with the old one.
     */
    async deletedElsewhere(versions) {
        const out = new Set();
        if (versions.length === 0)
            return out;
        const me = this.host.pubkey;
        const byAddress = new Map(versions.map((v) => [`${HIDDEN_KIND}:${me}:${dOf(v)}`, v]));
        const byId = new Map(versions.map((v) => [v.id, v]));
        const answers = await Promise.all([
            this.host.relays.queryEach({ kinds: [5], authors: [me], '#a': [...byAddress.keys()] }),
            this.host.relays.queryEach({ kinds: [5], authors: [me], '#e': [...byId.keys()] }),
        ]);
        for (const del of mergeAnswers(answers.flat())) {
            for (const t of del.tags) {
                const v = t[0] === 'a' ? byAddress.get(t[1]) : t[0] === 'e' ? byId.get(t[1]) : undefined;
                if (v && (t[0] === 'e' || del.created_at >= v.created_at)) {
                    out.add(dOf(v));
                    this.host.keys.noteOwnDeletion(dOf(v), Math.max(del.created_at, v.created_at), true);
                }
            }
        }
        return out;
    }
    static answered(answers) {
        return answers.filter((a) => a.outcome === 'answered');
    }
    static silentWords(answers) {
        return answers.flatMap((a) => (a.outcome === 'answered' ? [] : [`${a.url}: ${a.reason}`]));
    }
    /**
     * One of the agent's bags as it stands now, read before it is written:
     * the newest version the relays that answered hold, the outbox carries, or
     * this server signed last, and its entries, every one of them, whether or
     * not this server reads it. The canonical relay must answer, since it is
     * where every reader looks and where a rewrite lands (review of #32: a
     * rewrite from a lesser relay's older copy dropped what only the canonical
     * relay held).
     */
    async ownBag(lookupId, regionKey) {
        const answers = await this.host.relays.queryEach({ kinds: [HIDDEN_KIND], authors: [this.host.pubkey], '#d': [lookupId] });
        const silent = Placements.silentWords(answers);
        if (!answers.some((a) => a.outcome === 'answered' && normalizeURL(a.url) === this.canonical)) {
            throw new Refusal(`The canonical relay did not answer when asked for your bag in that cube (${silent.join('; ') || 'no answer'}). Nothing was changed: writing the bag without reading it there first could drop what it holds. Try again shortly.`);
        }
        const events = mergeAnswers(answers);
        let current = this.newestOwn(lookupId, events);
        if (current && !events.some((e) => e.id === current.id) && (await this.deletedElsewhere([current])).has(lookupId))
            current = null;
        if (!current)
            return { current: null, entries: [], silent };
        const entries = await openEntries(current, regionKey);
        if (entries === null)
            throw new Refusal(`Your bag in that cube (${current.id.slice(0, 8)}...) does not open with the key derived for it, so rewriting it would destroy what is there. Nothing was published.`);
        return { current, entries, silent };
    }
    /** Every bag of the agent's on the relays (and in its outbox), opened where a key is held, each thing in it as a row. */
    async readAll() {
        const answers = await this.host.relays.queryEach({ kinds: [HIDDEN_KIND], authors: [this.host.pubkey], limit: MAX_OWN_BAGS });
        if (Placements.answered(answers).length === 0) {
            throw new Refusal(`No relay answered when asked for your bags (${Placements.silentWords(answers).join('; ')}). Try again shortly.`);
        }
        const events = mergeAnswers(answers);
        const silent = Placements.silentWords(answers);
        for (const a of answers)
            if (a.outcome === 'answered' && a.events.length >= MAX_OWN_BAGS)
                silent.push(`${a.url}: returned ${a.events.length} bags, the most it gives at once, so some may be missing`);
        const ids = new Set();
        for (const e of events)
            if (e.kind === HIDDEN_KIND && e.pubkey === this.host.pubkey)
                ids.add(dOf(e));
        for (const o of this.host.outbox.entries)
            if (!o.dropped && o.event.kind === HIDDEN_KIND && o.event.pubkey === this.host.pubkey)
                ids.add(dOf(o.event));
        for (const b of this.host.keys.mine.values())
            if (b.lastEvent)
                ids.add(b.lookupId);
        // A version only this server holds, that a deletion on the relays (another session's, or one the outbox no longer carries) took down, is gone.
        const onlyHere = [...ids].map((d) => this.newestOwn(d, events)).filter((e) => !!e && !events.some((x) => x.id === e.id));
        const deleted = await this.deletedElsewhere(onlyHere);
        const bags = [];
        const unopened = [];
        for (const lookupId of ids) {
            const ev = this.newestOwn(lookupId, events);
            if (!ev || deleted.has(lookupId))
                continue;
            const own = this.host.keys.mine.get(lookupId);
            const held = this.host.keys.byLookupId(lookupId);
            const keyHex = own?.keyHex ?? held?.keyHex ?? null;
            const height = own?.height ?? held?.height ?? null;
            const base = own?.base ?? held?.base ?? null;
            const settings = bagSettingsOf(ev, height ?? 0);
            const bag = {
                lookupId, bagId: ev.id, height: height ?? -1, base, createdAt: ev.created_at, riddle: settings.riddle, entries: [], keyHeld: !!keyHex, opened: false,
                onlyHere: !events.some((e) => e.id === ev.id), event: ev, keyHex, rows: [],
            };
            const raw = keyHex ? await openEntries(ev, hexToBytes(keyHex)) : null;
            if (!raw || !keyHex || height === null || !base) {
                unopened.push(lookupId);
                bags.push(bag);
                continue;
            }
            bag.opened = true;
            if (!own && held)
                this.host.keys.noteOwnBag(held, ev.created_at, { bagId: ev.id });
            const origin = { at: { x: BigInt(base.x), y: BigInt(base.y), z: BigInt(base.z) }, plane: 0 };
            const opened = (await unbag(ev, hexToBytes(keyHex), (ref) => this.host.resolveReference(ref), origin, height)).map((h) => this.host.quiet?.(h) ?? h);
            for (const e of raw)
                bag.rows.push(this.rowOf(e, opened, bag));
            bag.entries = bag.rows.map(Placements.publicRow);
            bags.push(bag);
        }
        bags.sort((a, b) => b.createdAt - a.createdAt);
        return { bags, unopened, silent };
    }
    rowOf(e, opened, bag) {
        const key = entryKey(e);
        const h = opened.find((x) => (isReference(e) ? !!x.ref && entryKey(x.ref) === key : !x.ref && x.inner.id === e.id)) ?? null;
        const point = entryPoint(e);
        const at = h ? { x: h.at.x.toString(), y: h.at.y.toString(), z: h.at.z.toString() } : point ? { x: point.position.x.toString(), y: point.position.y.toString(), z: point.position.z.toString() } : (bag.base ?? { x: '?', y: '?', z: '?' });
        const plane = (h?.plane ?? point?.plane ?? 0);
        // No C on the entry (and, for a reference, none on what it names): in both planes, never assumed to be dataspace.
        const anyPlane = planeOfEntry(e) === null && (h ? namesNoPlane(h) : true) ? { anyPlane: true } : {};
        if (isReference(e)) {
            const sealed = !!h && h.inner.kind === OBJECT_KIND && h.inner.tags.some((t) => t[0] === 'encrypted');
            const id = sealed ? h.inner.id : objectHandle(`${bag.lookupId}/${key}`);
            return {
                id, lineage: e[0] === 'a' ? e[1] : null, type: h ? h.type : 'unreadable', label: h ? labelOf(h) : `a reference this server could not retrieve (${e[1].slice(0, 24)}...)`,
                at, plane, ...anyPlane, createdAt: h?.createdAt ?? bag.createdAt, byReference: h ? (sealed ? 'sealed' : 'public') : undefined, objectAddress: e[0] === 'a' ? e[1] : undefined,
                key, entry: e, hidden: h, bag,
            };
        }
        const inner = e;
        return {
            id: String(inner.id ?? objectHandle(`${bag.lookupId}/${key}`)), lineage: h ? itemLineage(h.inner) : null, type: h ? h.type : 'unreadable',
            label: h ? labelOf(h) : `an entry of kind ${inner.kind} this server does not read (kept as it is)`,
            at, plane, ...anyPlane, createdAt: typeof inner.created_at === 'number' ? inner.created_at : bag.createdAt, key, entry: e, hidden: h, bag,
        };
    }
    static publicRow(r) {
        const { id, lineage, type, label, at, plane, anyPlane, createdAt, byReference, objectAddress } = r;
        const shard = r.hidden?.shard;
        const walk = shard ? { constrain: chosenConstrainOf(shard) ?? null, opacity: readOpacity(shard.opacity) ?? 100 } : undefined;
        return { id, lineage, type, label, at, plane, ...(anyPlane ? { anyPlane } : {}), createdAt, ...(byReference ? { byReference } : {}), ...(objectAddress ? { objectAddress } : {}), ...(walk ? { walk } : {}) };
    }
    static rows(reading) {
        return reading.bags.flatMap((b) => b.rows);
    }
    /**
     * The newest thing placed or moved: what "this" and "last" mean. The one
     * this server last hid or moved, while it is still there; else the newest
     * by its signature's time.
     */
    last(rows) {
        const noted = this.host.keys.lastPlaced;
        const hit = noted ? rows.find((r) => r.bag.lookupId === noted.lookupId && r.key === noted.entryKey) : undefined;
        if (hit)
            return hit;
        return rows.reduce((best, r) => (!best || r.createdAt > best.createdAt || (r.createdAt === best.createdAt && r.bag.createdAt > best.bag.createdAt) ? r : best), null);
    }
    /**
     * The thing `target` names, of `type` when given: "last" (the newest
     * thing placed or moved, of that type), an id or lineage (at least 8 hex),
     * an object address, or a name, exactly. Never a part of a name: "shard"
     * must not take down a message that mentions a shard (review of #32).
     * Several fits are refused with the candidates.
     */
    resolve(reading, target, type) {
        const want = type === undefined ? undefined : TYPE_WORDS[String(type).trim().toLowerCase()];
        if (type !== undefined && !want)
            throw new Refusal('type is one of: shard, message, key, chest.');
        const rows = Placements.rows(reading).filter((r) => !want || r.type === want);
        const t = String(target ?? '').trim();
        const lower = t.toLowerCase();
        if (!t)
            throw new Refusal('Say which thing (target): "last" for the newest thing you placed or moved, its name, or its id; placed lists them. Nothing was changed.');
        if (rows.length === 0)
            throw new Refusal(`You have no${want ? ` ${want}` : 'thing'} placed that this server can open: placed lists your bags. Nothing was changed.`);
        if (LAST_WORDS.has(lower))
            return this.last(rows);
        const many = (hits, how) => {
            const list = hits.slice(0, 10).map((r) => `${r.type} "${r.label}" id ${r.id.slice(0, 12)} at ${words(r.at)} (h${r.bag.height})`).join('; ');
            throw new Refusal(`${hits.length} things you placed ${how}: ${list}. Give the id (placed lists them). Nothing was changed.`);
        };
        if (/^[0-9a-f]{8,64}$/.test(lower)) {
            const hits = rows.filter((r) => r.id.startsWith(lower) || (r.lineage !== null && /^[0-9a-f]{64}$/.test(r.lineage) && r.lineage.startsWith(lower)));
            const unique = [...new Map(hits.map((r) => [`${r.bag.lookupId}/${r.key}`, r])).values()];
            if (unique.length === 1)
                return unique[0];
            if (unique.length > 1)
                many(unique, `have ids starting ${lower}`);
        }
        const byAddress = rows.filter((r) => r.objectAddress === t);
        if (byAddress.length === 1)
            return byAddress[0];
        if (byAddress.length > 1)
            many(byAddress, `name the object ${t}`);
        const exact = rows.filter((r) => r.label.toLowerCase() === lower);
        if (exact.length === 1)
            return exact[0];
        if (exact.length > 1)
            many(exact, `are called "${t}"`);
        const close = rows.filter((r) => r.label.toLowerCase().includes(lower)).slice(0, 5).map((r) => `${r.type} "${r.label}" id ${r.id.slice(0, 12)}`);
        throw new Refusal(`Nothing you placed${want ? ` of type ${want}` : ''} is called exactly "${t}" or has an id starting ${lower}.${close.length ? ` Close: ${close.join('; ')}.` : ''} placed lists what you placed, with ids. Nothing was changed.`);
    }
    // ---- placed -----------------------------------------------------------------
    async list(input = {}) {
        const reading = await this.readAll();
        const match = String(input.match ?? '').trim().toLowerCase();
        const bags = reading.bags.map((b) => ({ ...b, rows: match ? b.rows.filter((r) => r.label.toLowerCase().includes(match)) : b.rows })).filter((b) => !match || b.rows.length > 0);
        const rows = bags.flatMap((b) => b.rows);
        const last = this.last(Placements.rows(reading));
        const out = [];
        if (reading.bags.length === 0)
            out.push('You have no bags on the relays that answered: nothing placed.');
        else
            out.push(`Your bags: ${reading.bags.length}, holding ${Placements.rows(reading).length} thing(s)${match ? `; ${rows.length} match "${match}"` : ''}. Newest bag first; names and messages are your own words, read back.`);
        if (last)
            out.push(`The newest thing you placed or moved ("last"): ${last.type} "${last.label}" id ${last.id.slice(0, 12)} at ${words(last.at)} (h${last.bag.height}).`);
        for (const b of bags) {
            const head = b.opened
                ? `h${b.height} cube at base ${b.base ? words(b.base) : '?'}: bag ${b.bagId.slice(0, 8)}..., lookup id ${b.lookupId.slice(0, 12)}..., ${b.rows.length} thing(s)${b.riddle ? `, riddle "${b.riddle}"` : ''}${b.onlyHere ? ' (this version is in your own record; no relay that answered has it yet)' : ''}`
                : `bag ${b.bagId.slice(0, 8)}..., lookup id ${b.lookupId.slice(0, 12)}...: ${b.keyHeld ? 'it does not open with the key this server holds for it' : 'this server holds no key for it'}, so what is inside cannot be read; remove_placed with bag ${b.lookupId.slice(0, 12)} takes it down whole (with your operator\'s approval when they approve deletes)`;
            out.push(head);
            for (const r of b.rows) {
                const how = r.byReference === 'sealed' ? ' [by reference, sealed to this place]' : r.byReference === 'public' ? ' [a public object placed by reference]' : '';
                const moved = r.lineage && r.lineage !== r.id && /^[0-9a-f]{64}$/.test(r.lineage) ? `, moved (lineage ${r.lineage.slice(0, 12)})` : '';
                // An object at opacity 0 is still there; its author should be able to find it (DECK-0003 1.11).
                const walk = r.hidden?.shard ? `, ${walkWords(r.hidden.shard)}${readOpacity(r.hidden.shard.opacity) === 0 ? ', invisible (opacity 0: a reader draws nothing of its own)' : ''}` : '';
                const build = this.host.builds ? `, build "${this.groupOf(r).label}"` : '';
                out.push(`  ${r.type} "${r.label}" id ${r.id.slice(0, 12)} at ${words(r.at)}${how}${moved}${walk}${build}`);
            }
        }
        if (reading.silent.length)
            out.push(`Not answered: ${reading.silent.join('; ')}. A bag only those relays hold is not listed.`);
        if (this.host.builds)
            out.push('Each thing names its build ("unlabelled": placed with no build, or before builds were kept). To take a whole build out and keep everything else in the same bags: delete_build.');
        out.push('To take one down: remove_placed with its target (its id, its exact name, or "last" for the newest of any type; add type: "shard" for the newest shard); whole_bag: true takes down the bag it is in. To move one: move_placed with its target and by: { dz: 12 } for 12 gibsons toward Z+ (dx, dy, dz in gibsons, negative for X-, Y-, Z-), or to: a coordinate. To turn collision in WALK on or off for shards: constrain_placed with their target (or match, bag, all: true) and constrain "opaque", "all" or "off".');
        return {
            text: out.join('\n'),
            data: {
                bags: bags.map((b) => ({ lookupId: b.lookupId, bagId: b.bagId, height: b.height, base: b.base, createdAt: b.createdAt, riddle: b.riddle, keyHeld: b.keyHeld, opened: b.opened, onlyHere: b.onlyHere, entries: b.rows.map((r) => ({ ...Placements.publicRow(r), ...(this.host.builds ? { build: this.groupOf(r).label } : {}) })) })),
                last: last ? Placements.publicRow(last) : null,
                unanswered: reading.silent,
            },
        };
    }
    // ---- publishing a bag change --------------------------------------------------
    /** Sign a bag version, newer than every version and deletion this server signed for it. */
    async signBag(entries, key, settings, place, current) {
        const createdAt = Math.max(nowSeconds(), (current?.created_at ?? 0) + 1, this.floor(key.lookupId));
        // The hint keeps its plane while the bag holds an entry there (spec 7.6 Planes, The hint).
        return this.host.sign(await bagTemplate(entries, hexToBytes(key.keyHex), key.lookupId, key.height, createdAt, HIDDEN_KIND, settings, { at: place.position, plane: hintPlaneFor(current, entries, place.plane) }));
    }
    /** Sign a bag version, record it whole as the newest this server signed, write it to the outbox and send it. */
    async publishBag(entries, key, settings, place, current) {
        const event = await this.signBag(entries, key, settings, place, current);
        this.host.keys.noteOwnBag(key, event.created_at, { bagId: event.id, event });
        const entry = this.host.outbox.add(event);
        await this.host.outbox.send(entry);
        return { event, entry };
    }
    /**
     * Send a rewrite of one of the agent's own bags straight to the relays and
     * settle it against the canonical relay, where every reader looks. Taken
     * there: recorded as the newest version and kept in the outbox, as a bag
     * move_placed sends to a new cube. Not taken: the canonical relay is asked
     * what it holds now. Our rewrite after all (an answer that was lost): it
     * landed. Anything else: nothing is recorded, and the relays that took our
     * rewrite get back the version our rewrite replaced, signed again newer:
     * whichever is newer of what the canonical relay holds now and `current`,
     * the bag this call read and built on. The canonical relay's can be newer
     * (another session wrote it meanwhile: a restore of the bag as read
     * overwrote it there, follow-up to #44); `current` can be newer (an
     * earlier change only a lesser relay took, as in a deny-mode lockout:
     * restoring the canonical relay's dropped it, review of #46). The canonical
     * relay itself is never written over.
     */
    async landBag(event, key, settings, place, current) {
        const sent = await this.host.relays.publish(event).catch((err) => ({ ok: false, reason: err instanceof Error ? err.message : String(err), reasons: {} }));
        const took = sent.ok ? sent.accepted : [];
        const record = async () => {
            this.host.keys.noteOwnBag(key, event.created_at, { bagId: event.id, event });
            const entry = this.host.outbox.add(event);
            await this.host.outbox.send(entry);
            await this.noteOpened(event, key, settings);
            return { landed: true, entry };
        };
        if (took.includes(this.canonical))
            return record();
        const said = Object.entries(sent.reasons).map(([u, why]) => `${u}: ${why}`).join('; ');
        const refused = `the canonical relay did not take the rewritten bag (${said || (sent.ok ? 'no answer' : sent.reason)}${said ? ', verbatim' : ''})`;
        const asked = await this.host.relays.queryEach({ kinds: [HIDDEN_KIND], authors: [this.host.pubkey], '#d': [key.lookupId] }, undefined, [this.host.relays.canonical]);
        const answer = asked.find((a) => a.outcome === 'answered' && normalizeURL(a.url) === this.canonical);
        if (!answer)
            return { landed: false, unanswered: took.length > 0, why: `${refused}, and did not answer when asked what it holds now, so nothing was sent to undo it${took.length ? `; ${took.join(', ')} may show the change until the bag is written again` : ''}` };
        let there = null;
        for (const e of answer.events)
            if (e.kind === HIDDEN_KIND && e.pubkey === this.host.pubkey && dOf(e) === key.lookupId && newer(e, there))
                there = e;
        if (there?.id === event.id)
            return record();
        if (took.length === 0)
            return { landed: false, unanswered: false, why: refused };
        // The version our rewrite replaced: the newer of the canonical relay's and the one this call built on.
        const base = current && newer(current, there) ? current : there;
        const from = base === there ? 'what the canonical relay holds' : 'the version this call read and rewrote';
        const entries = base ? await openEntries(base, hexToBytes(key.keyHex)) : null;
        if (!base || !entries)
            return { landed: false, unanswered: false, why: `${refused}. ${took.join(', ')} took it; ${base ? 'the version it replaced does not open with this key' : 'neither the canonical relay nor this call holds a version of this bag'}, so nothing was sent over it there` };
        const restore = await this.signBag(entries, key, bagSettingsOf(base, key.height), place, event);
        const back = await this.host.relays.publishMany(took, restore).catch((err) => ({ ok: false, reason: err instanceof Error ? err.message : String(err), reasons: {} }));
        return { landed: false, unanswered: false, why: `${refused}. ${took.join(', ')} took it, so ${from} (${base.id.slice(0, 8)}...) went out again there, newer (${restore.id.slice(0, 8)}...): ${back.ok ? `accepted by ${back.accepted.join(', ')}` : `not taken (${back.reason})`}` };
    }
    /** Delete one of the agent's bags whole (NIP-09), by its address and its newest id, exactly as ONOSENDAI deletes an emptied one. */
    async deleteBag(lookupId, bagId, createdAt, key) {
        const at = Math.max(nowSeconds(), createdAt);
        const event = this.host.sign({
            kind: 5,
            created_at: at,
            content: 'hidden content removed',
            // kind 33330 is addressable, so the address is what a relay replaces and what NIP-09 asks for; the event id goes too, for relays that only match that.
            tags: [['a', `${HIDDEN_KIND}:${this.host.pubkey}:${lookupId}`], ...(bagId ? [['e', bagId]] : []), ['k', String(HIDDEN_KIND)]],
        });
        // The version kept whole goes now, before anything is sent: it must never bring the bag back (review of #32, round 2).
        this.host.keys.noteOwnDeletion(lookupId, at, false);
        const entry = this.host.outbox.add(event);
        await this.host.outbox.send(entry);
        // Recorded as done only once the canonical relay took it: one it refused leaves the bag listed, so it can be removed again (review of #32).
        if (key && entry.accepted.includes(this.canonical))
            this.host.keys.noteOwnBag(key, at, { deleted: true });
        const noted = this.host.keys.bags.get(lookupId);
        if (noted?.author === this.host.pubkey)
            this.host.keys.forgetBag(lookupId);
        return { event, entry };
    }
    /** File a bag version as find files one, so find, comment and render see it as it is now. */
    async noteOpened(event, key, settings) {
        const base = { x: BigInt(key.base.x), y: BigInt(key.base.y), z: BigInt(key.base.z) };
        const opened = await unbag(event, hexToBytes(key.keyHex), (r) => this.host.resolveReference(r), { at: base, plane: 0 }, key.height);
        const refs = (await openEntries(event, hexToBytes(key.keyHex)) ?? []).filter(isReference).length;
        const bag = {
            lookupId: key.lookupId, bagId: event.id, author: this.host.pubkey, createdAt: event.created_at, height: key.height, base: key.base,
            entries: opened.map((h) => this.host.summarize(h, key.lookupId)), missing: refs - opened.filter((h) => h.ref).length, riddle: settings.riddle, hint: settings.hint, at: nowSeconds(),
        };
        this.host.keys.noteBag(bag);
    }
    /**
     * Whether the event at an object's address is still this very version, as
     * the relays answer (ONOSENDAI addressStillThis, review of #369): newer
     * when one holds a newer version, silent when none answered, since a
     * retraction by address deletes whatever the address holds.
     */
    async addressStillThis(object) {
        try {
            const answers = Placements.answered(await this.host.relays.queryEach({ kinds: [object.kind], authors: [object.pubkey], '#d': [dOf(object)] }));
            if (answers.length === 0)
                return 'silent';
            return answers.some((a) => a.events.some((e) => e.id !== object.id && e.created_at >= object.created_at)) ? 'newer' : 'this';
        }
        catch {
            return 'silent';
        }
    }
    /**
     * Take down a sealed object of the agent's that no bag names any more
     * (ONOSENDAI deleteInstance), with the deletion ONOSENDAI's RETRACT sends.
     * Only when every one of the agent's bags was read, none of them names it,
     * and the relays hold this very version. Returns what happened, in words.
     */
    async retractIfUnnamed(row, reading, goneFrom) {
        const object = row.hidden?.inner;
        if (!object || row.byReference !== 'sealed' || object.pubkey !== this.host.pubkey || !row.objectAddress)
            return '';
        if (reading.unopened.length > 0 || reading.silent.length > 0)
            return ' Its sealed object (kind 33331) was left up: not every bag of yours could be read, so another may still name it.';
        const named = Placements.rows(reading).some((r) => r.objectAddress === row.objectAddress && !goneFrom.has(`${r.bag.lookupId}/${r.key}`));
        if (named)
            return ' Its sealed object stays: another of your placements names it.';
        const still = await this.addressStillThis(referenced(object));
        if (still !== 'this')
            return ` Its sealed object was left up: ${still === 'newer' ? 'the relays hold a newer version of it' : 'no relay answered about it'}.`;
        const del = this.host.sign({ kind: 5, created_at: nowSeconds(), content: 'hidden object removed', tags: [['a', row.objectAddress], ['e', object.id], ['k', String(OBJECT_KIND)]] });
        const entry = this.host.outbox.add(del);
        await this.host.outbox.send(entry);
        return ` Its sealed object (kind 33331) was taken down too: ${relayWords(entry)}.`;
    }
    /** Refuse while an earlier change to one of these bags (or this object) has reached no relay at all: building on top of it now could lose it or bring it back. */
    unsentGuard(lookupIds, objectD) {
        const me = this.host.pubkey;
        // Owed: no relay took it yet and some relay may still take it. One every relay refused is settled, and building on it loses nothing.
        const owed = this.host.outbox.entries.filter((o) => !o.dropped && o.accepted.length === 0 && Object.keys(o.refused ?? {}).length < this.host.relays.urls.length && o.event.pubkey === me && ((o.event.kind === HIDDEN_KIND && lookupIds.includes(dOf(o.event))) ||
            (objectD !== null && o.event.kind === OBJECT_KIND && dOf(o.event) === objectD) ||
            (o.event.kind === 5 && o.event.tags.some((t) => t[0] === 'a' && lookupIds.some((l) => t[1] === `${HIDDEN_KIND}:${me}:${l}`)))));
        if (owed.length > 0)
            throw new Refusal(`An earlier change to that bag has not reached any relay yet (outbox: ${owed.map((o) => `kind ${o.event.kind} ${o.event.id.slice(0, 8)}...`).join(', ')}). Nothing was changed; the outbox retries it. Try again once outbox shows it accepted.`);
    }
    keyOf(bag) {
        if (!bag.keyHex || !bag.base || bag.height < 0)
            throw new Refusal('This server holds no key for that bag, so it cannot be rewritten; remove_placed with whole_bag: true takes it down whole.');
        return { lookupId: bag.lookupId, keyHex: bag.keyHex, height: bag.height, base: bag.base };
    }
    // ---- builds and backups ----------------------------------------------------------
    /** The build a thing belongs to, as a group: its ledger build, or "unlabelled" (in no build, or placed before the ledger). */
    groupOf(r) {
        const b = this.host.builds?.buildOf({ id: r.id, lineage: r.lineage }) ?? null;
        if (!b || groupKey(b.label) === UNLABELLED)
            return { key: UNLABELLED, label: UNLABELLED, id: b?.id ?? null };
        return { key: groupKey(b.label), label: b.label, id: b.id };
    }
    /** A thing named for the operator: its type, name, short id and build. */
    thingWords(r) {
        return `${r.type} "${r.label}" (id ${r.id.slice(0, 12)}, ${this.groupOf(r).label})`;
    }
    /** One removed thing as the trash keeps it: opened, never a secret (trash.ts). */
    trashPiece(r) {
        const h = r.hidden;
        const out = {
            id: r.id, lineage: r.lineage, type: r.type, label: withoutTokens(r.label).text, build: this.groupOf(r).label, lookupId: r.bag.lookupId, height: r.bag.height, at: r.at, plane: r.plane,
            ...(r.anyPlane ? { anyPlane: true } : {}), ...(r.byReference ? { byReference: r.byReference } : {}), ...(r.objectAddress ? { objectAddress: r.objectAddress } : {}),
            // How restore finds it again in the bag the trash keeps, and whether it was behind a locked door (never restored into the open).
            entryKey: r.key, ...(this.host.isRoomBag?.(r.bag.lookupId) ? { room: true } : {}),
        };
        if (h?.type === 'shard' && h.shard) {
            // An inline shard's payload as it was written (every field kept); a sealed one as sno-core reads it back.
            let raw = null;
            if (!isReference(r.entry)) {
                try {
                    raw = JSON.parse(r.entry.content);
                }
                catch {
                    raw = null;
                }
            }
            out.payload = raw && typeof raw === 'object' ? raw : toPayload(h.shard);
        }
        if (h?.type === 'message') {
            const t = withoutTokens(h.text ?? '');
            out.text = t.text;
            if (t.held)
                out.heldCashuToken = true;
        }
        // A key's own event carries its secret: only its name, sentence and public key are kept.
        if (h?.type === 'key' && h.key)
            out.key = { name: h.key.name, about: h.key.about, itemPubkey: h.key.itemPubkey };
        if (h?.type === 'chest' && h.chest)
            out.chest = { name: h.chest.name, requires: h.chest.requires, lockPubkey: h.chest.lockPubkey, ...(h.chest.door ? { door: h.chest.door } : {}) };
        if (h?.type === 'audio' && h.audio)
            out.audio = { title: h.audio.title };
        return out;
    }
    kept(r) {
        // A message's first words may start a Cashu token: blanked, as in its text.
        return { id: r.id, type: r.type, label: withoutTokens(r.label).text, build: this.groupOf(r).label };
    }
    /**
     * Write the backup of a delete to the trash, fsynced, before anything is
     * signed (trash.ts). Each bag as it stands now (`current`, read fresh),
     * the removed things opened, their sealed objects, their ledger entries,
     * and what stayed. Throws a Refusal when it cannot be written: then the
     * delete does not run.
     */
    backup(ctx, bags) {
        const trash = this.host.trash;
        if (!trash)
            throw new Refusal('This server has no trash to write a backup to, so nothing was deleted: a delete never runs without its backup.');
        const removed = bags.flatMap((b) => b.remove);
        const objects = removed.flatMap((r) => (isReference(r.entry) && r.hidden?.inner && r.hidden.inner.sig ? [referenced(r.hidden.inner)] : []));
        return trash.write({
            bags: bags.flatMap((b) => (b.current ? [b.current] : [])),
            objects: [...new Map(objects.map((o) => [o.id, o])).values()],
            pieces: removed.map((r) => this.trashPiece(r)),
            ledger: (this.host.builds?.entriesFor(removed) ?? []).map((e) => ({ ...e, piece: { ...e.piece, label: withoutTokens(e.piece.label).text } })),
            meta: {
                tool: ctx.tool, asked: ctx.asked, ...(ctx.build ? { build: ctx.build } : {}),
                bags: bags.map((b) => ({ lookupId: b.bag.lookupId, bagId: b.current?.id ?? null, height: b.bag.height, base: b.bag.base, wholeBag: b.whole, removed: b.remove.map((r) => r.id), kept: b.keep.map((r) => this.kept(r)) })),
                removed: removed.map((r) => this.kept(r)),
            },
        }, ctx.label);
    }
    /** What a delete would do to each bag, in words: what goes, what stays, and whether the bag is rewritten or deleted. */
    planWords(plans) {
        const out = [];
        for (const p of plans) {
            const b = p.bag;
            out.push(`h${b.height} bag at base ${b.base ? words(b.base) : '?'} (lookup id ${b.lookupId.slice(0, 12)}...): ${p.keep.length ? `rewritten without ${p.remove.length} thing(s); ${p.keep.length} stay` : `deleted (nothing else is in it)`}.`);
            out.push(`  goes: ${p.remove.map((r) => this.thingWords(r)).join('; ')}`);
            if (p.keep.length)
                out.push(`  stays: ${p.keep.map((r) => this.thingWords(r)).join('; ')}`);
        }
        return out;
    }
    // ---- the approval gate ---------------------------------------------------------------
    /**
     * Why the rolling window needs approval for `n` more pieces: under
     * deleteApproval "operator", deletes that ran without approval in the last
     * hour count with this one against the threshold (review of 485a2df: six
     * deletes of one piece are one delete of six).
     */
    windowNeeds(n) {
        const g = this.host.deleteGate;
        if (!g || !g.required())
            return [];
        const recent = g.recent();
        return recent > 0 && recent + n > g.threshold ? [`${recent} thing(s) were deleted in the last hour without approval; with these ${n} that makes ${recent + n}, more than ${g.threshold}`] : [];
    }
    /** Ask the gate about a delete: held for the operator, or go (spend the approval, if any, inside the lock right before signing). */
    async gate(pieces, needs, summary, again) {
        const g = this.host.deleteGate;
        if (!g)
            return { spend: () => { }, approved: false };
        const r = await g.check({ pieces, needs, summary, again });
        if ('held' in r)
            return r;
        return { spend: r.spend, approved: needs.length > 0 && g.required() };
    }
    // ---- remove_placed -------------------------------------------------------------
    async remove(input) {
        if (input.bag !== undefined && input.target !== undefined)
            throw new Refusal('Give either target (one thing) or bag (a whole bag), not both.');
        if (input.bag === undefined && (input.target === undefined || !String(input.target).trim()))
            throw new Refusal('Say what to remove: target ("last" for the newest thing you placed or moved, its exact name, or its id), or bag (a lookup id from placed). Nothing was changed.');
        const reading = await this.readAll();
        if (input.bag !== undefined) {
            const want = String(input.bag).trim().toLowerCase();
            if (!/^[0-9a-f]{8,64}$/.test(want))
                throw new Refusal('bag is at least 8 hex characters of a lookup id or bag id, as placed lists them.');
            const hits = reading.bags.filter((b) => b.lookupId.startsWith(want) || b.bagId.startsWith(want));
            if (hits.length === 0)
                throw new Refusal(`None of your bags has a lookup id or bag id starting ${want}. placed lists them.`);
            if (hits.length > 1)
                throw new Refusal(`${hits.length} of your bags start ${want}; give more of the id.`);
            return this.removeWhole(hits[0], reading, input);
        }
        const row = this.resolve(reading, input.target, input.type);
        if (input.whole_bag)
            return this.removeWhole(row.bag, reading, input);
        this.host.beforeRemove?.([row.id]);
        const key = this.keyOf(row.bag);
        // One thing never needs approval by itself; it does when deletes made just before it add up past the threshold.
        const needs = this.windowNeeds(1);
        const go = await this.gate([row.id], needs, this.planWords([{ bag: row.bag, remove: [row], keep: row.bag.rows.filter((r) => r !== row) }]).join('\n'), 'call inbox, then remove_placed again exactly as before');
        if ('held' in go)
            return { ...go.held, data: { ...go.held.data, preview: true } };
        return this.withBags([key.lookupId], async () => {
            this.unsentGuard([key.lookupId], null);
            const { current, entries } = await this.ownBag(key.lookupId, hexToBytes(key.keyHex));
            if (!current || !entries.some((e) => entryKey(e) === row.key))
                throw new Refusal(`${row.type} "${row.label}" is no longer in that bag; nothing was changed. placed shows what is there now.`);
            const left = entries.filter((e) => entryKey(e) !== row.key);
            const what = `${row.type} "${row.label}" (id ${row.id.slice(0, 12)}) at ${words(row.at)} in your h${key.height} bag`;
            go.spend();
            // The backup first, fsynced, before anything is signed (arkinox, 2026-11-26).
            const trashId = this.backup({ tool: 'remove_placed', asked: input, label: row.label }, [{ bag: row.bag, current, remove: [row], keep: row.bag.rows.filter((r) => r !== row), whole: left.length === 0 }]);
            const saved = ` A backup is in the trash (${trashId}); restore_build puts it back.`;
            if (left.length > 0) {
                const settings = bagSettingsOf(current, key.height);
                const { event, entry } = await this.publishBag(left, key, settings, { position: { x: BigInt(key.base.x), y: BigInt(key.base.y), z: BigInt(key.base.z) }, plane: row.plane }, current);
                this.host.builds?.removed([row], trashId);
                this.host.deleteGate?.note(1, go.approved);
                await this.noteOpened(event, key, settings);
                const retract = entry.accepted.includes(this.canonical) ? await this.retractIfUnnamed(row, reading, new Set([`${row.bag.lookupId}/${row.key}`])) : '';
                this.host.afterRemove?.([row.id]);
                return {
                    text: `Removed ${what}. The bag was rewritten without it (${event.id.slice(0, 8)}...), keeping the other ${left.length} thing(s): ${relayWords(entry)}.${retract}${saved}`,
                    data: { removed: Placements.publicRow(row), bagId: event.id, lookupId: key.lookupId, left: left.length, deletedBag: false, trashId, accepted: entry.accepted, refused: entry.refused ?? {} },
                };
            }
            const { event, entry } = await this.deleteBag(key.lookupId, current.id, current.created_at, key);
            this.host.builds?.removed([row], trashId);
            this.host.deleteGate?.note(1, go.approved);
            const retract = entry.accepted.includes(this.canonical) ? await this.retractIfUnnamed(row, reading, new Set([`${row.bag.lookupId}/${row.key}`])) : '';
            this.host.afterRemove?.([row.id]);
            return {
                text: `Removed ${what}. It was the last thing in the bag, so the bag itself was deleted (NIP-09 kind 5 ${event.id.slice(0, 8)}...): ${relayWords(entry)}.${retract}${saved}`,
                data: { removed: Placements.publicRow(row), deletionId: event.id, lookupId: key.lookupId, left: 0, deletedBag: true, trashId, accepted: entry.accepted, refused: entry.refused ?? {} },
            };
        });
    }
    /**
     * remove_placed of a whole bag. Refused when the bag holds things of more
     * than one build (the incident of 2026-11-26: a bag shared by a course and
     * a castle): delete_build takes one build out and keeps the rest. A bag
     * holding things in no build is the incident itself before builds were
     * kept (two builds, both "unlabelled"): it needs the operator's approval,
     * and with no approval to ask for it is refused (review of 485a2df). Also
     * needs approval above the threshold, and for a bag this server cannot
     * read (no key held, or one that does not open with it).
     */
    async removeWhole(bag, reading, input) {
        this.host.beforeRemove?.(bag.rows.map((r) => r.id));
        const groups = [...new Map(bag.rows.map((r) => { const g = this.groupOf(r); return [g.key, g]; })).values()];
        if (groups.length > 1) {
            const counts = groups.map((g) => `"${g.label}" (${bag.rows.filter((r) => this.groupOf(r).key === g.key).length} thing(s))`).join(', ');
            throw new Refusal(`That bag (h${bag.height}, lookup id ${bag.lookupId.slice(0, 12)}...) holds things of ${groups.length} builds: ${counts}. Deleting it whole would destroy the others too, so nothing was changed. To take one build out and keep the rest, call delete_build with that build (or with the ids of the pieces to go); it shows a preview first. build lists a build's pieces; build_add names the builds of things in no build.`);
        }
        const unlabelled = bag.opened && bag.rows.some((r) => this.groupOf(r).key === UNLABELLED);
        const asks = this.host.deleteGate?.required() ?? false;
        if (unlabelled && !asks) {
            throw new Refusal(`That bag (h${bag.height}, lookup id ${bag.lookupId.slice(0, 12)}...) holds ${bag.rows.length} thing(s) in no build, so nobody can tell whether they are one build or several sharing the bag. Nothing was changed. Name their builds first with build_add (by id, by name match, or the whole bag if it is all one build), then remove it; or take out exactly the pieces you mean with delete_build and their ids.`);
        }
        const threshold = this.host.deleteGate?.threshold ?? DEFAULT_DELETE_APPROVAL_THRESHOLD;
        const count = Math.max(1, bag.rows.length);
        const needs = [];
        if (bag.rows.length > threshold)
            needs.push(`${bag.rows.length} things would go, more than ${threshold}`);
        if (unlabelled)
            needs.push('it holds things in no build (placed before builds were kept, or with no build named), so nobody named what they are part of');
        const unread = !bag.keyHeld ? 'this server holds no key for it' : !bag.opened ? 'it does not open with the key this server holds for it' : null;
        if (unread)
            needs.push(`${unread}, so what it holds cannot be read, and its backup cannot be restored`);
        needs.push(...this.windowNeeds(count));
        const preview = bag.opened ? this.planWords([{ bag, remove: bag.rows, keep: [] }]) : [`bag ${bag.lookupId.slice(0, 12)}... (h${bag.height >= 0 ? bag.height : '?'}): could not be read (${unread}); deleted whole, and what it holds cannot be restored.`];
        const pieces = bag.opened ? bag.rows.map((r) => r.id) : [`bag:${bag.lookupId}`];
        const go = await this.gate(pieces, needs, preview.join('\n'), 'call inbox, then remove_placed again exactly as before');
        if ('held' in go)
            return { ...go.held, text: `${go.held.text}\nWhat would go:\n${preview.join('\n')}`, data: { ...go.held.data, preview: true, lookupId: bag.lookupId } };
        return this.removeBag(bag, reading, input, go);
    }
    async removeBag(bag, reading, input, go) {
        return this.withBags([bag.lookupId], async () => {
            this.unsentGuard([bag.lookupId], null);
            // The newest version, read again, so the deletion names the id the relays hold now.
            const answers = await this.host.relays.queryEach({ kinds: [HIDDEN_KIND], authors: [this.host.pubkey], '#d': [bag.lookupId] });
            if (!answers.some((a) => a.outcome === 'answered' && normalizeURL(a.url) === this.canonical))
                throw new Refusal(`The canonical relay did not answer for that bag (${Placements.silentWords(answers).join('; ')}). Nothing was changed. Try again shortly.`);
            const current = this.newestOwn(bag.lookupId, mergeAnswers(answers)) ?? bag.event;
            const key = bag.keyHex && bag.base && bag.height >= 0 ? { lookupId: bag.lookupId, keyHex: bag.keyHex, height: bag.height, base: bag.base } : null;
            // Something added since it was read (another session) would go unseen and unbacked: refused, so the next call sees it.
            if (bag.opened && key && current.id !== bag.event.id) {
                const fresh = await openEntries(current, hexToBytes(key.keyHex));
                const known = new Set(bag.rows.map((r) => r.key));
                if (!fresh || fresh.some((e) => !known.has(entryKey(e))))
                    throw new Refusal('That bag changed since it was read (another session wrote it). Nothing was changed; call placed again to see what it holds now.');
            }
            go.spend();
            const trashId = this.backup({ tool: 'remove_placed', asked: input, label: bag.rows.length === 1 ? bag.rows[0].label : `bag-${bag.lookupId.slice(0, 8)}` }, [{ bag, current, remove: bag.rows, keep: [], whole: true }]);
            const { event, entry } = await this.deleteBag(bag.lookupId, current.id, Math.max(current.created_at, this.floor(bag.lookupId) - 1), key);
            this.host.builds?.removed(bag.rows, trashId);
            this.host.deleteGate?.note(Math.max(1, bag.rows.length), go.approved);
            const gone = new Set(bag.rows.map((r) => `${bag.lookupId}/${r.key}`));
            const notes = [];
            if (entry.accepted.includes(this.canonical)) {
                for (const r of bag.rows) {
                    const n = await this.retractIfUnnamed(r, reading, gone);
                    if (n)
                        notes.push(n.trim());
                }
            }
            this.host.afterRemove?.(bag.rows.map((r) => r.id));
            const what = bag.opened ? `your h${bag.height} bag at base ${bag.base ? words(bag.base) : '?'} and the ${bag.rows.length} thing(s) in it${bag.rows.length ? ` (${bag.rows.slice(0, 8).map((r) => `"${r.label}"`).join(', ')}${bag.rows.length > 8 ? ', ...' : ''})` : ''}` : `your bag ${bag.lookupId.slice(0, 12)}... (it could not be read, so what it held was not seen)`;
            return {
                text: `Deleted ${what} (NIP-09 kind 5 ${event.id.slice(0, 8)}... naming 33330:<you>:${bag.lookupId.slice(0, 12)}...): ${relayWords(entry)}.${notes.length ? ` ${notes.join(' ')}` : ''} A backup is in the trash (${trashId})${bag.opened ? '; restore_build puts it back' : ': the bag as it was, sealed, which this server cannot open, so it cannot be restored'}.`,
                data: { deletedBag: true, lookupId: bag.lookupId, bagId: current.id, deletionId: event.id, removed: bag.rows.map(Placements.publicRow), trashId, accepted: entry.accepted, refused: entry.refused ?? {} },
            };
        });
    }
    // ---- delete_build ----------------------------------------------------------------
    /**
     * delete_build: take one build out of the agent's bags (or the pieces
     * named by id), keeping everything else in each bag (arkinox, 2026-11-26).
     * Without confirm it changes nothing and says, bag by bag, what would go
     * and what would stay, and whether the operator must approve. With
     * confirm: the approval when needed, the backup, then for each bag a
     * rewrite without the pieces (read fresh, as remove_placed rewrites) or,
     * when nothing else is left in it, its deletion. A bag that still holds
     * another build's pieces is never deleted. "unlabelled" is refused: things
     * in no build may be several builds (review of 485a2df).
     */
    async deleteBuild(input) {
        const hasBuild = input.build !== undefined && String(input.build).trim() !== '';
        const hasPieces = Array.isArray(input.pieces) && input.pieces.length > 0;
        if (hasBuild === hasPieces)
            throw new Refusal('Say what to delete with exactly one of: build (a build\'s label or id, as builds lists it) or pieces (the ids of the things to go, at least 8 hex each, as placed or build lists them). Nothing was changed.');
        if (hasBuild && groupKey(String(input.build)) === UNLABELLED)
            throw new Refusal('"unlabelled" is not one build: it is everything placed with no build named, or before builds were kept, which may be several builds sharing bags. Nothing was changed. Name their builds first with build_add, then delete the one you mean; or give the ids of exactly the pieces to go (pieces).');
        const reading = await this.readAll();
        const rows = Placements.rows(reading);
        let picked;
        let named = null;
        const notFound = [];
        if (hasBuild) {
            const given = String(input.build).trim();
            const b = this.host.builds?.get(given) ?? null;
            if (!b)
                throw new Refusal(`No build is called "${given}". builds lists them.`);
            named = { key: groupKey(b.label), label: b.label };
            // An entry this server cannot read (a kind it does not know) is never taken by a build: only by its id.
            picked = rows.filter((r) => this.groupOf(r).key === named.key && r.type !== 'unreadable');
            // What the ledger says is in the build but no bag holds now: said, never guessed at.
            for (const p of b.pieces)
                if (!p.removedAt && !picked.some((r) => r.id === p.id || (p.lineage !== null && r.lineage === p.lineage)))
                    notFound.push(`${p.type} "${p.label}" (id ${p.id.slice(0, 12)})`);
        }
        else {
            const ids = (input.pieces ?? []).map((x) => String(x).trim().toLowerCase());
            picked = [];
            for (const id of ids) {
                if (!/^[0-9a-f]{8,64}$/.test(id))
                    throw new Refusal(`"${id}" is not a piece id: each is at least 8 hex characters, as placed or build lists them. Nothing was changed.`);
                const hits = [...new Map(rows.filter((r) => r.id.startsWith(id)).map((r) => [`${r.bag.lookupId}/${r.key}`, r])).values()];
                if (hits.length > 1)
                    throw new Refusal(`${hits.length} things have ids starting ${id}; give more of it. Nothing was changed.`);
                if (hits.length === 0) {
                    notFound.push(id);
                    continue;
                }
                if (!picked.includes(hits[0]))
                    picked.push(hits[0]);
            }
        }
        if (picked.length === 0) {
            throw new Refusal(`Nothing ${named ? `of the build "${named.label}"` : 'with those ids'} is in your bags${notFound.length ? ` (not found: ${notFound.slice(0, 10).join('; ')})` : ''}. Nothing was changed. placed lists what is placed.`);
        }
        const plans = [];
        for (const r of picked) {
            let p = plans.find((x) => x.bag === r.bag);
            if (!p) {
                p = { bag: r.bag, remove: [], keep: [] };
                plans.push(p);
            }
            p.remove.push(r);
        }
        for (const p of plans)
            p.keep = p.bag.rows.filter((r) => !p.remove.includes(r));
        const threshold = this.host.deleteGate?.threshold ?? DEFAULT_DELETE_APPROVAL_THRESHOLD;
        const needs = [];
        if (picked.length > threshold)
            needs.push(`${picked.length} things would go, more than ${threshold}`);
        needs.push(...this.windowNeeds(picked.length));
        const approval = needs.length > 0 && !!this.host.deleteGate?.required();
        const preview = this.planWords(plans);
        const what = named ? `the build "${named.label}"` : `${picked.length} piece(s) named by id`;
        const data = {
            build: named?.label ?? null,
            bags: plans.map((p) => ({ lookupId: p.bag.lookupId, height: p.bag.height, base: p.bag.base, deletesBag: p.keep.length === 0, removes: p.remove.map((r) => ({ ...Placements.publicRow(r), build: this.groupOf(r).label })), keeps: p.keep.map((r) => ({ ...Placements.publicRow(r), build: this.groupOf(r).label })) })),
            pieces: picked.map((r) => r.id),
            notFound,
            approvalNeeded: approval,
            needs,
        };
        if (!input.confirm) {
            return {
                text: [
                    `Preview of deleting ${what}: nothing was changed. ${picked.length} thing(s) in ${plans.length} bag(s) would go; everything else in those bags stays.`,
                    ...preview,
                    ...(notFound.length ? [`In the build but in none of your bags now (nothing to remove): ${notFound.slice(0, 20).join('; ')}.`] : []),
                    approval ? `Your operator must approve it first (${needs.join('; ')}): call again with confirm: true and the server sends them this preview by DM with a code; once they approve, call inbox, then again with confirm: true, and it runs.` : 'No approval is needed: call again with confirm: true to delete.',
                    `A backup of everything that goes is written to the trash first. ${RESTORE_WORDS}`,
                    'Show this preview to your operator before you confirm.',
                ].join('\n'),
                data: { ...data, preview: true },
            };
        }
        const go = await this.gate(picked.map((r) => r.id), needs, [`Deleting ${what}:`, ...preview].join('\n'), 'call inbox, then delete_build again with confirm: true and the same build or pieces');
        if ('held' in go)
            return { ...go.held, text: `${go.held.text}\nWhat would go:\n${preview.join('\n')}`, data: { ...data, ...go.held.data, preview: true } };
        this.host.beforeRemove?.(picked.map((r) => r.id));
        const keys = plans.map((p) => this.keyOf(p.bag));
        return this.withBags(keys.map((k) => k.lookupId), async () => {
            for (const k of keys)
                this.unsentGuard([k.lookupId], null);
            // Every bag read fresh first: what goes is only what is still there; what another session added stays.
            const fresh = [];
            for (let i = 0; i < plans.length; i++) {
                const { current, entries } = await this.ownBag(keys[i].lookupId, hexToBytes(keys[i].keyHex));
                const here = new Set(entries.map(entryKey));
                const going = current ? plans[i].remove.filter((r) => here.has(r.key)) : [];
                const goingKeys = new Set(going.map((r) => r.key));
                fresh.push({ plan: plans[i], key: keys[i], current, left: entries.filter((e) => !goingKeys.has(entryKey(e))), going });
            }
            const going = fresh.flatMap((f) => f.going);
            if (going.length === 0)
                throw new Refusal(`None of it is in your bags any more (another session removed it?). Nothing was changed; placed shows what is there now.`);
            // The approval is spent now, right before anything is signed, and the backup written, fsynced: a delete never runs without it.
            go.spend();
            const trashId = this.backup({ tool: 'delete_build', asked: input, label: named?.label ?? picked[0].label, ...(named ? { build: named.label } : {}) }, fresh.filter((f) => f.going.length).map((f) => ({ bag: f.plan.bag, current: f.current, remove: f.going, keep: f.plan.keep, whole: f.left.length === 0 })));
            const lines = [];
            const bagsData = [];
            const goneFrom = new Set(going.map((r) => `${r.bag.lookupId}/${r.key}`));
            const retractable = [];
            const done = [];
            try {
                for (const f of fresh) {
                    if (f.going.length === 0) {
                        lines.push(`h${f.key.height} bag at base ${words(f.key.base)}: nothing of it was there any more; left as it is.`);
                        continue;
                    }
                    const k = f.key;
                    if (f.left.length > 0) {
                        const settings = bagSettingsOf(f.current, k.height);
                        const { event, entry } = await this.publishBag(f.left, k, settings, { position: { x: BigInt(k.base.x), y: BigInt(k.base.y), z: BigInt(k.base.z) }, plane: f.going[0].plane }, f.current);
                        // The ledger follows each bag as it lands, so a throw at the next bag leaves it true for this one.
                        this.host.builds?.removed(f.going, trashId);
                        done.push(...f.going);
                        await this.noteOpened(event, k, settings);
                        if (entry.accepted.includes(this.canonical))
                            retractable.push(...f.going);
                        lines.push(`h${k.height} bag at base ${words(k.base)}: rewritten without ${f.going.length} thing(s) (${event.id.slice(0, 8)}...), keeping the other ${f.left.length}: ${relayWords(entry)}.`);
                        bagsData.push({ lookupId: k.lookupId, bagId: event.id, deletedBag: false, removed: f.going.map((r) => r.id), left: f.left.length, accepted: entry.accepted, refused: entry.refused ?? {} });
                    }
                    else {
                        const { event, entry } = await this.deleteBag(k.lookupId, f.current.id, f.current.created_at, k);
                        this.host.builds?.removed(f.going, trashId);
                        done.push(...f.going);
                        if (entry.accepted.includes(this.canonical))
                            retractable.push(...f.going);
                        lines.push(`h${k.height} bag at base ${words(k.base)}: nothing else was in it, so it was deleted (NIP-09 kind 5 ${event.id.slice(0, 8)}...): ${relayWords(entry)}.`);
                        bagsData.push({ lookupId: k.lookupId, deletionId: event.id, deletedBag: true, removed: f.going.map((r) => r.id), left: 0, accepted: entry.accepted, refused: entry.refused ?? {} });
                    }
                }
            }
            finally {
                this.host.deleteGate?.note(done.length, go.approved);
                if (done.length)
                    this.host.afterRemove?.(done.map((r) => r.id));
            }
            for (const r of retractable) {
                const n = await this.retractIfUnnamed(r, reading, goneFrom);
                if (n)
                    lines.push(`  ${r.type} "${r.label}":${n}`);
            }
            const skipped = picked.length - going.length;
            return {
                text: [
                    `Deleted ${going.length} thing(s) of ${what}${skipped ? ` (${skipped} were no longer there)` : ''}; everything else in those bags stays.`,
                    ...lines,
                    `A backup is in the trash (${trashId}): restore_build with that id puts it back. ${RESTORE_WORDS}`,
                ].join('\n'),
                data: { deleted: true, build: named?.label ?? null, trashId, removed: going.map((r) => ({ ...Placements.publicRow(r), build: this.groupOf(r).label })), bags: bagsData, notFound },
            };
        });
    }
    // ---- restore_build -----------------------------------------------------------------
    /**
     * Put back the pieces of a trash entry (review of 485a2df: restore
     * fidelity). The trash keeps each bag as it was, signed and sealed; its
     * region key is derived again here from the place (keyFor), never kept
     * there, the bag opened, and the ORIGINAL entries of the removed pieces
     * put back verbatim, merged into the bag as it stands now (read fresh,
     * one change at a time): the same ids and lineage, so messages, coins,
     * items, chests and doors come back exactly. A shard sealed by reference
     * whose object was taken down is sealed again from the original
     * plaintext under a new d, and referenced; one whose object is still up
     * keeps its reference. A piece from a locked room goes back only into
     * that room bag, and only while this server holds its door (DECK-0004
     * §3.7.8: never shown in the open). `skip` holds the pieces already
     * back; `landed` hears each bag's pieces as they land, so a restore cut
     * short is tried again for the rest only.
     */
    async restoreFromTrash(entry, skip, landed) {
        const out = [];
        const report = (rs) => { out.push(...rs); landed(rs.map(({ build: _b, ...r }) => r)); };
        const todo = entry.pieces.filter((p) => !skip.has(p.id));
        const lookupIds = [...new Set(todo.map((p) => p.lookupId))];
        for (const lookupId of lookupIds) {
            const pieces = todo.filter((p) => p.lookupId === lookupId);
            const fail = (why) => report(pieces.map((p) => ({ from: p.id, id: null, type: p.type, label: p.label, ok: false, why, build: p.build })));
            try {
                const stored = entry.bags.find((e) => e.kind === HIDDEN_KIND && e.pubkey === this.host.pubkey && dOf(e) === lookupId);
                if (!stored) {
                    fail('the trash does not hold the bag it was in');
                    continue;
                }
                const first = pieces[0];
                const point = { x: BigInt(first.at.x), y: BigInt(first.at.y), z: BigInt(first.at.z) };
                const cube = this.host.keyFor(point, first.height).key;
                const held = first.room ? (this.host.roomKeyFor?.(point, first.plane, first.height, cube) ?? cube) : cube;
                if (held.lookupId !== lookupId) {
                    fail(first.room
                        ? 'it was inside a locked room whose door this server no longer holds; put back in the open cube it would show to anyone at the place, so it was not restored (seal the door again, then restore)'
                        : 'the key derived for its place today is not the one its bag was sealed with, so its bag cannot be opened');
                    continue;
                }
                const key = { lookupId, keyHex: held.keyHex, height: held.height, base: held.base };
                const regionKey = hexToBytes(key.keyHex);
                const original = await openEntries(stored, regionKey);
                if (!original) {
                    fail('the bag the trash keeps does not open with the key derived for its place');
                    continue;
                }
                await this.withBags([lookupId], async () => {
                    this.unsentGuard([lookupId], null);
                    const { current, entries } = await this.ownBag(lookupId, regionKey);
                    const have = new Set(entries.map(entryKey));
                    const putBack = [];
                    const results = [];
                    /** A shard sealed again: its new object's address, by the piece it restores. */
                    const addressOf = new Map();
                    const now = nowSeconds();
                    for (const p of pieces) {
                        const e = original.find((x) => entryKey(x) === (p.entryKey ?? p.id) || (!isReference(x) && x.id === p.id));
                        if (!e) {
                            results.push({ from: p.id, id: null, type: p.type, label: p.label, ok: false, why: 'its entry is not in the bag the trash keeps', build: p.build });
                            continue;
                        }
                        if (!isReference(e)) {
                            // Inline: the original entry itself, verbatim.
                            if (!have.has(entryKey(e)))
                                putBack.push(e);
                            results.push({ from: p.id, id: e.id, type: p.type, label: p.label, ok: true, build: p.build });
                            continue;
                        }
                        const ref = e;
                        const object = entry.objects.find((o) => o.id === p.id);
                        const live = await this.host.resolveReference(ref).catch(() => null);
                        if (p.byReference !== 'sealed' || !object || (live && live.id === object.id)) {
                            // A public object, or a sealed one still up: the reference as it was.
                            if (!live) {
                                results.push({ from: p.id, id: null, type: p.type, label: p.label, ok: false, why: 'the object it named is no longer published', build: p.build });
                                continue;
                            }
                            if (!have.has(entryKey(ref)))
                                putBack.push(ref);
                            results.push({ from: p.id, id: p.id, type: p.type, label: p.label, ok: true, build: p.build });
                            continue;
                        }
                        // Its object was taken down: sealed again from the original plaintext, under a new d (a deleted address is never used again).
                        const t = await sealedCopy(object, regionKey, randomBytes16(), Math.max(now, object.created_at + 1));
                        if (!t) {
                            results.push({ from: p.id, id: null, type: p.type, label: p.label, ok: false, why: 'its sealed object does not open with the key derived for its place', build: p.build });
                            continue;
                        }
                        const fresh = this.host.sign(t);
                        const sent = await this.host.relays.publish(fresh).catch((err) => ({ ok: false, reason: err instanceof Error ? err.message : String(err), reasons: {} }));
                        if (!sent.ok || !sent.accepted.includes(this.canonical)) {
                            results.push({ from: p.id, id: null, type: p.type, label: p.label, ok: false, why: `the canonical relay did not take its object sealed again (${sent.ok ? `only ${sent.accepted.join(', ') || 'no relay'} did` : sent.reason})`, build: p.build });
                            continue;
                        }
                        const address = `${OBJECT_KIND}:${this.host.pubkey}:${dOf(fresh)}`;
                        addressOf.set(p.id, address);
                        putBack.push(['a', address, this.host.relays.canonical, ref[3] ?? '']);
                        results.push({ from: p.id, id: fresh.id, type: p.type, label: p.label, ok: true, build: p.build });
                    }
                    if (putBack.length > 0) {
                        const merged = mergeEntries(entries, putBack);
                        // A bag gone since keeps the settings it had (its hint and riddle are public tags of the version kept).
                        const settings = bagSettingsOf(current ?? stored, key.height);
                        const place = { position: point, plane: first.plane };
                        const event = await this.signBag(merged, key, settings, place, current);
                        const tooBig = bagGrowthRefusal(event, current);
                        if (tooBig)
                            throw new Refusal(`${tooBig} Putting these back would make the bag too large.`);
                        this.host.keys.noteOwnBag(key, event.created_at, { bagId: event.id, event });
                        const sentBag = this.host.outbox.add(event);
                        await this.host.outbox.send(sentBag);
                        await this.noteOpened(event, key, settings);
                        if (sentBag.accepted.length === 0)
                            for (const r of results)
                                if (r.ok)
                                    r.why = `the bag waits in the outbox (${relayWords(sentBag)})`;
                    }
                    // The ledger follows each bag as it lands: the pieces back in their builds, with their ids.
                    for (const r of results) {
                        if (!r.ok || !r.id)
                            continue;
                        const p = pieces.find((x) => x.id === r.from);
                        const address = addressOf.get(p.id) ?? p.objectAddress;
                        this.host.builds?.record(p.build, {
                            lookupId, height: p.height, id: r.id, lineage: addressOf.has(p.id) ? address : p.lineage, type: p.type, label: p.label, at: p.at, plane: p.plane,
                            ...(address ? { objectAddress: address } : {}), placedAt: now,
                        });
                    }
                    report(results);
                });
            }
            catch (err) {
                const done = new Set(out.map((r) => r.from));
                const rest = pieces.filter((p) => !done.has(p.id));
                if (rest.length)
                    report(rest.map((p) => ({ from: p.id, id: null, type: p.type, label: p.label, ok: false, why: err instanceof Error ? err.message : String(err), build: p.build })));
            }
        }
        return out;
    }
    // ---- build_add: things already placed, into a build ------------------------------
    /**
     * build_add: record things already placed under a build, so a scoped
     * delete can tell them apart (every piece placed before the ledger is in
     * no build). By id (or a list of ids), by `match` on the name, or every
     * thing in one bag. A thing of another build is refused unless `move`.
     * Local state only: nothing is signed or published.
     */
    async buildAdd(input) {
        const builds = this.host.builds;
        if (!builds)
            throw new Refusal('This server keeps no build ledger.');
        const label = String(input.build ?? '').trim();
        if (!label)
            throw new Refusal('Say which build (build): its label or id; a new label starts one. Nothing was changed.');
        const selectors = [Array.isArray(input.pieces) && input.pieces.length > 0, input.match !== undefined, input.bag !== undefined].filter(Boolean).length;
        if (selectors !== 1)
            throw new Refusal('Say which things with exactly one of: pieces (their ids, at least 8 hex each, as placed lists them), match (every thing whose name contains these words) or bag (every thing in one bag, by its lookup id or bag id). Nothing was changed.');
        const reading = await this.readAll();
        const rows = Placements.rows(reading);
        let picked;
        if (input.bag !== undefined) {
            const want = String(input.bag).trim().toLowerCase();
            if (!/^[0-9a-f]{8,64}$/.test(want))
                throw new Refusal('bag is at least 8 hex characters of a lookup id or bag id, as placed lists them.');
            const hits = reading.bags.filter((b) => b.lookupId.startsWith(want) || b.bagId.startsWith(want));
            if (hits.length === 0)
                throw new Refusal(`None of your bags has a lookup id or bag id starting ${want}. placed lists them.`);
            if (hits.length > 1)
                throw new Refusal(`${hits.length} of your bags start ${want}; give more of the id.`);
            if (!hits[0].opened)
                throw new Refusal('That bag does not open with a key this server holds, so what is in it cannot be read or named. Nothing was changed.');
            picked = hits[0].rows;
        }
        else if (input.match !== undefined) {
            const m = String(input.match).trim().toLowerCase();
            if (!m)
                throw new Refusal('match is the words a name contains; it must not be empty. Nothing was changed.');
            picked = rows.filter((r) => r.label.toLowerCase().includes(m));
        }
        else {
            picked = [];
            for (const raw of input.pieces ?? []) {
                const id = String(raw).trim().toLowerCase();
                if (!/^[0-9a-f]{8,64}$/.test(id))
                    throw new Refusal(`"${id}" is not a piece id: each is at least 8 hex characters, as placed lists them. Nothing was changed.`);
                const hits = [...new Map(rows.filter((r) => r.id.startsWith(id)).map((r) => [`${r.bag.lookupId}/${r.key}`, r])).values()];
                if (hits.length === 0)
                    throw new Refusal(`Nothing you placed has an id starting ${id}. placed lists them. Nothing was changed.`);
                if (hits.length > 1)
                    throw new Refusal(`${hits.length} things have ids starting ${id}; give more of it. Nothing was changed.`);
                if (!picked.includes(hits[0]))
                    picked.push(hits[0]);
            }
        }
        if (picked.length === 0)
            throw new Refusal(`Nothing you placed${input.match !== undefined ? ` has a name containing "${String(input.match).trim()}"` : ' is in that bag'}. placed lists what you placed. Nothing was changed.`);
        const pieceOf = (r) => ({
            lookupId: r.bag.lookupId, height: r.bag.height, id: r.id, lineage: r.lineage, type: r.type, label: r.label, at: r.at, plane: r.plane,
            ...(r.objectAddress ? { objectAddress: r.objectAddress } : {}), placedAt: r.createdAt,
        });
        const res = builds.assign(label, picked.map(pieceOf), input.move === true);
        const name = (p) => `${p.type} "${p.label}" (id ${p.id.slice(0, 12)})`;
        if (res.conflicts.length && input.move !== true) {
            throw new Refusal(`${res.conflicts.length} of them already belong to another build: ${res.conflicts.slice(0, 15).map((c) => `${name(c.piece)} in "${c.build}"`).join('; ')}${res.conflicts.length > 15 ? '; ...' : ''}. Nothing was changed. Leave them out (name the pieces by id), or give move: true to move them into this build.`);
        }
        const b = res.build;
        const out = [
            res.added.length || res.moved.length ? `Recorded ${res.added.length + res.moved.length} thing(s) in the build "${b?.label ?? label}"${b ? ` (id ${b.id})` : ''}: ${[...res.added, ...res.moved.map((m) => m.piece)].slice(0, 20).map(name).join('; ')}.` : `Nothing to record: every thing named is already in the build "${b?.label ?? label}".`,
            ...(res.moved.length ? [`Moved from other builds: ${res.moved.map((m) => `${name(m.piece)} from "${m.from}"`).join('; ')}.`] : []),
            ...(res.already.length && (res.added.length || res.moved.length) ? [`Already in it: ${res.already.length}.`] : []),
            'Kept only on this machine; nothing was published. build shows the build checked against what is placed; delete_build takes it out of your bags and keeps everything else.',
        ];
        return { text: out.join('\n'), data: { build: b ? { id: b.id, label: b.label } : null, added: res.added, moved: res.moved.map((m) => ({ ...m.piece, from: m.from })), already: res.already.map((p) => p.id) } };
    }
    // ---- build: one build, checked against what is placed -----------------------------
    /**
     * One build's pieces as the ledger keeps them, each checked against the
     * bags as the relays hold them now: there, moved or written again
     * elsewhere (found by its lineage under another id or place), or missing.
     * "unlabelled" also lists what is in no build.
     */
    async buildReport(given) {
        const builds = this.host.builds;
        const isUnlabelled = groupKey(given) === UNLABELLED;
        const b = isUnlabelled ? (builds?.find(UNLABELLED) ?? null) : (builds?.get(given) ?? null);
        if (!b && !isUnlabelled)
            throw new Refusal(`No build is called "${given}". builds lists them.`);
        const reading = await this.readAll();
        const rows = Placements.rows(reading);
        const out = [];
        const pieces = [];
        const active = b ? b.pieces.filter((p) => !p.removedAt) : [];
        const removed = b ? b.pieces.filter((p) => p.removedAt) : [];
        out.push(`Build "${b?.label ?? UNLABELLED}"${b ? ` (id ${b.id})` : ''}: ${active.length} piece(s) in the ledger${removed.length ? `, ${removed.length} removed` : ''}.${b?.notes ? ` Notes: ${b.notes}` : ''}`);
        const flagged = { moved: 0, missing: 0 };
        for (const p of active) {
            const same = rows.find((r) => r.id === p.id && r.bag.lookupId === p.lookupId);
            const elsewhere = same ? null : rows.find((r) => r.id === p.id) ?? (p.lineage ? rows.find((r) => r.lineage === p.lineage) : undefined) ?? null;
            const state = same ? 'there' : elsewhere ? 'moved' : 'missing';
            if (state === 'moved')
                flagged.moved++;
            if (state === 'missing')
                flagged.missing++;
            const now = same ?? elsewhere;
            pieces.push({ ...p, state, ...(now ? { now: { id: now.id, at: now.at, height: now.bag.height, lookupId: now.bag.lookupId } } : {}) });
            out.push(`  ${p.type} "${p.label}" id ${p.id.slice(0, 12)} at ${words(p.at)} (h${p.height})${state === 'there' ? '' : state === 'moved' ? ` MOVED OR CHANGED: now id ${now.id.slice(0, 12)} at ${words(now.at)} (h${now.bag.height})` : ' MISSING: in none of your bags now'}`);
        }
        let legacy = [];
        if (isUnlabelled) {
            legacy = rows.filter((r) => this.groupOf(r).key === UNLABELLED && !active.some((p) => p.id === r.id));
            if (legacy.length)
                out.push(`In no build (placed before builds were kept): ${legacy.length} thing(s).`);
            for (const r of legacy)
                out.push(`  ${r.type} "${r.label}" id ${r.id.slice(0, 12)} at ${words(r.at)} (h${r.bag.height}, bag ${r.bag.lookupId.slice(0, 12)}...)`);
        }
        if (flagged.moved || flagged.missing)
            out.push(`${flagged.moved} moved or changed outside this server, ${flagged.missing} missing: placed shows what is where now.`);
        if (removed.length)
            out.push(`Removed: ${removed.slice(-10).map((p) => `"${p.label}"${p.trashId ? ` (trash ${p.trashId})` : ''}`).join(', ')}${removed.length > 10 ? ', ...' : ''}.`);
        if (reading.silent.length)
            out.push(`Not answered: ${reading.silent.join('; ')}. A piece only those relays hold shows as missing.`);
        out.push('delete_build with this build shows what deleting it would take out of each bag, and what would stay.');
        return {
            text: out.join('\n'),
            data: { build: b ? { id: b.id, label: b.label, notes: b.notes, createdAt: b.createdAt, updatedAt: b.updatedAt } : { id: null, label: UNLABELLED }, pieces, removed, legacy: legacy.map(Placements.publicRow), moved: flagged.moved, missing: flagged.missing, unanswered: reading.silent },
        };
    }
    // ---- move_placed ---------------------------------------------------------------
    async move(input) {
        if ((input.by === undefined) === (input.to === undefined))
            throw new Refusal('Give exactly one of: by (an offset from where the thing is now, in gibsons: { dz: 12 } is 12 toward Z+), or to (a coordinate: 64 hex, { x, y, z, plane }, or { dx, dy, dz } from where you stand).');
        if (input.target === undefined || !String(input.target).trim())
            throw new Refusal('Say what to move: target ("last" for the newest thing you placed or moved, its exact name, or its id). Nothing was changed.');
        const reading = await this.readAll();
        const row = this.resolve(reading, input.target, input.type);
        if (row.type === 'unreadable')
            throw new Refusal(`That entry is one this server cannot read (${row.label}), so it cannot be moved; remove_placed can take it down.`);
        // The things sealed in a chest keep the point they were sealed at, and ONOSENDAI shows them there (review of #32): a chest is not moved.
        if (row.type === 'chest')
            throw new Refusal(`A chest cannot be moved: what is sealed inside it keeps the place it was sealed at, so it would show at the old place. To have it elsewhere, seal a new chest there with seal_chest and take this one down with remove_placed. Nothing was changed.`);
        const from = placeOf({ x: BigInt(row.at.x), y: BigInt(row.at.y), z: BigInt(row.at.z) }, row.plane);
        let dest;
        try {
            if (input.by !== undefined) {
                const by = input.by;
                if (Object.keys(by).some((k) => !['dx', 'dy', 'dz'].includes(k)))
                    throw new Error('by takes only dx, dy and dz, in gibsons');
                dest = parseCoordinate({ dx: input.by.dx ?? 0, dy: input.by.dy ?? 0, dz: input.by.dz ?? 0 }, from);
            }
            else {
                dest = parseCoordinate(input.to, this.host.here());
            }
        }
        catch (err) {
            throw new Refusal(err instanceof Error ? err.message : String(err));
        }
        const oldKey = this.keyOf(row.bag);
        const height = input.height ?? oldKey.height;
        if (!Number.isInteger(height) || height < this.host.minHeight || height > this.host.maxHeight)
            throw new Refusal(`height must be an integer from ${this.host.minHeight} to ${this.host.maxHeight}.`);
        if (dest.hex === from.hex && height === oldKey.height)
            throw new Refusal(`${row.type} "${row.label}" is already at ${words(row.at)} in your h${height} bag; nothing was changed.`);
        const { key: cubeKey, ms: keyMs } = this.host.keyFor(dest.position, height);
        const newHeld = this.host.roomKeyFor?.(dest.position, dest.plane, height, cubeKey) ?? cubeKey;
        // A move out of a locked room would show the thing to anyone at the place (DECK-0004 §3.7.8): not done by a move.
        if (this.host.isRoomBag?.(oldKey.lookupId) && !this.host.isRoomBag?.(newHeld.lookupId))
            throw new Refusal(`${row.type} "${row.label}" is inside one of your locked rooms; moving it out would show it to anyone at the place. To have it outside, remove it with remove_placed and place it again there. Nothing was changed.`);
        const newKey = { lookupId: newHeld.lookupId, keyHex: newHeld.keyHex, height: newHeld.height, base: newHeld.base };
        const sameBag = newKey.lookupId === oldKey.lookupId;
        const isRef = isReference(row.entry);
        const sealedOwn = isRef && row.byReference === 'sealed' && row.hidden?.inner.pubkey === this.host.pubkey;
        return this.withBags([oldKey.lookupId, newKey.lookupId], async () => {
            this.unsentGuard([oldKey.lookupId, newKey.lookupId], sealedOwn ? dOf(row.hidden.inner) : null);
            const src = await this.ownBag(oldKey.lookupId, hexToBytes(oldKey.keyHex));
            if (!src.current)
                throw new Refusal(`${row.type} "${row.label}" is no longer placed; nothing was changed.`);
            const was = src.entries.find((e) => entryKey(e) === row.key);
            if (!was)
                throw new Refusal(`${row.type} "${row.label}" is no longer in that bag; nothing was changed. placed shows what is there now.`);
            const now = nowSeconds();
            // The thing at its new place: signed again with its lineage, or its reference pointed at the new point.
            let moved;
            let object = null;
            let rollback = null;
            if (!isReference(was)) {
                const inner = was;
                // The moved version carries `-` (a version from before 2026-10-20
                // gains it once), and a message or hidden audio goes out as a rumor,
                // never signed, as when it was hidden (ONOSENDAI #409, DECK-0007 §3):
                // a signed hidden audio item would be a playable file post under
                // this key.
                // A shard is written again, so it carries its WALK setting: the
                // author's word, or "opaque" when nobody chose (ONOSENDAI #476,
                // DECK-0003 1.12: "including one that is moved"); every other field
                // of its payload as it was.
                const content = inner.kind === SHARD_KIND ? (rewritePayload(inner.content) ?? inner.content) : inner.content;
                const next = editedTemplate({ kind: inner.kind, created_at: now, content, tags: [['C', dest.hex], [...PROTECTED_TAG]] }, inner);
                moved = sealedAsRumor(inner.kind) ? rumorOf(attributed(next), this.host.pubkey) : this.host.sign(next);
            }
            else {
                const ref = was;
                // Sealed again to the new region; or inside its bag when it has no
                // WALK setting yet, so the default reaches it as ONOSENDAI's EDIT
                // reseals every reference it moves (review of #44, L2). One that
                // already chose a word moves inside its bag without a reseal: its
                // payload would be the same.
                const needsDefault = sealedOwn && !!row.hidden?.shard && chosenConstrainOf(row.hidden.shard) === undefined;
                if (sealedOwn && (!sameBag || needsDefault)) {
                    const old = referenced(row.hidden.inner);
                    const still = await this.addressStillThis(old);
                    if (still !== 'this')
                        throw new Refusal(still === 'newer' ? 'The relays hold a newer version of that shard\'s object than the one in your bag (moved from somewhere else?). Nothing was changed; call placed again.' : 'No relay answered about that shard\'s object, so sealing it again could overwrite a version this server cannot see. Nothing was changed; try again shortly.');
                    const objectAt = Math.max(now, old.created_at + 1);
                    const t = await resealedObject(old, hexToBytes(oldKey.keyHex), hexToBytes(newKey.keyHex), objectAt);
                    if (!t)
                        throw new Refusal('That shard\'s object does not open with its bag\'s key, so it cannot be sealed to the new place. Nothing was changed.');
                    object = this.host.sign(t);
                    // The old version, signed again a second newer: what goes back if the move does not land (ONOSENDAI rollback, review of #369).
                    rollback = this.host.sign({ kind: old.kind, created_at: objectAt + 1, content: old.content, tags: old.tags });
                }
                moved = [ref[0], ref[1], ref[2] ?? '', dest.hex];
            }
            // What its payload says now, when this move wrote it (DECK-0003 1.12: a tool with no screen reports it; review of #44, L1).
            const shard = row.hidden?.shard;
            const walk = shard && (!isReference(was) || object)
                ? ` WALK: ${walkWords(withAuthoredConstrain(shard))}${chosenConstrainOf(shard) ? '' : ', the default, written since it had none'}; constrain_placed changes it.`
                : '';
            // Inside one bag: one rewrite, which loses nothing whichever relays take it.
            if (sameBag) {
                if (object && rollback) {
                    // The object first, and only into a bag the canonical relay can read it from: refused, the old version goes back and nothing moves.
                    const sent = await this.host.relays.publish(object).catch((err) => ({ ok: false, reason: err instanceof Error ? err.message : String(err), reasons: {} }));
                    if (!sent.ok || !sent.accepted.includes(this.canonical)) {
                        const back = await this.putBack(rollback);
                        throw new Refusal(`The canonical relay did not take the shard's object sealed again with its WALK setting (${sent.ok ? `only ${sent.accepted.join(', ') || 'no relay'} did` : sent.reason}${Object.entries(sent.reasons).length ? `; ${Object.entries(sent.reasons).map(([u, r]) => `${u}: ${r}`).join('; ')}` : ''}). Nothing was moved; it stays where it was.${back}`);
                    }
                }
                const entries = mergeEntries(src.entries.filter((e) => entryKey(e) !== row.key), [moved]);
                const settings = bagSettingsOf(src.current, height);
                // Straight to the relays and counted only once the canonical relay took it, as the cross-cube path (follow-up to #44: through the outbox a refusal read as moved).
                const newBag = await this.signBag(entries, newKey, settings, dest, src.current);
                const landed = await this.landBag(newBag, newKey, settings, dest, src.current);
                if (!landed.landed) {
                    const back = object && rollback ? await this.putBack(rollback) : '';
                    const recover = landed.unanswered ? ' Some relays may show it at the new place until the bag is written again. Once the canonical relay answers, call placed: wherever it shows the thing, move_placed it to where you want it (to back where it was, if it shows the new place), which writes the bag again everywhere.' : '';
                    throw new Refusal(`${landed.why.charAt(0).toUpperCase()}${landed.why.slice(1)}. Nothing was moved on the canonical relay; it stays where it was.${back}${recover}`);
                }
                const entry = landed.entry;
                return this.moved(row, moved, object, from, dest, oldKey, newKey, height, keyMs, true, `Same bag, rewritten in one step (${newBag.id.slice(0, 8)}..., ${entries.length} thing(s)): ${relayWords(entry)}.${object ? ` Its sealed object was sealed again under the same d (${object.id.slice(0, 8)}...).` : ''}${walk}`, newBag, entry.accepted, entry.refused ?? {});
            }
            // To another bag: the destination's bag with it added, signed before anything goes out.
            const dst = await this.ownBag(newKey.lookupId, hexToBytes(newKey.keyHex));
            const entries = mergeEntries(dst.entries, [moved]);
            // A room bag carries no height, hint, sector or contents tag, the first time too (DECK-0004 §3.7.2).
            const toRoom = this.host.isRoomBag?.(newKey.lookupId) ?? false;
            const settings0 = toRoom ? { heightTag: false, hint: null, riddle: '', contents: false, money: false } : dst.current ? bagSettingsOf(dst.current, height) : { heightTag: true, hint: null, riddle: '', contents: false, money: false };
            const settings = { ...settings0, hint: settings0.hint && hintFits(settings0.hint, height) ? settings0.hint : null };
            const newBag = await this.signBag(entries, newKey, settings, dest, dst.current);
            // Refused before anything goes out when the move would bring the destination's bag past BAG_SAFE_BYTES (a large chest, DECK-0004 3.2). An object moves as a reference of some 280 bytes, and its rollback is already prepared, so only an inline entry is checked here.
            const tooBig = object && rollback ? null : bagGrowthRefusal(newBag, dst.current);
            if (tooBig)
                throw new Refusal(`${tooBig} The bag at the new place already holds ${dst.entries.length} thing(s). Nothing was moved; it stays where it was.`);
            const canonical = this.canonical;
            if (object && rollback) {
                // On disk before anything is published, so a server stopped mid-move puts the old object back at its next start.
                this.host.keys.holdPutBack({ rollback, newLookupId: newKey.lookupId, newBagId: newBag.id });
                const sent = await this.host.relays.publish(object).catch((err) => ({ ok: false, reason: err instanceof Error ? err.message : String(err), reasons: {} }));
                if (!sent.ok || !sent.accepted.includes(canonical)) {
                    const back = await this.putBack(rollback);
                    throw new Refusal(`The canonical relay did not take the shard's object sealed to its new place (${sent.ok ? `only ${sent.accepted.join(', ')} did` : sent.reason}${Object.entries(sent.reasons).length ? `; ${Object.entries(sent.reasons).map(([u, r]) => `${u}: ${r}`).join('; ')}` : ''}). Nothing was moved; it stays where it was.${back}`);
                }
            }
            // The new bag goes to the relays directly, not through the outbox first, so no retry can send it after the move is given up.
            const sent = await this.host.relays.publish(newBag).catch((err) => ({ ok: false, reason: err instanceof Error ? err.message : String(err), reasons: {} }));
            const accepted = sent.ok ? sent.accepted : [];
            const said = Object.entries(sent.reasons).map(([u, r]) => `${u}: ${r}`).join('; ');
            if (!accepted.includes(canonical)) {
                const back = object && rollback ? await this.putBack(rollback) : '';
                if (accepted.length > 0 && !object) {
                    // A lesser relay holds the new copy: it is recorded, so no later rewrite there drops it, and the old copy stays everywhere.
                    this.host.keys.noteOwnBag(newKey, newBag.created_at, { bagId: newBag.id, event: newBag });
                    const entry = this.host.outbox.add(newBag);
                    await this.host.outbox.send(entry);
                    throw new Refusal(`The canonical relay did not take the bag at the new place${said ? ` (${said})` : ''}; only ${accepted.join(', ')} did. The old copy stays where it was everywhere; on ${accepted.join(', ')} the thing now also shows at the new place (and on the canonical relay too if a retry gets it there). remove_placed takes down the copy you do not want.`);
                }
                throw new Refusal(`The canonical relay did not take the bag at the new place${said ? ` (${said})` : sent.ok ? '' : ` (${sent.reason})`}. Nothing was moved; it stays where it was.${back}${accepted.length > 0 ? ` ${accepted.join(', ')} took the new bag, whose reference no longer opens now that the object is back; it is harmless and placed shows it as unreadable there.` : ''}${sent.ok ? '' : ' A relay whose answer timed out may still have stored the new bag; placed shows what is there.'}`);
            }
            this.host.keys.noteOwnBag(newKey, newBag.created_at, { bagId: newBag.id, event: newBag });
            if (rollback)
                this.host.keys.settlePutBack(rollback.id);
            const newEntry = this.host.outbox.add(newBag);
            await this.host.outbox.send(newEntry);
            await this.noteOpened(newBag, newKey, settings);
            // Taken out of the old bag only now that the canonical relay has the new one, as remove_placed would, except that a resealed object is the moved shard's now and stays.
            let oldWords;
            const left = src.entries.filter((e) => entryKey(e) !== row.key);
            if (left.length > 0) {
                const oldSettings = bagSettingsOf(src.current, oldKey.height);
                const { event, entry } = await this.publishBag(left, oldKey, oldSettings, from, src.current);
                await this.noteOpened(event, oldKey, oldSettings);
                oldWords = entry.accepted.length > 0
                    ? ` The old bag was rewritten without it (${event.id.slice(0, 8)}..., ${left.length} thing(s) left): ${relayWords(entry)}.`
                    : ` The old bag's rewrite reached no relay yet, so the old copy still shows until the outbox gets it through (${relayWords(entry)}).`;
            }
            else {
                const { event, entry } = await this.deleteBag(oldKey.lookupId, src.current.id, src.current.created_at, oldKey);
                oldWords = entry.accepted.length > 0
                    ? ` It was the last thing in its old bag, so that bag was deleted (kind 5 ${event.id.slice(0, 8)}...): ${relayWords(entry)}.`
                    : ` The old bag's deletion reached no relay yet, so the old copy still shows until the outbox gets it through (${relayWords(entry)}).`;
            }
            return this.moved(row, moved, object, from, dest, oldKey, newKey, height, keyMs, false, `New place: your h${height} bag at base ${words(newKey.base)} (${newBag.id.slice(0, 8)}..., ${entries.length} thing(s)): ${relayWords(newEntry)}. Key cost ${keyMs.toFixed(0)} ms.${oldWords} Comments are sealed to a bag, so comments left in the old cube stay there.${walk}`, newBag, newEntry.accepted, newEntry.refused ?? {});
        });
    }
    /** The answer to a move that happened, and the records that follow it. */
    moved(row, moved, object, from, dest, oldKey, newKey, height, keyMs, sameBag, bagWords, newBag, accepted, refused) {
        const place = { lookupId: newKey.lookupId, height, x: dest.position.x.toString(), y: dest.position.y.toString(), z: dest.position.z.toString(), plane: dest.plane };
        this.host.keys.notePlaced(newKey.lookupId, entryKey(moved), nowSeconds());
        if (!isReference(row.entry) && !isReference(moved))
            this.host.keys.movedItem(row.entry.id, moved.id, place);
        const newId = isReference(moved) ? (object ? object.id : (row.byReference === 'sealed' ? row.id : objectHandle(`${newKey.lookupId}/${entryKey(moved)}`))) : moved.id;
        const lineage = isReference(moved) ? moved[1] : itemLineage(moved);
        // The ledger follows it: the new id replaces the old, its lineage kept (builds.ts).
        this.host.builds?.moved({ id: row.id, lineage: row.lineage }, { id: newId, lineage: typeof lineage === 'string' ? lineage : null, lookupId: newKey.lookupId, height, at: { x: place.x, y: place.y, z: place.z }, plane: dest.plane });
        const delta = ['x', 'y', 'z'].map((a) => [a, dest.position[a] - from.position[a]]).filter(([, d]) => d !== 0n).map(([a, d]) => `${d > 0n ? '+' : ''}${d} ${a}`);
        const text = [
            `Moved ${row.type} "${row.label}" from ${words(row.at)} to ${words(place)}${delta.length ? ` (${delta.join(', ')} gibsons)` : ''}${height !== oldKey.height ? `, from the h${oldKey.height} cube to h${height}` : ''}. Its new id is ${newId.slice(0, 12)}; ${isReference(moved) ? 'its object keeps its address' : `it keeps its lineage ${String(lineage).slice(0, 12)}`}, so its reactions follow it.`,
            bagWords,
        ].join('\n');
        return {
            text,
            data: {
                moved: { ...Placements.publicRow(row), id: newId, lineage, at: { x: place.x, y: place.y, z: place.z }, plane: dest.plane },
                from: { ...row.at, plane: row.plane, height: oldKey.height, lookupId: oldKey.lookupId },
                to: { x: place.x, y: place.y, z: place.z, plane: dest.plane, height, lookupId: newKey.lookupId },
                sameBag, bagId: newBag.id, accepted, refused, keyMs: Math.round(keyMs), objectEventId: object?.id ?? null,
            },
        };
    }
    // ---- constrain_placed ----------------------------------------------------------
    /**
     * The shards a constrain_placed call names: one target or a list of them
     * (each as remove_placed and move_placed take one, of type shard unless
     * said otherwise), every shard whose name contains `match`, every shard in
     * one bag, or every shard placed. A target that cannot take the setting
     * refuses the call; in a selection by match, bag or all it is skipped.
     */
    pickShards(reading, input) {
        const editable = (r) => {
            if (r.type !== 'shard')
                return `it is a ${r.type}, and only a shard has a WALK setting`;
            if (!r.hidden?.shard)
                return 'this server cannot read it';
            if (r.byReference === 'public') {
                return r.hidden.inner.pubkey === this.host.pubkey
                    ? 'it is your public object placed by reference: its setting is in the object itself, so publish_object again with its d and constrain in the payload, which changes it everywhere it is placed'
                    : 'it is a public object by someone else, placed by reference: its setting is its author\'s and is never changed here; to choose your own, place a copy of its payload (place with object, or with its id) and remove this placement';
            }
            if (r.byReference === 'sealed' && r.hidden.inner.pubkey !== this.host.pubkey)
                return 'its sealed object was signed by another key, so only that key can seal it again';
            return null;
        };
        // A sealed object is one thing however many entries name it: sealed again once, reported once (review of #44, N1).
        const unique = (rows) => [...new Map(rows.map((r) => [r.byReference === 'sealed' && r.objectAddress ? r.objectAddress : `${r.bag.lookupId}/${r.key}`, r])).values()];
        if (input.target !== undefined) {
            const targets = (Array.isArray(input.target) ? input.target : [input.target]).map((t) => String(t).trim());
            if (targets.length === 0 || targets.some((t) => !t))
                throw new Refusal('target is "last", an exact name or an id, or a list of them; none may be empty. Nothing was changed.');
            const rows = unique(targets.map((t) => this.resolve(reading, t, input.type ?? 'shard')));
            for (const r of rows) {
                const why = editable(r);
                if (why)
                    throw new Refusal(`${r.type} "${r.label}" (id ${r.id.slice(0, 12)}): ${why}. Nothing was changed.`);
            }
            return { rows, skipped: [] };
        }
        let pool;
        if (input.bag !== undefined) {
            const want = String(input.bag).trim().toLowerCase();
            if (!/^[0-9a-f]{8,64}$/.test(want))
                throw new Refusal('bag is at least 8 hex characters of a lookup id or bag id, as placed lists them.');
            const hits = reading.bags.filter((b) => b.lookupId.startsWith(want) || b.bagId.startsWith(want));
            if (hits.length === 0)
                throw new Refusal(`None of your bags has a lookup id or bag id starting ${want}. placed lists them.`);
            if (hits.length > 1)
                throw new Refusal(`${hits.length} of your bags start ${want}; give more of the id.`);
            if (!hits[0].opened)
                throw new Refusal('That bag does not open with a key this server holds, so what is in it cannot be read or rewritten. Nothing was changed.');
            pool = hits[0].rows;
        }
        else if (input.match !== undefined) {
            const m = String(input.match).trim().toLowerCase();
            if (!m)
                throw new Refusal('match is the words a shard\'s name contains; it must not be empty (all: true is every shard). Nothing was changed.');
            pool = Placements.rows(reading).filter((r) => r.label.toLowerCase().includes(m));
        }
        else {
            pool = Placements.rows(reading);
        }
        const shards = pool.filter((r) => r.type === 'shard');
        if (shards.length === 0)
            throw new Refusal(`You have no shard placed${input.match !== undefined ? ` whose name contains "${String(input.match).trim()}"` : input.bag !== undefined ? ' in that bag' : ''} that this server can open: placed lists what you placed. Nothing was changed.`);
        const rows = [];
        const skipped = [];
        for (const r of unique(shards)) {
            const why = editable(r);
            if (why)
                skipped.push({ row: r, why });
            else
                rows.push(r);
        }
        return { rows, skipped };
    }
    /**
     * constrain_placed: set the WALK setting (DECK-0003 1.12) and, if asked,
     * the opacity (1.11) of shards placed, in place, as ONOSENDAI's EDIT writes
     * them (#461, #476). Opacity is 0 to 100: at 0 nothing of the shard is
     * drawn, and its constrain still holds walkers as written (DECK-0003 1.11,
     * 1.12). Each bag is read fresh and changed by one call at a time; an inline shard is signed again with its lineage (d = its first
     * id) and its bag rewritten in one step, keeping every other entry exactly
     * as found; a shard hidden by reference has its own sealed object sealed
     * again to the same place under the same d (its address, which comments
     * and reactions name), only while the relays hold this very version, and
     * put back when the canonical relay does not take the new one.
     */
    async constrain(input) {
        const constrain = input.constrain === undefined ? undefined : chosenConstrain(input.constrain);
        if (input.constrain !== undefined && !constrain)
            throw new Refusal('constrain is one of three words, lowercase: "opaque" (WALK cannot cross it while it is solid and fully opaque; the default), "all" (WALK cannot cross any face) or "off" (WALK passes through). Nothing was changed.');
        if (input.opacity !== undefined && (!Number.isInteger(input.opacity) || input.opacity < 0 || input.opacity > 100))
            throw new Refusal('opacity is a whole percent from 0 to 100: 100 is fully opaque, 0 draws nothing of the shard (DECK-0003 1.11). Nothing was changed.');
        if (constrain === undefined && input.opacity === undefined)
            throw new Refusal('Say what to set: constrain ("opaque", "all" or "off"), opacity (0 to 100), or both. Nothing was changed.');
        const selectors = [input.target !== undefined, input.match !== undefined, input.bag !== undefined, input.all === true].filter(Boolean).length;
        if (selectors !== 1)
            throw new Refusal('Say which shards with exactly one of: target ("last", an exact name or an id, or a list of them), match (every shard whose name contains these words), bag (every shard in one bag, by its lookup id or bag id from placed), or all: true (every shard you placed). Nothing was changed.');
        if (input.type !== undefined && TYPE_WORDS[String(input.type).trim().toLowerCase()] !== 'shard')
            throw new Refusal('Only a shard has a WALK setting: type, when given, is "shard". Nothing was changed.');
        const reading = await this.readAll();
        const { rows, skipped } = this.pickShards(reading, input);
        // What each shard will say, and the ones that already say it.
        const wantOf = (r) => ({
            constrain: constrain ?? authoredConstrainOf(r.hidden.shard),
            opacity: readOpacity(input.opacity !== undefined ? input.opacity : r.hidden.shard.opacity),
        });
        const already = rows.filter((r) => { const w = wantOf(r); return rawConstrain(r.hidden.shard) === w.constrain && readOpacity(r.hidden.shard.opacity) === w.opacity; });
        // The cap counts only what still needs changing, so the same call made again reaches the rest (review of #44, S1).
        // The cap counts only what this call changes: a bag the canonical relay
        // refuses does not use it up, so the other bags are done in the same call
        // (follow-up to #44: a refused bag first in the list stalled every call).
        const needing = rows.filter((r) => !already.includes(r));
        const byBag = new Map();
        for (const r of needing)
            byBag.set(r.bag.lookupId, [...(byBag.get(r.bag.lookupId) ?? []), r]);
        let attempted = 0;
        const changed = [];
        const failed = [];
        const bagNotes = [];
        const bagsData = [];
        const canonical = this.canonical;
        await this.withBags([...byBag.keys()], async () => {
            for (const [lookupId, all] of byBag) {
                const room = Math.min(MAX_CONSTRAIN_PER_CALL - changed.length, MAX_CONSTRAIN_ATTEMPTS_PER_CALL - attempted);
                if (room <= 0)
                    break;
                const group = all.slice(0, room);
                attempted += group.length;
                try {
                    const key = this.keyOf(group[0].bag);
                    for (const r of group)
                        this.unsentGuard([lookupId], isReference(r.entry) ? dOf(r.hidden.inner) : null);
                    const src = await this.ownBag(lookupId, hexToBytes(key.keyHex));
                    const now = nowSeconds();
                    const replaced = new Map();
                    for (const r of group) {
                        const was = src.current ? src.entries.find((e) => entryKey(e) === r.key) : undefined;
                        if (!was) {
                            failed.push({ row: r, why: 'it is no longer in that bag (placed shows what is there now)' });
                            continue;
                        }
                        // What is written: the word, and the opacity as asked (100 is written as no field), or the shard's own when not asked.
                        const w = { constrain: wantOf(r).constrain, ...(input.opacity !== undefined ? { opacity: input.opacity } : {}) };
                        if (!isReference(was)) {
                            // Inline: the item signed again where it is, with its lineage, every other tag and its payload's every other field kept.
                            const inner = was;
                            const content = rewritePayload(inner.content, w);
                            if (content === null) {
                                failed.push({ row: r, why: 'its payload does not read as SNO' });
                                continue;
                            }
                            const point = inner.tags.find((t) => t[0] === 'C');
                            replaced.set(r.key, this.host.sign(editedTemplate({ kind: inner.kind, created_at: now, content, tags: [...(point ? [[...point]] : []), [...PROTECTED_TAG]] }, inner)));
                            continue;
                        }
                        // By reference: its own sealed object, sealed again to the same place under the same d. The bag names it by address and stays as it is.
                        const old = referenced(r.hidden.inner);
                        const still = await this.addressStillThis(old);
                        if (still !== 'this') {
                            failed.push({ row: r, why: still === 'newer' ? 'the relays hold a newer version of its object than the one in your bag; call placed again' : 'no relay answered about its object, so sealing it again could overwrite a version this server cannot see' });
                            continue;
                        }
                        const objectAt = Math.max(now, old.created_at + 1);
                        const t = await resealedObject(old, hexToBytes(key.keyHex), hexToBytes(key.keyHex), objectAt, w);
                        if (!t) {
                            failed.push({ row: r, why: 'its object does not open with its bag\'s key' });
                            continue;
                        }
                        const object = this.host.sign(t);
                        // The old version, signed again a second newer: what goes back if the canonical relay does not take the new one (as move_placed does).
                        const rollback = this.host.sign({ kind: old.kind, created_at: objectAt + 1, content: old.content, tags: old.tags });
                        const sent = await this.host.relays.publish(object).catch((err) => ({ ok: false, reason: err instanceof Error ? err.message : String(err), reasons: {} }));
                        const said = Object.entries(sent.reasons).map(([u, why]) => `${u}: ${why}`).join('; ');
                        if (!sent.ok || !sent.accepted.includes(canonical)) {
                            const back = await this.putBack(rollback);
                            failed.push({ row: r, why: `the canonical relay did not take its object sealed again (${sent.ok ? `only ${sent.accepted.join(', ') || 'no relay'} did` : sent.reason}${said ? `; ${said}` : ''}), so it keeps its old setting.${back}` });
                            continue;
                        }
                        changed.push({ row: r, id: object.id, lineage: r.objectAddress ?? null, how: `its sealed object was sealed again under the same d (${object.id.slice(0, 8)}...): accepted by ${sent.accepted.join(', ')}${said ? `; refused by ${said} (verbatim)` : ''}; the bag names it by its address and was not rewritten` });
                    }
                    if (replaced.size > 0) {
                        const entries = src.entries.map((e) => replaced.get(entryKey(e)) ?? e);
                        const settings = bagSettingsOf(src.current, key.height);
                        const place = { position: { x: BigInt(key.base.x), y: BigInt(key.base.y), z: BigInt(key.base.z) }, plane: group[0].plane };
                        // Straight to the relays, and counted only once the canonical relay took it (landBag; review of #44, B1).
                        const event = await this.signBag(entries, key, settings, place, src.current);
                        const landed = await this.landBag(event, key, settings, place, src.current);
                        if (!landed.landed) {
                            // No direct way to make a relay drop what it took: writing the bag again is the way (review of #46, L1).
                            const recover = landed.unanswered ? ` To make every relay show the same: once the canonical relay answers, call constrain_placed again with the setting you want; if it says the shard already has it, set another value first (constrain "off", or another opacity) and then the one you want, which writes the bag again everywhere.` : '';
                            for (const r of group)
                                if (replaced.has(r.key))
                                    failed.push({ row: r, why: `${landed.why}. It keeps its old setting on the canonical relay.${recover}` });
                            continue;
                        }
                        const entry = landed.entry;
                        // "last" keeps naming the same thing when that thing was signed again.
                        const noted = this.host.keys.lastPlaced;
                        const next = noted && noted.lookupId === lookupId ? replaced.get(noted.entryKey) : undefined;
                        if (noted && next)
                            this.host.keys.notePlaced(lookupId, entryKey(next), noted.at);
                        for (const r of group) {
                            const n = replaced.get(r.key);
                            if (n)
                                changed.push({ row: r, id: n.id, lineage: itemLineage(n), how: `signed again with its lineage ${String(itemLineage(n)).slice(0, 12)}` });
                        }
                        bagNotes.push(`Your h${key.height} bag at base ${words(key.base)} was rewritten in one step (${event.id.slice(0, 8)}..., ${entries.length} thing(s), ${replaced.size} signed again, every other entry kept as it was): ${relayWords(entry)}.`);
                        bagsData.push({ lookupId, bagId: event.id, accepted: entry.accepted, refused: entry.refused ?? {} });
                    }
                }
                catch (err) {
                    const why = err instanceof Error ? err.message : String(err);
                    for (const r of group)
                        if (!changed.some((c) => c.row === r) && !failed.some((f) => f.row === r))
                            failed.push({ row: r, why });
                }
            }
        });
        // The ledger follows each shard written again to its new id (builds.ts).
        this.host.builds?.replaced(changed.map((c) => ({ from: { id: c.row.id, lineage: c.row.lineage }, id: c.id })));
        const setting = (r) => {
            const w = wantOf(r);
            return walkWords({ mode: r.hidden.shard.mode, opacity: w.opacity, extra: { constrain: w.constrain } }) + (input.opacity !== undefined ? `, opacity ${w.opacity ?? 100}` : w.opacity === 0 ? ', still invisible (opacity 0)' : '');
        };
        const name = (r) => `shard "${r.label}" at ${words(r.at)}${r.byReference === 'sealed' ? ' [by reference]' : ''}`;
        const asked = [constrain ? `constrain "${constrain}" (${CONSTRAIN_WORDS[constrain]})` : '', input.opacity !== undefined ? `opacity ${input.opacity}` : ''].filter(Boolean).join(' and ');
        // Opacity alone still writes the shard again, so one that chose no WALK word gains "opaque" (review of #44, N2).
        const gained = constrain === undefined ? changed.filter((c) => chosenConstrainOf(c.row.hidden.shard) === undefined).length : 0;
        const out = [];
        out.push(changed.length
            ? `Set ${asked} on ${changed.length} shard(s), in place, as ONOSENDAI's EDIT does: each keeps its lineage, so its comments and reactions follow it.${gained ? ` ${gained} of them had no WALK setting, so they now carry constrain "opaque", the default every shard written again gets.` : ''}`
            : failed.length
                ? `Changed nothing: no shard took ${asked}.`
                : already.length
                    ? `Nothing to change: every shard named already has ${asked}.`
                    : `Nothing to change: no shard named can take ${asked}.`);
        for (const c of changed)
            out.push(`  ${name(c.row)}: now ${setting(c.row)}; new id ${c.id.slice(0, 12)}, ${c.how}.`);
        // Opacity 0 (DECK-0003 1.11, no floor since 2026-11-15): nothing of the shard is drawn, and its constrain still holds as written (1.12).
        if (input.opacity === 0 && changed.length)
            out.push('At opacity 0 a reader draws nothing of these shards\' own (its glow, if it has one, still shows), and they still hold walkers as their constrain says: "all" holds a walker at an invisible wall; "opaque" never holds one at opacity 0, since the shard is not opaque (DECK-0003 1.11, 1.12).');
        out.push(...bagNotes);
        if (already.length)
            out.push(`Already set, left as they are: ${already.map((r) => `"${r.label}" (id ${r.id.slice(0, 12)})`).join(', ')}.`);
        for (const f of failed)
            out.push(`Not changed: ${name(f.row)} (id ${f.row.id.slice(0, 12)}): ${f.why}`);
        for (const k of skipped)
            out.push(`Skipped: ${name(k.row)} (id ${k.row.id.slice(0, 12)}): ${k.why}.`);
        const later = needing.length - attempted;
        if (later > 0)
            out.push(`${later} more shard(s) still need it: one call changes at most ${MAX_CONSTRAIN_PER_CALL} and tries at most ${MAX_CONSTRAIN_ATTEMPTS_PER_CALL}. Make the same call again for the rest; the ones already set are left alone.${failed.length ? ' A bag the canonical relay refused is tried again by the next call too; narrow the call with match or bag to leave it out.' : ''}`);
        if (reading.silent.length)
            out.push(`Not answered: ${reading.silent.join('; ')}. A shard only those relays hold was not seen.`);
        const text = out.join('\n');
        if (changed.length === 0 && failed.length > 0)
            throw new Refusal(text);
        const row = (r) => Placements.publicRow(r);
        return {
            text,
            data: {
                constrain: constrain ?? null, opacity: input.opacity ?? null,
                changed: changed.map((c) => ({ ...row(c.row), id: c.id, previousId: c.row.id, lineage: c.lineage, walk: { constrain: wantOf(c.row).constrain, opacity: wantOf(c.row).opacity ?? 100 } })),
                already: already.map(row),
                failed: failed.map((f) => ({ ...row(f.row), why: f.why })),
                skipped: skipped.map((k) => ({ ...row(k.row), why: k.why })),
                bags: bagsData,
                remaining: later,
            },
        };
    }
    /** Publish a failed move's old object version, retried; if no relay takes it, the outbox keeps sending it. Returns words for the answer. */
    async putBack(rollback) {
        for (let i = 0;; i++) {
            const r = await this.host.relays.publish(rollback).catch(() => ({ ok: false, reason: 'failed', reasons: {} }));
            if (r.ok && r.accepted.includes(this.canonical)) {
                this.host.keys.settlePutBack(rollback.id);
                return ' The shard\'s object was put back as it was.';
            }
            if (i >= PUT_BACK_RETRY_MS.length)
                break;
            await new Promise((res) => setTimeout(res, PUT_BACK_RETRY_MS[i]));
        }
        const entry = this.host.outbox.add(rollback);
        await this.host.outbox.send(entry);
        this.host.keys.settlePutBack(rollback.id);
        return ' Its old object version could not be put back on the canonical relay yet; the outbox keeps sending it. Where a relay took the object sealed to the new place, the old copy does not open until the old version lands there.';
    }
}
//# sourceMappingURL=placed.js.map