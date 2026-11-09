// headers.ts: the headers-v1 blob format and its proof-of-work verifier.
//
// Ported from ONOSENDAI src/lib/hyperspace/headers.ts at commit 18eded9
// (branch v2): verbatim. Adapted: `bytesToHex` and `hexToBytes` come from
// ../nostr/event.js, the same two functions ONOSENDAI's src/lib/events.ts
// holds. The worker that fetches blobs and calls `verifyAndDerive` is not
// here; the server's line store (plan task A3) will own fetching and
// persistence and call the same verifier.
/**
 * headers.ts: the headers-v1 static blob format and its verifier.
 *
 * The hyperspace line needs one fact per Bitcoin block (the merkle root, and
 * the block hash for landfalls), and the relay path pays ~570 MB of kind-321
 * events on the main thread to get it. A block header is 80 bytes and is
 * self-verifying, so instead we ship 48-byte records (the header minus its
 * prev_hash, which is redundant: it is the sha256d of the header before it)
 * in statically served blobs of 50k blocks, and verify the whole chain
 * locally: linkage, proof of work against the compact target, the mainnet
 * 2016-block retarget window, and pinned checkpoints. Everything in this file
 * is pure and synchronous so the same code runs in the worker and under node
 * in tests; the worker owns fetch and the Cache API.
 *
 * Byte-order glossary, because Bitcoin has two: INTERNAL order is what gets
 * hashed (the wire encoding); DISPLAY order is the byte-reversed form every
 * explorer prints and every kind-321 anchor carries. The blob stores merkle
 * roots internally; every column we emit is display order, matching stops.ts.
 */
import { sha256 } from 'cyberspace-core';
import { bytesToHex, hexToBytes } from '../nostr/event.js';
import { landfallCoordApprox } from './landfall.js';
export const HEADER_RECORD_SIZE = 48;
/** Full wire header: version, prev_hash, merkle_root, time, bits, nonce. */
export const WIRE_HEADER_SIZE = 80;
/** Mainnet difficulty retarget interval: bits may only change at multiples. */
export const RETARGET_INTERVAL = 2016;
/** Read record `index` of a packed blob. The merkle is a view, not a copy. */
export function readRecord(bytes, index) {
    const off = index * HEADER_RECORD_SIZE;
    const dv = new DataView(bytes.buffer, bytes.byteOffset + off, HEADER_RECORD_SIZE);
    return {
        version: dv.getInt32(0, true),
        merkleInternal: bytes.subarray(off + 4, off + 36),
        time: dv.getUint32(36, true),
        bits: dv.getUint32(40, true),
        nonce: dv.getUint32(44, true),
    };
}
/** Write record `index` of a packed blob; the format the packager emits. */
export function writeRecord(out, index, rec) {
    const off = index * HEADER_RECORD_SIZE;
    const dv = new DataView(out.buffer, out.byteOffset + off, HEADER_RECORD_SIZE);
    dv.setInt32(0, rec.version, true);
    out.set(rec.merkleInternal, off + 4);
    dv.setUint32(36, rec.time, true);
    dv.setUint32(40, rec.bits, true);
    dv.setUint32(44, rec.nonce, true);
}
/** Reassemble the 80-byte wire header a record stands for. */
export function wireHeader(rec, prevHashInternal) {
    const out = new Uint8Array(WIRE_HEADER_SIZE);
    const dv = new DataView(out.buffer);
    dv.setInt32(0, rec.version, true);
    out.set(prevHashInternal, 4);
    out.set(rec.merkleInternal, 36);
    dv.setUint32(68, rec.time, true);
    dv.setUint32(72, rec.bits, true);
    dv.setUint32(76, rec.nonce, true);
    return out;
}
export function sha256d(bytes) {
    return sha256(sha256(bytes));
}
/** Copy of 32 bytes reversed: internal order <-> display order. */
export function reverse32(bytes) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
        out[i] = bytes[31 - i];
    return out;
}
// ---------------------------------------------------------------------------
// Small byte/bigint helpers shared with the columnar index
// ---------------------------------------------------------------------------
export function bigToBytes32(v) {
    const out = new Uint8Array(32);
    let n = v;
    for (let i = 31; i >= 0; i--) {
        out[i] = Number(n & 0xffn);
        n >>= 8n;
    }
    return out;
}
export function bytesToBigAt(bytes, offset) {
    let n = 0n;
    for (let i = 0; i < 32; i++)
        n = (n << 8n) | BigInt(bytes[offset + i]);
    return n;
}
/** dst = src >> 1 over 32 big-endian bytes, without a bigint round trip. */
export function shiftRight1Into(src, srcOff, dst, dstOff) {
    let carry = 0;
    for (let i = 0; i < 32; i++) {
        const b = src[srcOff + i];
        dst[dstOff + i] = (b >>> 1) | (carry << 7);
        carry = b & 1;
    }
}
// ---------------------------------------------------------------------------
// Proof of work
// ---------------------------------------------------------------------------
/**
 * Decode Bitcoin compact bits into a 32-byte big-endian target, or null when
 * the encoding is unusable for PoW (negative flag, zero mantissa, or a value
 * that overflows 256 bits). value = mantissa * 256^(exponent - 3).
 */
export function decodeCompactTarget(bits) {
    const exponent = bits >>> 24;
    const mantissa = bits & 0x007fffff;
    if ((bits & 0x00800000) !== 0)
        return null;
    if (mantissa === 0)
        return null;
    const out = new Uint8Array(32);
    const mBytes = [(mantissa >>> 16) & 0xff, (mantissa >>> 8) & 0xff, mantissa & 0xff];
    for (let k = 0; k < 3; k++) {
        // Mantissa byte k has weight 256^(exponent - 1 - k): big-endian index
        // 32 - exponent + k. Off the top is overflow; off the bottom truncates,
        // exactly like arith_uint256::SetCompact.
        const pos = 32 - exponent + k;
        if (pos < 0) {
            if (mBytes[k] !== 0)
                return null;
            continue;
        }
        if (pos > 31)
            continue;
        out[pos] = mBytes[k];
    }
    return out;
}
/** The PoW rule: the DISPLAY hash, read as a big-endian 256-bit integer,
 * must not exceed the target. Bytewise compare, never through Number. */
export function hashMeetsTarget(displayHash, target) {
    for (let i = 0; i < 32; i++) {
        if (displayHash[i] < target[i])
            return true;
        if (displayHash[i] > target[i])
            return false;
    }
    return true;
}
export function genesisState() {
    return { prevHashInternal: new Uint8Array(32), prevBits: null };
}
/** Seed linkage from a known display hash (a checkpoint), losing the bits
 * memory: the window rule then re-arms on the first record. */
export function checkpointState(displayHashHex) {
    return { prevHashInternal: reverse32(hexToBytes(displayHashHex)), prevBits: null };
}
/** How often the walk reports progress, in records. */
const PROGRESS_EVERY = 4096;
/**
 * Verify `count` records starting at `startHeight` and derive the stop
 * columns in the same pass. Returns the columns and the chain state to carry
 * into the next blob, or a reason to discard this one. All-or-nothing on
 * purpose: a blob that fails anywhere is untrusted everywhere, and the relay
 * path can cover its range instead.
 *
 * Note the trust chain: bits are self-declared, so PoW alone would accept a
 * fabricated easy chain. What makes the verdict strong is the combination:
 * the final hash must equal the manifest checkpoint, embedded checkpoints
 * (compiled into the app) must match where present, and every record in
 * between is linked by sha256d. Forging any record means re-mining real
 * mainnet difficulty from there to the checkpoint.
 */
export function verifyAndDerive(bytes, startHeight, count, state, checks, onProgress) {
    if (count <= 0)
        return { ok: false, reason: 'empty blob' };
    if (bytes.length !== count * HEADER_RECORD_SIZE) {
        return { ok: false, reason: `blob is ${bytes.length} bytes, expected ${count * HEADER_RECORD_SIZE}` };
    }
    const keys = new Uint8Array(count * 32);
    const kinds = new Uint8Array(count);
    const merkles = new Uint8Array(count * 32);
    const hashes = new Uint8Array(count * 32);
    const coords = new Uint8Array(count * 32);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // One reused header buffer: the loop runs up to 50k times per blob.
    const header = new Uint8Array(WIRE_HEADER_SIZE);
    const headerDv = new DataView(header.buffer);
    let prevHash = state.prevHashInternal;
    let prevBits = state.prevBits;
    let target = prevBits === null ? null : decodeCompactTarget(prevBits);
    let lastDisplayHex = '';
    for (let i = 0; i < count; i++) {
        const height = startHeight + i;
        const off = i * HEADER_RECORD_SIZE;
        const bits = dv.getUint32(off + 40, true);
        // Mainnet difficulty rule: within a 2016-block window the target is
        // constant; it may only move at a retarget boundary. We cannot recompute
        // the retarget itself (that needs full timestamp history), but holding
        // the window shape plus the endpoint checkpoints pins the chain.
        if (prevBits !== null && bits !== prevBits && height % RETARGET_INTERVAL !== 0) {
            return { ok: false, reason: `bits changed mid-window at height ${height}` };
        }
        if (target === null || bits !== prevBits) {
            target = decodeCompactTarget(bits);
            if (target === null)
                return { ok: false, reason: `invalid compact bits at height ${height}` };
        }
        prevBits = bits;
        // Reconstruct the wire header: version || prev_hash || merkle || time || bits || nonce.
        headerDv.setInt32(0, dv.getInt32(off, true), true);
        header.set(prevHash, 4);
        header.set(bytes.subarray(off + 4, off + 36), 36);
        headerDv.setUint32(68, dv.getUint32(off + 36, true), true);
        headerDv.setUint32(72, bits, true);
        headerDv.setUint32(76, dv.getUint32(off + 44, true), true);
        const hashInternal = sha256d(header);
        const displayHash = reverse32(hashInternal);
        if (!hashMeetsTarget(displayHash, target)) {
            return { ok: false, reason: `proof of work failed at height ${height}` };
        }
        const embedded = checks.embedded.get(height);
        if (embedded !== undefined) {
            lastDisplayHex = bytesToHex(displayHash);
            if (lastDisplayHex !== embedded) {
                return { ok: false, reason: `embedded checkpoint mismatch at height ${height}` };
            }
        }
        // Derive the stop (DECK-0001 v3 §1): the merkle's plane bit picks port
        // or landfall. Display LSB of the merkle equals internal byte 0's LSB.
        const plane = bytes[off + 4] & 1;
        kinds[i] = plane;
        const col = i * 32;
        hashes.set(displayHash, col);
        for (let b = 0; b < 32; b++)
            merkles[col + b] = bytes[off + 35 - b];
        if (plane === 1) {
            // A port sits at the merkle root's own coordinate.
            coords.set(merkles.subarray(col, col + 32), col);
        }
        else {
            // Landfall: float64 approximation only; the exact decimal path is
            // derived lazily on the main thread when a verifier-visible value is
            // needed (stopCoordExact), never here.
            const approx = landfallCoordApprox(bytesToHex(displayHash));
            coords.set(bigToBytes32(approx), col);
        }
        shiftRight1Into(coords, col, keys, col);
        prevHash = hashInternal;
        if (onProgress && (i + 1) % PROGRESS_EVERY === 0)
            onProgress(i + 1);
    }
    if (checks.finalHashHex !== null) {
        const finalHex = bytesToHex(hashes.subarray((count - 1) * 32, count * 32));
        if (finalHex !== checks.finalHashHex) {
            return { ok: false, reason: `checkpoint mismatch at height ${startHeight + count - 1}` };
        }
    }
    // Pre-sort the rows by key so the main thread merges instead of sorting.
    const order = new Uint32Array(count);
    for (let i = 0; i < count; i++)
        order[i] = i;
    order.sort((a, b) => {
        const oa = a * 32;
        const ob = b * 32;
        for (let i = 0; i < 32; i++) {
            const d = keys[oa + i] - keys[ob + i];
            if (d !== 0)
                return d;
        }
        return 0;
    });
    onProgress?.(count);
    return {
        ok: true,
        columns: { startHeight, count, keys, kinds, merkles, hashes, coords, order },
        state: { prevHashInternal: prevHash, prevBits },
    };
}
//# sourceMappingURL=headers.js.map