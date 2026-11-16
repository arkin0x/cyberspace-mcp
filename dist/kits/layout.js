// layout.ts: check_layout. A planned build (kit pieces, each with a place,
// a quarter turn and a scale) checked against the kits' own rules before
// anything is placed, with plain errors an agent can act on.
//
// No kit is named here: each catalog says which family of rules it follows
// and the numbers they need (KitRules: the grid, the door offset, what each
// edge profile means), and hints name a piece by its catalog role, so the
// exact piece comes from the local catalog.
//
// - Rooms (rules.family 'rooms'): tiles on the grid, one per cell; two
//   openings that meet are the same size and, for a long hatch, turned
//   alike, or joined by a reducer placed with the larger one (a lower hatch
//   larger than the upper has none); every other opening is sealed by a plug
//   of its size at its tile's position, or a door, or declared open on
//   purpose; a ceiling hatch under another tile is sealed by that tile's
//   floor when the floor covers it (the catalog's floorSeals), else by a
//   recessed ceiling plug, and a plain ceiling plug there z-fights.
// - Terrain (rules.family 'terrain'): tile edges meet only where they carry
//   the same profile at the same world height, the profile read along the
//   world axis after the turn (a turned edge may read reversed); a seam where
//   they differ is a step that a facing step wall, a ramp bank or a high
//   enough seam wall must hide; a region edge shows the slab's skirt.
// - Both: every piece fits the bag it is hidden in (a shard is drawn at the
//   centre of its gibson and clipped to the aligned cube of its height),
//   pieces do not overlap, and decor stands on what is under it.
import { ticksOf, vertexAt } from 'sno-core/shards';
import { validateSnoPayload } from '../sno.js';
import { KitError } from './library.js';
import { quarters, scaleStep, turnModel, turnY } from './transform.js';
const FACES = ['+x', '-x', '+y', '-y', '+z', '-z'];
const NORMAL = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
const OPP = { '+x': '-x', '-x': '+x', '+y': '-y', '-y': '+y', '+z': '-z', '-z': '+z' };
const faceOf = (n) => FACES.find((f) => NORMAL[f][0] === n[0] && NORMAL[f][1] === n[1] && NORMAL[f][2] === n[2]);
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const key = (c) => c.join(',');
const r1 = (x) => Math.round(x * 10) / 10;
const fmt = (v) => `[${v.map(r1).join(', ')}]`;
/** The world face a local face turns to. */
const turnFace = (f, q) => faceOf(turnY(NORMAL[f], q));
/** The turn (degrees) that faces a piece built facing `from` onto world face `to`: a turn takes x, z to z, -x. */
function turnTo(from, to) {
    for (let q = 0; q < 4; q++)
        if (turnFace(from, q) === to)
            return q * 90;
    return 0;
}
/** An opening's area, which orders sizes (a reducer goes from the larger to the smaller). */
const area = (o) => o.w * o.h;
function vec(at, i) {
    const v = Array.isArray(at) ? at : at && typeof at === 'object' ? [at.x, at.y, at.z] : [];
    if (v.length !== 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n)))
        throw new KitError(`placement ${i}: at must be [x, y, z] in gibsons from the layout's origin.`);
    if (!v.every((n) => Number.isInteger(n)))
        throw new KitError(`placement ${i}: at must be whole gibsons (an object's origin is drawn at the centre of a gibson); got ${JSON.stringify(v)}.`);
    return v;
}
/** Resolve every placement: its piece, turn, scale and world box. Throws a KitError for a placement that cannot be read at all. */
export function resolvePlacements(lib, input) {
    if (!Array.isArray(input.placements) || input.placements.length === 0)
        throw new KitError('placements must list at least one piece: { piece, at: [x, y, z], turn, scale }.');
    if (input.placements.length > 400)
        throw new KitError(`At most 400 placements a layout; got ${input.placements.length}. Check the build in parts.`);
    return input.placements.map((p, i) => {
        const entry = lib.get(p.piece);
        const at = vec(p.at, i);
        const q = quarters(p.turn);
        const s = scaleStep(p.scale, entry.unit);
        const k = 2 ** s;
        const corners = [];
        for (const x of [entry.bounds.min[0], entry.bounds.max[0]])
            for (const y of [entry.bounds.min[1], entry.bounds.max[1]])
                for (const z of [entry.bounds.min[2], entry.bounds.max[2]])
                    corners.push(turnY([x * k, y * k, z * k], q));
        const lo = [0, 1, 2].map((a) => at[a] + 0.5 + Math.min(...corners.map((c) => c[a])));
        const hi = [0, 1, 2].map((a) => at[a] + 0.5 + Math.max(...corners.map((c) => c[a])));
        const open = new Set();
        for (const f of p.open ?? []) {
            if (!FACES.includes(f))
                throw new KitError(`placement ${i}: open lists ${JSON.stringify(f)}; faces are +x, -x, +y, -y, +z, -z (world directions).`);
            open.add(f);
        }
        if (p.height !== undefined && (!Number.isInteger(p.height) || p.height < 0 || p.height > 16))
            throw new KitError(`placement ${i}: height must be a whole number from 0 to 16.`);
        const label = p.label ? `${p.label} (${shortId(entry)})` : shortId(entry);
        return { i, entry, at, q, s, k, label, open, height: p.height, lo, hi };
    });
}
const shortId = (e) => e.id.split('/').pop();
const where = (p) => `placement ${p.i} (${p.label} at ${fmt(p.at)}${p.q ? `, turned ${p.q * 90}` : ''})`;
// ---------- ground under a point (decor standing on tiles and floors) ----------
const meshCache = new Map();
/** A piece's triangles in gibsons, in its own frame at scale 0. */
function trianglesOf(lib, e) {
    const hit = meshCache.get(`${e.kit}/${e.id}`);
    if (hit)
        return hit.tris;
    const v = validateSnoPayload(lib.payload(e));
    const tris = new Float64Array(v.ok ? v.shard.faces.length * 9 : 0);
    if (v.ok) {
        const per = 2 ** v.shard.unit;
        const pts = v.shard.vertices.map((x) => ticksOf(x).map((t) => (t / 120) * per));
        v.shard.faces.forEach((f, i) => { for (let j = 0; j < 3; j++)
            for (let a = 0; a < 3; a++)
                tris[i * 9 + j * 3 + a] = pts[f[j]][a]; });
    }
    meshCache.set(`${e.kit}/${e.id}`, { tris });
    return tris;
}
/** The heights (world) of a placed piece's faces straight under or over world point (x, z), from the top. */
function surfacesAt(lib, p, x, z) {
    // The point in the piece's own frame: undo the offset, the scale and the turn.
    const local = turnY([(x - p.at[0] - 0.5) / p.k, 0, (z - p.at[2] - 0.5) / p.k], (4 - p.q) % 4);
    const tris = trianglesOf(lib, p.entry);
    const hits = [];
    for (let i = 0; i < tris.length; i += 9) {
        const ax = tris[i], az = tris[i + 2], bx = tris[i + 3], bz = tris[i + 5], cx = tris[i + 6], cz = tris[i + 8];
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(d) < 1e-12)
            continue;
        const u = ((bz - cz) * (local[0] - cx) + (cx - bx) * (local[2] - cz)) / d;
        const w = ((cz - az) * (local[0] - cx) + (ax - cx) * (local[2] - cz)) / d;
        if (u < -1e-9 || w < -1e-9 || u + w > 1 + 1e-9)
            continue;
        const y = u * tris[i + 1] + w * tris[i + 4] + (1 - u - w) * tris[i + 7];
        hits.push(p.at[1] + 0.5 + y * p.k);
    }
    return hits.sort((a, b) => b - a);
}
// ---------- the check ----------
export function checkLayout(lib, input) {
    const placed = resolvePlacements(lib, input);
    const errors = [];
    const warnings = [];
    const err = (code, ps, message, fix) => errors.push({ code, message, placements: ps.map((p) => p.i), ...(fix ? { fix } : {}) });
    const warn = (code, ps, message, fix) => warnings.push({ code, message, placements: ps.map((p) => p.i), ...(fix ? { fix } : {}) });
    // Each family of rules over its own pieces, one kit at a time.
    const byKit = new Map();
    for (const p of placed)
        byKit.set(p.entry.kit, [...(byKit.get(p.entry.kit) ?? []), p]);
    const unruled = [];
    for (const [, ps] of byKit) {
        const rules = lib.rulesOf(ps[0].entry);
        if (rules?.family === 'rooms') {
            checkRooms(lib, ps.filter((p) => p.entry.kind !== 'course'), rules, err, warn);
            unruled.push(...ps.filter((p) => p.entry.kind === 'course'));
        }
        else if (rules?.family === 'terrain')
            checkTerrain(lib, ps, rules, err, warn);
        else
            unruled.push(...ps);
    }
    if (unruled.length)
        warn('no-rules', unruled, `${unruled.length} placement(s) have no rules here (pieces whose kit gives check_layout no rules, or course pieces with rules of their own in their kit's notes); only overlaps and the bag are checked for them.`);
    checkOverlaps(placed, warn);
    const bag = checkBags(placed, input, err, warn);
    const counts = { placements: placed.length };
    for (const p of placed)
        counts[p.entry.kind] = (counts[p.entry.kind] ?? 0) + 1;
    const ok = errors.length === 0;
    const lines = [
        ok ? `Layout OK: ${placed.length} placements, no errors${warnings.length ? `, ${warnings.length} warning(s)` : ''}.` : `Layout has ${errors.length} error(s)${warnings.length ? ` and ${warnings.length} warning(s)` : ''}. Fix the errors before placing anything.`,
        ...errors.map((e, n) => `ERROR ${n + 1} [${e.code}]: ${e.message}${e.fix ? ` FIX: ${e.fix}` : ''}`),
        ...warnings.map((w, n) => `WARNING ${n + 1} [${w.code}]: ${w.message}${w.fix ? ` FIX: ${w.fix}` : ''}`),
        String(bag.text),
    ];
    return { ok, errors, warnings, counts, bag, text: lines.join('\n') };
}
function checkRooms(lib, kitPieces, rules, err, warn) {
    const rooms = kitPieces.filter((p) => p.entry.kind === 'tile' || p.entry.kind === 'open');
    if (!rooms.length) {
        for (const p of kitPieces)
            if (['plug', 'reducer', 'recessed-plug', 'door', 'door-open'].includes(p.entry.kind))
                err('no-tile', [p], `${where(p)} seals an opening, but the layout has no tile for it to seal.`);
        for (const p of kitPieces.filter((x) => ['prop', 'decor', 'insert', 'cap'].includes(x.entry.kind)))
            checkRoomDecor(lib, p, [], warn, rules);
        return;
    }
    const scales = new Set(rooms.map((p) => p.s));
    if (scales.size > 1)
        err('mixed-scale', rooms, `Tiles of different scales (${[...scales].join(', ')}) do not share a grid: every tile and plug of one build takes the same scale.`);
    const ref = rooms[0];
    const tile = rules.tile * ref.k;
    const facing = (rules.builtFacing ?? '-z');
    const kitOf = ref.entry.kit;
    const named = (role, words) => { const e = lib.byRole(role, kitOf); return e ? `${words} (${e.id})` : words; };
    const cellOf = (at) => {
        const d = sub(at, ref.at);
        return d.every((x) => x % tile === 0) ? mul(d, 1 / tile) : null;
    };
    // Cells and openings.
    const cells = new Map();
    const openings = new Map();
    const roomCells = new Map();
    for (const p of rooms) {
        const c0 = cellOf(p.at);
        if (!c0) {
            err('off-grid', [p], `${where(p)} is off the ${tile}-gibson tile grid the first tile sets (tiles stand ${tile} gibsons apart from ${fmt(ref.at)}).`, `move it to ${fmt(add(ref.at, mul(sub(p.at, ref.at).map((x) => Math.round(x / tile)), tile)))}`);
            continue;
        }
        const span = p.entry.cells ?? { lo: [0, 0, 0], hi: [0, 0, 0] };
        const mine = [];
        for (let x = span.lo[0]; x <= span.hi[0]; x++)
            for (let y = span.lo[1]; y <= span.hi[1]; y++)
                for (let z = span.lo[2]; z <= span.hi[2]; z++) {
                    const c = add(c0, turnY([x, y, z], p.q));
                    const other = cells.get(key(c));
                    if (other)
                        err('overlap', [other, p], `${where(p)} and ${where(other)} fill the same tile cell ${fmt(add(ref.at, mul(c, tile)))}.`, 'move one of them to an empty cell');
                    else
                        cells.set(key(c), p);
                    mine.push(c);
                }
        roomCells.set(p.i, mine);
        for (const o of p.entry.openings ?? []) {
            const face = turnFace(o.face, p.q);
            const cell = add(c0, turnY(o.cell, p.q));
            const square = o.w === o.h;
            const along = face[1] === 'y' && !square ? (turnY([0, 0, 1], p.q)[2] !== 0 ? 'z' : 'x') : null;
            openings.set(`${key(cell)}|${face}`, { p, face, size: o.size, w: o.w, h: o.h, cell, along, sealedBy: [] });
        }
    }
    const at = (c) => fmt(add(ref.at, mul(c, tile)));
    const plugWords = (o) => {
        const side = o.face[1] === 'y' ? (o.face === '-y' ? 'floor' : 'ceiling') : 'wall';
        const turn = side === 'wall' ? turnTo(facing, o.face) : o.p.q * 90;
        return `${named(`plug:${side}:${o.size}`, `the ${side} plug for a ${o.w} x ${o.h} opening`)} at ${at(o.cell)}${turn ? ` turned ${turn}` : ''}`;
    };
    // Sealers: plugs, recessed plugs, reducers and doors, matched to the openings they sit in.
    const reducers = [];
    for (const p of kitPieces) {
        const e = p.entry;
        if (e.kind === 'plug' || e.kind === 'recessed-plug') {
            if (p.s !== ref.s) {
                err('mixed-scale', [p], `${where(p)} has scale ${p.s}; the tiles have ${ref.s}.`);
                continue;
            }
            const c = cellOf(p.at);
            const side = e.plug.side;
            const local = side === 'wall' ? facing : side === 'floor' ? '-y' : '+y';
            const face = turnFace(local, p.q);
            if (!c) {
                err('plug-off-grid', [p], `${where(p)} is not at a tile's position: a plug is placed at the very position of the tile it seals.`);
                continue;
            }
            const o = openings.get(`${key(c)}|${face}`);
            if (!o) {
                const here = cells.get(key(c));
                err('plug-no-opening', [p], `${where(p)} seals the ${face} ${side === 'wall' ? 'wall' : 'hatch'} of ${here ? where(here) : `cell ${at(c)} (empty)`}, which has no opening there.${side === 'wall' ? ` A wall plug is built facing ${facing}: turn ${turnTo(facing, turnFace(facing, 1))} for ${turnFace(facing, 1)}, 180 for ${turnFace(facing, 2)}, ${turnTo(facing, turnFace(facing, 3))} for ${turnFace(facing, 3)}.` : ''}`, here ? `take it out, or turn it to face an opening of ${shortId(here.entry)}` : 'take it out');
                continue;
            }
            if (o.size !== e.plug.size) {
                err('plug-size', [p, o.p], `${where(p)} is a ${e.plug.size} plug in the ${o.size} opening ${o.face} of ${where(o.p)}.`, `use ${plugWords(o)}`);
                continue;
            }
            if (o.along) {
                const plugAlong = turnY([0, 0, 1], p.q)[2] !== 0 ? 'z' : 'x';
                if (plugAlong !== o.along) {
                    err('plug-turn', [p, o.p], `${where(p)} is turned across the ${o.size} hatch of ${where(o.p)}: a long hatch plug turns with its tile.`, `turn it ${o.p.q * 90}`);
                    continue;
                }
            }
            if (e.kind === 'recessed-plug' && o.face !== '+y') {
                err('plug-no-opening', [p], `${where(p)} is a recessed ceiling plug; it seals only a ceiling hatch (+y).`);
                continue;
            }
            o.sealedBy.push(p);
        }
        else if (e.kind === 'reducer') {
            if (p.s !== ref.s) {
                err('mixed-scale', [p], `${where(p)} has scale ${p.s}; the tiles have ${ref.s}.`);
                continue;
            }
            const c = cellOf(p.at);
            if (!c) {
                err('plug-off-grid', [p], `${where(p)} is not at a tile's position: a reducer is placed at the position of the tile with the larger opening.`);
                continue;
            }
            const local = e.reducer.side === 'wall' ? facing : '-y';
            const face = turnFace(local, p.q);
            const big = openings.get(`${key(c)}|${face}`);
            if (!big || big.size !== e.reducer.from) {
                err('reducer-misplaced', [p], `${where(p)} needs a ${e.reducer.from} opening on the ${face} side of the tile at ${at(c)}${big ? `; that opening is a ${big.size}` : '; there is none'}. A ${e.reducer.side} reducer stands with the tile that has the larger opening${e.reducer.side === 'floor' ? ' (the upper tile, in its floor)' : ''}.`);
                continue;
            }
            const nb = add(c, NORMAL[face]);
            const small = openings.get(`${key(nb)}|${OPP[face]}`) ?? null;
            if (!small || small.size !== e.reducer.to) {
                err('reducer-misplaced', [p], `${where(p)} joins a ${e.reducer.from} to a ${e.reducer.to}, but across the ${face} side at ${at(nb)} there is ${small ? `a ${small.size} opening` : 'no opening facing back'}.`);
                continue;
            }
            if (e.reducer.side === 'floor' && big.along) {
                // A floor reducer's rims are long hatches too: it turns with the hatches it joins.
                const redAlong = turnY([0, 0, 1], p.q)[2] !== 0 ? 'z' : 'x';
                if (redAlong !== big.along) {
                    err('plug-turn', [p, big.p], `${where(p)} is turned across the ${big.size} hatch of ${where(big.p)}: a floor reducer turns with the hatches it joins.`, `turn it ${big.p.q * 90}`);
                    continue;
                }
            }
            if (big.along && small.along && big.along !== small.along) {
                err('turn-mismatch', [big.p, small.p], `The ${big.size} hatch of ${where(big.p)} and the ${small.size} hatch of ${where(small.p)} cross at right angles: long hatches meet only when the two tiles are turned alike or 180 apart.`);
                continue;
            }
            big.sealedBy.push(p);
            small.sealedBy.push(p);
            reducers.push({ r: p, big, small });
        }
        else if (e.kind === 'door' || e.kind === 'door-open') {
            if (p.s !== ref.s) {
                err('mixed-scale', [p], `${where(p)} has scale ${p.s}; the tiles have ${ref.s}, and a door fits only tiles of its own scale.`);
                continue;
            }
            const toTile = mul(turnY(rules.doorOffset ?? [0, -tile / 2, -tile / 2], p.q), p.k);
            const c = cellOf(sub(p.at, toTile));
            const face = turnFace(facing, p.q);
            const o = c && (openings.get(`${key(c)}|${face}`) ?? openings.get(`${key(add(c, NORMAL[face]))}|${OPP[face]}`));
            if (!o) {
                err('door-no-opening', [p], `${where(p)} is not in an opening: a door's origin is the bottom centre of the opening it closes, at the tile's position plus (${(rules.doorOffset ?? []).join(', ')}) for its ${facing} opening, turned like a wall plug (the offset turns with it).`);
                continue;
            }
            if (o.size !== e.closes) {
                err('door-size', [p, o.p], `${where(p)} closes a ${e.closes}; the opening it stands in is a ${o.size} (${o.w} x ${o.h}).`, lib.byRole(`door:${o.size}`, kitOf) ? `use ${named(`door:${o.size}`, `the door for a ${o.w} x ${o.h} opening`)} instead` : `no door fits a ${o.w} x ${o.h} opening: plug it`);
                continue;
            }
            o.door = p;
            const back = openings.get(`${key(add(o.cell, NORMAL[o.face]))}|${OPP[o.face]}`);
            if (back)
                back.door = p;
        }
    }
    // Every opening: joined, sealed, doored, or open on purpose.
    const reported = new Set();
    for (const o of openings.values()) {
        const nbCell = add(o.cell, NORMAL[o.face]);
        const nb = cells.get(key(nbCell));
        const back = openings.get(`${key(nbCell)}|${OPP[o.face]}`);
        const pairKey = [`${key(o.cell)}|${o.face}`, `${key(nbCell)}|${OPP[o.face]}`].sort().join('~');
        const plugs = o.sealedBy.filter((s) => s.entry.kind !== 'reducer');
        const reducer = o.sealedBy.find((s) => s.entry.kind === 'reducer');
        const name = `the ${o.face} ${o.size}${o.face[1] === 'y' ? ' hatch' : ''} of ${where(o.p)}`;
        if (plugs.length > 1)
            err('double-plug', plugs, `${name} has ${plugs.length} plugs; they z-fight.`, 'keep one');
        if (back && nb) {
            if (reported.has(pairKey))
                continue;
            reported.add(pairKey);
            const backPlugs = back.sealedBy.filter((s) => s.entry.kind !== 'reducer');
            if (o.size === back.size) {
                if (o.along && back.along && o.along !== back.along)
                    err('turn-mismatch', [o.p, back.p], `${name} and the ${back.face} ${back.size} hatch of ${where(back.p)} cross at right angles: a long hatch meets one only when both tiles are turned alike or 180 apart.`, `turn one of them by 90`);
                if (plugs.length && backPlugs.length)
                    err('double-plug', [...plugs, ...backPlugs], `The join between ${where(o.p)} and ${where(back.p)} is plugged from both sides; the two plugs z-fight.`, 'take both out to open the way, or keep one to shut it');
                else if (plugs.length || backPlugs.length)
                    warn('plugged-join', [...plugs, ...backPlugs], `The join between ${where(o.p)} and ${where(back.p)} is plugged, so the way between them is shut.`, 'take the plug out unless you mean to shut it');
            }
            else if (!reducer) {
                const bigO = area(o) > area(back) ? o : back;
                const smallO = bigO === o ? back : o;
                if (bigO.face === '+y')
                    err('hatch-sizes', [o.p, back.p], `The ${bigO.size} ceiling hatch of ${where(bigO.p)} sits under the smaller ${smallO.size} floor hatch of ${where(smallO.p)}: a reducer stands only in an upper floor, so a lower hatch larger than the upper one has no fit.`, 'swap the tiles, or use tiles whose hatches match');
                else {
                    const side = bigO.face[1] === 'y' ? 'floor' : 'wall';
                    const turn = side === 'wall' ? turnTo(facing, bigO.face) : bigO.p.q * 90;
                    err('needs-reducer', [o.p, back.p], `The ${bigO.size} of ${where(bigO.p)} meets the ${smallO.size} of ${where(smallO.p)}.`, `place ${named(`reducer:${side}:${bigO.size}-${smallO.size}`, `the ${side} reducer from ${bigO.w} x ${bigO.h} to ${smallO.w} x ${smallO.h}`)} at ${fmt(bigO.p.at)}${turn ? ` turned ${turn}` : ''}, or use tiles whose openings match`);
                }
            }
            continue;
        }
        if (o.face === '+y' && nb && !back) {
            // A ceiling hatch under another tile's floor.
            const span = nb.entry.cells ?? { lo: [0, 0, 0], hi: [0, 0, 0] };
            const c0 = cellOf(nb.at);
            const localCell = turnY(sub(nbCell, c0), (4 - nb.q) % 4);
            const seals = nb.entry.floorSeals?.find((f) => key(f.cell) === key(localCell))?.seals;
            const alongLocal = o.along ? (turnY(o.along === 'z' ? [0, 0, 1] : [1, 0, 0], (4 - nb.q) % 4)[2] !== 0 ? 'z' : 'x') : 'z';
            const want = o.along && alongLocal === 'x' ? `${o.size}-x` : o.size;
            const covered = seals ? seals.includes(want) : localCell[1] === span.lo[1] ? null : false;
            const plain = plugs.filter((s) => s.entry.kind === 'plug');
            const recessed = plugs.filter((s) => s.entry.kind === 'recessed-plug');
            if (covered === true) {
                if (plain.length)
                    err('zfight', plain, `${name} is sealed by the floor of ${where(nb)} above it; a ceiling plug there lies in that floor's plane and z-fights.`, 'take the ceiling plug out (the floor seals it)');
            }
            else if (!recessed.length && !o.door) {
                err('needs-recessed-plug', [o.p, nb], `${name} is under ${where(nb)}, whose floor ${covered === null ? 'the kit could not measure there' : 'covers it only partly'}; a ceiling plug there would z-fight with that floor.`, `place ${named(`plug:ceiling-recessed:${o.size}`, `the recessed ceiling plug for a ${o.w} x ${o.h} hatch`)} at ${fmt(o.p.at)}${o.p.q ? ` turned ${o.p.q * 90}` : ''} (sealed from inside)`);
            }
            continue;
        }
        // A closed door seals like a plug; an open one leaves the way open.
        if (plugs.length || o.sealedBy.length || (o.door && o.door.entry.kind === 'door'))
            continue;
        if (o.p.open.has(o.face))
            continue;
        if (nb && nb.entry.kind === 'open') {
            err('opens-to-open-air', [o.p, nb], `${name} opens onto ${where(nb)}, an open-air piece, so the room is not enclosed.`, `plug it (${plugWords(o)}), or list "${o.face}" in that placement's open if it is a way out on purpose`);
            continue;
        }
        if (nb) {
            err('opens-into-wall', [o.p, nb], `${name} opens against ${where(nb)}, which has no opening facing back.`, `plug it (${plugWords(o)}), or turn one of the two tiles so their openings meet`);
            continue;
        }
        err('opens-into-nothing', [o.p], `${name} opens into nothing (cell ${at(nbCell)} is empty), so the room is not enclosed and its inside shows.`, `put a tile with a ${OPP[o.face]} ${o.size} at ${at(nbCell)}, plug it (${plugWords(o)}), or list "${o.face}" in that placement's open if it is the way in`);
    }
    for (const p of kitPieces.filter((x) => ['prop', 'decor', 'insert', 'cap', 'chest-look'].includes(x.entry.kind))) {
        const host = [...roomCells.entries()].find(([, cs]) => cs.some((c) => [0, 1, 2].every((a) => Math.abs(p.at[a] + 0.5 - (ref.at[a] + 0.5 + c[a] * tile)) <= tile / 2)));
        checkRoomDecor(lib, p, host ? [rooms.find((r) => r.i === host[0])] : [], warn, rules, ref, tile);
    }
}
function checkRoomDecor(lib, p, host, warn, rules, ref, tile = rules.tile) {
    const e = p.entry;
    if (e.kind === 'insert' || e.kind === 'cap') {
        const want = e.host;
        if (want && !(host[0] && host[0].entry.id.endsWith(`/${want.split('/').slice(1).join('/') || want}`) && host[0].at.join() === p.at.join() && host[0].q === p.q)) {
            warn('insert-host', [p], `${where(p)} is made for ${want}: place it at the same position and turn as that tile.`);
        }
        return;
    }
    if (!host.length) {
        warn('decor-outside', [p], `${where(p)} stands outside every room of the layout.`, 'move it inside a room, or take it out');
        return;
    }
    const room = host[0];
    // Inside the walls: walls stand rules.wallInset inside the cell boundary.
    if (ref) {
        const off = sub(add(p.at, [0.5, 0.5, 0.5]), add(ref.at, [0.5, 0.5, 0.5]));
        const c = off.map((x) => Math.round(x / tile));
        const centre = add(add(ref.at, [0.5, 0.5, 0.5]), mul(c, tile));
        const lim = (tile / 2) - (rules.wallInset ?? 0) * (tile / rules.tile);
        if ([0, 2].some((a) => p.lo[a] < centre[a] - lim - 1e-6 || p.hi[a] > centre[a] + lim + 1e-6))
            warn('decor-in-wall', [p], `${where(p)} reaches past the walls of its tile cell (they stand ${r1(lim)} from the cell's centre ${fmt(sub(centre, [0.5, 0.5, 0.5]))}).`, 'move it in from the wall');
    }
    if ((e.mount ?? 'floor') === 'floor') {
        const base = p.at[1] + 0.5;
        const under = surfacesAt(lib, room, p.at[0] + 0.5, p.at[2] + 0.5).filter((y) => y <= base + 0.75);
        const floor = under[0];
        if (floor === undefined)
            warn('decor-floating', [p], `${where(p)} has no floor under it in ${where(room)}.`);
        else if (Math.abs(floor - base) > 0.5)
            warn(floor < base ? 'decor-floating' : 'decor-sunk', [p], `${where(p)} stands ${r1(Math.abs(base - floor))} ${floor < base ? 'above' : 'below'} the floor of ${where(room)} (floor at y ${r1(floor - 0.5)} in placement terms).`, `place it at y ${Math.round(floor - 0.5)}`);
    }
}
/** A profile and the tile's height as one signature: flat ones by their world height, the others by name and height (the catalog's rules.profiles say which is which). */
function signature(rules, profile, y) {
    const flat = rules.profiles?.[profile]?.flat;
    if (typeof flat === 'number')
        return { sig: `flat:${y + flat}`, flat: y + flat };
    return { sig: `${profile}@${y}`, flat: null };
}
/** The same profile read along the axis the other way, by the catalog's rules (unchanged when it has no direction). */
const reversed = (rules, e) => rules.profiles?.[e]?.reverse ?? e;
const SIDE_N = { px: [1, 0, 0], nx: [-1, 0, 0], pz: [0, 0, 1], nz: [0, 0, -1] };
function edgesOf(rules, p) {
    const e = p.entry;
    const [w0, d0] = e.footprint;
    const out = [];
    for (const side of ['px', 'nx', 'pz', 'nz']) {
        const n = turnY(SIDE_N[side], p.q);
        const ws = n[0] > 0.5 ? 'px' : n[0] < -0.5 ? 'nx' : n[2] > 0.5 ? 'pz' : 'nz';
        const axis = ws[1] === 'x' ? 'z' : 'x';
        // The profile's + end along the local edge axis (z on an x side, x on a z side), turned into the world.
        const localAxis = side[1] === 'x' ? [0, 0, 1] : [1, 0, 0];
        const wa = turnY(localAxis, p.q);
        const flip = (axis === 'z' ? wa[2] : wa[0]) < 0;
        const profile = flip ? reversed(rules, e.edges[side]) : e.edges[side];
        const localLen = (side[1] === 'x' ? d0 : w0) * p.k;
        const half = localLen / 2;
        const cx = p.at[0], cz = p.at[2];
        const W = (p.q % 2 ? d0 : w0) * p.k, D = (p.q % 2 ? w0 : d0) * p.k;
        const line = ws === 'px' ? cx + W / 2 : ws === 'nx' ? cx - W / 2 : ws === 'pz' ? cz + D / 2 : cz - D / 2;
        const mid = axis === 'z' ? cz : cx;
        const { sig, flat } = signature(rules, profile, p.at[1]);
        out.push({ p, side: ws, axis, line, a: mid - half, b: mid + half, sig, flat, profile, len: localLen });
    }
    return out;
}
/** The parts of [a, b] not covered by the intervals. */
function uncovered(a, b, cover) {
    const segs = cover.map(([x, y]) => [Math.max(a, Math.min(x, y)), Math.min(b, Math.max(x, y))]).filter(([x, y]) => y > x + 1e-6).sort((s, t) => s[0] - t[0]);
    const out = [];
    let at = a;
    for (const [x, y] of segs) {
        if (x > at + 1e-6)
            out.push([at, x]);
        at = Math.max(at, y);
    }
    if (b > at + 1e-6)
        out.push([at, b]);
    return out;
}
function checkTerrain(lib, terrain, rules, err, warn) {
    const facing = (rules.builtFacing ?? '-z');
    const kitOf = terrain[0].entry.kit;
    const named = (role, words) => { const e = lib.byRole(role, kitOf); return e ? `${words} (${e.id})` : words; };
    const isRamp = (pr) => !!rules.profiles?.[pr]?.ramp;
    const minHide = rules.minHideHeight ?? 0;
    const tiles = terrain.filter((p) => p.entry.footprint && p.entry.edges);
    const walls = terrain.filter((p) => p.entry.wall);
    const decor = terrain.filter((p) => p.entry.kind === 'decor' || p.entry.kind === 'ruin');
    // The module, from the first tile's low corner.
    const foot = (p) => {
        const [w0, d0] = p.entry.footprint;
        const W = (p.q % 2 ? d0 : w0) * p.k, D = (p.q % 2 ? w0 : d0) * p.k;
        return { x0: p.at[0] - W / 2, x1: p.at[0] + W / 2, z0: p.at[2] - D / 2, z1: p.at[2] + D / 2 };
    };
    if (tiles.length) {
        const r = foot(tiles[0]);
        const m = (rules.module ?? rules.tile) * tiles[0].k;
        for (const p of tiles) {
            const f = foot(p);
            if ([(f.x0 - r.x0) % m, (f.z0 - r.z0) % m].some((x) => Math.abs(x) > 1e-6))
                err('off-module', [p], `${where(p)} has its edges off the ${m}-gibson module the first tile sets, so its edges cannot meet its neighbours vertex for vertex.`, `move it so its corners terrain on multiples of ${m} from ${fmt([r.x0, 0, r.z0])}`);
        }
        for (let a = 0; a < tiles.length; a++)
            for (let b = a + 1; b < tiles.length; b++) {
                const A = foot(tiles[a]), B = foot(tiles[b]);
                if (Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0) > 1e-6 && Math.min(A.z1, B.z1) - Math.max(A.z0, B.z0) > 1e-6)
                    err('overlap', [tiles[a], tiles[b]], `${where(tiles[a])} and ${where(tiles[b])} overlap.`, 'tiles sit side by side, never on top of each other: a raised area is tiles placed 10 higher in place of the ground tiles, not over them');
            }
    }
    // Wall centre lines in the world.
    const wallSegs = walls.flatMap((w) => {
        const segs = (w.entry.wall.hides ?? w.entry.wall.segments).map(([[ax, az], [bx, bz]]) => {
            const A = turnY([ax * w.k, 0, az * w.k], w.q), B = turnY([bx * w.k, 0, bz * w.k], w.q);
            return { w, a: [A[0] + w.at[0], A[2] + w.at[2]], b: [B[0] + w.at[0], B[2] + w.at[2]] };
        });
        return segs;
    });
    const coverOn = (axis, line) => wallSegs.filter((s) => axis === 'z' ? Math.abs(s.a[0] - line) < 1e-6 && Math.abs(s.b[0] - line) < 1e-6 : Math.abs(s.a[1] - line) < 1e-6 && Math.abs(s.b[1] - line) < 1e-6);
    const used = new Set();
    const all = tiles.flatMap((t) => edgesOf(rules, t));
    const exposed = [];
    for (const e of all) {
        const across = all.filter((o) => o.p !== e.p && o.axis === e.axis && Math.abs(o.line - e.line) < 1e-6 && OPP_SIDE[o.side] === e.side && Math.min(o.b, e.b) - Math.max(o.a, e.a) > 1e-6);
        const touched = [];
        for (const o of across) {
            const a = Math.max(o.a, e.a), b = Math.min(o.b, e.b);
            touched.push([a, b]);
            if (e.p.i > o.p.i)
                continue;
            const k = e.axis === 'z' ? 1 : 0;
            const onSeam = coverOn(e.axis, e.line).filter((sg) => Math.min(Math.max(sg.a[k], sg.b[k]), b) - Math.max(Math.min(sg.a[k], sg.b[k]), a) > 1e-6);
            // A wall on any seam is on an edge, whether or not the seam needs it (a low ruin wall, a hedge between fields).
            for (const sg of onSeam)
                used.add(sg.w.i);
            const exact = Math.abs(o.a - e.a) < 1e-6 && Math.abs(o.b - e.b) < 1e-6;
            const matches = e.sig === o.sig && (e.flat !== null || exact);
            if (matches)
                continue;
            const seg = (sp) => (e.axis === 'z' ? `x ${r1(e.line)}, z ${r1(sp[0])} to ${r1(sp[1])}` : `z ${r1(e.line)}, x ${r1(sp[0])} to ${r1(sp[1])}`);
            const rampEdge = isRamp(e.profile) ? e : isRamp(o.profile) ? o : null;
            const flatStep = e.flat !== null && o.flat !== null;
            const low = flatStep ? (e.flat < o.flat ? e : o) : null;
            const lowY = flatStep ? Math.min(e.flat, o.flat) : Math.min(e.p.at[1], o.p.at[1]);
            const lowDir = low ? NORMAL[sideFace(OPP_SIDE[low.side])] : null;
            // Which walls on this seam hide it: standing on the low ground; a step wall facing the low tile, or a seam wall at least minHideHeight high; a ramp side only a ramp bank with the ramp tile on its far side from its plumb face.
            const why = new Map();
            const hides = onSeam.filter((sg) => {
                const w = sg.w, info = w.entry.wall;
                if (Math.abs(w.at[1] - lowY) > 1) {
                    why.set(w.i, `stands at y ${w.at[1]}; its base must be at the low ground's level, ${lowY}`);
                    return false;
                }
                // A wall's plumb face is the face it is built facing (rules.builtFacing); a ramp bank has the ramp on its other side.
                const plumb = turnY(NORMAL[facing], w.q);
                if (rampEdge) {
                    if (info.kind !== 'ramp-step') {
                        why.set(w.i, `is not a ramp-step wall, and only a ramp-step wall lines a ramp's side`);
                        return false;
                    }
                    const toRamp = NORMAL[sideFace(OPP_SIDE[rampEdge.side])];
                    if (-plumb[0] !== toRamp[0] || -plumb[2] !== toRamp[2]) {
                        why.set(w.i, `has the ramp on its wrong side: turn it ${turnTo(facing, sideFace(rampEdge.side))} so its back faces the ramp tile`);
                        return false;
                    }
                    // Its high end (wall.highEnd: +1 or -1 along its own x) must be where the ramp is high (the profile's rises).
                    const high = turnY([info.highEnd ?? 1, 0, 0], w.q);
                    const rises = rules.profiles?.[rampEdge.profile]?.rises ?? 1;
                    if ((rampEdge.axis === 'x' ? high[0] : high[2]) !== rises) {
                        why.set(w.i, `rises the wrong way along the ramp: use the ramp-step wall whose high end is at its other end${lib.byRole('ramp-step-mirror', kitOf) ? ` (${(info.highEnd ?? 1) > 0 ? named('ramp-step-mirror', 'the mirrored ramp bank') : named('ramp-step-wall', 'the ramp bank')})` : ''}`);
                        return false;
                    }
                    return true;
                }
                if (info.kind === 'step') {
                    if (info.corner || !lowDir)
                        return true;
                    if (plumb[0] !== lowDir[0] || plumb[2] !== lowDir[2]) {
                        why.set(w.i, `has its plumb face toward the raised tile; it must face the low tile ${where(low.p)} (turn it ${turnTo(facing, sideFace(OPP_SIDE[low.side]))})`);
                        return false;
                    }
                    return true;
                }
                if (info.kind === 'seam' && info.height >= minHide)
                    return true;
                why.set(w.i, `is ${info.height} high; a seam wall must be ${minHide} or more to hide a step`);
                return false;
            });
            const gaps = uncovered(a, b, hides.map((sg) => [sg.a[k], sg.b[k]]));
            for (const sg of onSeam)
                if (why.has(sg.w.i))
                    err(why.get(sg.w.i).startsWith('has its plumb') ? 'step-facing' : 'wall-cannot-hide', [sg.w], `${where(sg.w)} ${why.get(sg.w.i)}.`);
            why.clear();
            if (gaps.length) {
                const words = flatStep ? `a step from ${Math.min(e.flat, o.flat)} to ${Math.max(e.flat, o.flat)}` : rampEdge ? 'a ramp\'s side' : `edges that do not match (${e.profile} at ${e.p.at[1]} against ${o.profile} at ${o.p.at[1]})`;
                const turn = low ? turnTo(facing, sideFace(OPP_SIDE[low.side])) : undefined;
                const len = Math.round(gaps[0][1] - gaps[0][0]);
                err('edge-mismatch', [e.p, o.p], `Between ${where(e.p)} and ${where(o.p)} the seam at ${gaps.map(seg).join(' and ')} is ${words}, and nothing hides it, so the raised tile's skirt shows.`, rampEdge ? `line it with ${named('ramp-step-wall', 'a ramp-step wall')} (or ${named('ramp-step-mirror', 'its mirrored twin')}) at y ${lowY}, turned ${turnTo(facing, sideFace(rampEdge.side))} so its back faces the ramp tile, or join it to another ramp`
                    : low && turn !== undefined ? `stand step walls on that seam with their plumb face toward the low tile (turn ${turn}), base at y ${low.flat}: for example ${named(`step-wall:${len}`, `a step wall ${len} long`)}, centred on the stretch; or any seam wall ${minHide} or more high`
                        : 'change one tile so the profiles match, or stand a wall on the seam');
            }
        }
        const open = uncovered(e.a, e.b, touched);
        if (open.length) {
            const cover = coverOn(e.axis, e.line).map((s) => (e.axis === 'z' ? [s.a[1], s.b[1]] : [s.a[0], s.b[0]]));
            const left = open.flatMap(([a, b]) => uncovered(a, b, cover));
            for (const w of coverOn(e.axis, e.line))
                used.add(w.w.i);
            // A profile the kit leaves open on purpose (rules.profiles[...].open: the sea side, say) is not a skirt to hide.
            if (left.length && !rules.profiles?.[e.profile]?.open)
                exposed.push({ e, segs: left });
        }
    }
    if (exposed.length) {
        const list = exposed.map(({ e, segs }) => `${sideFace(e.side)} of ${shortId(e.p.entry)} at ${fmt(e.p.at)} (${e.profile}${segs.length === 1 && Math.abs(segs[0][1] - segs[0][0] - (e.b - e.a)) < 1e-6 ? '' : `, ${r1(segs.reduce((n, s) => n + s[1] - s[0], 0))} of ${r1(e.b - e.a)}`})`);
        warn('region-edge', [...new Set(exposed.map((x) => x.e.p))], `${exposed.length} region edge${exposed.length === 1 ? '' : 's'} show the slabs' dirt skirts: ${list.join('; ')}.`, `line them with seam walls (${named('seam-wall:64', 'a seam wall')}, say), or add tiles beyond them`);
    }
    for (const w of walls) {
        if (!used.has(w.i)) {
            const inside = tiles.some((t) => { const f = foot(t); return w.at[0] > f.x0 + 1e-6 && w.at[0] < f.x1 - 1e-6 && w.at[2] > f.z0 + 1e-6 && w.at[2] < f.z1 - 1e-6; });
            warn('wall-off-seam', [w], `${where(w)} stands on no tile edge${inside ? ' (it is inside a tile)' : ''}: walls stand on seams and region edges, their centre line on the edge.`, 'move it onto an edge, turned to lie along it');
        }
    }
    for (const p of decor) {
        const host = tiles.find((t) => { const f = foot(t); return p.at[0] + 0.5 >= f.x0 && p.at[0] + 0.5 <= f.x1 && p.at[2] + 0.5 >= f.z0 && p.at[2] + 0.5 <= f.z1; });
        if (!host) {
            warn('decor-outside', [p], `${where(p)} stands on no tile.`, 'move it onto a tile');
            continue;
        }
        const ground = surfacesAt(lib, host, p.at[0] + 0.5, p.at[2] + 0.5)[0];
        if (ground === undefined)
            continue;
        const origin = p.at[1] + 0.5;
        if (Math.abs(origin - ground) > 1)
            warn(origin > ground ? 'decor-floating' : 'decor-sunk', [p], `${where(p)} stands ${r1(Math.abs(origin - ground))} ${origin > ground ? 'above' : 'below'} the ground of ${where(host)} there (the ground is at ${r1(ground)}).`, `place it at y ${Math.round(ground - 0.5)}`);
    }
}
const OPP_SIDE = { px: 'nx', nx: 'px', pz: 'nz', nz: 'pz' };
const sideFace = (s) => (s === 'px' ? '+x' : s === 'nx' ? '-x' : s === 'pz' ? '+z' : '-z');
// ---------- both kits ----------
const SOLID = (p) => p.entry.constrain === 'all' || p.entry.constrain === 'opaque';
function checkOverlaps(placed, warn) {
    // Free-standing things (props, decor, ruins) against each other and against walls: tiles, plugs and inserts are checked by the kit rules.
    const free = placed.filter((p) => ['prop', 'decor', 'ruin', 'chest-look'].includes(p.entry.kind) && SOLID(p));
    const walls = placed.filter((p) => p.entry.wall);
    const hit = (a, b) => [0, 1, 2].every((k) => Math.min(a.hi[k], b.hi[k]) - Math.max(a.lo[k], b.lo[k]) > 0.05);
    for (let i = 0; i < free.length; i++)
        for (let j = i + 1; j < free.length; j++)
            if (hit(free[i], free[j]))
                warn('overlap', [free[i], free[j]], `${where(free[i])} and ${where(free[j])} overlap (their boxes cross).`, 'move one of them apart');
    for (const f of free)
        for (const w of walls)
            if (hit(f, w))
                warn('overlap', [f, w], `${where(f)} runs into ${where(w)}.`, 'move it off the wall');
}
function checkBags(placed, input, err, warn) {
    const lo = [0, 1, 2].map((a) => Math.min(...placed.map((p) => p.lo[a])));
    const hi = [0, 1, 2].map((a) => Math.max(...placed.map((p) => p.hi[a])));
    // The smallest height whose aligned cube can hold the whole layout, and where its origin may sit in that cube.
    let need = -1;
    for (let h = 0; h <= 16; h++) {
        const side = 2 ** h;
        const r = [0, 1, 2].map((a) => [Math.ceil(-lo[a] - 1e-9), Math.floor(side - hi[a] + 1e-9)]);
        if (r.every(([a, b]) => a <= b)) {
            need = h;
            break;
        }
    }
    const height = input.height;
    const bag = { box: { min: lo.map(r1), max: hi.map(r1) }, fitsOneBagAt: need >= 0 ? need : null };
    // Inline bytes per bag: pieces at or under 16,384 bytes travel inside the bag, larger ones by reference.
    const inline = placed.filter((p) => p.entry.bytes <= 16_384).reduce((n, p) => n + p.entry.bytes, 0);
    const estimate = Math.round(inline * 1.4 + placed.length * 450 + 600);
    bag.inlineBytesEstimate = estimate;
    if (estimate > 64_000)
        warn('bag-size', [], `If every piece goes in one bag, it carries about ${Math.round(estimate / 1000)} KB inline (pieces under 16 KB travel inside the bag): relays with a 64 KB limit refuse it, and the strictest ONOSENDAI relay takes about 128 KB.`, 'hide part of the build at another height, or in the next cube, so it splits across bags');
    if (!input.origin) {
        if (need < 0) {
            err('too-big', [], `The layout spans ${fmt(sub(hi, lo))} gibsons: no bag holds it in one cube (height 16 at most).`, 'build it in parts, each with its own bag');
            return { ...bag, text: 'Bags: too large for one.' };
        }
        if (height !== undefined && height < need)
            err('bag-too-small', [], `At height ${height} no cube holds the whole layout (it spans ${fmt(sub(hi, lo))} gibsons); it needs height ${need}.`, `hide everything at height ${need} or more`);
        const h = Math.max(need, height ?? need);
        const side = 2 ** h;
        let r = [0, 1, 2].map((a) => [Math.ceil(-lo[a] - 1e-9), Math.floor(side - hi[a] + 1e-9)]);
        // Pieces with heights of their own (a room behind a door, say) must also fit their own cubes: search the origin's place
        // modulo the largest cube, axis by axis, for the offsets where every piece fits its cube.
        const own = placed.filter((p) => p.height !== undefined && p.height !== h);
        if (own.length) {
            const top = Math.max(h, ...own.map((p) => p.height));
            const big = 2 ** top;
            r = [];
            for (let a = 0; a < 3; a++) {
                let found = null;
                for (let off = 0; off < big && !found; off++) {
                    const ok = (o) => placed.every((p) => {
                        const hs = 2 ** (p.height ?? h);
                        const rel = (((o + p.at[a]) % hs) + hs) % hs;
                        return rel + (p.lo[a] - p.at[a]) >= -1e-9 && rel + (p.hi[a] - p.at[a]) <= hs + 1e-9;
                    });
                    if (ok(off)) {
                        let end = off;
                        while (end + 1 < big && ok(end + 1))
                            end++;
                        found = [off, end];
                    }
                }
                if (!found) {
                    err('bag-too-small', own, `No place for the origin lets every piece fit its own cube on ${'xyz'[a]} (the pieces with heights of their own and the rest at height ${h}).`, 'move those pieces, or give them another height');
                    return { ...bag, text: 'Bags: no origin fits every cube.' };
                }
                r.push(found);
            }
        }
        bag.height = h;
        bag.originOffsets = r;
        const mod = own.length ? 2 ** Math.max(h, ...own.map((p) => p.height)) : side;
        const text = `Bags: the whole layout fits one bag of height ${h} (${side} gibsons)${own.length ? `, and ${own.length} piece(s) their own cubes,` : ''} when its origin [0,0,0] sits ${r.map(([a, b], k) => `${'xyz'[k]} ${a} to ${b}`).join(', ')} gibsons from a cube's low corner (the coordinate mod ${mod}). Give origin (where you will build, from whereami) to check the real cubes.`;
        return { ...bag, text };
    }
    const o = input.origin;
    const fits = (p, h) => {
        const side = 2 ** h;
        const P = [o.x + BigInt(p.at[0]), o.y + BigInt(p.at[1]), o.z + BigInt(p.at[2])];
        const over = [];
        for (let a = 0; a < 3; a++) {
            const off = Number(P[a] - ((P[a] >> BigInt(h)) << BigInt(h)));
            const plo = off + (p.lo[a] - p.at[a]), phi = off + (p.hi[a] - p.at[a]);
            if (plo < -1e-6)
                over.push(`${r1(-plo)} past -${'xyz'[a]}`);
            if (phi > side + 1e-6)
                over.push(`${r1(phi - side)} past +${'xyz'[a]}`);
        }
        return over;
    };
    // With no height given: the lowest at which nothing is clipped where the layout really stands.
    let auto = need >= 0 ? need : 16;
    if (height === undefined)
        while (auto < 16 && placed.some((p) => p.height === undefined && fits(p, auto).length))
            auto++;
    const cubes = new Map();
    const clipped = [];
    for (const p of placed) {
        const h = p.height ?? height ?? auto;
        const side = 2 ** h;
        const P = [o.x + BigInt(p.at[0]), o.y + BigInt(p.at[1]), o.z + BigInt(p.at[2])];
        const base = P.map((v) => (v >> BigInt(h)) << BigInt(h));
        cubes.set(`${h}:${base.join(',')}`, (cubes.get(`${h}:${base.join(',')}`) ?? 0) + 1);
        const over = fits(p, h);
        if (over.length) {
            clipped.push(String(p.i));
            const fit = p.entry.bag.minHeight;
            err('clipped', [p], `${where(p)} sticks out of its height-${h} bag (${side} gibsons) by ${over.join(', ')}, so it is drawn cut off.`, auto > h ? `hide it at height ${auto} (nothing is clipped there)` : `move the layout so it sits inside one cube (check_layout without origin gives the offsets), or hide it higher (this piece alone needs height ${fit} or more, placed well inside the cube)`);
        }
    }
    bag.height = height ?? auto;
    bag.cubes = cubes.size;
    // When the real place forces a taller bag than the layout's size needs, say how far to move it to fit the smaller one.
    let shiftWords = '';
    if (height === undefined && need >= 0 && auto > need) {
        const side = 2 ** need;
        const shift = [o.x, o.y, o.z].map((v, a) => {
            const off = Number(((v % BigInt(side)) + BigInt(side)) % BigInt(side));
            const [lo0, hi0] = [Math.ceil(-lo[a] - 1e-9), Math.floor(side - hi[a] + 1e-9)];
            return off < lo0 ? lo0 - off : off > hi0 ? hi0 - off : 0;
        });
        bag.shiftForHeight = { height: need, by: shift };
        shiftWords = ` Here it needs height ${auto}; moved by [${shift.join(', ')}] (add that to the origin, or to every placement) the whole layout fits one bag of height ${need}.`;
    }
    const text = `Bags: height ${height ?? auto}, ${cubes.size} cube${cubes.size === 1 ? '' : 's'} at origin ${[o.x, o.y, o.z].join(', ')}${clipped.length ? `; ${clipped.length} placement(s) clipped` : '; nothing clipped'}.${cubes.size > 1 ? ' Pieces in different cubes go in different bags, each with its own key.' : ''}${shiftWords}`;
    return { ...bag, text };
}
/**
 * The whole layout as one object to draw (render's layout): every piece
 * turned, scaled and moved to its place, in gibsons from the layout origin
 * (unit 0), each face in its own colour. With cut, faces reaching above that
 * height (gibsons from the origin) are left out, so a top view looks into
 * enclosed rooms like a floor plan.
 */
export function layoutModel(lib, placed, cut) {
    const vertices = [];
    const faces = [];
    // A colour per face: the piece's own face colour, or its first corner's (kept per face rather than expanded, so a big layout stays under render's vertex cap).
    const facecolors = [];
    let reach = 1;
    for (const p of placed) {
        const v = validateSnoPayload(lib.payload(p.entry));
        if (!v.ok || v.shard.mode !== 'solid')
            continue;
        const shard = turnModel(v.shard, p.q);
        const per = 2 ** (v.shard.unit + p.s);
        const pts = shard.vertices.map((x) => { const t = ticksOf(x); return [t[0] * per + p.at[0] * 120, t[1] * per + p.at[1] * 120, t[2] * per + p.at[2] * 120]; });
        const base = vertices.length;
        pts.forEach((t, n) => { vertices.push(vertexAt(t, shard.vertices[n].c)); reach = Math.max(reach, ...t.map((c) => Math.ceil(Math.abs(c) / 120))); });
        shard.faces.forEach((f, i) => {
            if (cut !== undefined && f.some((n) => pts[n][1] / 120 > cut))
                return;
            faces.push([f[0] + base, f[1] + base, f[2] + base]);
            facecolors.push(shard.facecolors?.[i] ?? shard.vertices[f[0]].c);
        });
    }
    return { id: 'layout', name: 'layout preview', unit: 0, extent: reach, mode: 'solid', vertices, faces, facecolors, up: false, spin: 0 };
}
//# sourceMappingURL=layout.js.map