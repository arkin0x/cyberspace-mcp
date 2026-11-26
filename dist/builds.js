// builds.ts: which build each thing the agent placed belongs to, in local
// state only (arkinox, 2026-11-26, after "delete the obstacle run"
// took a 31-piece castle that shared an h9 bag with it: "build labels,
// memory notes, backup-before-delete, scoped deletes").
//
// A build is a label a human would say ("obstacle run"), the agent's
// notes on it, and its pieces: each thing placed under it, where, and its
// ids. place and hide record a piece under the build they are given, else
// under the current build (build_use), else under "unlabelled"; move_placed
// and constrain_placed follow a piece to its new id; a delete marks it
// removed and names the trash entry that holds its backup. Things placed
// before this ledger existed are in no build, and group as "unlabelled".
//
// The label lives ONLY here, in <state>/builds.json (mode 600). Nothing of
// it is ever published: v2 content is sealed to its place, and a public tag
// naming the build would tell anyone what is hidden where.
import { randomBytes } from 'node:crypto';
import { Refusal } from './tool.js';
import { withoutTokens } from './trash.js';
const FILE = 'builds.json';
/** The group of everything placed under no build, and of what was placed before the ledger. */
export const UNLABELLED = 'unlabelled';
/** The longest label kept. */
export const MAX_BUILD_LABEL = 80;
/** The longest notes one build keeps, in characters. */
export const MAX_BUILD_NOTES = 8000;
/** A label as kept: trimmed, single spaces, at most MAX_BUILD_LABEL characters. */
export function cleanLabel(raw) {
    return String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_BUILD_LABEL);
}
/** The group key of a label: labels match case-insensitively. */
export function groupKey(label) {
    return cleanLabel(label).toLowerCase();
}
/** The build ledger in <state>/builds.json: read once, written whole on every change. */
/** A piece as the ledger keeps it: a message's first words may start a Cashu token, blanked as the trash blanks it (review of 485a2df). */
function safe(piece) {
    return { ...piece, label: withoutTokens(piece.label).text };
}
export class Builds {
    dir;
    now;
    state;
    constructor(dir, now = () => Math.floor(Date.now() / 1000)) {
        this.dir = dir;
        this.now = now;
        const saved = dir.readJson(FILE, null);
        this.state = saved?.version === 1 && Array.isArray(saved.builds) ? { version: 1, current: saved.current ?? null, builds: saved.builds.map((b) => ({ ...b, pieces: (b.pieces ?? []).map(safe) })) } : { version: 1, current: null, builds: [] };
    }
    save() {
        this.dir.writeJson(FILE, this.state);
    }
    /** Every build, oldest first. */
    all() {
        return this.state.builds;
    }
    /** The build later placements go to when they name none, or null. */
    current() {
        return this.state.builds.find((b) => b.id === this.state.current) ?? null;
    }
    /** A build by its id or its label (case does not matter), or null. */
    find(given) {
        const g = cleanLabel(given);
        if (!g)
            return null;
        return this.state.builds.find((b) => b.id === g.toLowerCase()) ?? this.state.builds.find((b) => groupKey(b.label) === groupKey(g)) ?? null;
    }
    /** A build by id or label, or a Refusal naming the builds there are. */
    get(given) {
        const b = this.find(given);
        if (b)
            return b;
        const names = this.state.builds.map((x) => `"${x.label}"`).slice(0, 20).join(', ');
        throw new Refusal(`No build is called "${cleanLabel(given)}"${names ? `. Your builds: ${names}` : ': you have no builds yet'}. builds lists them.`);
    }
    /** The build a label names, made when there is none. */
    ensure(label) {
        const clean = cleanLabel(label);
        if (!clean)
            throw new Refusal('A build label is a few words, not empty.');
        const found = this.find(clean);
        if (found)
            return found;
        const t = this.now();
        const used = new Set(this.state.builds.map((b) => b.id));
        let id;
        do {
            id = randomBytes(4).toString('hex');
        } while (used.has(id));
        const b = { id, label: clean, notes: '', createdAt: t, updatedAt: t, pieces: [] };
        this.state.builds.push(b);
        return b;
    }
    /** The build a placement goes to: the one it names, else the current build, else "unlabelled". */
    target(label) {
        const given = cleanLabel(label);
        return given || this.current()?.label || UNLABELLED;
    }
    /** Record a piece just placed, under `label` (or the current build, or "unlabelled"). Returns the build. */
    record(label, piece) {
        const b = this.ensure(this.target(label));
        b.pieces = b.pieces.filter((p) => !(p.id === piece.id && p.lookupId === piece.lookupId && !p.removedAt));
        b.pieces.push(safe(piece));
        b.updatedAt = this.now();
        this.save();
        return b;
    }
    /**
     * The build a thing in a bag belongs to: the build with a piece still
     * there by this id, else by this lineage when exactly one piece has it
     * (a piece moved or written again by another client keeps its lineage).
     * Null for a thing the ledger never recorded.
     */
    buildOf(thing) {
        for (const b of this.state.builds)
            if (b.pieces.some((p) => !p.removedAt && p.id === thing.id))
                return b;
        if (!thing.lineage)
            return null;
        const hits = this.state.builds.flatMap((b) => b.pieces.filter((p) => !p.removedAt && p.lineage === thing.lineage).map(() => b));
        return hits.length === 1 ? hits[0] : null;
    }
    /** The piece record a thing matches (by id, else by a unique lineage), or null. */
    pieceOf(thing) {
        for (const b of this.state.builds) {
            const p = b.pieces.find((x) => !x.removedAt && x.id === thing.id);
            if (p)
                return { build: b, piece: p };
        }
        if (!thing.lineage)
            return null;
        const hits = this.state.builds.flatMap((b) => b.pieces.filter((p) => !p.removedAt && p.lineage === thing.lineage).map((piece) => ({ build: b, piece })));
        return hits.length === 1 ? hits[0] : null;
    }
    /** A piece moved (move_placed): the new id replaces the old, its lineage kept, its place updated. A thing in no build is left alone. */
    moved(from, to) {
        const hit = this.pieceOf(from);
        if (!hit)
            return;
        const t = this.now();
        Object.assign(hit.piece, { id: to.id, lineage: to.lineage ?? hit.piece.lineage, lookupId: to.lookupId, height: to.height, at: to.at, plane: to.plane, changedAt: t });
        hit.build.updatedAt = t;
        this.save();
    }
    /** Pieces written again where they stand (constrain_placed): each old id replaced by its new one. */
    replaced(changes) {
        const t = this.now();
        let any = false;
        for (const c of changes) {
            const hit = this.pieceOf(c.from);
            if (!hit)
                continue;
            hit.piece.id = c.id;
            hit.piece.changedAt = t;
            hit.build.updatedAt = t;
            any = true;
        }
        if (any)
            this.save();
    }
    /** Pieces removed: marked so (never forgotten), each naming the trash entry that holds its backup. */
    removed(things, trashId) {
        const t = this.now();
        let any = false;
        for (const thing of things) {
            const hit = this.pieceOf(thing);
            if (!hit)
                continue;
            hit.piece.removedAt = t;
            if (trashId)
                hit.piece.trashId = trashId;
            hit.build.updatedAt = t;
            any = true;
        }
        if (any)
            this.save();
    }
    /** Rename a build. A label another build has is refused, and so is "unlabelled" (it would merge with what has no build). */
    rename(given, label) {
        const b = this.get(given);
        // "unlabelled" holds what no build named: renaming it would claim all of it is one build (review of 485a2df). build_add sorts it.
        if (groupKey(b.label) === UNLABELLED)
            throw new Refusal(`"${UNLABELLED}" is where things with no build go, so it cannot be renamed: it may hold several builds. Name each with build_add (by id, by name match, or a whole bag). Nothing was changed.`);
        const clean = cleanLabel(label);
        if (!clean)
            throw new Refusal('The new label is a few words, not empty.');
        if (groupKey(clean) === UNLABELLED && groupKey(b.label) !== UNLABELLED)
            throw new Refusal(`"${UNLABELLED}" is where things with no build go; choose another label.`);
        const other = this.find(clean);
        if (other && other.id !== b.id)
            throw new Refusal(`Another build is already called "${other.label}" (id ${other.id}). Choose another label.`);
        b.label = clean;
        b.updatedAt = this.now();
        this.save();
        return b;
    }
    /** Set the current build (made when new), or clear it with an empty label. */
    use(label) {
        const clean = cleanLabel(label);
        if (!clean) {
            this.state.current = null;
            this.save();
            return null;
        }
        const b = this.ensure(clean);
        this.state.current = b.id;
        this.save();
        return b;
    }
    /** Replace or append to a build's notes. */
    setNotes(given, input) {
        const b = this.get(given);
        const next = input.set !== undefined ? String(input.set) : [b.notes, String(input.append ?? '')].filter(Boolean).join('\n');
        if (next.length > MAX_BUILD_NOTES)
            throw new Refusal(`A build's notes are at most ${MAX_BUILD_NOTES} characters; these would be ${next.length}. Nothing was changed. Shorten them (set replaces them all), or keep the longer story in notes.`);
        b.notes = next;
        b.updatedAt = this.now();
        this.save();
        return b;
    }
    /**
     * Assign things already placed to a build (build_add): each recorded under
     * `label` (made when new). A thing in no build, or in "unlabelled", is
     * simply recorded. A thing in another build is a conflict: with `move`, it
     * leaves that build for this one; without, nothing at all is changed and
     * the conflicts are returned.
     */
    assign(label, pieces, move) {
        const clean = cleanLabel(label);
        if (!clean)
            throw new Refusal('A build label is a few words, not empty.');
        const want = groupKey(clean);
        const added = [];
        const already = [];
        const moved = [];
        const conflicts = [];
        const plan = [];
        for (const piece of pieces) {
            const hit = this.pieceOf(piece);
            if (hit && groupKey(hit.build.label) === want) {
                already.push(piece);
                continue;
            }
            if (hit && groupKey(hit.build.label) !== UNLABELLED)
                conflicts.push({ piece, build: hit.build.label });
            plan.push({ piece, from: hit });
        }
        if (conflicts.length && !move)
            return { build: this.find(clean), added, already, moved, conflicts };
        if (plan.length === 0)
            return { build: this.find(clean), added, already, moved, conflicts };
        const b = this.ensure(clean);
        const t = this.now();
        for (const { piece, from } of plan) {
            // The record leaves its old build (unlabelled, or another with move): a piece is in one build at a time.
            if (from) {
                from.build.pieces = from.build.pieces.filter((p) => p !== from.piece);
                from.build.updatedAt = t;
                if (groupKey(from.build.label) !== UNLABELLED)
                    moved.push({ piece, from: from.build.label });
            }
            b.pieces.push(safe({ ...piece, ...(from ? { placedAt: from.piece.placedAt } : {}), changedAt: t }));
            if (!from || groupKey(from.build.label) === UNLABELLED)
                added.push(piece);
        }
        b.updatedAt = t;
        this.save();
        return { build: b, added, already, moved, conflicts };
    }
    /** Copies of the ledger entries for these things, as a trash entry keeps them. */
    entriesFor(things) {
        return things.flatMap((t) => {
            const hit = this.pieceOf(t);
            return hit ? [{ build: { id: hit.build.id, label: hit.build.label }, piece: { ...hit.piece } }] : [];
        });
    }
}
//# sourceMappingURL=builds.js.map