// outbox.ts: signed events not yet confirmed by the canonical relay, and
// their retry, persisted across restarts.
//
// The retry to the canonical relay is ported from ONOSENDAI
// src/lib/publisher.ts at commit 3756962 (branch feat/keys-and-chests):
// published counts once any relay took the event; the canonical relay is
// where every other reader looks, so when it was not among them the event is
// asked of it again in the background, with the state saved beside the
// chain so a restart still knows what is owed.
//
// Crash safety (brief, ruling 6): an event is written here before it is
// sent anywhere, so a server killed between signing and confirmation leaves
// an entry that the next start replays. An event no relay has taken yet is
// sent only when the guard the agent provides says the chain is clear: the
// guard reads the relays, and a fork (another device moved from the same
// point meanwhile) drops the entry with a note, while relays that cannot be
// read leave it pending rather than publish blind.
import { normalizeURL } from 'nostr-tools/utils';
import { REFUSED } from './relays.js';
/** An event's NIP-01 address: kind:pubkey:d for addressable kinds, kind:pubkey: for replaceable ones, null otherwise. */
function addressOf(ev) {
    const k = ev.kind;
    if (k >= 30000 && k < 40000)
        return `${k}:${ev.pubkey}:${ev.tags.find((t) => t[0] === 'd')?.[1] ?? ''}`;
    if (k === 0 || k === 3 || (k >= 10000 && k < 20000))
        return `${k}:${ev.pubkey}:`;
    return null;
}
const FILE = 'outbox.json';
/** First wait before the canonical relay is asked again; doubles up to the cap. */
export const CANONICAL_RETRY_MS = 5_000;
const RETRY_MAX_MS = 60_000;
/** Refused and dropped entries kept for the outbox tool to show. */
const HISTORY_KEPT = 50;
/**
 * How long after signing an event the canonical relay took is still asked of
 * the other configured relays that have not taken it (a second relay that was
 * down then, as nostr1 is kept second after the 2026-11-05 switch). A day
 * covers an outage without asking a relay gone for good forever.
 */
export const OTHERS_RETRY_S = 24 * 3600;
export class Outbox {
    dir;
    relays;
    entries;
    timer = null;
    backoff;
    retryMs;
    log;
    onAccepted;
    guard;
    stopped = false;
    constructor(dir, relays, opts = {}) {
        this.dir = dir;
        this.relays = relays;
        const saved = dir.readJson(FILE, null);
        this.entries = saved?.version === 1 && Array.isArray(saved.entries) ? saved.entries : [];
        this.retryMs = opts.retryMs ?? CANONICAL_RETRY_MS;
        this.backoff = this.retryMs;
        this.log = opts.log ?? (() => { });
        this.onAccepted = opts.onAccepted;
        this.guard = opts.guard;
    }
    save() {
        const history = this.entries.filter((e) => e.dropped || this.settled(e));
        if (history.length > HISTORY_KEPT) {
            const drop = new Set(history.slice(0, history.length - HISTORY_KEPT).map((e) => e.event.id));
            this.entries = this.entries.filter((e) => !drop.has(e.event.id));
        }
        this.dir.writeJson(FILE, { version: 1, entries: this.entries });
    }
    /** Whether an entry has nothing left to do: the canonical relay took it, or refused it outright. */
    settled(e) {
        return e.accepted.includes(this.relays.canonical) || (e.refused?.[this.relays.canonical] !== undefined);
    }
    /** The entries still owed to the canonical relay. */
    pending() {
        return this.entries.filter((e) => !e.dropped && !this.settled(e));
    }
    /**
     * Whether the canonical relay took an entry signed in the last day that
     * another configured relay has neither taken nor refused: it is asked of
     * those relays again, on the same backoff.
     */
    owedElsewhere(e, now = Math.floor(Date.now() / 1000)) {
        if (e.dropped || !e.accepted.includes(this.relays.canonical) || now - e.signedAt > OTHERS_RETRY_S)
            return false;
        return this.owedTo(e).length > 0 && !this.superseded(e);
    }
    /** The configured relays that have neither taken nor refused an entry. */
    owedTo(e) {
        return this.relays.urls.filter((u) => !e.accepted.includes(u) && e.refused?.[u] === undefined);
    }
    /**
     * Whether a later entry makes an event pointless to send anywhere it has
     * not gone: a deletion (kind 5) by its author naming its id or its address,
     * or a newer version at the same address (NIP-01: newer created_at, or the
     * same one and the lower id). A deleted event is never sent again.
     */
    superseded(e) {
        const ev = e.event;
        const address = addressOf(ev);
        return this.entries.some((o) => {
            const other = o.event;
            if (other.id === ev.id || other.pubkey !== ev.pubkey || o.dropped)
                return false;
            if (other.kind === 5) {
                return other.tags.some((t) => (t[0] === 'e' && t[1] === ev.id) || (address !== null && t[0] === 'a' && t[1] === address));
            }
            return address !== null && addressOf(other) === address
                && (other.created_at > ev.created_at || (other.created_at === ev.created_at && other.id < ev.id));
        });
    }
    /** Whether anything is left to ask of any relay. */
    owed() {
        return this.pending().length > 0 || this.entries.some((e) => this.owedElsewhere(e));
    }
    /** Record a signed event before anything is sent. */
    add(event, now = Math.floor(Date.now() / 1000)) {
        const entry = { event, signedAt: now, accepted: [], attempts: 0 };
        this.entries.push(entry);
        this.save();
        return entry;
    }
    /**
     * Send an entry to every relay that has not taken it. Resolves to the
     * publish result; the entry records what each relay said. Schedules the
     * retry when the canonical relay did not take it and did not refuse it.
     */
    async send(entry) {
        return this.sendTo(entry, this.relays.urls.filter((u) => !entry.accepted.includes(u) && entry.refused?.[u] === undefined));
    }
    /** `send`, to these relays only; `fresh: false` makes it one try, with no resend over fresh sockets. */
    async sendTo(entry, urls, fresh = true) {
        entry.attempts++;
        const result = urls.length === 0
            ? { ok: true, accepted: [], reasons: {} }
            : await this.relays.publishMany(urls, entry.event, { fresh });
        const newly = result.ok ? result.accepted.filter((u) => !entry.accepted.includes(u)) : [];
        entry.accepted = [...new Set([...entry.accepted, ...newly])];
        for (const [url, reason] of Object.entries(result.reasons)) {
            if (REFUSED.test(reason))
                entry.refused = { ...(entry.refused ?? {}), [normalizeURL(url)]: reason };
            else
                entry.lastError = `${url}: ${reason}`;
        }
        if (result.ok && newly.length === 0 && urls.length > 0)
            entry.lastError = Object.values(result.reasons)[0] ?? entry.lastError;
        this.save();
        if (newly.length > 0)
            this.onAccepted?.(entry.event, newly);
        if (!this.settled(entry) || this.owedElsewhere(entry))
            this.scheduleRetry();
        return result.ok && entry.accepted.length > 0 ? { ok: true, accepted: entry.accepted, reasons: result.reasons } : result;
    }
    /**
     * Whether an entry may be sent now. An event some relay already took is
     * public, so re-sending it changes nothing about forks; one no relay has
     * taken is asked of the guard. Resolves to the reason it must wait or be
     * dropped, or null when it may go.
     */
    async guarded(entry) {
        if (entry.accepted.length > 0 || !this.guard)
            return 'send';
        const g = await this.guard(entry.event).catch((err) => ({ verdict: 'unknown', reason: `the guard failed: ${err instanceof Error ? err.message : String(err)}` }));
        if (g.verdict === 'clear')
            return 'send';
        if (g.verdict === 'fork') {
            entry.dropped = g.reason;
            this.save();
            return 'dropped';
        }
        entry.lastError = g.reason;
        this.save();
        return 'wait';
    }
    scheduleRetry() {
        if (this.stopped || this.timer !== null || !this.owed())
            return;
        this.timer = setTimeout(() => { this.timer = null; void this.retry(); }, this.backoff);
    }
    /**
     * Passes never overlap. The timer's retry and a caller's retry used to run
     * at once, and when the guard's verdict flipped between their two guard
     * calls both sent the same event (seen as a flaky test under a parallel
     * suite, 2026-10-11). A retry made while one runs waits for it and then
     * makes a pass of its own, so a caller's retry still sees what the timer's
     * pass left pending.
     */
    running = Promise.resolve();
    /** Ask the relays once more for everything pending, each entry through the guard first. */
    retry() {
        const next = this.running.then(() => this.pass());
        this.running = next.catch(() => undefined);
        return next;
    }
    async pass() {
        if (this.stopped)
            return;
        let allSettled = true;
        for (const entry of this.pending()) {
            const may = await this.guarded(entry);
            if (may === 'dropped')
                continue;
            if (may === 'wait') {
                allSettled = false;
                continue;
            }
            await this.send(entry).catch((err) => this.log(`retry failed: ${err instanceof Error ? err.message : String(err)}`));
            if (!this.settled(entry))
                allSettled = false;
        }
        // What the canonical relay has, asked of the other relays that missed it
        // (a day at most), relay by relay: one that cannot be reached is skipped
        // for this pass after one try, not dialled again for each entry it is owed.
        const owing = this.entries.filter((e) => this.owedElsewhere(e));
        for (const url of [...new Set(owing.flatMap((e) => this.owedTo(e)))]) {
            if (this.stopped || !(await this.relays.reachable(url)))
                continue;
            for (const entry of owing) {
                if (!this.owedElsewhere(entry) || !this.owedTo(entry).includes(url))
                    continue;
                const result = await this.sendTo(entry, [url], false).catch((err) => { this.log(`retry failed: ${err instanceof Error ? err.message : String(err)}`); return null; });
                const why = result && !result.ok ? result.reason : null;
                // Gone since the check (not a refusal): the rest wait for the next pass.
                if (result === null || (why !== null && !REFUSED.test(why)))
                    break;
            }
        }
        const elsewhere = this.entries.some((e) => this.owedElsewhere(e));
        if ((allSettled || this.pending().length === 0) && !elsewhere) {
            this.backoff = this.retryMs;
            return;
        }
        this.backoff = Math.min(this.backoff * 2, RETRY_MAX_MS);
        if (this.timer === null && !this.stopped)
            this.timer = setTimeout(() => { this.timer = null; void this.retry(); }, this.backoff);
    }
    /**
     * At startup: every pending entry goes through the guard. Clear ones are
     * sent, forks are dropped with the reason, unknown ones stay pending and
     * the retry asks again.
     */
    async replay() {
        const sent = [];
        const dropped = [];
        const waiting = [];
        for (const entry of this.pending()) {
            const may = await this.guarded(entry);
            if (may === 'dropped') {
                dropped.push(entry);
                continue;
            }
            if (may === 'wait') {
                waiting.push(entry);
                continue;
            }
            await this.send(entry).catch((err) => this.log(`replay failed: ${err instanceof Error ? err.message : String(err)}`));
            sent.push(entry);
        }
        if (waiting.length > 0 || this.owed())
            this.scheduleRetry();
        return { sent, dropped, waiting };
    }
    /** What the outbox tool shows. */
    state() {
        return {
            pending: this.pending(),
            refused: this.entries.filter((e) => e.refused && this.settled(e) && !e.dropped),
            dropped: this.entries.filter((e) => e.dropped),
            nextRetryMs: this.timer === null ? null : this.backoff,
        };
    }
    stop() {
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}
//# sourceMappingURL=outbox.js.map