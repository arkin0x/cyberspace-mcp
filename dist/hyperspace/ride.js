// ride.ts: DECK-0001 v3 5, the ride and its proof, as ONOSENDAI publishes and verifies it.
//
// Ported from ONOSENDAI src/lib/hyperspace/ride.ts at commit 18eded9
// (branch v2): verbatim, every domain constant, the mn grind nonce
// (meetsPrice: int(G) * A < 2^256 with A = max(1, ceil(n / 32)), mn as 16
// lowercase hex), the SAMPLE_V2 indices drawn from G, the abolished
// zero-length ride and the 5.8 exemption by event id exactly as there.
// Adapted: `firstBreak`, `lookBack`, `openBracket` and `ActionEvent` come
// from ../chain/events.js, the server's port of the same chain reader
// (lookBack exported and openBracket added there for `lineStateOf`). The
// worker pool that spreads `findRideNonce` and the leaves over threads
// (ONOSENDAI's ridePool.ts) is not here; the server's ride runner (plan
// task B4) will call these functions.
/**
 * ride.ts: DECK-0001 v3 §5. A ride passes the blocks strictly between the two
 * endpoints plus the destination; each carries seeded Cantor work at height
 * K_b + K_LINE, hashed into a leaf, Merkle-aggregated into the proof root,
 * with SAMPLES openings for Level 1 verification.
 *
 * Openings version 2 (§5.5, §5.8): the sample positions come from G, which
 * costs a re-roll price to find. One attempt is one Cantor tree at
 * GRIND_HEIGHT, and the prover needs a nonce whose G, times A = ceil(n / 32),
 * stays below 2^256, so a prover that skipped blocks pays about one
 * thirty-second of the ride for every fresh set of samples.
 *
 * Everything here is consensus-critical and pure; the worker pool wraps it.
 */
import { alignedBase, bytesToHex, computeSubtreeCantor, hexToBytes, intToBytesBE, sha256 } from 'cyberspace-core';
import { firstBreak, lookBack, openBracket } from '../chain/events.js';
import { GRANDFATHERED_V1_HYPERJUMPS } from './grandfathered.js';
export const K_LINE = 6;
export const RIDE_MAX_HEIGHT = 16 + K_LINE;
export const SAMPLES = 32;
/** The height of one re-roll attempt's Cantor tree (§5.5). */
export const GRIND_HEIGHT = 16;
export const PAD_LEAF = new Uint8Array(32);
/**
 * Why a ride from `fromHeight` to `toHeight` is refused, or null when it is
 * not a zero-length ride. A ride always goes to a different block (arkinox,
 * 2026-10-07, Q1): DECK-0001 §5.6's zero-length ride, the first ride after a
 * boarding with the station as its destination, is abolished, because
 * entering hyperspace is how you travel from your station to somewhere else,
 * never a way to teleport onto the station. `chained` is a ride from the
 * stop the last ride reached, rather than the first ride from a boarding.
 */
export function zeroLengthRideRefusal(fromHeight, toHeight, chained) {
    if (fromHeight !== toHeight)
        return null;
    return chained
        ? `You are already at block ${toHeight}, so a ride there would go nowhere. A ride always takes you to a different block than the one it starts from. To come back to block ${toHeight} from here, ride to any other block first, then ride back to block ${toHeight}.`
        : `Block ${toHeight} is your station, the block this ride would start from, so a ride there would go nowhere. Entering hyperspace lets you travel from your station to a different block; it never moves you onto your station itself. If you want to be at your station, ride to any other block first, then ride back to block ${toHeight}.`;
}
const enc = new TextEncoder();
export const HYPERSPACE_TERRAIN_DOMAIN = enc.encode('CYBERSPACE_HYPERSPACE_TERRAIN_V1');
export const HYPERSPACE_SEED_DOMAIN = enc.encode('CYBERSPACE_HYPERSPACE_SEED_V1');
export const HYPERSPACE_LEAF_DOMAIN = enc.encode('CYBERSPACE_HYPERSPACE_LEAF_V1');
export const HYPERSPACE_GRIND_DOMAIN = enc.encode('CYBERSPACE_HYPERSPACE_GRIND_V1');
export const HYPERSPACE_SAMPLE_DOMAIN = enc.encode('CYBERSPACE_HYPERSPACE_SAMPLE_V2');
const TWO_256 = 1n << 256n;
const NONCE_LIMIT = 1n << 64n;
const AXIS_MASK = (1n << 85n) - 1n;
function concat(...parts) {
    let len = 0;
    for (const p of parts)
        len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}
export function be64(n) {
    const out = new Uint8Array(8);
    let v = BigInt(n);
    for (let i = 7; i >= 0; i--) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return out;
}
export function be32(n) {
    const out = new Uint8Array(4);
    out[0] = (n >>> 24) & 0xff;
    out[1] = (n >>> 16) & 0xff;
    out[2] = (n >>> 8) & 0xff;
    out[3] = n & 0xff;
    return out;
}
function bytesToBigInt(b) {
    let n = 0n;
    for (const x of b)
        n = (n << 8n) | BigInt(x);
    return n;
}
/** §5.3 step 1: line terrain K for a block, from its hash. K in [0, 16]. */
export function lineTerrainK(blockHashHex) {
    const digest = sha256(concat(HYPERSPACE_TERRAIN_DOMAIN, hexToBytes(blockHashHex)));
    let word = (digest[0] << 8) | digest[1];
    let count = 0;
    while (word) {
        count += word & 1;
        word >>>= 1;
    }
    return count;
}
/** §5.3 step 3: the temporal seed for block b under this chain position. */
export function rideSeed(previousEventIdHex, height) {
    if (previousEventIdHex.length !== 64)
        throw new Error('previousEventIdHex must be 64 hex chars');
    const digest = sha256(concat(HYPERSPACE_SEED_DOMAIN, hexToBytes(previousEventIdHex), be64(height)));
    return bytesToBigInt(digest) & AXIS_MASK;
}
/** §5.3 steps 1 to 5: one block's leaf, repeating its full Cantor work. */
export function computeRideLeaf(previousEventIdHex, height, blockHashHex) {
    const k = lineTerrainK(blockHashHex);
    const h = k + K_LINE;
    const t = rideSeed(previousEventIdHex, height);
    const cantorT = computeSubtreeCantor(alignedBase(t, h), h, RIDE_MAX_HEIGHT);
    return sha256(concat(HYPERSPACE_LEAF_DOMAIN, be64(height), intToBytesBE(cantorT)));
}
export function lineStateOf(actions) {
    const head = actions[actions.length - 1];
    // A broken chain is frozen at its last valid position (arkinox,
    // 2026-10-07): not boarded and not at any stop, whatever its last event
    // claims, a broken ride included.
    if (!head || openBracket(actions) || firstBreak(actions))
        return null;
    const standing = lookBack(actions, actions.length);
    if (!standing)
        return null;
    if (standing.type === 'enter-hyperspace')
        return { previousId: head.id, coordHex: head.coordHex, fromHeight: null };
    if (standing.type === 'hyperjump' && standing.toHeight !== undefined)
        return { previousId: head.id, coordHex: head.coordHex, fromHeight: standing.toHeight };
    return null;
}
/** The heights a ride from `from` to `to` passes: (lo, hi], ascending. */
export function rideBlocks(fromHeight, toHeight) {
    const lo = Math.min(fromHeight, toHeight);
    const hi = Math.max(fromHeight, toHeight);
    const out = [];
    for (let b = lo + 1; b <= hi; b++)
        out.push(b);
    return out;
}
/**
 * Where along the line the ride visually IS after `done` of `total` blocks:
 * the height whose stop the transit ghost stands at. Progress counts
 * completed leaves, which can finish out of order; the ghost walks the line
 * in order anyway, because "how far along" is what the count means to a
 * rider. Done is clamped so a stray count can never walk past the
 * destination.
 */
export function rideVisualHeight(fromHeight, toHeight, done, total) {
    if (total <= 0)
        return toHeight;
    const step = toHeight >= fromHeight ? 1 : -1;
    const k = Math.max(0, Math.min(total, done));
    return fromHeight + step * k;
}
/**
 * The walked stretch of the line, oldest first, head last, capped to the
 * most recent `cap` heights so an h18 ride cannot ask for a million-vertex
 * trail: the comet keeps its tail, not its history.
 */
export function rideTrail(fromHeight, toHeight, done, total, cap) {
    const head = rideVisualHeight(fromHeight, toHeight, done, total);
    const step = toHeight >= fromHeight ? 1 : -1;
    const walked = Math.abs(head - fromHeight) + 1;
    const count = Math.max(1, Math.min(walked, cap));
    const out = new Array(count);
    for (let i = 0; i < count; i++)
        out[count - 1 - i] = head - step * i;
    return out;
}
export function paddedCount(n) {
    if (n <= 1)
        return Math.max(n, 0);
    let p = 1;
    while (p < n)
        p <<= 1;
    return p;
}
export function merkleDepth(n) {
    const p = paddedCount(n);
    let d = 0;
    for (let v = p; v > 1; v >>= 1)
        d++;
    return d;
}
/** §5.4: pad with PAD_LEAF to a power of two, parent = sha256(left || right). */
export function merkleLayers(leaves) {
    if (leaves.length === 0)
        return [[]];
    const p = paddedCount(leaves.length);
    let level = leaves.slice();
    while (level.length < p)
        level.push(PAD_LEAF);
    const layers = [level];
    while (level.length > 1) {
        const next = new Array(level.length / 2);
        for (let i = 0; i < level.length; i += 2) {
            next[i / 2] = sha256(concat(level[i], level[i + 1]));
        }
        layers.push(next);
        level = next;
    }
    return layers;
}
export function merkleRoot(leaves) {
    const layers = merkleLayers(leaves);
    const top = layers[layers.length - 1];
    return top.length === 1 ? top[0] : PAD_LEAF;
}
/** §5.5: A, the price in attempts. Each succeeds with probability 1/A. */
export function attemptsRequired(n) {
    return Math.max(1, Math.ceil(n / SAMPLES));
}
/**
 * §5.5: one re-roll attempt, one Cantor tree at GRIND_HEIGHT. Returns G.
 *
 *   seed_nonce = sha256(GRIND_DOMAIN || previous_event_id || root || be64(nonce))
 *   g_base     = ((int(seed_nonce) mod 2^85) >> 16) << 16
 *   G          = sha256(GRIND_DOMAIN || seed_nonce || int_to_bytes_be_min(cantor(g_base, 16)))
 */
export function grindAttempt(previousEventIdHex, root, nonce) {
    if (previousEventIdHex.length !== 64)
        throw new Error('previousEventIdHex must be 64 hex chars');
    if (root.length !== 32)
        throw new Error('root must be 32 bytes');
    if (nonce < 0n || nonce >= NONCE_LIMIT)
        throw new Error('the nonce is an unsigned 64-bit integer');
    const seed = sha256(concat(HYPERSPACE_GRIND_DOMAIN, hexToBytes(previousEventIdHex), root, be64(nonce)));
    const cantorG = computeSubtreeCantor(alignedBase(bytesToBigInt(seed) & AXIS_MASK, GRIND_HEIGHT), GRIND_HEIGHT, GRIND_HEIGHT);
    return sha256(concat(HYPERSPACE_GRIND_DOMAIN, seed, intToBytesBE(cantorG)));
}
/** §5.5: the price is met when G, as a 256-bit big-endian integer, times A is below 2^256. */
export function meetsPrice(G, attempts) {
    return bytesToBigInt(G) * BigInt(attempts) < TWO_256;
}
/**
 * The first nonce from `start` whose attempt meets the price, searching
 * upward on this thread, as the golden vectors do. The worker pool spreads
 * the same search over disjoint ranges (ridePool.ts); any valid nonce
 * verifies.
 */
export function findRideNonce(previousEventIdHex, root, n, start = 0n) {
    const attempts = attemptsRequired(n);
    for (let nonce = start; nonce < NONCE_LIMIT; nonce++) {
        const G = grindAttempt(previousEventIdHex, root, nonce);
        if (meetsPrice(G, attempts))
            return { nonce, G };
    }
    throw new Error('no 64-bit nonce meets the price');
}
/** The `mn` tag (§5.2): the nonce as exactly 16 lowercase hex characters, big-endian. */
export function encodeNonce(nonce) {
    if (nonce < 0n || nonce >= NONCE_LIMIT)
        throw new Error('the nonce is an unsigned 64-bit integer');
    return nonce.toString(16).padStart(16, '0');
}
/** The nonce in an `mn` tag, or null unless it is exactly 16 lowercase hex characters. */
export function decodeNonce(hex) {
    return /^[0-9a-f]{16}$/.test(hex) ? BigInt('0x' + hex) : null;
}
/** §5.5: sample indices among the n real leaves, drawn from G. */
export function sampleIndices(G, n, samples = SAMPLES) {
    if (n <= 0)
        return [];
    const out = [];
    for (let i = 0; i < samples; i++) {
        const digest = sha256(concat(HYPERSPACE_SAMPLE_DOMAIN, G, be32(i)));
        out.push(Number(bytesToBigInt(digest) % BigInt(n)));
    }
    return out;
}
/** The sibling path (leaf level first) for one index. */
export function inclusionPath(layers, index) {
    const path = [];
    let i = index;
    for (let level = 0; level < layers.length - 1; level++) {
        path.push(layers[level][i ^ 1]);
        i >>= 1;
    }
    return path;
}
export function verifyInclusion(leaf, index, path, root) {
    let acc = leaf;
    let i = index;
    for (const sibling of path) {
        acc = (i & 1) === 0 ? sha256(concat(acc, sibling)) : sha256(concat(sibling, acc));
        i >>= 1;
    }
    if (acc.length !== root.length)
        return false;
    for (let k = 0; k < acc.length; k++)
        if (acc[k] !== root[k])
            return false;
    return true;
}
/** The mp tag: SAMPLES inclusion paths, ':'-joined, each path hex-concatenated. */
export function encodeOpenings(paths) {
    return paths.map((p) => p.map((s) => bytesToHex(s)).join('')).join(':');
}
export function decodeOpenings(mp, depth) {
    if (mp === '')
        return depth === 0 ? [] : null;
    const parts = mp.split(':');
    const out = [];
    for (const part of parts) {
        if (part.length !== depth * 64 || !/^[0-9a-f]*$/.test(part))
            return null;
        const path = [];
        for (let i = 0; i < depth; i++)
            path.push(hexToBytes(part.slice(i * 64, i * 64 + 64)));
        out.push(path);
    }
    return out;
}
/** Leaves must be in ascending height order for rideBlocks(from, to), and at least one. */
export function rideTree(leaves) {
    if (leaves.length === 0)
        throw new Error('a ride passes at least one block: there is no zero-length ride (arkinox, 2026-10-07)');
    const layers = merkleLayers(leaves);
    return { layers, root: layers[layers.length - 1][0], n: leaves.length };
}
/** §5.5: the proof, once a nonce meeting the price and its G are known. */
export function rideProofFor(tree, nonce, G) {
    const paths = sampleIndices(G, tree.n).map((i) => inclusionPath(tree.layers, i));
    return { rootHex: bytesToHex(tree.root), mp: encodeOpenings(paths), mnHex: encodeNonce(nonce) };
}
/**
 * The full ride proof from precomputed leaves (§5.4, §5.5), on this thread,
 * with the nonce searched upward from 0 as in the golden vectors. The worker
 * pool does the same in parallel and resumably (ridePool.ts).
 */
export function buildRideProof(previousEventIdHex, leaves) {
    const tree = rideTree(leaves);
    const { nonce, G } = findRideNonce(previousEventIdHex, tree.root, tree.n);
    return rideProofFor(tree, nonce, G);
}
/**
 * Whether a ride is one of those published before openings version 2 and
 * exempt under §5.8: it carries no `mn` tag, and its root and openings are
 * accepted without re-checking.
 */
export function isGrandfatheredV1Hyperjump(eventId) {
    return eventId !== undefined && GRANDFATHERED_V1_HYPERJUMPS.has(eventId);
}
/**
 * Level 1 verification of a ride's proof (§5.5 steps 3 to 6): the re-roll
 * price from one attempt, then the sampled leaves recomputed from scratch and
 * carried up their paths. The chain structure, the station and the stop
 * coordinate (steps 1 and 2) are the caller's to check, for a grandfathered
 * ride as for any other.
 */
export async function verifyRideLevel1(input) {
    const fail = (checked, reason) => ({ ok: false, checked, reason, grandfathered: false });
    if (input.mn === null || input.mn === undefined) {
        return isGrandfatheredV1Hyperjump(input.eventId)
            ? { ok: true, checked: 0, reason: null, grandfathered: true }
            : fail(0, 'no mn tag, and not a ride exempt under §5.8');
    }
    const nonce = decodeNonce(input.mn);
    if (nonce === null)
        return fail(0, 'malformed mn');
    const blocks = rideBlocks(input.fromHeight, input.toHeight);
    const n = blocks.length;
    if (n === 0)
        return fail(0, 'a zero-length ride, whose destination is the block it starts from, is never valid');
    if (!/^[0-9a-f]{64}$/.test(input.rootHex))
        return fail(0, 'malformed root');
    const root = hexToBytes(input.rootHex);
    const G = grindAttempt(input.previousEventIdHex, root, nonce);
    if (!meetsPrice(G, attemptsRequired(n)))
        return fail(0, 'the mn nonce does not meet the price');
    const indices = sampleIndices(G, n);
    const paths = decodeOpenings(input.mp, merkleDepth(n));
    if (paths === null || paths.length !== indices.length)
        return fail(0, 'malformed openings');
    for (let s = 0; s < indices.length; s++) {
        const idx = indices[s];
        const height = blocks[idx];
        const hash = await input.blockHashFor(height);
        const leaf = computeRideLeaf(input.previousEventIdHex, height, hash);
        if (!verifyInclusion(leaf, idx, paths[s], root)) {
            return fail(s, `opening ${s} (block ${height}) does not verify`);
        }
    }
    return { ok: true, checked: indices.length, reason: null, grandfathered: false };
}
/** Expected Cantor pairings for a ride of n blocks (mean 2^K_LINE * (3/2)^16). */
export function expectedRidePairs(n) {
    return n * Math.round(2 ** K_LINE * (3 / 2) ** 16);
}
/**
 * Expected Cantor pairings for the re-roll price of a ride of n blocks: A
 * attempts of one GRIND_HEIGHT tree each (§5.5), about one thirty-second of
 * the ride. Nothing for no blocks, which is no ride at all.
 */
export function expectedPricePairs(n) {
    return n === 0 ? 0 : attemptsRequired(n) * 2 ** GRIND_HEIGHT;
}
/** Exact pairings for known block hashes: sum of 2^(K_b + K_LINE). */
export function exactRidePairs(blockHashes) {
    let total = 0;
    for (const h of blockHashes)
        total += 2 ** (lineTerrainK(h) + K_LINE);
    return total;
}
/**
 * The K values the calibration sample spans. Low through average, never the
 * heavy tail: a K=16 block alone is 2^22 pairings and would make calibration
 * itself seconds long. The measurement is normalized per pairing and scaled
 * to the binomial mean block, so excluding the tail does not bias the result,
 * it only bounds the cost.
 */
export const CALIBRATION_KS = [4, 5, 6, 7, 8, 9, 10, 11];
/** One synthetic block hash per calibration K, in K order. Deterministic. */
export function calibrationHashes() {
    const enc = new TextEncoder();
    const found = new Map();
    for (let counter = 0; found.size < CALIBRATION_KS.length && counter < 100_000; counter++) {
        const hex = bytesToHex(sha256(enc.encode(`ride-calibration-${counter}`)));
        const k = lineTerrainK(hex);
        if (CALIBRATION_KS.includes(k) && !found.has(k))
            found.set(k, hex);
    }
    return CALIBRATION_KS.filter((k) => found.has(k)).map((k) => found.get(k));
}
/** The calibration sample, timed wherever it runs: elapsed wall-clock and the
 * exact pairings it took, from which ms per mean block follows. */
export function timeCalibrationSample() {
    const previousEventIdHex = 'ca'.repeat(32);
    const hashes = calibrationHashes();
    const started = performance.now();
    for (let i = 0; i < hashes.length; i++) {
        computeRideLeaf(previousEventIdHex, 1_000 + i, hashes[i]);
    }
    return { elapsedMs: performance.now() - started, pairs: exactRidePairs(hashes) };
}
/**
 * What the chain's rides add up to: how many hyperjumps, and how many blocks
 * they passed between them (§5.3: the ride passes every block from the
 * lower height exclusive to the higher inclusive, so a ride's length is the
 * difference). Exact from the events themselves, which is why it is derived
 * from the chain rather than tallied as proofs finish: an adopted chain has
 * the same numbers as one ridden here. Only rides that stand on the chain
 * count: buildChain marks a hyperjump a game client signed inside a bracket
 * as broken (type `other`), since it moves nobody (spec §8.11.4 rule 3).
 */
export function rideStatsOf(actions) {
    let hyperjumps = 0;
    let blocksRidden = 0;
    for (const a of actions) {
        if (a.type !== 'hyperjump' || a.fromHeight === undefined || a.toHeight === undefined)
            continue;
        hyperjumps += 1;
        blocksRidden += Math.abs(a.toHeight - a.fromHeight);
    }
    return { hyperjumps, blocksRidden };
}
//# sourceMappingURL=ride.js.map