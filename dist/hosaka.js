// hosaka.ts: the HOSAKA cloud-compute API, the part of it a ride needs, as
// this server speaks it. Ported from ONOSENDAI src/lib/hosaka.ts (branch v2
// at 6f29bc9): the error shape and its transient and answerLost readings,
// the NIP-98 authorization with a nonce tag per request, the request timeout,
// the bigint-free JSON, the poll token for reading a job without signing,
// the deposit claim, /start, and the idempotency key on every priced submit,
// a pure function of what the submit asks for, so every attempt at one job
// names the same job and a provider that honors keys answers a retry with
// the job it already made instead of charging twice.
//
// What is not ported: hop and sidestep quotes, limits, hops, sidesteps,
// region keys, deposits bought on their own, the balance, and the waiting
// loops. The agent polls through its own tool calls (transit.ts), never in
// the background, and the lost-answer retry is the next tool call, with the
// key persisted in the state directory, instead of a timer.
//
// THE RIDE JOB IS A PROPOSED CONTRACT. hosaka-api has no ride route yet
// (onosendai-launch #35, phases P2 to P4). This file speaks the shape the
// existing jobs have, with the fields a ride needs, so the server side can be
// built to it:
//
//   - GET /api/v1/provider lists {"type": "ride", "max_blocks": <n>} among
//     its services when it sells rides, and `idempotency` when it honors
//     keys. Without both, nothing is submitted.
//   - POST /api/v1/ride, NIP-98 signed, body {previous_event_id, from_height,
//     to_height, idempotency_key}, answers as /api/v1/sidestep does: the job,
//     its poll token, and either balance_debited or payment_required with a
//     deposit (deposit_id, bolt11, amount_msats, expires_at).
//   - A completed ride job's result is {root, mp, mn, previous_event_id,
//     from_height, to_height}: the hyperjump's proof, mp and mn tags.
//   - POST /api/v1/ride/quote, public and unsigned, body {from_height,
//     to_height}, prices a ride without buying it (HosakaRideQuote below).
//     The station tool shows it beside the local estimate.
//
// Money never touches this file. HOSAKA issues the invoice, the operator's
// wallet pays it, and the node's own answer is the payment: the agent only
// sends the invoice on and asks whether it settled.
import { createHash } from 'node:crypto';
import * as nip98 from 'nostr-tools/nip98';
import { bytesToHex } from './nostr/event.js';
/** The production API, the same one ONOSENDAI uses (VITE_HOSAKA_URL there, --hosaka-url here). */
export const HOSAKA_DEFAULT_URL = 'https://arkin0x--hosaka-api-api-server.modal.run';
/** One request outstanding longer than this is a dead connection, not a slow one. */
const REQUEST_TIMEOUT_MS = 20_000;
/**
 * What the API said no to, or what stopped the request. `code` is the
 * server's machine-readable `error` when it sent one, `network` when the
 * request never got an answer.
 */
export class HosakaError extends Error {
    status;
    code;
    detail;
    constructor(status, code, message, detail) {
        super(message);
        this.name = 'HosakaError';
        this.status = status;
        this.code = code;
        this.detail = detail;
    }
    static fromResponse(status, body) {
        const detail = body !== null && typeof body === 'object' && 'detail' in body ? body.detail : body;
        let code = null;
        let message = `HOSAKA answered ${status}`;
        if (typeof detail === 'string') {
            message = detail;
        }
        else if (detail !== null && typeof detail === 'object' && !Array.isArray(detail)) {
            const d = detail;
            if (typeof d.error === 'string')
                code = d.error;
            const text = typeof d.hint === 'string' ? d.hint : typeof d.message === 'string' ? d.message : null;
            message = [code, text].filter((s) => !!s).join(': ') || message;
        }
        return new HosakaError(status, code, message, detail);
    }
    /**
     * The request went out and its outcome is unknown: the connection dropped
     * or timed out, or the server failed while answering. A priced submit with
     * a lost answer may have made its job; asking again is safe only with the
     * same idempotency key.
     */
    get answerLost() {
        return (this.status === 0 && this.code === 'network') || this.status >= 500;
    }
}
/** JSON with object keys sorted at every level: the same value, the same text. */
function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const obj = value;
        return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
/** The body of a ride submit, before its key is added: the chain head the leaves are seeded by and the blocks passed. */
export function rideBody(previousEventId, fromHeight, toHeight) {
    return { previous_event_id: previousEventId, from_height: fromHeight, to_height: toHeight };
}
/**
 * The idempotency key of one ride: a hash of what the proof is (the head
 * and the two blocks), so the same ride from the same head is always the
 * same key. It survives a restart, a lost answer, a canceled ride asked for
 * again, and a failed job started again (HOSAKA lets a failed key start a
 * new job, paid from the refund it left in the balance). A ride from another
 * head is another key, which is right: its leaves are other leaves.
 */
export function rideIdempotencyKey(previousEventId, fromHeight, toHeight) {
    const digest = createHash('sha256').update(`cyberspace-mcp/1\nride\n${canonicalJson(rideBody(previousEventId, fromHeight, toHeight))}`).digest('hex');
    return `cyberspace-mcp-${digest}`;
}
/** Whether the provider says it sells rides, and the most blocks one may pass when it says. */
export function rideService(p) {
    const s = p.services?.find((x) => x?.type === 'ride');
    if (!s)
        return null;
    return { maxBlocks: typeof s.max_blocks === 'number' && s.max_blocks > 0 ? s.max_blocks : null };
}
/**
 * An answer from /api/v1/ride/quote as a quote for the ride asked about, or
 * the reason it is not one: not JSON, not an object, missing the fields a
 * price is read from, or a quote for another ride. A quote HOSAKA would not
 * take (within_cap false, or a refusal) is still a quote; its cost may be null.
 */
export function rideQuoteOf(raw, fromHeight, toHeight) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return 'the answer was not a JSON quote';
    const q = raw;
    if (typeof q.within_cap !== 'boolean')
        return 'the answer does not say whether the ride is within its cap';
    if (q.cost_msats !== null && !(typeof q.cost_msats === 'number' && Number.isFinite(q.cost_msats) && q.cost_msats >= 0))
        return 'the answer carries no readable price';
    if (q.refusal !== undefined && q.refusal !== null && typeof q.refusal !== 'object')
        return 'the answer carries an unreadable refusal';
    if ((typeof q.from_height === 'number' && q.from_height !== fromHeight) || (typeof q.to_height === 'number' && q.to_height !== toHeight)) {
        return `the answer prices a ride from block ${q.from_height} to block ${q.to_height}, not the one asked about`;
    }
    if (q.within_cap && !q.refusal && q.cost_msats === null)
        return 'the answer takes the ride but names no price';
    return { ...q, refusal: q.refusal ?? null };
}
/** Seconds as a short human estimate in the voice of HOSAKA's est_time: "~45 s", "~12 min", "~3.5 h". */
export function durationWords(seconds) {
    if (seconds < 90)
        return `~${Math.max(1, Math.round(seconds))} s`;
    if (seconds < 90 * 60)
        return `~${Math.round(seconds / 60)} min`;
    return `~${(seconds / 3600).toFixed(1)} h`;
}
/** Whether the provider says it honors idempotency keys. */
export function honorsKeys(p) {
    return typeof p.idempotency === 'object' && p.idempotency !== null;
}
/** A completed job's result as a ride proof, or the reason it is not one. */
export function rideResultOf(job) {
    const r = job.result;
    if (!r || typeof r !== 'object')
        return 'the job carries no result';
    if (typeof r.root !== 'string' || typeof r.mp !== 'string' || typeof r.mn !== 'string')
        return 'the result has no root, mp and mn';
    if (typeof r.previous_event_id !== 'string' || typeof r.from_height !== 'number' || typeof r.to_height !== 'number')
        return 'the result does not say which ride it proves';
    return r;
}
function randomNonce() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
}
export function createHosaka(opts) {
    const apiUrl = opts.apiUrl.replace(/\/+$/, '');
    const doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    /**
     * A fresh kind 27235 event per request. HOSAKA remembers every event id it
     * accepted for the freshness window, so a token is never sent twice; the
     * nonce tag makes two requests signed in the same second distinct events.
     */
    const authorization = (url, method) => nip98.getToken(url, method, (template) => opts.sign({ ...template, tags: [...template.tags, ['nonce', randomNonce()]] }), true);
    const request = async (path, init) => {
        const url = apiUrl + path;
        const headers = { accept: 'application/json', ...(init.headers ?? {}) };
        if (init.body !== undefined)
            headers['content-type'] = 'application/json';
        if (init.auth)
            headers.authorization = await authorization(url, init.method);
        const timeout = AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS);
        const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        let res;
        try {
            res = await doFetch(url, { method: init.method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal });
        }
        catch (err) {
            throw new HosakaError(0, 'network', err instanceof Error ? err.message : String(err));
        }
        let text;
        try {
            text = await res.text();
        }
        catch (err) {
            throw new HosakaError(0, 'network', err instanceof Error ? err.message : String(err));
        }
        let data = null;
        if (text) {
            try {
                data = JSON.parse(text);
            }
            catch {
                data = text;
            }
        }
        if (!res.ok)
            throw HosakaError.fromResponse(res.status, data);
        return data;
    };
    return {
        apiUrl,
        provider: (o) => request('/api/v1/provider', { method: 'GET', ...o }),
        rideQuote: (fromHeight, toHeight, o) => request('/api/v1/ride/quote', { method: 'POST', body: { from_height: fromHeight, to_height: toHeight }, ...o }),
        submitRide: (previousEventId, fromHeight, toHeight, key) => request('/api/v1/ride', { method: 'POST', auth: true, body: { ...rideBody(previousEventId, fromHeight, toHeight), idempotency_key: key } }),
        getJob: (jobId, pollToken) => request(`/api/v1/jobs/${encodeURIComponent(jobId)}`, { method: 'GET', headers: { 'X-Job-Token': pollToken } }),
        startJob: (jobId) => request(`/api/v1/jobs/${encodeURIComponent(jobId)}/start`, { method: 'POST', auth: true }),
        claimDeposit: (depositId) => request(`/api/v1/deposit/${encodeURIComponent(depositId)}/claim`, { method: 'POST', auth: true }),
    };
}
//# sourceMappingURL=hosaka.js.map