// install.ts: `cyberspace-mcp kits add | list | remove`. A kit arrives as a
// zip (docs/kits.md, format cyberspace-kit-1):
//
//   kit.json      the manifest: the kit's name and title, its rules, and what
//                 each piece is (kind, openings or edge profiles, role, tags...)
//   GUIDE.md      optional: the kit's own building rules, served to the agent
//                 as the resource cyberspace://kits.md while it is installed
//   briefs/*.json optional: build briefs for the kit eval
//   **/*.json     the pieces' SNO payloads, in folders, as a workshop zip
//                 holds them; a piece's id is its path without .json
//
// `add` unpacks it into the kits directory as <kits>/<kit>/ (pieces/,
// catalog.json, GUIDE.md, briefs/), building the catalog from the manifest
// and measuring every payload itself: its bytes, its counts, its bounds and
// the bag height it needs are never taken on trust. It writes the new folder
// beside the old one and swaps it in, so a running server never reads half a
// kit, and it only ever replaces a folder it wrote. Local only: nothing is
// fetched, published or sent.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { ticksOf } from 'sno-core/shards';
import { validateSnoPayload } from '../sno.js';
import { CATALOG_FORMAT, KitError } from './library.js';
import { readZip } from './zip.js';
export const MANIFEST_FORMAT = 'cyberspace-kit-1';
const KIT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The fields a manifest may give a piece; everything measurable is measured instead. */
const PIECE_FIELDS = ['name', 'kind', 'set', 'group', 'tags', 'notes', 'blurb', 'origin', 'role', 'cells', 'footprint', 'levels', 'openings', 'floorSeals', 'plug', 'reducer', 'host', 'cap', 'mount', 'size', 'closes', 'decorGroup', 'edges', 'base', 'step', 'wall', 'solid', 'sink'];
/** The smallest bag height whose aligned cube can hold a shape drawn from a gibson's centre, and where its point may sit (ONOSENDAI deployFit). */
export function bagFit(min, max) {
    for (let h = 0; h <= 16; h++) {
        const side = 2 ** h;
        const offsets = [];
        let ok = true;
        for (let k = 0; k < 3; k++) {
            const lo = Math.ceil(-0.5 - min[k] - 1e-9), hi = Math.floor(side - 0.5 - max[k] + 1e-9);
            if (lo > hi) {
                ok = false;
                break;
            }
            offsets.push([lo, hi]);
        }
        if (ok) {
            const same = offsets.every((o) => o[0] === offsets[0][0] && o[1] === offsets[0][1]);
            const where = same ? `${offsets[0][0]} to ${offsets[0][1]}` : `x ${offsets[0][0]}-${offsets[0][1]}, y ${offsets[1][0]}-${offsets[1][1]}, z ${offsets[2][0]}-${offsets[2][1]}`;
            return { minHeight: h, offsets, note: `needs a bag of height ${h} or more (${side} gibsons); at height ${h} its point must be ${where} gibsons from the cube's low corner on each axis, or it is clipped` };
        }
    }
    return { minHeight: 17, offsets: [], note: 'larger than any bag a hide can make (height 16)' };
}
const round = (x) => Math.round(x * 1000) / 1000;
/** Unpack a kit zip into the kits directory. Throws a KitError in words. */
export function installKit(zipFile, kitsDir, now = new Date()) {
    const entries = readZip(zipFile);
    const manifestEntry = entries.find((e) => e.name === 'kit.json');
    if (!manifestEntry)
        throw new KitError(`${zipFile} has no kit.json at its top: it is a zip of pieces, not a kit (docs/kits.md says what a kit zip holds).`);
    let m;
    try {
        m = JSON.parse(manifestEntry.data.toString('utf8'));
    }
    catch {
        throw new KitError('kit.json is not JSON.');
    }
    if (m.format !== MANIFEST_FORMAT)
        throw new KitError(`kit.json says format ${JSON.stringify(m.format)}; this server reads ${MANIFEST_FORMAT}.`);
    if (typeof m.kit !== 'string' || !KIT_NAME.test(m.kit))
        throw new KitError('kit.json needs "kit": a name of lowercase letters, digits and dashes (at most 64), which is also its folder.');
    if (typeof m.title !== 'string' || !m.title.trim())
        throw new KitError('kit.json needs "title".');
    const declared = m.pieces && typeof m.pieces === 'object' ? m.pieces : {};
    const title = m.title.trim();
    const pieces = [];
    const skipped = [];
    const files = new Map();
    for (const e of entries) {
        if (e.name === 'kit.json' || e.name === 'GUIDE.md' || e.name.startsWith('briefs/') || !e.name.endsWith('.json'))
            continue;
        const id = e.name.replace(/\.json$/, '');
        let raw;
        try {
            raw = JSON.parse(e.data.toString('utf8'));
        }
        catch {
            skipped.push({ id, why: 'not JSON' });
            continue;
        }
        const v = validateSnoPayload(raw);
        if (!v.ok) {
            skipped.push({ id, why: `not valid SNO: ${v.errors[0]}` });
            continue;
        }
        if ((v.shard.parts?.length ?? 0) > 0) {
            skipped.push({ id, why: 'places other objects (parts); a kit piece is placed on its own' });
            continue;
        }
        const per = 2 ** v.shard.unit;
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (const x of v.shard.vertices) {
            const t = ticksOf(x);
            for (let k = 0; k < 3; k++) {
                min[k] = Math.min(min[k], (t[k] / 120) * per);
                max[k] = Math.max(max[k], (t[k] / 120) * per);
            }
        }
        if (!v.shard.vertices.length) {
            skipped.push({ id, why: 'has no vertices' });
            continue;
        }
        const segs = id.split('/');
        const inner = segs[0] === m.kit && segs.length > 1 ? segs.slice(1) : segs;
        const d = declared[id] ?? {};
        const bag = bagFit(min, max);
        const p = raw;
        const entry = {
            kit: m.kit, folder: m.kit, id, file: `pieces/${e.name}`,
            name: String(p.name ?? inner[inner.length - 1]).replace(new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*`, 'i'), ''),
            set: inner.length > 1 ? inner[0] : '', group: inner.slice(1, -1).join('/'), kind: 'piece',
            bytes: e.data.length, vertices: v.shard.vertices.length, faces: v.shard.faces.length, unit: v.shard.unit,
            bounds: { min: min.map(round), max: max.map(round) },
            constrain: typeof p.constrain === 'string' ? p.constrain : null,
            ...(typeof p.opacity === 'number' ? { opacity: p.opacity } : {}),
            bag, tags: [], notes: [],
        };
        for (const f of PIECE_FIELDS)
            if (d[f] !== undefined)
                entry[f] = d[f];
        entry.tags = Array.isArray(entry.tags) ? entry.tags.map(String) : [];
        entry.notes = [bag.note, ...(Array.isArray(entry.notes) ? entry.notes.map(String).filter((n) => n !== bag.note) : [])];
        pieces.push(entry);
        files.set(e.name, e.data);
    }
    if (!pieces.length)
        throw new KitError(`${zipFile} holds no piece this server can read.`);
    for (const id of Object.keys(declared))
        if (!files.has(`${id}.json`) && !skipped.some((s) => s.id === id))
            skipped.push({ id, why: 'declared in kit.json, but its payload is not in the zip' });
    const catalog = {
        format: CATALOG_FORMAT, kit: m.kit, title, generated: now.toISOString(),
        source: { ...(m.source ?? {}), zip: zipFile.split(sep).pop(), version: m.version },
        ...(m.notice ? { notice: m.notice } : {}),
        standard: { ...(m.standard ?? {}), ...(m.rules ? { rules: m.rules } : {}) },
        pieces, skipped,
    };
    const root = resolve(kitsDir);
    mkdirSync(root, { recursive: true });
    const finalDir = join(root, m.kit);
    const tmp = join(root, `.${m.kit}.tmp-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    for (const [name, data] of files) {
        const f = join(tmp, 'pieces', name);
        if (!resolve(f).startsWith(resolve(tmp) + sep))
            throw new KitError(`${name} would land outside the kit's folder.`);
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, data);
    }
    const guide = entries.find((e) => e.name === 'GUIDE.md');
    if (guide)
        writeFileSync(join(tmp, 'GUIDE.md'), guide.data);
    const briefs = entries.filter((e) => e.name.startsWith('briefs/') && e.name.endsWith('.json') && !e.name.slice(7).includes('/'));
    if (briefs.length) {
        mkdirSync(join(tmp, 'briefs'), { recursive: true });
        for (const b of briefs)
            writeFileSync(join(tmp, b.name), b.data);
    }
    writeFileSync(join(tmp, 'catalog.json'), JSON.stringify(catalog, null, 1) + '\n');
    let replaced = false;
    if (existsSync(finalDir)) {
        assertOurs(finalDir);
        const aside = join(root, `.${m.kit}.old-${process.pid}`);
        renameSync(finalDir, aside);
        renameSync(tmp, finalDir);
        rmSync(aside, { recursive: true, force: true });
        replaced = true;
    }
    else
        renameSync(tmp, finalDir);
    return { kit: m.kit, title, dir: finalDir, pieces: pieces.length, skipped, guide: !!guide, briefs: briefs.length, replaced };
}
/** Refuse to touch a folder that is not a kit this server installed. */
function assertOurs(dir) {
    const f = join(dir, 'catalog.json');
    let format;
    try {
        format = JSON.parse(readFileSync(f, 'utf8')).format;
    }
    catch {
        format = undefined;
    }
    if (format !== CATALOG_FORMAT)
        throw new KitError(`${dir} is not a kit folder this server wrote (no ${CATALOG_FORMAT} catalog.json); left as it is.`);
}
/** The kits in a directory: name, title, pieces, when installed. */
export function listKits(kitsDir) {
    let names;
    try {
        names = readdirSync(kitsDir);
    }
    catch {
        return [];
    }
    const out = [];
    for (const n of names.filter((x) => !x.startsWith('.')).sort()) {
        try {
            const c = JSON.parse(readFileSync(join(kitsDir, n, 'catalog.json'), 'utf8'));
            if (c.format !== CATALOG_FORMAT)
                continue;
            out.push({ kit: n, title: String(c.title ?? n), pieces: Array.isArray(c.pieces) ? c.pieces.length : 0, generated: String(c.generated ?? ''), guide: existsSync(join(kitsDir, n, 'GUIDE.md')) });
        }
        catch { /* not a kit */ }
    }
    return out;
}
/** Remove one installed kit's folder (only a folder this server wrote). */
export function removeKit(kitsDir, kit) {
    if (!KIT_NAME.test(kit))
        throw new KitError(`${JSON.stringify(kit)} is not a kit name.`);
    const dir = join(resolve(kitsDir), kit);
    if (!existsSync(dir))
        throw new KitError(`No kit ${kit} in ${kitsDir}.`);
    assertOurs(dir);
    rmSync(dir, { recursive: true, force: true });
    return dir;
}
//# sourceMappingURL=install.js.map