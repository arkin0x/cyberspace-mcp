// approvals.ts: the operator approves each payment first (arkinox,
// 2026-11-23: "the current limits are fine, but I would want to know when
// any spend happens, and I'd want xor to ask before spending every time").
//
// With paymentApproval "operator", a payment the wallet would make (within
// maxPaymentSats and maxDailySats, which still apply) is held as a request:
// the server, never a model, DMs the operator what it is for, the amount,
// who is paid and what is left of the day, with a short code. It is paid
// only when the operator's own DM (sealed by their key, checked by the
// operator channel) names that code; "no <code>" refuses it. A request
// expires after APPROVAL_TTL_MS with nothing paid. One approval is one
// payment of exactly that amount and payment hash, used once: there is no
// "approve all", and an approval already used, expired or refused is
// ignored. The code is never in a tool's answer, so a model cannot hand it
// on; it reaches only the operator, by DM.
//
// <state>/approvals.json keeps the requests (mode 600), so a restart waits
// on the same request instead of asking twice.
import { randomInt } from 'node:crypto';
import { RESTORE_WORDS } from './trash.js';
/** How long the operator has to answer a request. */
export const APPROVAL_TTL_MS = 30 * 60_000;
/** How many requests are kept, newest last; settled ones older than a week go first. */
const KEPT = 200;
const KEPT_MS = 7 * 24 * 60 * 60_000;
const FILE = 'approvals.json';
/** No 0/O, 1/I/L: read aloud or typed on a phone without mistakes. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export class Approvals {
    dir;
    mode;
    now;
    ttlMs;
    requests;
    constructor(dir, mode, now = Date.now, ttlMs = APPROVAL_TTL_MS) {
        this.dir = dir;
        this.mode = mode;
        this.now = now;
        this.ttlMs = ttlMs;
        const saved = dir.readJson(FILE, null);
        this.requests = saved?.version === 1 && Array.isArray(saved.requests) ? saved.requests : [];
    }
    /** Whether every payment waits for the operator's approval. */
    get required() {
        return this.mode === 'operator';
    }
    save() {
        const cutoff = this.now() - KEPT_MS;
        this.requests = this.requests.filter((r) => r.state === 'pending' || r.state === 'approved' || r.createdAt >= cutoff).slice(-KEPT);
        this.dir.writeJson(FILE, { version: 1, requests: this.requests });
    }
    /** Mark lapsed requests expired. Returns whether anything changed. */
    expire() {
        const t = this.now();
        let changed = false;
        for (const r of this.requests) {
            if ((r.state === 'pending' || r.state === 'approved') && t >= r.expiresAt) {
                r.state = 'expired';
                changed = true;
            }
        }
        if (changed)
            this.save();
        return changed;
    }
    /** The newest request for a deposit, judged against the amount and payment hash about to be paid. */
    verdict(depositId, sats, paymentHash) {
        this.expire();
        const r = [...this.requests].reverse().find((q) => q.depositId === depositId);
        if (!r)
            return { state: 'none' };
        if (r.state === 'pending')
            return { state: 'pending', request: r };
        if (r.state === 'expired')
            return { state: 'expired', request: r, reason: `your operator did not answer approval request ${r.code} within ${Math.round(this.ttlMs / 60_000)} minutes, so nothing was paid` };
        if (r.state === 'refused')
            return { state: 'refused', request: r, reason: `your operator refused approval request ${r.code}, so nothing was paid` };
        if (r.state === 'used')
            return { state: 'used', request: r, reason: `approval ${r.code} was already used for one payment; an approval is never used twice` };
        if (r.sats !== sats || r.paymentHash !== paymentHash.toLowerCase()) {
            return { state: 'mismatch', request: r, reason: `approval ${r.code} was for ${r.sats} sats and another invoice; this one is not what your operator approved, so nothing was paid` };
        }
        return { state: 'approved', request: r };
    }
    /** Hold a payment as a request with a fresh code. The caller DMs the operator the words requestWords gives. */
    request(input) {
        const code = newCode('PAY', new Set(this.requests.map((r) => r.code)));
        const t = this.now();
        const r = { code, depositId: input.depositId, paymentHash: input.paymentHash.toLowerCase(), sats: input.sats, purpose: input.purpose, payee: input.payee, createdAt: t, expiresAt: t + this.ttlMs, state: 'pending' };
        this.requests.push(r);
        this.save();
        return r;
    }
    /** Spend an approval on the one payment it covers, before the payment goes out. False when it is not (or no longer) an approval for exactly this. */
    use(code, sats, paymentHash) {
        this.expire();
        const r = this.requests.find((q) => q.code === code);
        if (!r || r.state !== 'approved' || r.sats !== sats || r.paymentHash !== paymentHash.toLowerCase())
            return false;
        r.state = 'used';
        this.save();
        return true;
    }
    /**
     * A DM from the operator (the caller has checked the seal: it is theirs,
     * to this agent). When it names a pending request's code it answers that
     * request: approved, or refused when it says no. Returns the request it
     * answered, or null when it names none (then it is an ordinary message).
     * The DM must be newer than the request it answers: an old message cannot
     * approve a new request.
     */
    answer(text, createdAtSeconds, messageId) {
        if (!this.required)
            return null;
        this.expire();
        const said = readAnswer(text);
        if (!said)
            return null;
        const r = this.requests.find((q) => q.state === 'pending' && q.code === said.code);
        if (!r)
            return null;
        if (createdAtSeconds * 1000 < r.createdAt - 60_000)
            return null;
        r.state = said.yes ? 'approved' : 'refused';
        r.answeredAt = this.now();
        r.answerId = messageId;
        this.save();
        return r;
    }
    /** Whether the operator has been sent this request's DM; a request whose DM did not go out is sent again. */
    notified(code) {
        return this.requests.find((q) => q.code === code)?.notified === true;
    }
    markNotified(code) {
        const r = this.requests.find((q) => q.code === code);
        if (r && !r.notified) {
            r.notified = true;
            this.save();
        }
    }
    /** Requests still waiting on the operator, for the wallet tool (never with the code). */
    pending() {
        this.expire();
        return this.requests.filter((r) => r.state === 'pending').map(({ code: _c, answerId: _a, ...rest }) => rest);
    }
}
/** Every approval code, payment (PAY-) or delete (DEL-): a message holding two answers nothing. */
const ANY_CODE = /\b(?:PAY|DEL)-[2-9A-HJKMNP-Z]{6}\b/gi;
const YES = new Set(['YES', 'Y', 'OK', 'OKAY', 'APPROVE', 'APPROVED', 'GO']);
const NO = new Set(['NO', 'N', 'DENY', 'DENIED', 'REFUSE', 'REFUSED', 'REJECT', 'CANCEL']);
/** The yes-word each kind of request adds: "pay PAY-..." and "delete DEL-..." read as yes. */
const YES_FOR = { PAY: 'PAY', DEL: 'DELETE' };
/**
 * What an operator's DM says about a request, read strictly (review of
 * #107: "do not pay PAY-X" must never pay): the code alone, or one yes-word
 * and the code, approves; one no-word and the code refuses. Anything else
 * (other words, a question, two codes of any kind) answers nothing, and the
 * message is an ordinary one. Case and the punctuation around the words do
 * not count. `prefix` says which requests it answers: a DEL- code never
 * answers a payment, nor a PAY- code a delete.
 */
export function readAnswer(text, prefix = 'PAY') {
    const codes = text.match(ANY_CODE) ?? [];
    if (codes.length !== 1)
        return null;
    const code = codes[0].toUpperCase();
    if (!code.startsWith(`${prefix}-`))
        return null;
    const words = text.toUpperCase().replace(ANY_CODE, ' ').replace(/[.,!:;"'()\s]+/g, ' ').trim().split(' ').filter(Boolean);
    if (words.length === 0)
        return { code, yes: true };
    if (words.length !== 1)
        return null;
    if (YES.has(words[0]) || words[0] === YES_FOR[prefix])
        return { code, yes: true };
    if (NO.has(words[0]))
        return { code, yes: false };
    return null;
}
/** A text with every approval code blanked (payment and delete): what the server keeps of the DMs it sent, so no tool can echo a code back (review of #107). */
export function withoutCodes(text) {
    return text.replace(ANY_CODE, (m) => `${m.slice(0, 3).toUpperCase()}-******`);
}
/** A fresh code with this prefix, unlike any in `used`. */
function newCode(prefix, used) {
    let code;
    do {
        code = `${prefix}-` + Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    } while (used.has(code));
    return code;
}
/** The DM that asks the operator to approve one payment. */
export function requestWords(r, day) {
    const minutes = Math.round((r.expiresAt - r.createdAt) / 60_000);
    return [
        `May I pay ${r.sats} sats? ${r.purpose}`,
        `Paid to: ${r.payee}.`,
        `Today so far: ${day.spentSats} of ${day.maxDailySats} sats spent; after this, ${Math.max(0, day.maxDailySats - day.spentSats - r.sats)} left. One payment may be at most ${day.maxPaymentSats} sats.`,
        `To approve, reply with just the code ${r.code} (or "yes ${r.code}"). To refuse, reply "no ${r.code}". Any other reply approves nothing. It expires in ${minutes} minutes; if you do not answer, nothing is paid.`,
    ].join('\n');
}
// ---- deletes -----------------------------------------------------------------
//
// The operator approves a large delete first (arkinox, 2026-11-26, after
// "delete the aerocarnival course" took a 31-piece castle that shared a bag
// with it: "a delete preview with operator approval"). The same strict
// reading as a payment: the server, never a model, DMs the operator what
// would go and what stays, with a DEL- code; only the operator's own DM
// naming it approves; "no <code>" refuses; it lapses after the TTL; one
// approval is one delete of exactly the pieces previewed, used once. The
// code is never in a tool's answer. <state>/delete-approvals.json keeps the
// requests (mode 600).
/** How many pieces may go in one delete without the operator's approval, by default. */
export const DEFAULT_DELETE_APPROVAL_THRESHOLD = 5;
const DELETE_FILE = 'delete-approvals.json';
/** How long a delete that ran without approval counts against the threshold (review of 485a2df: no splitting a large delete into small ones). */
export const DELETE_WINDOW_MS = 60 * 60_000;
/** The set a request covers, as one string: the ids sorted, without repeats. */
function setOf(pieces) {
    return [...new Set(pieces)].sort();
}
/** The delete approval requests in <state>/delete-approvals.json, read as strictly as a payment's. */
export class DeleteApprovals {
    dir;
    mode;
    now;
    ttlMs;
    requests;
    /** Deletes that ran without an approval, the last hour's: when, and how many pieces. */
    deleted;
    constructor(dir, mode, now = Date.now, ttlMs = APPROVAL_TTL_MS) {
        this.dir = dir;
        this.mode = mode;
        this.now = now;
        this.ttlMs = ttlMs;
        const saved = dir.readJson(DELETE_FILE, null);
        this.requests = saved?.version === 1 && Array.isArray(saved.requests) ? saved.requests : [];
        this.deleted = saved?.version === 1 && Array.isArray(saved.deleted) ? saved.deleted.filter((d) => typeof d?.at === 'number' && typeof d?.pieces === 'number') : [];
    }
    /** How many pieces deletes that needed no approval took in the last hour, across delete_build and remove_placed. */
    recentDeleted() {
        const since = this.now() - DELETE_WINDOW_MS;
        return this.deleted.filter((d) => d.at > since).reduce((n, d) => n + d.pieces, 0);
    }
    /** A delete ran. One the operator approved is not counted: they saw exactly what went. */
    noteDeleted(pieces, approved) {
        if (approved || pieces <= 0)
            return;
        this.deleted.push({ at: this.now(), pieces });
        this.save();
    }
    /** Whether a delete that needs approval waits for the operator. */
    get required() {
        return this.mode === 'operator';
    }
    /** How long the operator has to answer, in minutes. */
    get ttlMinutes() {
        return Math.round(this.ttlMs / 60_000);
    }
    save() {
        const cutoff = this.now() - KEPT_MS;
        this.requests = this.requests.filter((r) => r.state === 'pending' || r.state === 'approved' || r.createdAt >= cutoff).slice(-KEPT);
        const since = this.now() - DELETE_WINDOW_MS;
        this.deleted = this.deleted.filter((d) => d.at > since);
        this.dir.writeJson(DELETE_FILE, { version: 1, requests: this.requests, deleted: this.deleted });
    }
    expire() {
        const t = this.now();
        let changed = false;
        for (const r of this.requests) {
            if ((r.state === 'pending' || r.state === 'approved') && t >= r.expiresAt) {
                r.state = 'expired';
                changed = true;
            }
        }
        if (changed)
            this.save();
    }
    /**
     * The newest request for exactly this set of pieces. A request for any
     * other set does not apply (the preview it approved is not this one). A
     * refusal or lapse is told once; after that the set has no request, so the
     * next confirm asks again.
     */
    verdict(pieces) {
        this.expire();
        const want = setOf(pieces).join(',');
        const r = [...this.requests].reverse().find((q) => q.pieces.join(',') === want);
        if (!r || r.state === 'used' || r.reported)
            return { state: 'none' };
        if (r.state === 'pending')
            return { state: 'pending', request: r };
        if (r.state === 'approved')
            return { state: 'approved', request: r };
        // Words without the code: no tool's answer ever carries one, a spent one included.
        const reason = r.state === 'refused'
            ? 'your operator refused this delete, so nothing was deleted'
            : `your operator did not answer the request for this delete within ${this.ttlMinutes} minutes, so nothing was deleted`;
        return { state: r.state === 'refused' ? 'refused' : 'expired', request: r, reason };
    }
    /** Mark a refusal or lapse as told to the agent. */
    reported(code) {
        const r = this.requests.find((q) => q.code === code);
        if (r && !r.reported) {
            r.reported = true;
            this.save();
        }
    }
    /** Hold a delete as a request with a fresh code. The caller DMs the operator deleteRequestWords. */
    request(input) {
        const code = newCode('DEL', new Set(this.requests.map((r) => r.code)));
        const t = this.now();
        const r = { code, pieces: setOf(input.pieces), summary: input.summary, createdAt: t, expiresAt: t + this.ttlMs, state: 'pending' };
        this.requests.push(r);
        this.save();
        return r;
    }
    /** Spend an approval on the delete it covers, before anything is signed. False when it is not (or no longer) an approval of exactly this set. */
    use(code, pieces) {
        this.expire();
        const r = this.requests.find((q) => q.code === code);
        if (!r || r.state !== 'approved' || r.pieces.join(',') !== setOf(pieces).join(','))
            return false;
        r.state = 'used';
        this.save();
        return true;
    }
    /** A DM from the operator (seal checked by the caller): answers the pending delete request it names, as Approvals.answer does a payment's. */
    answer(text, createdAtSeconds, messageId) {
        if (!this.required)
            return null;
        this.expire();
        const said = readAnswer(text, 'DEL');
        if (!said)
            return null;
        const r = this.requests.find((q) => q.state === 'pending' && q.code === said.code);
        if (!r)
            return null;
        if (createdAtSeconds * 1000 < r.createdAt - 60_000)
            return null;
        r.state = said.yes ? 'approved' : 'refused';
        r.answeredAt = this.now();
        r.answerId = messageId;
        this.save();
        return r;
    }
    notified(code) {
        return this.requests.find((q) => q.code === code)?.notified === true;
    }
    markNotified(code) {
        const r = this.requests.find((q) => q.code === code);
        if (r && !r.notified) {
            r.notified = true;
            this.save();
        }
    }
    /** Requests still waiting on the operator (never with the code). */
    pending() {
        this.expire();
        return this.requests.filter((r) => r.state === 'pending').map(({ code: _c, answerId: _a, ...rest }) => rest);
    }
}
/** The DM that asks the operator to approve one delete. Kept under the DM cap: the list is cut, never the code or how to answer. */
export function deleteRequestWords(r, maxChars = 3800) {
    const minutes = Math.round((r.expiresAt - r.createdAt) / 60_000);
    const head = `May I delete ${r.pieces.length} thing(s) I placed? A backup of everything that goes is written to the trash in my state directory first. ${RESTORE_WORDS}`;
    const tail = `To approve, reply with just the code ${r.code} (or "yes ${r.code}"). To refuse, reply "no ${r.code}". Any other reply approves nothing. It expires in ${minutes} minutes; if you do not answer, nothing is deleted.`;
    const room = Math.max(200, maxChars - head.length - tail.length - 4);
    const summary = r.summary.length > room ? `${r.summary.slice(0, room - 20).replace(/\s+\S*$/, '')} ... (list cut)` : r.summary;
    return [head, summary, tail].join('\n');
}
//# sourceMappingURL=approvals.js.map