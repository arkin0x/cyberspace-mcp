// chests.ts: sealing a chest and opening one (Keys and Chests B1 2.2), and
// forging a key item (B1 2.1).
//
// Ported from ONOSENDAI src/lib/chests.ts at commit 123cb55 (branch
// feat/keys-and-chests). The signer-based opener is replaced by the
// agent's own secret, which it holds locally.
//
// A chest is a bag item whose content is a list of entries, in exactly the
// shape of a bag's plaintext (spec 7.6), sealed with NIP-44 v2 to a public
// key instead of to a place: an item's public key (a key item found
// somewhere else) or a person's pubkey, which is how a chest becomes a gift.
// The seal is the gift-wrap pattern: a fresh keypair used once as the NIP-44
// sender, its public half written into the chest's lock tag, its secret
// discarded. Past 65,535 bytes of plaintext nostr-tools writes and reads
// NIP-44's extended length prefix (two zero bytes, then the length in four
// bytes), so a chest up to CHEST_MAX_PLAINTEXT seals and opens with the same
// two calls.
import { v2 as nip44 } from 'nostr-tools/nip44';
import { generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes, isAuthentic } from '../nostr/event.js';
import { isReference, readItem, sealedAsRumor } from './bags.js';
/** A new key item: a fresh keypair under a name (B1 3.1). */
export function forgeKey(name, about = '') {
    const sk = generateSecretKey();
    return { name, about, itemPubkey: getPublicKey(sk), secretHex: bytesToHex(sk) };
}
/**
 * The most a chest's list of entries may be, in UTF-8 bytes (DECK-0004 3.2
 * step 2 and Size, cyberspace #117; ONOSENDAI lib/chests.ts). Not NIP-44's
 * limit: the event that carries the chest is. 131,072 bytes pad to 131,072
 * and seal to 174,860 characters of content, and a chest of that, alone in
 * one event, stays under the 240,000 bytes ONOSENDAI holds a bag to. One byte
 * more pads to 163,840, which no bag or sealed entry can carry.
 */
export const CHEST_MAX_PLAINTEXT = 131_072;
/** Why a list of this many bytes cannot be sealed, in words, or null when it fits. */
function sizeRefusal(bytes) {
    if (bytes <= CHEST_MAX_PLAINTEXT)
        return null;
    return `Too large to seal: ${bytes} of ${CHEST_MAX_PLAINTEXT} bytes. Take something out.`;
}
/** Seal a list of entries to a public key with a one-time sender key. Throws with sizeRefusal's words when too large. */
export function sealEntries(entries, lockPubkey) {
    const plaintext = JSON.stringify(entries);
    const refusal = sizeRefusal(new TextEncoder().encode(plaintext).length);
    if (refusal)
        throw new Error(refusal);
    const senderSecret = generateSecretKey();
    const senderPubkey = getPublicKey(senderSecret);
    const payload = nip44.encrypt(plaintext, nip44.utils.getConversationKey(senderSecret, lockPubkey));
    senderSecret.fill(0);
    return { payload, senderPubkey };
}
/** The entries a decrypted chest holds. Anything that is not a list is a chest this server cannot read. */
function parseChestPlaintext(plaintext) {
    let parsed;
    try {
        parsed = JSON.parse(plaintext);
    }
    catch {
        throw new Error('This chest holds something this server cannot read.');
    }
    if (!Array.isArray(parsed))
        throw new Error('This chest holds something this server cannot read.');
    return parsed.filter((e) => isReference(e) || (!!e && typeof e === 'object' && !Array.isArray(e) && typeof e.kind === 'number'));
}
/** Open a chest with a secret: a held key item's, or the agent's own when the chest is sealed to its pubkey. Throws on the wrong key. */
export function openWithSecret(chest, secretHex) {
    const key = nip44.utils.getConversationKey(hexToBytes(secretHex), chest.senderPubkey);
    return parseChestPlaintext(nip44.decrypt(chest.payload, key));
}
/** Whether an entry has the fields an event is read by, each of its type; a chest's plaintext may hold anything. */
function wellFormed(ev) {
    return typeof ev.kind === 'number' && typeof ev.content === 'string' && typeof ev.created_at === 'number'
        && typeof ev.pubkey === 'string' && /^[0-9a-f]{64}$/.test(ev.pubkey)
        && Array.isArray(ev.tags) && ev.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'));
}
/**
 * The readable contents of an opened chest (ONOSENDAI lib/chests.ts
 * readContents, #409). A signed item (a non-empty `sig`) that fails to
 * verify is dropped, and only that item; a reference is skipped; a kind
 * this server does not read is skipped. An unsigned item is kept, and its
 * id is its hash, whatever it claims. Its author is a fact only when it is
 * a message written as a rumor by the chest's own signer: `sealer` is the
 * chest's pubkey, given only when the chest itself was verified (found in a
 * bag whose signer it is, or inside a chest that vouched for it), and the
 * rumor's `pubkey` is that key and its `id` its hash (spec 7.6 Rumors).
 * Any other unsigned item's author is a claim.
 */
export function readContents(entries, sealer) {
    const out = [];
    for (const e of entries) {
        try {
            if (isReference(e) || !wellFormed(e))
                continue;
            const ev = e;
            // Unsigned is no `sig`, or an empty one (spec 7.6), as the bag reader has it.
            const signed = ev.sig !== undefined && ev.sig !== '';
            const plain = { pubkey: ev.pubkey, created_at: ev.created_at, kind: ev.kind, tags: ev.tags, content: ev.content };
            if (signed && !isAuthentic({ ...plain, id: ev.id, sig: ev.sig }))
                continue;
            const hash = signed ? ev.id : getEventHash(plain);
            // A message or hidden audio written as a rumor by the chest's own signer (RUMOR_KINDS).
            const vouched = !signed && sealedAsRumor(ev.kind) && sealer !== undefined && ev.pubkey === sealer && ev.id === hash;
            const body = readItem({ ...plain, id: hash });
            if (!body)
                continue;
            out.push({ id: hash, event: { ...plain, id: hash, sig: signed ? ev.sig : '' }, verified: signed || vouched, body });
        }
        catch {
            continue;
        }
    }
    return out;
}
/** Which of the reader's keys opens this chest, or that the lock is the reader's own pubkey, or null. */
export function openerFor(chest, keys, me) {
    const key = keys.find((k) => k.itemPubkey === chest.lockPubkey);
    if (key)
        return { by: 'key', key };
    return chest.lockPubkey === me ? { by: 'self' } : null;
}
/** What a reader who cannot open a chest is told. */
export function requiresLabel(chest) {
    return chest.requires || 'an item you have not found';
}
//# sourceMappingURL=chests.js.map