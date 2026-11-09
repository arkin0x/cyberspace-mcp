// presence.ts: who is in this part of cyberspace.
//
// Ported from ONOSENDAI src/store/usePresence.ts at commit 8cf3354 (the
// 27-sector filter, inNeighborhood, the ingest rule that the newest action
// per author places them) and src/lib/neighborChains.ts at commit 8cf3354
// (the chain verdict: a newest action says where someone is only if their
// chain is valid up to it; an invalid chain stands frozen at its last valid
// position), both on branch feat/keys-and-chests. The periodic sweep and
// the LRU caches are simplified: the server re-reads a person's chain when
// `look` asks and keeps one verdict per person.
//
// Every action carries its destination's sector on four tags; a relay
// indexes single-letter tags, and tag filters combine with AND across tags
// and OR within one, so one subscription on the three axis tags, each
// listing the agent's sector and its two neighbors, returns every action
// landing in the 27 sectors around it. strfry refuses a filter with more
// than three tag filters, so the action name is checked on arrival instead.
import { EventEmitter } from 'node:events';
import { xyzToSectorId } from 'cyberspace-core';
import { ACTION_KIND } from './chain/builder.js';
import { buildChain, firstBreak, parseAction } from './chain/events.js';
import { fetchChainEvents, isNewerAction } from './chain/resolve.js';
import { readProfile } from './profile.js';
import { placeFromHex } from './space/coords.js';
/** Newest actions fetched when a neighborhood is entered. */
const BACKFILL_LIMIT = 500;
/** The sector a position is in, as the string the S tag carries. */
export function sectorKey(p) {
    const s = xyzToSectorId(p.x, p.y, p.z);
    return `${s.sx}-${s.sy}-${s.sz}`;
}
/** The 27 sectors around a position, as one relay filter. */
export function neighborhoodFilter(p) {
    const s = xyzToSectorId(p.x, p.y, p.z);
    const around = (v) => [v - 1n, v, v + 1n].filter((x) => x >= 0n).map(String);
    return { kinds: [ACTION_KIND], '#X': around(s.sx), '#Y': around(s.sy), '#Z': around(s.sz) };
}
/** Whether a position's sector is within one of the given sector on every axis. */
export function inNeighborhood(p, of) {
    const a = xyzToSectorId(p.x, p.y, p.z);
    const b = xyzToSectorId(of.x, of.y, of.z);
    const near = (u, v) => u >= v - 1n && u <= v + 1n;
    return near(a.sx, b.sx) && near(a.sy, b.sy) && near(a.sz, b.sz);
}
/** How many sectors apart two positions are: the largest per-axis sector difference. */
export function sectorsApart(p, of) {
    const a = xyzToSectorId(p.x, p.y, p.z);
    const b = xyzToSectorId(of.x, of.y, of.z);
    const abs = (v) => (v < 0n ? -v : v);
    return [abs(a.sx - b.sx), abs(a.sy - b.sy), abs(a.sz - b.sz)].reduce((m, v) => (v > m ? v : m), 0n);
}
export class Presence extends EventEmitter {
    relays;
    me;
    log;
    people = new Map();
    sector = null;
    loading = false;
    arrivals = 0;
    here = null;
    stopLive = null;
    profiles = new Map();
    constructor(relays, me, log = () => { }) {
        super();
        this.relays = relays;
        this.me = me;
        this.log = log;
    }
    /** Enter the neighborhood around `at`: forget the old one, listen, then fetch. */
    async enter(at, now = Math.floor(Date.now() / 1000)) {
        const key = sectorKey(at);
        this.here = at;
        if (this.sector === key)
            return;
        this.stopLive?.();
        this.stopLive = null;
        this.sector = key;
        this.people.clear();
        this.loading = true;
        const filter = neighborhoodFilter(at);
        this.stopLive = this.relays.subscribe({ ...filter, since: now - 60 }, (ev) => {
            if (this.sector !== key)
                return;
            this.ingest(ev);
        });
        try {
            const events = await this.relays.query({ ...filter, limit: BACKFILL_LIMIT });
            if (this.sector !== key)
                return;
            for (const ev of events)
                this.ingest(ev);
        }
        catch (err) {
            this.log(`presence backfill failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        finally {
            if (this.sector === key)
                this.loading = false;
        }
    }
    /** Ask the relays for the neighborhood's newest actions again: what the live subscription may have missed. */
    async refresh() {
        if (!this.here)
            return;
        try {
            const events = await this.relays.query({ ...neighborhoodFilter(this.here), limit: BACKFILL_LIMIT });
            for (const ev of events)
                this.ingest(ev);
        }
        catch (err) {
            this.log(`presence refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** Take an action event in: the newest per author wins. A newcomer after the backfill is an arrival. */
    ingest(ev) {
        const action = parseAction(ev);
        if (!action || !this.here)
            return null;
        if (action.pubkey === this.me)
            return null;
        if (!inNeighborhood(action.position, this.here))
            return null;
        const have = this.people.get(action.pubkey);
        if (have && have.lastActive >= action.createdAt)
            return null;
        const person = {
            pubkey: action.pubkey,
            place: placeFromHex(action.coordHex),
            lastActive: action.createdAt,
            type: action.type,
            actionId: action.id,
            ...(have?.frozen && action.type !== 'spawn' ? { frozen: true, place: have.place } : {}),
            ...(this.profiles.has(action.pubkey) ? { profile: this.profiles.get(action.pubkey) } : {}),
        };
        this.people.set(action.pubkey, person);
        if (!have && !this.loading) {
            this.arrivals++;
            this.emit('arrival', person);
        }
        return person;
    }
    /** Everyone here, newest first. */
    others() {
        return [...this.people.values()].sort((a, b) => b.lastActive - a.lastActive);
    }
    /**
     * Read one person's chain at the action they show, and place them by it:
     * frozen at the last valid position when the chain is broken at or before
     * that action. A read whose chain does not hold the action says nothing.
     */
    async verdict(person) {
        if (person.verdictAt === person.actionId)
            return person;
        let chain;
        try {
            chain = buildChain(await fetchChainEvents(this.relays, person.pubkey), person.pubkey);
        }
        catch {
            return person;
        }
        const at = chain.findIndex((a) => a.id === person.actionId);
        if (at < 0)
            return person;
        const broken = firstBreak(chain);
        const shown = chain[at];
        const updated = { ...person, place: placeFromHex(shown.coordHex), frozen: broken !== null && at >= broken.index, verdictAt: person.actionId };
        if (this.people.get(person.pubkey)?.actionId === person.actionId)
            this.people.set(person.pubkey, updated);
        return updated;
    }
    /** Read the chains of up to `limit` people who have no verdict yet. */
    async verdicts(limit = 12) {
        const todo = this.others().filter((p) => p.verdictAt !== p.actionId).slice(0, limit);
        for (const p of todo)
            await this.verdict(p);
    }
    /** Fetch the kind 0 of everyone here whose profile is not known. */
    async fetchProfiles() {
        const missing = this.others().filter((p) => !this.profiles.has(p.pubkey)).map((p) => p.pubkey);
        if (missing.length === 0)
            return;
        try {
            const events = await this.relays.query({ kinds: [0], authors: missing.slice(0, 100) });
            const newest = new Map();
            for (const ev of events) {
                const have = newest.get(ev.pubkey);
                if (!have || isNewerAction({ createdAt: ev.created_at, id: ev.id }, { createdAt: have.created_at, id: have.id }))
                    newest.set(ev.pubkey, ev);
            }
            for (const pubkey of missing) {
                const profile = readProfile(newest.get(pubkey));
                this.profiles.set(pubkey, profile);
                const person = this.people.get(pubkey);
                if (person)
                    person.profile = profile;
            }
        }
        catch (err) {
            this.log(`profile fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    stop() {
        this.stopLive?.();
        this.stopLive = null;
        this.sector = null;
    }
}
//# sourceMappingURL=presence.js.map