// comments.ts: NIP-22 comments (kind 1111) on a hidden item, as ONOSENDAI
// writes them (arkinox, 2026-10-12: a quest said "leave a comment on what you
// find", and the agent had no way to).
//
// Ported from ONOSENDAI src/lib/comments.ts at origin/v2 b615675: the
// template, the sealing and the parse, unchanged but for the client name
// and the imports; the threading and LIVE LINK parts are left out (this
// server writes comments on items it opened, never on a public object placed
// by reference).
//
// A comment's ROOT scope is the bag, by address (A = 33330:<bag author>:<lookup
// id>, K 33330, P the bag's author), and its PARENT is the item: its event id,
// its kind (1 a message, 3330 a shard, 3340 an item, 3341 a chest) and the bag's
// author, who signed it. A thing revealed from a chest is answered as an item
// of the chest's bag, as ONOSENDAI's revealedIn makes it. The words are sealed
// to the place: the content is a public placeholder, and the text rides in an
// FF-1 encrypted tag under the bag's region key, so only whoever reaches the
// place (or opened the bag) reads it.
//
// Pure: signing and publishing happen in the agent.
import { CLIENT_NAME } from '../nostr/event.js';
import { AUDIO_KIND, CHEST_KIND, HIDDEN_KIND, KEY_KIND, MESSAGE_KIND, SHARD_KIND } from './bags.js';
import { decryptForRegion, encryptForRegion } from './crypto.js';
export const COMMENT_KIND = 1111;
export const MAX_COMMENT_LENGTH = 2000;
/** What every other client shows: an invitation, not the words. */
export const PLACEHOLDER = 'This comment is hidden at an undisclosed location in cyberspace. Happy hunting: https://onosendai.tech';
/** FF-1 encrypted tag: the scheme and, in place of a key service, the derivation. */
export const ENCRYPTED_SCHEME = 'aes-256-gcm';
export const KEY_DERIVATION = 'cyberspace:region';
export function bagAddress(subject) {
    return `${HIDDEN_KIND}:${subject.author}:${subject.lookupId}`;
}
/** The kind an item of this type is (ONOSENDAI itemKind). */
export function itemKind(type) {
    return type === 'shard' ? SHARD_KIND : type === 'key' ? KEY_KIND : type === 'chest' ? CHEST_KIND : type === 'audio' ? AUDIO_KIND : MESSAGE_KIND;
}
/**
 * The kind 1111 template, tag for tag as ONOSENDAI's commentTemplate: the
 * root scope, the parent, the client tag (this server's name where ONOSENDAI
 * writes its own), then the sealed words.
 */
export function commentTemplate(subject, parent, ciphertext, createdAt) {
    if (!ciphertext)
        throw new Error('a comment needs some text');
    return {
        kind: COMMENT_KIND,
        created_at: createdAt,
        content: PLACEHOLDER,
        tags: [
            ['A', bagAddress(subject)],
            ['K', String(HIDDEN_KIND)],
            ['P', subject.author],
            ...(parent.id ? [['e', parent.id, '', parent.pubkey]] : []),
            ...(parent.address ? [['a', parent.address, '']] : []),
            ['k', String(parent.kind)],
            ['p', parent.pubkey],
            ['client', CLIENT_NAME],
            ['encrypted', ENCRYPTED_SCHEME, ciphertext, KEY_DERIVATION],
        ],
    };
}
/** The words sealed under the bag's region key, as a ready template. */
export async function sealedComment(subject, parent, text, createdAt, key) {
    const body = text.trim().slice(0, MAX_COMMENT_LENGTH);
    if (!body)
        throw new Error('a comment needs some text');
    return commentTemplate(subject, parent, await encryptForRegion(key, body), createdAt);
}
/** A comment's root, parent and words, opened with the region key; null when it is not one this server can place or open. */
export async function readComment(ev, key) {
    if (ev.kind !== COMMENT_KIND)
        return null;
    const tag = (name) => ev.tags.find((t) => t[0] === name);
    const root = tag('A')?.[1];
    const parentId = tag('e')?.[1] ?? tag('a')?.[1];
    const parentKind = Number(tag('k')?.[1]);
    const enc = tag('encrypted');
    if (!root || !parentId || !Number.isFinite(parentKind) || !enc || enc[1] !== ENCRYPTED_SCHEME || !enc[2])
        return null;
    const text = (await decryptForRegion(key, enc[2]))?.trim();
    return text ? { root, parentId, parentKind, text } : null;
}
//# sourceMappingURL=comments.js.map