// updates.ts: signed update notices (arkinox, 2026-11-23: "go ahead"; NIP-82
// chosen the same day: "nip 82 sounds good"). People run this server from a
// clone, an npm install from GitHub or a release bundle, and nothing told them
// about a security fix. Now, when a release is cut, the cyberspace-mcp RELEASE
// KEY publishes it as NIP-82 events to wss://relay.onosendai.tech
// (docs/releasing.md, scripts/publish-update-notice.mjs), the same events
// ngit and Zapstore publish, and every running copy listens for them.
//
//   - Trust. A release counts only when its signature verifies and its
//     author is RELEASE_PUBKEY, compiled in here. Nothing a relay, a chat line
//     or a tool argument says can change that key; the tests alone pass
//     another.
//   - Strict reading. parseNotice reads a kind 30063 exactly (the section
//     below says what it checks). Anything malformed, duplicated or out of
//     range makes the whole event ignored, never half read.
//   - Latest by version, minimum by high-water mark. The latest release is
//     the highest version seen, not the newest event, so a backport published
//     after a newer release does not win. The minimum safe version is the
//     highest min_allowed_version any trusted release ever carried, kept in
//     the state directory and never lowered: a relay that hides events, or
//     replays old ones, cannot roll it back. An event dated more than ten
//     minutes ahead of this clock is not read, and no version part may have
//     more than six digits.
//   - What it does. The operator is told, never the code changed: one line
//     in doctor, a short line at the end of tool replies (rate limited), and
//     one DM per announced version. The update commands in those words come
//     from this file, never from the event. A copy older than the minimum
//     safe version switches off the features in GATED_FEATURES until it is
//     updated, and says why. Movement and reading the world keep working.
//   - No automatic installs, by design: a stolen release key must never mean
//     code execution on every server. The worst a stolen key can do is make
//     copies tell their operators to update, or switch off the gated features
//     until a release with a new key (docs/releasing.md, "Update notices").
//   - Privacy. No GitHub call, no HTTP at all: the releases come over the
//     relays this server already talks to, plus the notice relay.
import { readFileSync } from 'node:fs';
import { verifyEvent } from 'nostr-tools/pure';
import { DEFAULT_RELAY } from './nostr/relays.js';
/** The cyberspace-mcp release key (npub1ttlpyy4r6lrsvgtxmny8wny2pakp8xwpurvuc3a6pae2jnv8wpestxy4ks), the only author of notices. */
export const RELEASE_PUBKEY = '5afe1212a3d7c7062166dcc8774c8a0f6c1399c1e0d9cc47ba0f72a94d877073';
/** Where the release key publishes notices; every copy asks it besides its own relays. */
export const NOTICE_RELAY = DEFAULT_RELAY;
/** The most of the release notes shown to the operator, in characters. */
export const MAX_NOTE = 280;
/** How far ahead of this clock a notice may be dated and still be read, in seconds. */
export const MAX_FUTURE_S = 600;
/** How often the tool replies repeat a plain "update available" line, and the line of a copy below min_safe, in ms. */
export const AVAILABLE_LINE_EVERY_MS = 6 * 60 * 60_000;
export const UNSAFE_LINE_EVERY_MS = 15 * 60_000;
/** How often an undelivered DM is tried again. */
const RETELL_MS = 30 * 60_000;
/** How long a DM waits for the other releases a relay sends at once. */
const SETTLE_MS = 5_000;
/** The least time between two DMs about updates, in seconds. */
const TELL_EVERY_S = 60 * 60;
/** The least time between a DM and one saying a minimum newly switched features off. */
const URGENT_TELL_EVERY_S = 10 * 60;
const FILE = 'update.json';
/**
 * What a copy below the notice's min_safe switches off until it is updated
 * (docs/releasing.md, "Update notices"). Kept explicit: the tests and the
 * words in doctor and the tool replies come from this list.
 */
export const GATED_FEATURES = {
    /** Strangers' chat: listen, look and wait_for leave out chat lines by anyone but the operator and the agent, and no stranger's line wakes a turn. Other text strangers wrote (bag labels, profiles) is not gated here; operator-only mode covers it once it lands. */
    strangerWords: 'strangers\' chat lines are not shown and wake nothing (operator only)',
    /** Wallet payments: the wallet pays nothing; a HOSAKA invoice goes to the operator by DM instead. */
    payments: 'the wallet pays nothing (HOSAKA invoices go to your operator)',
};
/** The update commands, as README "Updating" gives them. Never taken from a notice. */
export function updateCommands(version) {
    return [
        'In your clone: git pull && npm ci --omit=dev --ignore-scripts, then restart serve.',
        `Installed with npm i -g: npm i -g github:arkin0x/cyberspace-mcp#v${version}, then restart serve.`,
        'From a release bundle: download and check the new bundle (docs/releasing.md, "Using a release").',
    ];
}
// ---- versions ---------------------------------------------------------------
/** X.Y.Z, each part a whole number of at most six digits, no leading zeros, nothing after. */
const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
/** The version as three numbers, or null when it is not strict X.Y.Z. */
export function parseSemver(s) {
    if (typeof s !== 'string')
        return null;
    const m = SEMVER.exec(s);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
/** Negative when a is older than b, zero when equal, positive when newer. */
export function compareSemver(a, b) {
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
/** A running version: X.Y.Z, or X.Y.Z-<pre-release>, which is below X.Y.Z (semver precedence). Null when it is neither. */
export function parseRunning(s) {
    if (typeof s !== 'string')
        return null;
    const m = /^([^-+]+)(-[0-9A-Za-z.-]+)?$/.exec(s);
    const v = m ? parseSemver(m[1]) : null;
    return v ? { v, pre: !!m[2] } : null;
}
/** This copy's version, from its package.json (one folder above src/ and dist/); 0.0.0 when it cannot be read, which every minimum is above. */
export function runningVersion() {
    try {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        return pkg.name === 'cyberspace-mcp' && parseRunning(pkg.version) ? String(pkg.version) : '0.0.0';
    }
    catch {
        return '0.0.0';
    }
}
export const VERSION = runningVersion();
// ---- the release event (NIP-82) --------------------------------------------
//
// NIP-82 "Software Applications" (nostr-protocol/nips#2526, draft, used by
// Zapstore, ngit and Amethyst): kind 32267 lists the app, kind 30063 is one
// release, kind 3063 is one file of it. This server reads only the 30063: one
// event per version, addressable by d = "cyberspace-mcp@<version>", so every
// release stays on the relays and the newest version is found by comparing
// versions. Two tags are ours and other readers skip them: ["security",
// "true"] and ["min_allowed_version", "<version>"] (a copy of the 3063's
// standard tag, so one event says it). Everything about the event's shape is
// in this section, so a change to NIP-82 before it merges lands here.
/** NIP-82 kinds. */
export const APP_KIND = 32267;
export const RELEASE_KIND = 30063;
export const ASSET_KIND = 3063;
/** The app id: the 32267's d, every 30063's and 3063's i. */
export const APP_ID = 'cyberspace-mcp';
/** The release channel this server follows (NIP-82 Appendix B). */
export const CHANNEL = 'main';
/** How many releases one question asks for: enough to hold every recent one; the highest version wins, not the first answered. */
export const RELEASES_WINDOW = 100;
/** The longest release notes read; longer, and the event is ignored. */
const MAX_CONTENT = 65_536;
/** The app listing's address, which every release names in its a tag. */
export function appAddress(releasePubkey = RELEASE_PUBKEY) {
    return `${APP_KIND}:${releasePubkey}:${APP_ID}`;
}
/** The filter that asks for the release key's releases of this app. */
export function noticeFilter(releasePubkey = RELEASE_PUBKEY) {
    return { kinds: [RELEASE_KIND], authors: [releasePubkey], '#i': [APP_ID], limit: RELEASES_WINDOW };
}
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX128 = /^[0-9a-f]{128}$/;
/** Control characters (newlines included), and the bidirectional overrides that make text read other than it is. */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
/** What a shown note may hold: letters, digits, plain spaces and ordinary punctuation. No backtick, pipe, dollar, angle bracket, line separator, zero-width or format character. */
const NOTE_CHARS = /^[\p{L}\p{M}\p{N} .,;:!?'"()&%/+#*=@\[\]-]*$/u;
/** A link or a command target by another name: a URI scheme (nostr:npub..., magnet:...) or a domain (evil.example/fix.sh). */
const LINKISH = /[a-z][a-z0-9+.-]*:[^\s]|[a-z0-9-]+\.[a-z][a-z0-9-]*[a-z](\/|\b)/i;
/** Single-valued tags whose meaning parseNotice knows; each may appear once at most. */
const ONCE = new Set(['d', 'i', 'version', 'c', 'min_allowed_version', 'security', 'commit']);
/**
 * What the operator is shown of the release notes: the first line, cut to
 * MAX_NOTE characters, and nothing when it holds a link or a character that
 * could disguise text. The update commands never come from here; a stolen key
 * must not be able to put a "run this" link in front of every operator.
 */
export function noteOf(content) {
    const first = (content.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').replace(/^[\s#]+/, '').trim();
    if (!first || first.includes('://') || UNSAFE_TEXT.test(first) || !NOTE_CHARS.test(first) || LINKISH.test(first))
        return '';
    const chars = Array.from(first);
    return chars.length > MAX_NOTE ? `${chars.slice(0, MAX_NOTE - 3).join('').trimEnd()}...` : first;
}
/**
 * The release an event carries, or null when it is not one this copy trusts
 * and reads exactly: the trusted author, a valid signature over a freshly
 * built event (so nothing cached on the object counts), kind 30063, i the app
 * id, a strict X.Y.Z version (each part at most six digits), d equal to
 * "<app id>@<version>", channel main, the a tag naming the release key's own
 * app listing, at least one f and one well formed e, and our two tags well
 * formed when present (min_allowed_version no higher than the version). A
 * single-valued tag given twice, or with extra values, ignores the event
 * whole. Tags it does not know are skipped.
 */
export function parseNotice(raw, trustedPubkey, nowS) {
    if (!raw || typeof raw !== 'object')
        return null;
    const e = raw;
    if (typeof e.id !== 'string' || !HEX64.test(e.id))
        return null;
    if (typeof e.pubkey !== 'string' || e.pubkey !== trustedPubkey)
        return null;
    if (typeof e.sig !== 'string' || !HEX128.test(e.sig))
        return null;
    if (e.kind !== RELEASE_KIND)
        return null;
    if (typeof e.created_at !== 'number' || !Number.isSafeInteger(e.created_at) || e.created_at <= 0)
        return null;
    if (e.created_at > nowS + MAX_FUTURE_S)
        return null;
    if (typeof e.content !== 'string' || e.content.length > MAX_CONTENT)
        return null;
    if (!Array.isArray(e.tags) || e.tags.length > 256)
        return null;
    const tags = [];
    for (const t of e.tags) {
        if (!Array.isArray(t) || t.length === 0 || t.length > 8 || !t.every((x) => typeof x === 'string' && x.length <= 1024))
            return null;
        tags.push(t);
    }
    const fresh = { id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags, content: e.content, sig: e.sig };
    let valid = false;
    try {
        valid = verifyEvent(fresh);
    }
    catch {
        valid = false;
    }
    if (!valid)
        return null;
    const one = {};
    const apps = [];
    const assets = [];
    let platforms = 0;
    for (const t of tags) {
        if (ONCE.has(t[0])) {
            if (t[0] in one || t.length !== 2)
                return null;
            one[t[0]] = t[1];
        }
        else if (t[0] === 'a') {
            if ((t[1] ?? '').startsWith(`${APP_KIND}:`))
                apps.push(t[1]);
        }
        else if (t[0] === 'e') {
            if (!HEX64.test(t[1] ?? ''))
                return null;
            assets.push(t[1]);
        }
        else if (t[0] === 'f') {
            if (!/^[a-z0-9_-]{1,64}$/.test(t[1] ?? ''))
                return null;
            platforms++;
        }
    }
    if (one.i !== APP_ID)
        return null;
    const version = parseSemver(one.version);
    if (!version)
        return null;
    if (one.d !== `${APP_ID}@${one.version}`)
        return null;
    if (one.c !== CHANNEL)
        return null;
    if (apps.length !== 1 || apps[0] !== appAddress(trustedPubkey))
        return null;
    if (assets.length === 0 || platforms === 0)
        return null;
    let minSafe = null;
    if ('min_allowed_version' in one) {
        const m = parseSemver(one.min_allowed_version);
        if (!m || compareSemver(m, version) > 0)
            return null;
        minSafe = one.min_allowed_version;
    }
    if ('security' in one && one.security !== 'true' && one.security !== 'false')
        return null;
    if ('commit' in one && !HEX40.test(one.commit))
        return null;
    return {
        id: e.id, created_at: e.created_at, version: one.version, minSafe, security: one.security === 'true',
        note: noteOf(e.content), commit: one.commit ?? null, assets: [...new Set(assets)],
    };
}
/**
 * Whether release a stands above b as the latest: the higher version; for
 * the same version (a release overwritten, as NIP-82 allows), the later
 * created_at, then the lower id. Never by created_at across versions, so a
 * backport published after a newer release does not win.
 */
export function replaces(a, b) {
    if (!b)
        return true;
    const v = compareSemver(parseSemver(a.version), parseSemver(b.version));
    if (v !== 0)
        return v > 0;
    if (a.created_at !== b.created_at)
        return a.created_at > b.created_at;
    return a.id < b.id;
}
/** The higher of two minimum safe versions; null counts as none. */
export function higherMin(a, b) {
    if (!a)
        return b;
    if (!b)
        return a;
    return compareSemver(parseSemver(a), parseSemver(b)) >= 0 ? a : b;
}
export const NOTHING_SEEN = { latest: null, minSafe: null, security: null };
/** Fold one trusted release into what was seen. Never lowers the minimum or the security mark. */
export function absorb(seen, n) {
    return {
        latest: replaces(n, seen.latest) ? n : seen.latest,
        minSafe: higherMin(seen.minSafe, n.minSafe),
        security: n.security ? higherMin(seen.security, n.version) : seen.security,
    };
}
/** Every trusted release among these events, folded into what was seen. */
export function absorbAll(seen, events, trustedPubkey, nowS) {
    let out = seen;
    for (const ev of events) {
        const n = parseNotice(ev, trustedPubkey, nowS);
        if (n)
            out = absorb(out, n);
    }
    return out;
}
/** What the releases seen mean for a copy at `running` (0.0.0 when it cannot be read, below every minimum). */
export function judge(seen, running) {
    const r = parseRunning(running) ?? { v: [0, 0, 0], pre: false };
    // A pre-release of X.Y.Z is below X.Y.Z.
    const behind = (v) => {
        if (v === null)
            return false;
        const c = compareSemver(r.v, parseSemver(v));
        return c < 0 || (c === 0 && r.pre);
    };
    const base = { running, latest: seen.latest, minSafe: seen.minSafe, security: behind(seen.security) };
    if (behind(seen.minSafe))
        return { state: 'unsafe', ...base };
    if (!seen.latest)
        return { state: 'unknown', ...base };
    return { state: behind(seen.latest.version) ? 'available' : 'current', ...base };
}
/** The operator's DM: what is out, why it matters, the commands. Plain words; the note is the release key's. */
export function dmWords(s) {
    const n = s.latest;
    const lines = [
        `cyberspace-mcp ${n.version} is out${s.security ? ' (security release)' : ''}. This agent runs ${s.running}.`,
        ...(n.note ? [n.note] : []),
        ...(s.state === 'unsafe' ? [`${s.running} is below the minimum safe version ${s.minSafe}, so until you update: ${Object.values(GATED_FEATURES).join('; ')}. Moving and looking still work.`] : []),
        'To update:',
        ...updateCommands(n.version),
        'Nothing installs by itself. This notice is signed by the cyberspace-mcp release key.',
    ];
    return lines.join('\n');
}
/** The short line at the end of a tool reply, for the model. Never the note: the line is the same words whoever signed the release. */
export function toolLine(s) {
    if (s.state === 'unsafe') {
        return `UPDATE REQUIRED: this server (${s.running}) is below the minimum safe version ${s.minSafe}; ${Object.values(GATED_FEATURES).join('; ')} until your human updates. Moving and looking still work. Do not try to update it yourself; your human was told.`;
    }
    if (s.state !== 'available')
        return null;
    return `Update available: cyberspace-mcp ${s.latest.version}${s.security ? ' (security release)' : ''}; this server runs ${s.running}. Your human updates it; do not try yourself.`;
}
/**
 * The live side: keeps what the trusted releases add up to in the state
 * directory, takes what the subscription hands it, tells the operator once
 * per version, and answers the gate and the tool line.
 */
export class UpdateWatch {
    deps;
    releasePubkey;
    running;
    state;
    telling = null;
    lastLineAt = null;
    lastLineState = null;
    closer = null;
    timer = null;
    settle = null;
    /** Our clock (seconds) at the last DM, for the hourly cap. */
    lastToldAt = null;
    /** The minimum the last DM said this copy is below, if any. */
    lastToldMin = null;
    constructor(deps) {
        this.deps = deps;
        this.releasePubkey = deps.releasePubkey ?? RELEASE_PUBKEY;
        this.running = deps.running ?? VERSION;
        const saved = deps.dir.readJson(FILE, null);
        // What another release key signed (an older build's, or a stolen one's) does not count here.
        const ours = saved?.version === 3 && saved.releasePubkey === this.releasePubkey;
        this.state = { version: 3, releasePubkey: this.releasePubkey, seen: ours ? keptSeen(saved.seen) : { ...NOTHING_SEEN }, told: ours ? keptTold(saved.told) : {} };
    }
    /** Listen for releases (subscribe opens the live subscription and returns its closer), and tell the operator about one already kept. */
    start(subscribe) {
        this.closer = subscribe(noticeFilter(this.releasePubkey), (ev) => { this.consider(ev); });
        const every = this.deps.retellMs ?? RETELL_MS;
        if (every > 0) {
            this.timer = setInterval(() => { void this.tellOnce(); }, every);
            this.timer.unref?.();
        }
        void this.tellOnce();
    }
    stop() {
        this.closer?.();
        this.closer = null;
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
        if (this.settle)
            clearTimeout(this.settle);
        this.settle = null;
    }
    /** Take an event if it is a trusted release that changes what was seen. Returns whether it changed anything. */
    consider(ev) {
        const n = parseNotice(ev, this.releasePubkey, this.deps.now());
        if (!n)
            return false;
        const before = this.state.seen;
        const after = absorb(before, n);
        if (after.latest?.id === before.latest?.id && after.minSafe === before.minSafe && after.security === before.security)
            return false;
        const was = this.status().state;
        this.state.seen = after;
        this.save();
        const s = this.status();
        this.deps.log(`update notice: ${n.version}${n.security ? ' (security)' : ''}${n.minSafe ? `, min_allowed_version ${n.minSafe}` : ''}; running ${this.running}: ${s.state}`);
        if (s.state !== was)
            this.lastLineAt = null;
        const wait = this.deps.settleMs ?? SETTLE_MS;
        if (wait <= 0)
            void this.tellOnce();
        else if (!this.settle) {
            this.settle = setTimeout(() => { this.settle = null; void this.tellOnce(); }, wait);
            this.settle.unref?.();
        }
        return true;
    }
    status() {
        return judge(this.state.seen, this.running);
    }
    /** Whether a gated feature is off now, and why (one sentence), or null when it is on. */
    off(feature) {
        const s = this.status();
        if (s.state !== 'unsafe')
            return null;
        return `this server (${s.running}) is below the minimum safe version ${s.minSafe} named by a release the release key signed, so until it is updated ${GATED_FEATURES[feature]}`;
    }
    /** The tool reply's update line when one is due, or null: once per pace, and at once when the state changes. */
    line() {
        const s = this.status();
        const words = toolLine(s);
        if (!words)
            return null;
        const now = (this.deps.nowMs ?? Date.now)();
        const every = s.state === 'unsafe' ? UNSAFE_LINE_EVERY_MS : AVAILABLE_LINE_EVERY_MS;
        if (this.lastLineState === s.state && this.lastLineAt !== null && now - this.lastLineAt < every)
            return null;
        this.lastLineAt = now;
        this.lastLineState = s.state;
        return words;
    }
    /** Tell the operator once per announced version (and again if the minimum rises), when this copy is behind. Never throws. */
    tellOnce() {
        if (this.telling)
            return this.telling;
        this.telling = this.doTell().finally(() => { this.telling = null; });
        return this.telling;
    }
    async doTell() {
        // Again after each DM: a release that came in while one was being sent is told about too (within the cap).
        for (let i = 0; i < 3; i++) {
            const s = this.status();
            if (!s.latest || (s.state !== 'available' && s.state !== 'unsafe'))
                return;
            const key = `${s.latest.version}|${s.minSafe ?? ''}`;
            if (this.state.told[key])
                return;
            let ok = false;
            try {
                ok = this.deps.hasOperator();
            }
            catch {
                ok = false;
            }
            if (!ok)
                return;
            // At most one DM an hour, so a burst of releases (or a stolen key) cannot flood the operator; the retry timer tells the newest later.
            // A minimum newly above this copy is told sooner (ten minutes), since features just switched off.
            const now = this.deps.now();
            const urgent = s.state === 'unsafe' && this.lastToldMin !== s.minSafe;
            if (this.lastToldAt !== null && now - this.lastToldAt < (urgent ? URGENT_TELL_EVERY_S : TELL_EVERY_S))
                return;
            try {
                await this.deps.tell(dmWords(s));
                this.lastToldAt = now;
                this.lastToldMin = s.state === 'unsafe' ? s.minSafe : this.lastToldMin;
                this.state.told[key] = now;
                this.save();
                this.deps.log(`update notice: told the operator about ${s.latest.version}`);
            }
            catch (err) {
                this.deps.log(`update notice: could not tell the operator yet: ${err instanceof Error ? err.message : String(err)}`);
                return;
            }
        }
    }
    save() {
        try {
            this.deps.dir.writeJson(FILE, this.state);
        }
        catch (err) {
            this.deps.log(`update notice: not saved: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
/** A release as update.json keeps it, read back strictly; null when anything is off. */
export function keptNotice(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const n = raw;
    if (typeof n.id !== 'string' || !HEX64.test(n.id))
        return null;
    if (typeof n.created_at !== 'number' || !Number.isSafeInteger(n.created_at))
        return null;
    const v = parseSemver(n.version);
    if (!v)
        return null;
    if (n.minSafe !== null && (!parseSemver(n.minSafe) || compareSemver(parseSemver(n.minSafe), v) > 0))
        return null;
    if (typeof n.security !== 'boolean' || typeof n.note !== 'string' || n.note !== noteOf(n.note))
        return null;
    if (!(n.commit === null || (typeof n.commit === 'string' && HEX40.test(n.commit))))
        return null;
    if (!Array.isArray(n.assets) || n.assets.length === 0 || !n.assets.every((x) => typeof x === 'string' && HEX64.test(x)))
        return null;
    return { id: n.id, created_at: n.created_at, version: n.version, minSafe: n.minSafe, security: n.security, note: n.note, commit: n.commit, assets: n.assets };
}
/**
 * What update.json kept, read back strictly. A minimum or a security mark
 * that is not strict X.Y.Z is dropped; a kept file someone edits can only be
 * as wrong as its owner makes it, and its owner owns the machine anyway.
 */
export function keptSeen(raw) {
    if (!raw || typeof raw !== 'object')
        return { ...NOTHING_SEEN };
    const s = raw;
    const semverOrNull = (x) => (typeof x === 'string' && parseSemver(x) ? x : null);
    return { latest: keptNotice(s.latest), minSafe: semverOrNull(s.minSafe), security: semverOrNull(s.security) };
}
/** What update.json says the operator was told: version keys to times; anything else is dropped. */
function keptTold(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return {};
    const out = {};
    for (const [k, v] of Object.entries(raw))
        if (typeof v === 'number' && Number.isFinite(v))
            out[k] = v;
    return out;
}
/** The doctor's view: what serve kept (when the same release key signed it), with what the relays answered now folded in. Reads only. */
export function seenWith(keptFile, live, trustedPubkey, nowS) {
    const f = keptFile && typeof keptFile === 'object' ? keptFile : null;
    const kept = f?.version === 3 && f.releasePubkey === trustedPubkey ? keptSeen(f.seen) : { ...NOTHING_SEEN };
    return live ? absorbAll(kept, live, trustedPubkey, nowS) : kept;
}
//# sourceMappingURL=updates.js.map