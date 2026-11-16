// avatar.ts: the shape others see the agent as, a kind 11333 (spec 8.10).
//
// Ported from ONOSENDAI src/lib/avatar.ts and src/store/useAvatars.ts at
// origin/v2 17fa254 (arkinox, 2026-10-11: "tell XOR to set a shard as his
// avatar"). The event is the one ONOSENDAI's workshop publishes: kind 11333,
// replaceable, no `d`; the tags in ONOSENDAI's order, `name` then `client`;
// the content a shard payload as sno-core's toPayload writes it. The client
// tag names this server (cyberspace-mcp), where ONOSENDAI's names ONOSENDAI;
// no reader looks at it.
//
// The reader's verdict is cyberspace-core's verifyAvatar, the check
// ONOSENDAI draws with, so an event this file signs is one ONOSENDAI draws,
// and one it would not draw is never published.
//
// An avatar owes no proof of work (spec 8.10, ruled 2026-11): its content is
// bounded by size alone, at most AVATAR_CONTENT_MAX (131,072) bytes of
// UTF-8, and a reader draws the dodecahedron for anything larger. An avatar
// published while the rule asked for work carries a nonce tag and maybe a
// trailing `nonce` field in its content; it reads as any other.
import { AVATAR_CONTENT_MAX, AVATAR_CONTENT_WARN, AVATAR_KIND, avatarContentBytes, verifyAvatar } from 'cyberspace-core';
import { fromPayload, toPayload } from 'sno-core/shards';
import { CLIENT_NAME } from './nostr/event.js';
export { AVATAR_CONTENT_MAX, AVATAR_CONTENT_WARN, AVATAR_KIND, avatarContentBytes, verifyAvatar };
/** The event to sign: this shard as the avatar, or none for the dodecahedron. ONOSENDAI's avatarTemplate. */
export function avatarTemplate(shard, createdAt) {
    return {
        kind: AVATAR_KIND,
        created_at: createdAt,
        tags: shard ? [['name', shard.name], ['client', CLIENT_NAME]] : [['client', CLIENT_NAME]],
        content: shard ? JSON.stringify(toPayload(shard)) : '',
    };
}
/** Whether content of this many UTF-8 bytes is over the limit (a reader draws the dodecahedron for it). */
export function avatarTooLarge(bytes) {
    return bytes > AVATAR_CONTENT_MAX;
}
/** The refusal's words for content over the limit. */
export function avatarTooLargeWords(bytes) {
    return `the payload is ${bytes} bytes, and an avatar is at most ${AVATAR_CONTENT_MAX} bytes (spec 8.10; a reader draws the dodecahedron for anything larger)`;
}
/**
 * The shard an avatar event carries, or null when it carries none or is not
 * one. ONOSENDAI's avatarFromEvent. A `nonce` field in the content (left by
 * a miner while avatars owed work) is not part of the shape and is dropped
 * before sno-core reads it, so it never rides along in the shard's `extra`.
 */
export function avatarFromEvent(ev) {
    if (ev.kind !== AVATAR_KIND)
        return null;
    if (!ev.content)
        return null;
    try {
        const payload = JSON.parse(ev.content);
        if (payload && typeof payload === 'object' && !Array.isArray(payload))
            delete payload.nonce;
        return fromPayload(payload, `avatar:${ev.pubkey}`);
    }
    catch {
        return null;
    }
}
/** The shard ONOSENDAI draws for an event: none for empty content, none for one cyberspace-core's verifyAvatar refuses (too large, not an avatar). ONOSENDAI's paidShard. */
export function paidShard(ev) {
    if (!ev.content)
        return null;
    if (!verifyAvatar(ev).ok)
        return null;
    return avatarFromEvent(ev);
}
//# sourceMappingURL=avatar.js.map