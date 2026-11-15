// tools.ts: what the kit tools answer (kit, kit_piece, check_layout, and the
// kit and layout options of place and render), kept out of agent.ts. Every
// function here is local: it reads the kit directory and computes; nothing is
// signed, published or sent. A KitError becomes the tool's refusal.
import { renderShard } from '../render.js';
import { Refusal } from '../tool.js';
import { KitError, overview, pieceLine, searchKits } from './library.js';
import { checkLayout, layoutModel, resolvePlacements } from './layout.js';
import { kitObject, quarters, scaleStep, turnY } from './transform.js';
/** Run a kit function, turning its KitError into a refusal. */
export function kitCall(fn) {
    try {
        return fn();
    }
    catch (err) {
        if (err instanceof KitError)
            throw new Refusal(err.message);
        throw err;
    }
}
const GUIDE = 'The resource cyberspace://kits.md is the guide to building with kits (the rules, the craft notes and worked examples): read it before your first kit build.';
/** kit: what is installed, or the pieces that fit a search. */
export function kitTool(lib, q) {
    return kitCall(() => {
        const filtered = Object.entries(q).some(([k, v]) => k !== 'limit' && v !== undefined && !(Array.isArray(v) && v.length === 0));
        if (!filtered) {
            const o = overview(lib);
            return {
                text: `Kits installed (local, for building; never publish a kit or a piece on its own):\n${o.text}\nSearch with text and filters (kit, set, group, kind, tags, opening, edge, max_bytes, max_bag_height); kit_piece gives one piece in full. ${GUIDE}`,
                data: { dir: lib.dir(), kits: o.kits },
            };
        }
        const r = searchKits(lib, q);
        const lines = r.pieces.map(pieceLine);
        return {
            text: r.total === 0
                ? 'No kit piece fits that search. Try fewer words or filters; kit with nothing lists what is installed.'
                : `${r.total} piece${r.total === 1 ? '' : 's'} fit${r.total > r.pieces.length ? `; the first ${r.pieces.length}` : ''}:\n${lines.join('\n')}`,
            data: { total: r.total, pieces: r.pieces.map(compact) },
        };
    });
}
/** The fields a list shows: enough to choose and place a piece. */
function compact(p) {
    const out = { id: p.id, name: p.name, kind: p.kind, set: p.set, group: p.group, bytes: p.bytes, bagHeight: p.bag.minHeight, tags: p.tags };
    for (const k of ['footprint', 'openings', 'edges', 'plug', 'reducer', 'closes', 'wall', 'mount', 'size'])
        if (p[k] !== undefined)
            out[k] = p[k];
    return out;
}
/** kit_piece: one piece in full, its kit's standard, and its payload when asked (turned and scaled as asked). */
export function kitPieceTool(lib, input) {
    return kitCall(() => {
        const entry = lib.get(input.piece);
        const catalog = lib.catalogOf(entry);
        const q = quarters(input.turn);
        const s = scaleStep(input.scale, entry.unit);
        const turnedOpenings = (entry.openings ?? []).map((o) => ({ ...o, worldFace: faceAfter(o.face, q) }));
        const lines = [
            pieceLine(entry),
            entry.blurb ? `What it is: ${entry.blurb}` : '',
            entry.origin ? `Origin: ${entry.origin}.` : '',
            `Bounds (its own frame, gibsons at scale 0): min ${entry.bounds.min.join(', ')}, max ${entry.bounds.max.join(', ')}.`,
            q && turnedOpenings.length ? `Turned ${q * 90}, its openings face: ${turnedOpenings.map((o) => `${o.face} -> ${o.worldFace} (${o.size})`).join(', ')}.` : '',
            entry.floorSeals?.length ? `Its floor seals a ceiling hatch below it: ${entry.floorSeals.map((f) => `cell ${f.cell.join(',')}: ${f.seals.join(', ') || 'none (use the recessed ceiling plug below)'}`).join('; ')} ("-x" names a long hatch lying along this piece's x).` : '',
            entry.wall ? `Wall centre line (own frame): ${entry.wall.segments.map(([a, b]) => `(${a.join(', ')}) to (${b.join(', ')})`).join(', ')}${entry.wall.low ? `; low side ${entry.wall.low}` : ''}.` : '',
            ...entry.notes.map((n) => `Note: ${n}.`),
            input.sno ? `Payload below${q || s ? ` (turned ${q * 90}, scale ${s})` : ''}, named "${entry.name}". To build with it, place it with kit: "${entry.id}" (and turn, scale) rather than pasting it.` : `Place it with place (kit: "${entry.id}", turn, scale, coordinate, height). sno: true returns its payload.`,
        ].filter(Boolean);
        const data = { piece: entry, standard: catalog.standard, kit: { kit: catalog.kit, title: catalog.title, generated: catalog.generated, commit: catalog.source?.commit } };
        if (input.sno)
            data.sno = kitObject(lib, entry.id, { turn: q * 90, scale: s }).payload;
        return { text: lines.join('\n'), data };
    });
}
const FACE_N = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
function faceAfter(face, q) {
    const n = turnY(FACE_N[face], q);
    return Object.entries(FACE_N).find(([, v]) => v.every((x, i) => x === n[i]))[0];
}
/** check_layout: the kits' rules over a planned build. */
export function checkLayoutTool(lib, input) {
    return kitCall(() => {
        const r = checkLayout(lib, input);
        return {
            text: `${r.text}\nLook at it with render (layout: the same placements; view "top" with cut 2 above a floor shows the rooms like a plan, "iso" the whole build).`,
            data: { ok: r.ok, errors: r.errors, warnings: r.warnings, counts: r.counts, bag: r.bag },
        };
    });
}
/** render's kit option: one kit piece as it would be placed. */
export function kitShard(lib, input) {
    return kitCall(() => {
        const k = kitObject(lib, input.kit, { turn: input.turn, scale: input.scale });
        return { shard: k.shard, source: `kit piece ${k.entry.id}${k.turn ? ` turned ${k.turn}` : ''}${k.scale ? ` scale ${k.scale}` : ''}` };
    });
}
/** render's layout option: the planned build as one picture. */
export function renderLayout(lib, input) {
    return kitCall(() => {
        const placed = resolvePlacements(lib, { placements: input.layout });
        const shard = layoutModel(lib, placed, input.cut);
        if (shard.faces.length === 0)
            throw new KitError(input.cut !== undefined ? `Nothing is left below the cut at ${input.cut}: cut higher (gibsons above the layout origin).` : 'The layout has no faces to draw.');
        let r;
        try {
            r = renderShard(shard, { view: input.view, yaw: input.yaw, pitch: input.pitch, size: input.size });
        }
        catch (err) {
            throw new KitError(err instanceof Error ? err.message : String(err));
        }
        return {
            text: `The layout, ${placed.length} placements${input.cut !== undefined ? `, cut at ${input.cut} above the origin` : ''}: ${r.caption} Units are gibsons from the layout origin. Directions: the red arrow is world +x; the blue arrow is the SNO wire frame's +Z, which is world -z, so world +z points away from it (in the top view, +x is right and +z is up the picture).`,
            images: [{ data: r.png.toString('base64'), mimeType: 'image/png' }],
            data: { placements: placed.length, vertices: r.vertices, faces: r.faces, bounds: r.bounds, view: r.view, size: r.size, cut: input.cut ?? null, pngBytes: r.png.length, ms: Math.round(r.ms) },
        };
    });
}
/**
 * Whether a payload is a kit piece as the kit ships it, or a turned or scaled
 * copy of one: its name is a kit's ("Maze Kit: ...") or a piece's own name,
 * with that piece's vertex and face counts. Publishing one on its own (as a
 * public object or an avatar) is refused: kits are never published
 * (arkinox, 2026-11-15). Null when it is not one, or no kits are installed.
 */
export function kitPieceIn(lib, shard) {
    const name = shard.name.trim();
    if (/^(maze|landscape) kit\s*:/i.test(name))
        return name;
    if (!lib.dir())
        return null;
    try {
        const hit = lib.entries().find((e) => e.name === name && e.vertices === shard.vertices.length && e.faces === shard.faces.length);
        return hit ? hit.id : null;
    }
    catch {
        return null;
    }
}
export const KIT_PUBLISH_REFUSAL = 'is a kit piece. Kits are never published, as a whole or one piece on its own (your human\'s rule): build with a piece by placing it (place with kit), and publish only what you made yourself.';
/** Why a kit piece placed at this gibson and height is clipped by its bag's cube, or null when it fits (ONOSENDAI deployFit.ts). */
export function clipWords(entry, turn, scale, at, height) {
    const q = quarters(turn);
    const k = 2 ** scaleStep(scale, entry.unit);
    const corners = [];
    for (const x of [entry.bounds.min[0], entry.bounds.max[0]])
        for (const y of [entry.bounds.min[1], entry.bounds.max[1]])
            for (const z of [entry.bounds.min[2], entry.bounds.max[2]])
                corners.push(turnY([x * k, y * k, z * k], q));
    const side = 2 ** height;
    const over = [];
    const P = [at.x, at.y, at.z];
    for (let a = 0; a < 3; a++) {
        const off = Number(P[a] - ((P[a] >> BigInt(height)) << BigInt(height)));
        const lo = off + 0.5 + Math.min(...corners.map((c) => c[a])), hi = off + 0.5 + Math.max(...corners.map((c) => c[a]));
        if (lo < -1e-6)
            over.push(`${Math.round(-lo * 10) / 10} past -${'xyz'[a]}`);
        if (hi > side + 1e-6)
            over.push(`${Math.round((hi - side) * 10) / 10} past +${'xyz'[a]}`);
    }
    return over.length ? `${entry.id} would stick out of its height-${height} cube (${side} gibsons) by ${over.join(', ')}, so it would be drawn cut off. ${entry.bag.note}. Check the whole build with check_layout (give origin) for the height and place that fit.` : null;
}
//# sourceMappingURL=tools.js.map