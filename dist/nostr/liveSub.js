// liveSub.ts: a subscription that outlives its socket.
//
// Ported from ONOSENDAI src/lib/liveSub.ts at commit f77da38 (branch
// feat/keys-and-chests), unchanged but for the event type.
//
// A relay socket dies for reasons the process never sees: a NAT forgets an
// idle connection, a relay restarts. This keeps each live subscription as a
// record and reopens it whenever the transport reports it closed, with
// backoff. `since` is moved forward to just before the last event seen, with
// a minute of overlap: a repeat is cheaper than a gap, and every consumer
// merges by id. The transport is injected so the loop runs against the fake
// relay in tests.
/** Seconds of overlap when a subscription is reissued. */
export const RESUME_OVERLAP_S = 60;
/** How long a reopen waits after each successive close, in milliseconds. */
export const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** The filter to reissue with: `since` moved up to just before the last event seen. */
export function resumedFilter(filter, lastSeen) {
    if (lastSeen === null)
        return filter;
    const since = Math.max(filter.since ?? 0, lastSeen - RESUME_OVERLAP_S);
    return { ...filter, since };
}
export function backoffFor(attempts) {
    return BACKOFF_MS[Math.min(Math.max(0, attempts - 1), BACKOFF_MS.length - 1)];
}
export class LiveRegistry {
    transport;
    records = new Map();
    nextId = 1;
    constructor(transport) {
        this.transport = transport;
    }
    /** Open a subscription that will be kept open. Returns its closer. */
    subscribe(filter, handlers) {
        const live = {
            id: this.nextId++, filter, handlers, lastSeen: null, events: 0, reopens: 0,
            attempts: 0, closed: false, closer: null, timer: null, opening: false,
        };
        this.records.set(live.id, live);
        void this.open(live);
        return () => this.close(live);
    }
    list() {
        return [...this.records.values()];
    }
    /** Close every record. */
    closeAll() {
        for (const live of [...this.records.values()])
            this.close(live);
    }
    async open(live) {
        if (live.closed || live.opening)
            return;
        live.opening = true;
        const generation = live.reopens;
        try {
            const closer = await this.transport.open(resumedFilter(live.filter, live.lastSeen), {
                onEvent: (ev) => {
                    if (live.closed)
                        return;
                    live.events++;
                    live.attempts = 0;
                    if (live.lastSeen === null || ev.created_at > live.lastSeen)
                        live.lastSeen = ev.created_at;
                    live.handlers.onEvent(ev);
                },
                onEose: live.handlers.onEose,
            }, () => {
                if (live.closed || live.reopens !== generation)
                    return;
                live.closer = null;
                this.scheduleReopen(live);
            });
            if (live.closed) {
                closer();
                return;
            }
            live.closer = closer;
        }
        catch {
            this.scheduleReopen(live);
        }
        finally {
            live.opening = false;
        }
    }
    scheduleReopen(live) {
        if (live.closed || live.timer)
            return;
        live.attempts++;
        live.timer = setTimeout(() => {
            live.timer = null;
            live.reopens++;
            void this.open(live);
        }, backoffFor(live.attempts));
    }
    close(live) {
        live.closed = true;
        if (live.timer) {
            clearTimeout(live.timer);
            live.timer = null;
        }
        live.closer?.();
        live.closer = null;
        this.records.delete(live.id);
    }
}
//# sourceMappingURL=liveSub.js.map