// library.ts: the kits an operator copied onto this machine, read from a
// local directory (arkinox, 2026-11-15: "dont publish the kits ever. can we
// just copy them to a directory for xor to use"). Nothing here downloads,
// publishes or sends a kit: a kit is local data, one folder per kit, each
// with a catalog.json (format cyberspace-kit-catalog-1, docs/kits.md) and its
// pieces' SNO payloads as files beside it. The kits' own repositories write
// these folders (each kit's own export script).
//
// Where: the kitsDir setting (config.json "kitsDir", --kits-dir), else the
// first of <state>/kits and <state>/../kits that holds a catalog. With none,
// every kit tool says that no kits are installed and where it looked.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
export const CATALOG_FORMAT = 'cyberspace-kit-catalog-1';
/** A refusal-shaped error: the kit tools turn it into the tool's refusal. */
export class KitError extends Error {
}
/** Where kits are looked for, in order: the setting alone when it is given, else <state>/kits and <state>/../kits. */
export function kitsDirCandidates(stateDir, kitsDir) {
    if (kitsDir)
        return [resolve(kitsDir)];
    return [join(resolve(stateDir), 'kits'), join(dirname(resolve(stateDir)), 'kits')];
}
/** The kits in one directory, read once and again whenever a catalog file changes. */
export class KitLibrary {
    candidates;
    loaded = null;
    constructor(candidates) {
        this.candidates = candidates;
    }
    /** The directory the kits are read from, or null when none of the candidates holds one. */
    dir() {
        for (const d of this.candidates) {
            if (catalogFiles(d).length)
                return d;
        }
        return null;
    }
    /** The sentence for a server with no kits. */
    noKits() {
        return `No kits are installed on this server: no <kit>/catalog.json in ${this.candidates.join(' or ')}. Kits are local data your human copies onto this machine (docs/kits.md says how); nothing here can download one. Build from your own objects instead.`;
    }
    load() {
        const dir = this.dir();
        if (!dir)
            throw new KitError(this.noKits());
        const files = catalogFiles(dir);
        const stamp = files.map((f) => `${f}:${statSync(f).mtimeMs}`).join('|');
        if (this.loaded && this.loaded.dir === dir && this.loaded.stamp === stamp)
            return this.loaded;
        const catalogs = [];
        const byId = new Map();
        for (const f of files) {
            let c;
            try {
                c = JSON.parse(readFileSync(f, 'utf8'));
            }
            catch {
                continue;
            }
            if (c.format !== CATALOG_FORMAT || !Array.isArray(c.pieces))
                continue;
            const folder = f.split(sep).slice(-2)[0];
            // The catalog names its kit; the folder is only where it lives (a kit copied to another folder keeps its rules).
            c.folder = folder;
            c.kit = typeof c.kit === 'string' && c.kit ? c.kit : folder;
            for (const p of c.pieces) {
                p.kit = c.kit;
                p.folder = folder;
                p.tags ??= [];
                p.notes ??= [];
                byId.set(p.id, p);
            }
            catalogs.push(c);
        }
        if (!catalogs.length)
            throw new KitError(`${this.noKits()} (${dir} has catalogs, but none in the format ${CATALOG_FORMAT}.)`);
        this.loaded = { dir, stamp, catalogs, byId };
        return this.loaded;
    }
    catalogs() {
        return this.load().catalogs;
    }
    entries() {
        return this.load().catalogs.flatMap((c) => c.pieces);
    }
    /** The rules of a piece's kit, or null for a kit whose catalog gives none (check_layout then checks only overlaps and bags). */
    rulesOf(entry) {
        const r = this.catalogOf(entry).standard?.rules;
        return r && (r.family === 'rooms' || r.family === 'terrain') && typeof r.tile === 'number' ? r : null;
    }
    /** The piece that does a standard job in a kit (its catalog's role), preferring the given kit; null when none does. */
    byRole(role, kit) {
        const all = this.entries().filter((e) => e.role === role);
        return all.find((e) => e.kit === kit) ?? all[0] ?? null;
    }
    /** Each installed kit's own guide (its GUIDE.md), for the resource cyberspace://kits.md. */
    guides() {
        const dir = this.dir();
        if (!dir)
            return [];
        const out = [];
        for (const c of this.catalogs()) {
            try {
                out.push({ kit: c.kit, title: c.title, text: readFileSync(join(dir, c.folder, 'GUIDE.md'), 'utf8') });
            }
            catch { /* a kit without a guide */ }
        }
        return out;
    }
    /** The kits' titles, as their pieces' names start in the zips ("<title>: ..."). */
    titles() {
        return this.catalogs().map((c) => c.title).filter((t) => typeof t === 'string' && t.length > 0);
    }
    catalogOf(entry) {
        return this.load().catalogs.find((c) => c.folder === entry.folder);
    }
    /**
     * One piece by its id (<kit>/<set>/<folder>/<piece>), or by the end of its
     * id when only one piece ends that way (<folder>/<piece>, <piece>). Refused with the candidates when it fits several.
     */
    get(name) {
        const { byId } = this.load();
        const q = String(name ?? '').trim().replace(/\.json$/, '').replace(/^\/+/, '');
        if (!q)
            throw new KitError('Name a kit piece: its id as kit lists it.');
        const exact = byId.get(q);
        if (exact)
            return exact;
        const hits = [...byId.values()].filter((p) => p.id.endsWith(`/${q}`));
        if (hits.length === 1)
            return hits[0];
        if (hits.length > 1)
            throw new KitError(`"${q}" fits ${hits.length} pieces: ${hits.slice(0, 8).map((p) => p.id).join(', ')}${hits.length > 8 ? ', ...' : ''}. Give the whole id.`);
        const loose = [...byId.values()].filter((p) => p.id.includes(q) || p.name.toLowerCase() === q.toLowerCase());
        throw new KitError(`No kit piece "${q}".${loose.length ? ` Close: ${loose.slice(0, 8).map((p) => p.id).join(', ')}.` : ' Search with kit.'}`);
    }
    /**
     * Every piece's shape fingerprint (shapeKey), read once per catalog: what a
     * turned, scaled or renamed copy still has, so a kit piece published on its
     * own is known whatever it is called.
     */
    shapes() {
        const l = this.load();
        if (l.shapes)
            return l.shapes;
        const shapes = new Map();
        for (const e of l.byId.values()) {
            try {
                const raw = this.payload(e);
                if (Array.isArray(raw.vertices) && Array.isArray(raw.faces))
                    shapes.set(shapeKey(raw.vertices.length, raw.faces), e.id);
            }
            catch { /* a missing payload is said when it is used */ }
        }
        l.shapes = shapes;
        return shapes;
    }
    /** A piece's payload as the kit holds it, parsed. */
    payload(entry) {
        const { dir } = this.load();
        const root = resolve(dir, entry.folder);
        const file = resolve(root, entry.file);
        if (!file.startsWith(root + sep))
            throw new KitError(`${entry.id}: its file is outside its kit's folder.`);
        if (!existsSync(file))
            throw new KitError(`${entry.id}: its payload ${file} is missing; your human should refresh the kit (docs/kits.md).`);
        try {
            return JSON.parse(readFileSync(file, 'utf8'));
        }
        catch {
            throw new KitError(`${entry.id}: its payload is not JSON.`);
        }
    }
}
function catalogFiles(dir) {
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return [];
    }
    return names.filter((n) => !n.startsWith('.')).map((n) => join(dir, n, 'catalog.json')).filter((f) => existsSync(f)).sort();
}
const words = (s) => s.toLowerCase().split(/[^a-z0-9+\-.]+/).filter(Boolean);
export function searchKits(lib, q) {
    const want = q.text ? words(q.text) : [];
    const scored = [];
    for (const p of lib.entries()) {
        if (q.kit && p.kit !== q.kit)
            continue;
        if (q.set && p.set !== q.set)
            continue;
        if (q.group && !(p.group === q.group || p.group.startsWith(`${q.group}/`)))
            continue;
        if (q.kind && p.kind !== q.kind)
            continue;
        if (q.tags?.length && !q.tags.every((t) => p.tags.includes(t)))
            continue;
        if (q.opening && !(p.openings ?? []).some((o) => o.size === q.opening) && p.plug?.size !== q.opening && p.closes !== q.opening && p.reducer?.from !== q.opening && p.reducer?.to !== q.opening)
            continue;
        if (q.edge && !Object.values(p.edges ?? {}).includes(q.edge))
            continue;
        if (q.max_bytes !== undefined && p.bytes > q.max_bytes)
            continue;
        if (q.max_bag_height !== undefined && p.bag.minHeight > q.max_bag_height)
            continue;
        let score = 0;
        let all = true;
        for (const w of want) {
            let s = 0;
            if (p.tags.includes(w))
                s += 4;
            if (p.id.toLowerCase().includes(w))
                s += 3;
            if (p.name.toLowerCase().includes(w))
                s += 3;
            if (p.kind === w)
                s += 3;
            if ((p.blurb ?? '').toLowerCase().includes(w))
                s += 1;
            if (!s) {
                all = false;
                break;
            }
            score += s;
        }
        if (!all)
            continue;
        scored.push({ p, score });
    }
    scored.sort((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id));
    const limit = Math.max(1, Math.min(100, q.limit ?? 20));
    return { total: scored.length, pieces: scored.slice(0, limit).map((s) => s.p) };
}
/** One line of a piece for a list: what it is, its size and how it connects. */
export function pieceLine(p) {
    const parts = [`${p.id} (${p.kind}) "${p.name}"`];
    if (p.footprint)
        parts.push(p.footprint.join(' x '));
    else {
        const d = [0, 1, 2].map((k) => Math.round((p.bounds.max[k] - p.bounds.min[k]) * 10) / 10);
        parts.push(`${d.join(' x ')} gibsons`);
    }
    if (p.openings?.length)
        parts.push(`openings ${p.openings.map((o) => `${o.face} ${o.size}${o.cell.some((c) => c !== 0) ? `@${o.cell.join(',')}` : ''}`).join(', ')}`);
    if (p.edges)
        parts.push(`edges px ${p.edges.px}, nx ${p.edges.nx}, pz ${p.edges.pz}, nz ${p.edges.nz}`);
    if (p.plug)
        parts.push(`seals a ${p.plug.side} ${p.plug.size}`);
    if (p.reducer)
        parts.push(`${p.reducer.side} reducer ${p.reducer.from} to ${p.reducer.to}`);
    if (p.closes)
        parts.push(`closes a ${p.closes}`);
    if (p.wall)
        parts.push(`${p.wall.kind} wall ${p.wall.length} long, ${p.wall.height} high`);
    if (p.mount && p.kind !== 'tile')
        parts.push(`${p.mount} mount`);
    parts.push(`${p.bytes} bytes, bag height ${p.bag.minHeight}+`);
    if (p.tags.length)
        parts.push(`tags ${p.tags.join(' ')}`);
    return parts.join('; ');
}
/** What is installed, in a few lines: each kit, its sets, and how many pieces of each kind. */
export function overview(lib) {
    const kits = lib.catalogs().map((c) => {
        const sets = {};
        const kinds = {};
        for (const p of c.pieces) {
            sets[p.set] = (sets[p.set] ?? 0) + 1;
            kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
        }
        return { kit: c.kit, title: c.title, pieces: c.pieces.length, sets, kinds, generated: c.generated, commit: c.source?.commit };
    });
    const text = kits.map((k) => `${k.kit} (${k.title}): ${k.pieces} pieces. Sets: ${Object.entries(k.sets).map(([s, n]) => `${s} ${n}`).join(', ')}. Kinds: ${Object.entries(k.kinds).map(([s, n]) => `${s} ${n}`).join(', ')}.`).join('\n');
    return { text, kits };
}
/** A shape's fingerprint: its vertex count and its faces, which a quarter turn, a scale or a new name never change. */
export function shapeKey(vertexCount, faces) {
    return createHash('sha256').update(`${vertexCount}|${JSON.stringify(faces)}`).digest('hex');
}
//# sourceMappingURL=library.js.map