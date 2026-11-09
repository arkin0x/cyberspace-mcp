// builder.ts: the one module that writes a movement event (kind 3333).
//
// Spec 8.3 to 8.5 and 10 say exactly which tags a spawn, a hop and a
// sidestep carry, DECK-0001 3.1 and 5.2 say which tags a boarding
// (enter-hyperspace) and a ride (hyperjump) carry, and spec 8.8 says every
// tag the chain rules read appears exactly once with a well-formed value.
// These builders write those tags from the rules and nothing else, so an
// agent can never hand-build one: every other module takes a template from
// here, and `kind: 3333` appears in this file and in no other source file of
// this server.
//
// The templates follow ONOSENDAI's src/lib/events.ts tag for tag, so an
// event this server signs is one ONOSENDAI would have signed: spawn and
// sidestep from commit 8e4d0e3, enter-hyperspace and hyperjump from commit
// 18eded9 (branch v2). The hop is version 2 of the hop proof (spec 5.13,
// chain rules 2026-10-08-residue-openings): proof (the seal), mn, mp, in the
// order spec 8.4 lists them at arkin0x/cyberspace 8b45430, the order
// ONOSENDAI's feat/hop-residue-v2 (ono-1) writes them in. The sixteen rides of DECK-0001 5.8 all carry their
// tags in the order hyperjumpTemplate writes them, less the mn they predate
// (checked against the 2026-09-28 Level 2 audit corpus; four are fixtures).
import { coordToXyz, hexToCoord } from 'cyberspace-core';
import { HEX_64, tagValue } from '../nostr/event.js';
import { positionHex, sectorTags } from '../space/coords.js';
/** A re-roll nonce as the mn tag carries it: an unsigned 64-bit number as exactly 16 lowercase hex characters (spec 5.10, 6.10, DECK-0001 5.2). */
const MN_HEX = /^[0-9a-f]{16}$/;
/**
 * A hop's mp as spec 8.4 shapes it: lowercase hex, no separators, exactly
 * HOP_SAMPLES (16) openings of 128 + 64 depth characters each. The depth
 * follows from the hop's geometry, which the template does not derive, so
 * this checks the shape every depth shares (a whole number of 64-character
 * siblings past the 16 blocks of residues); the agent verifies the signed
 * hop at Level 1 before it leaves (agent.ts), which checks the width exactly.
 */
function hopOpeningsShape(mp) {
    if (!/^[0-9a-f]+$/.test(mp) || mp.length % 16 !== 0)
        return false;
    const perOpening = mp.length / 16;
    return perOpening >= 128 && (perOpening - 128) % 64 === 0;
}
/** A block height as the ride tags carry it, base 10. The same test the chain reader applies (events.ts parseAction), so the builder refuses exactly what the reader would not read. */
const BLOCK_HEIGHT = /^\d+$/;
/** Spec 8.1: every movement action, spawn included, is this one kind. */
export const ACTION_KIND = 3333;
/**
 * Spec 8.3. The coordinate IS the pubkey, so there is nothing to choose: the
 * only input besides identity is when.
 */
export function spawnTemplate(pubkey, createdAt) {
    if (!HEX_64.test(pubkey))
        throw new Error('a spawn needs the identity\'s 32-byte public key');
    const at = coordToXyz(hexToCoord(pubkey));
    return {
        kind: ACTION_KIND,
        created_at: createdAt,
        content: '',
        tags: [['A', 'spawn'], ['C', pubkey], ...sectorTags(at)],
    };
}
/** The tags every move starts with, after its A tag: the two links, where it starts, where it lands, and its proof. */
function moveTags(i, proof) {
    return [
        ['e', i.genesisId, '', 'genesis'],
        ['e', i.previousId, '', 'previous'],
        ['c', i.prevCoordHex],
        ['C', positionHex(i.to, i.plane)],
        ['proof', proof],
    ];
}
/**
 * Spec 8.4: a version 2 hop. Never a version 1 hop: a hop without its mn
 * and mp is a version 1 hop, invalid unless its id is on the exemption list
 * (spec 5.13), and no new event can be on it, so this refuses to build one.
 */
export function hopTemplate(i) {
    checkLinks(i);
    if (!HEX_64.test(i.seal))
        throw new Error('a hop needs its 32-byte seal as the proof tag');
    if (!MN_HEX.test(i.mnHex))
        throw new Error('a hop needs its re-roll nonce as 16 lowercase hex characters');
    if (!hopOpeningsShape(i.mpHex))
        throw new Error('a hop needs its 16 residue openings as lowercase hex, 16 x (128 + 64 x depth) characters');
    return {
        kind: ACTION_KIND,
        created_at: i.createdAt,
        content: '',
        tags: [
            ['A', 'hop'],
            ...moveTags(i, i.seal),
            ['mn', i.mnHex],
            ['mp', i.mpHex],
            ...sectorTags(i.to),
        ],
    };
}
/** Spec 8.5. */
export function sidestepTemplate(i) {
    checkLinks(i);
    if (!HEX_64.test(i.proofHash))
        throw new Error('a sidestep needs its 32-byte proof hash');
    if (!MN_HEX.test(i.mnHex))
        throw new Error('a sidestep needs its re-roll nonce as 16 lowercase hex characters');
    if (!i.merkleRoots.every((r) => HEX_64.test(r)))
        throw new Error('a sidestep needs three 32-byte Merkle roots');
    const [hx, hy, hz] = i.lcaHeights;
    return {
        kind: ACTION_KIND,
        created_at: i.createdAt,
        content: '',
        tags: [
            ['A', 'sidestep'],
            ...moveTags(i, i.proofHash),
            ['mr', i.merkleRoots.join(':')],
            ['mp', i.openings.join(':')],
            ['mn', i.mnHex],
            ['hx', String(hx)],
            ['hy', String(hy)],
            ['hz', String(hz)],
            ...sectorTags(i.to),
        ],
    };
}
/**
 * DECK-0001 3.1: board the line from wherever you stand. c equals C. Ported
 * from ONOSENDAI src/lib/events.ts enterHyperspaceTemplate at commit 18eded9,
 * tag for tag and in its order; the input checks are this server's.
 */
export function enterHyperspaceTemplate(i) {
    checkLinks({ genesisId: i.genesisId, previousId: i.previousId, prevCoordHex: i.coordHex });
    if (!HEX_64.test(i.proofHash))
        throw new Error('a boarding needs its 32-byte entry proof hash');
    const here = i.coordHex;
    const at = coordToXyz(hexToCoord(here));
    return {
        kind: ACTION_KIND,
        created_at: i.createdAt,
        content: '',
        tags: [
            ['A', 'enter-hyperspace'],
            ['e', i.genesisId, '', 'genesis'],
            ['e', i.previousId, '', 'previous'],
            ['c', here],
            ['C', here],
            ['proof', i.proofHash],
            ...sectorTags({ x: at.x, y: at.y, z: at.z }),
        ],
    };
}
/**
 * DECK-0001 5.2: ride the line from the station (or current stop) to a
 * stop. Ported from ONOSENDAI src/lib/events.ts hyperjumpTemplate at commit
 * 18eded9, tag for tag and in its order; the input checks beyond the
 * zero-length refusal are this server's. Never a zero-length ride (arkinox,
 * 2026-10-07; DECK-0001 5.6): a destination that is the block the ride starts
 * from throws, so no path can sign one.
 */
export function hyperjumpTemplate(i) {
    checkLinks(i);
    if (i.fromHeight === i.toHeight)
        throw new Error(`a zero-length ride (block ${i.toHeight} to itself) is never signed: a ride always goes to a different block`);
    if (!HEX_64.test(i.toCoordHex))
        throw new Error('a ride needs the coordinate of the stop it goes to, as 64 lowercase hex characters');
    if (!HEX_64.test(i.rootHex))
        throw new Error('a ride needs its 32-byte Merkle root');
    if (!MN_HEX.test(i.mnHex))
        throw new Error('a ride needs its re-roll nonce as 16 lowercase hex characters');
    const at = coordToXyz(hexToCoord(i.toCoordHex));
    return {
        kind: ACTION_KIND,
        created_at: i.createdAt,
        content: '',
        tags: [
            ['A', 'hyperjump'],
            ['e', i.genesisId, '', 'genesis'],
            ['e', i.previousId, '', 'previous'],
            ['c', i.prevCoordHex],
            ['C', i.toCoordHex],
            ['from_height', String(i.fromHeight)],
            ['B', String(i.toHeight)],
            ...(i.asOf !== undefined ? [['as_of', String(i.asOf)]] : []),
            ['proof', i.rootHex],
            ['mp', i.mp],
            ['mn', i.mnHex],
            ...sectorTags({ x: at.x, y: at.y, z: at.z }),
        ],
    };
}
function checkLinks(i) {
    if (!HEX_64.test(i.genesisId))
        throw new Error('a chain action needs the id of its spawn as genesis');
    if (!HEX_64.test(i.previousId))
        throw new Error('a chain action needs the id of the event before it as previous');
    if (!HEX_64.test(i.prevCoordHex))
        throw new Error('a chain action needs the coordinate it starts from, as the previous event\'s C');
}
const BUILT_ACTIONS = ['spawn', 'hop', 'sidestep', 'enter-hyperspace', 'hyperjump'];
/**
 * The tags the chain rules read on each action (spec 8.8, DECK-0001 8), as
 * this module writes them. A template is checked against this before it is
 * signed, so a bug in a builder is caught here and never reaches a relay.
 * A ride's as_of is not listed: the rules read it only on the first ride
 * after a boarding, which the template cannot tell from a later one, so
 * chainTemplateProblem checks it separately, at most once and well formed.
 * A hop reads mn and mp beside its proof (spec 8.4, 8.8, chain rules
 * 2026-10-08-residue-openings); a boarding keeps its own row without them,
 * as spec 8.8 spells out, so it never inherits them from the hop's.
 */
const READ_TAGS = {
    spawn: ['A', 'C', 'X', 'Y', 'Z', 'S'],
    hop: ['A', 'e:genesis', 'e:previous', 'c', 'C', 'proof', 'mn', 'mp', 'X', 'Y', 'Z', 'S'],
    sidestep: ['A', 'e:genesis', 'e:previous', 'c', 'C', 'proof', 'mr', 'mp', 'mn', 'hx', 'hy', 'hz', 'X', 'Y', 'Z', 'S'],
    'enter-hyperspace': ['A', 'e:genesis', 'e:previous', 'c', 'C', 'proof', 'X', 'Y', 'Z', 'S'],
    hyperjump: ['A', 'e:genesis', 'e:previous', 'c', 'C', 'from_height', 'B', 'proof', 'mp', 'mn', 'X', 'Y', 'Z', 'S'],
};
function countTag(t, key) {
    if (!key.startsWith('e:'))
        return t.tags.filter((x) => x[0] === key).length;
    const marker = key.slice(2);
    return t.tags.filter((x) => x[0] === 'e' && x[3] === marker).length;
}
/**
 * Why a template is not a well-formed chain event, or null. Checked before
 * every signature: exactly one A tag naming an action this module builds;
 * every tag the rules read exactly once with a value; the sector tags equal
 * to the ones computed from C; a spawn's C equal to the pubkey it is signed
 * by; a hop's proof a 32-byte seal, its mn a 16-hex nonce and its mp the
 * shape of 16 residue openings (version 2, spec 8.4, so never a version 1
 * hop); a boarding's C equal to its c; a ride's from_height, B and as_of block
 * heights in base 10, as_of at most once, B a different block from
 * from_height, and mn a 16-hex nonce. Each sentence names the one thing
 * wrong, so the log says what to fix and the relay never sees it.
 */
export function chainTemplateProblem(t, pubkey) {
    if (t.kind !== ACTION_KIND)
        return `kind ${t.kind} is not a chain event`;
    const names = t.tags.filter((x) => x[0] === 'A').map((x) => x[1] ?? '');
    if (names.length !== 1)
        return `${names.length} A tags; a chain event carries exactly one`;
    const name = names[0];
    if (!BUILT_ACTIONS.includes(name))
        return `action ${JSON.stringify(name)} is not one this server builds`;
    for (const key of READ_TAGS[name]) {
        const n = countTag(t, key);
        if (n !== 1)
            return `${key} appears ${n} times; every tag the chain rules read appears exactly once`;
    }
    for (const tag of t.tags) {
        if (READ_TAGS[name].includes(tag[0]) && (tag[1] === undefined || tag[1] === ''))
            return `${tag[0]} has no value`;
    }
    const C = tagValue(t, 'C');
    if (!HEX_64.test(C))
        return 'C is not a 32-byte lowercase hex coordinate';
    if (name === 'spawn' && C !== pubkey)
        return 'a spawn\'s C must equal the pubkey';
    if (name === 'hop') {
        if (!HEX_64.test(tagValue(t, 'proof')))
            return 'a hop\'s proof is not a 32-byte lowercase hex seal';
        if (!MN_HEX.test(tagValue(t, 'mn')))
            return 'a hop\'s mn is not a re-roll nonce of 16 lowercase hex characters';
        if (!hopOpeningsShape(tagValue(t, 'mp')))
            return 'a hop\'s mp is not 16 residue openings in lowercase hex (spec 8.4)';
    }
    if (name === 'enter-hyperspace' && tagValue(t, 'c') !== C)
        return 'a boarding\'s C must equal its c; boarding the line does not move the identity';
    if (name === 'hyperjump') {
        const ride = rideTagsProblem(t);
        if (ride)
            return ride;
    }
    const { x, y, z } = coordToXyz(hexToCoord(C));
    for (const [k, v] of sectorTags({ x, y, z })) {
        const got = tagValue(t, k);
        if (got !== v)
            return `${k} says ${got} where C is in ${v}`;
    }
    return null;
}
/**
 * Why a ride's own tags are malformed, or null (DECK-0001 5.2, 5.6, 8). The
 * count rules for from_height, B, mp and mn already held when this runs;
 * this reads their values, and as_of, which the count rules leave alone.
 */
function rideTagsProblem(t) {
    for (const key of ['from_height', 'B']) {
        if (!BLOCK_HEIGHT.test(tagValue(t, key)))
            return `${key} is not a block height in base 10`;
    }
    const asOf = t.tags.filter((x) => x[0] === 'as_of');
    if (asOf.length > 1)
        return `as_of appears ${asOf.length} times; a first ride names its station bound exactly once`;
    if (asOf.length === 1 && !BLOCK_HEIGHT.test(asOf[0][1] ?? ''))
        return 'as_of is not a block height in base 10';
    // Compared as integers, not strings: "0100" and "100" are the same block, and a rule about blocks holds however they are spelled.
    const from = BigInt(tagValue(t, 'from_height'));
    const to = BigInt(tagValue(t, 'B'));
    if (from === to)
        return `a zero-length ride: from_height and B are both block ${to}; a ride always goes to a different block`;
    // The station is found among the blocks up to as_of, so the stop ridden to can never lie above it (DECK-0001 4.2, 5.2).
    if (asOf.length === 1 && BigInt(asOf[0][1]) < to)
        return `as_of (${asOf[0][1]}) is below the block the ride goes to (${to}); the station bound covers the destination`;
    if (!MN_HEX.test(tagValue(t, 'mn')))
        return 'mn is not a re-roll nonce of 16 lowercase hex characters';
    return null;
}
//# sourceMappingURL=builder.js.map