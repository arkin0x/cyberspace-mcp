// avatar.ts: the shape others see the agent as, a kind 11333 (spec 8.10).
//
// Ported from ONOSENDAI src/lib/avatar.ts, src/lib/avatarMine.ts and
// src/store/useAvatars.ts at origin/v2 17fa254 (arkinox, 2026-10-11: "tell
// XOR to set a shard as his avatar"). The event is the one ONOSENDAI's
// workshop publishes: kind 11333, replaceable, no `d`; the tags in ONOSENDAI's
// order, `name` then `client` then `nonce`; the content a shard payload as
// sno-core's toPayload writes it. The client tag is in the template before
// mining, because the work is NIP-13 over the event's own id: a tag added at
// signing would change the id and void the work. It names this server
// (cyberspace-mcp), where ONOSENDAI's names ONOSENDAI; no reader looks at it.
//
// The work owed and the reader's verdict are cyberspace-core's avatarWork
// and verifyAvatarWork, the same pinned commit ONOSENDAI draws with, so an
// event this file mines is one ONOSENDAI draws, and one it would not draw is
// never published.
//
// Since 2026-11 (spec 8.10, cyberspace-core 0.3.0) the work is
// ceil(10 + 2 log2(reach) + 1.5 log2(detail / 32)) and the content is at most
// 131,072 bytes, a trailing nonce field included. The miner (avatarMine.ts)
// writes the nonce as the last field of the content and hashes one SHA-256
// block per try from a midstate, so a try costs the same at any size.
import { AVATAR_CONTENT_MAX, AVATAR_KIND, AVATAR_NONCE_ROOM, avatarContentBytes, avatarWork, verifyAvatarWork } from 'cyberspace-core';
import { fromPayload, toPayload } from 'sno-core/shards';
import { CLIENT_NAME } from './nostr/event.js';
export { AVATAR_KIND, avatarWork, verifyAvatarWork };
/**
 * The most bytes an avatar's content may hold, UTF-8, the mined nonce field
 * included (spec 8.10, cyberspace-core's AVATAR_CONTENT_MAX): a reader draws
 * the dodecahedron for a larger one, whatever work it carries.
 */
export const MAX_AVATAR_BYTES = AVATAR_CONTENT_MAX;
/** The most bytes a payload may have before mining: the limit less the room the nonce field may take (AVATAR_NONCE_ROOM). */
export const MAX_AVATAR_PAYLOAD_BYTES = AVATAR_CONTENT_MAX - AVATAR_NONCE_ROOM;
/** Whether a payload of this many bytes still fits the limit once the nonce is mined into it. */
export function avatarFits(payloadBytes) {
    return payloadBytes + AVATAR_NONCE_ROOM <= MAX_AVATAR_BYTES;
}
/** The refusal's words for a payload over the limit. */
export function avatarTooLargeWords(payloadBytes) {
    return `the payload is ${payloadBytes} bytes, and an avatar's content is at most ${MAX_AVATAR_BYTES} bytes with the mined nonce field (up to ${AVATAR_NONCE_ROOM} bytes) included, so at most ${MAX_AVATAR_PAYLOAD_BYTES} before mining; a reader draws the dodecahedron for anything larger (spec 8.10)`;
}
/** The event to mine and sign: this shard as the avatar, or none for the dodecahedron. ONOSENDAI's avatarTemplate. */
export function avatarTemplate(shard, createdAt) {
    return {
        kind: AVATAR_KIND,
        created_at: createdAt,
        tags: shard ? [['name', shard.name], ['client', CLIENT_NAME]] : [['client', CLIENT_NAME]],
        content: shard ? JSON.stringify(toPayload(shard)) : '',
    };
}
/**
 * The shard an avatar event carries, or null when it carries none or is not
 * one. ONOSENDAI's avatarFromEvent. A `nonce` field in the content (the
 * miner's, spec 8.10) is not part of the shape and is dropped before
 * sno-core reads it, so it never rides along in the shard's `extra`.
 */
export function avatarFromEvent(ev) {
    if (ev.kind !== AVATAR_KIND)
        return null;
    if (!ev.content)
        return null;
    try {
        const payload = JSON.parse(ev.content);
        // sno-core would carry an unknown field through in `extra`; the nonce is the work's, not the shape's.
        if (payload && typeof payload === 'object' && !Array.isArray(payload))
            delete payload.nonce;
        return fromPayload(payload, `avatar:${ev.pubkey}`);
    }
    catch {
        return null;
    }
}
/** The shard ONOSENDAI draws for an event: none for empty content, none for a shape that has not paid or is over the limit. ONOSENDAI's paidShard. */
export function paidShard(ev) {
    if (!ev.content)
        return null;
    if (!verifyAvatarWork(ev).ok)
        return null;
    return avatarFromEvent(ev);
}
/**
 * Midstate tries per sha256PerSec, for a calibration saved before the
 * miner's own rate was measured. The calibration's SHA-256 rate is a Merkle
 * tree's, hashes of 64 bytes and more each; a midstate try is one
 * compression with no allocation. Measured 3.6 to 4.7 on a desktop core
 * (2026-11-16); 3 keeps the estimate on the slow side.
 */
export const AVATAR_TRIES_PER_SHA256 = 3;
/**
 * What each thread past the first adds to the rate. The threads are
 * worker_threads, each with its own miner on its own range of nonces and
 * nothing shared but a stop flag, so on idle cores they scale almost
 * linearly; on a busy machine they share cores with everything else
 * (measured 0.45 to 0.5 per extra thread on 16 cores at a load of 16,
 * 2026-11-16). 0.7, the factor this estimate used before (ONOSENDAI's
 * triesPerSec), sits between.
 */
export const AVATAR_THREAD_GAIN = 0.7;
/** Tries per second on one thread: the calibration's measured miner rate, else derived from its SHA-256 rate. */
export function avatarTriesPerSec(calibration) {
    const measured = calibration.avatarTriesPerSec;
    if (typeof measured === 'number' && Number.isFinite(measured) && measured > 0)
        return measured;
    return calibration.sha256PerSec * AVATAR_TRIES_PER_SHA256;
}
/**
 * Seconds of wall time the expected 2^bits tries take on this machine. A
 * try is one SHA-256 block from a midstate whatever the avatar's size
 * (avatarMine.ts), so the rate is a fixed tries per second per thread, and
 * each thread past the first adds AVATAR_THREAD_GAIN of one.
 */
export function avatarSeconds(bits, triesPerSec, threads) {
    const rate = triesPerSec * (1 + AVATAR_THREAD_GAIN * Math.max(0, threads - 1));
    return 2 ** bits / rate;
}
/** What an avatar's content owes, for the price: the bits (cyberspace-core's avatarWork over its payload) and its UTF-8 bytes before mining. */
export function avatarPrice(content) {
    return { bits: avatarWork(JSON.parse(content)), contentBytes: avatarContentBytes(content) };
}
//# sourceMappingURL=avatar.js.map