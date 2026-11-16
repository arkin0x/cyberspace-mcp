// transform.ts: a kit piece made ready to build with: turned by quarter turns
// about Y and scaled by a power of two, as ONOSENDAI's deploy bar turns and
// scales a copy (src/lib/turn.ts there). A quarter turn is exact on the tick
// lattice and a proper rotation, so every face keeps its winding; the turn is
// baked into the copy, so every reader draws it turned (arkinox chose this
// over an orientation field, 2026-09-27). The scale is the payload's unit:
// one model unit is 2^unit gibsons, so scale 1 doubles every length.
//
// The copy is named by the catalog's name for the piece, which carries no
// kit's title: a piece an agent builds with is part of its build, never a kit
// or catalog under the kit's name. A name that still starts with the kit's
// title ("<title>: ...") loses that prefix.
import { quarterTurnPart } from 'sno-core/parts';
import { MAX_UNIT, ticksOf, toPayload, vertexAt } from 'sno-core/shards';
import { validateSnoPayload } from '../sno.js';
import { KitError } from './library.js';
/** Quarter turns from degrees: 0, 90, 180 or 270 (and -90, 360...), or a sentence. */
export function quarters(turn) {
    const t = turn ?? 0;
    if (!Number.isFinite(t) || t % 90 !== 0)
        throw new KitError(`turn must be a multiple of 90 degrees (0, 90, 180 or 270); got ${JSON.stringify(turn)}. Kit pieces turn only in quarter turns about Y.`);
    return (((t / 90) % 4) + 4) % 4;
}
/** A point turned q quarter turns about +Y: x, z -> z, -x per turn (the kits' and ONOSENDAI's turn). */
export function turnY(p, q) {
    let [x, y, z] = p;
    for (let i = 0; i < ((q % 4) + 4) % 4; i++)
        [x, z] = [z, -x];
    return [x, y, z];
}
/** The shard turned q quarter turns about Y (ONOSENDAI turnShard, Y only). */
export function turnModel(s, q) {
    const n = ((q % 4) + 4) % 4;
    if (n === 0)
        return s;
    let vertices = s.vertices;
    let parts = s.parts;
    for (let k = 0; k < n; k++) {
        vertices = vertices.map((v) => {
            const p = ticksOf(v);
            return vertexAt([p[2], p[1], -p[0]], v.c);
        });
        // About Y the plane runs z toward x: quarterTurnPart(part, 2, 0) takes z to x and x to -z.
        if (parts)
            parts = parts.map((part) => quarterTurnPart(part, 2, 0, [0, 0]) ?? part);
    }
    return parts ? { ...s, vertices, parts } : { ...s, vertices };
}
/** A whole scale step, 0 or more, that keeps the unit inside the format, or a sentence. */
export function scaleStep(scale, unit) {
    const s = scale ?? 0;
    if (!Number.isInteger(s) || s < 0)
        throw new KitError(`scale must be a whole number, 0 or more: each step doubles the piece (0 is the size the kit was built at); got ${JSON.stringify(scale)}.`);
    if (unit + s > MAX_UNIT)
        throw new KitError(`scale ${s} would put the unit past ${MAX_UNIT}.`);
    return s;
}
/** A kit piece as a payload to build with: turned, scaled and named for the build. */
export function kitObject(lib, piece, opts = {}) {
    const entry = lib.get(piece);
    const v = validateSnoPayload(lib.payload(entry));
    if (!v.ok)
        throw new KitError(`${entry.id} is not valid SNO: ${v.errors.join(' ')} Your human should refresh the kit.`);
    const q = quarters(opts.turn);
    const s = scaleStep(opts.scale, v.shard.unit);
    const title = lib.catalogOf(entry).title;
    const bare = (opts.name ?? entry.name).trim().replace(new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*`, 'i'), '');
    const name = bare || entry.name;
    const shard = { ...turnModel(v.shard, q), unit: v.shard.unit + s, name };
    return { entry, shard, payload: toPayload(shard), turn: q * 90, scale: s };
}
//# sourceMappingURL=transform.js.map