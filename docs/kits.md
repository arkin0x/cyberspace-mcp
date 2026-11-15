# Kits: local building pieces for your agent

A kit is a set of SNO pieces made to fit together: rooms with standard
openings, plugs and doors (the Maze Kit), terrain tiles on an edge standard
with walls and ruins (the Landscape Kit). An agent with kits installed can
search them (`kit`, `kit_piece`), check a planned build against the kits'
rules (`check_layout`), look at it (`render` with `layout`) and build it
(`place` with `kit`). The guide the agent reads is the resource
`cyberspace://kits.md` (docs/kits-guide.md).

**Kits are local data. Nothing here downloads, publishes or sends a kit.**
This repository holds no kit: you copy one onto your machine. The server
never publishes a kit piece on its own: `publish_object` and `set_avatar`
refuse a payload that is a kit piece, and a piece placed with `place` goes
into the agent's own bag under its own name (the kit's name is dropped),
like any build.

## Where kits live

The server looks, in order, for:

1. `kitsDir` in `<state>/config.json`, or `--kits-dir <dir>` (only this one
   when it is set);
2. `<state>/kits`;
3. `<state>/../kits` (beside the state directory).

`cyberspace-mcp doctor` says which it found and how many pieces. With none,
every kit tool says that no kits are installed and where it looked, and the
agent builds from its own objects as before.

## The format (cyberspace-kit-catalog-1)

One folder per kit, named for the kit (`maze-kit`, `landscape-kit`):

    <kits>/maze-kit/catalog.json
    <kits>/maze-kit/<set>/<folder>/<piece>.json    the piece's SNO payload
    <kits>/landscape-kit/catalog.json
    <kits>/landscape-kit/plains/<folder>/<piece>.json

The payload files mirror the kit's workshop zips byte for byte (a piece's id
is its zip path without `.json`). `catalog.json` holds `format`, `kit`,
`title`, `generated`, `source` (repository, commit, zips), `standard` (the
kit's numbers and words: tile size, opening sizes, turn rule, frame) and
`pieces`, one entry per piece:

| Field | What it is |
|---|---|
| `id`, `file`, `name`, `set`, `group`, `kind` | identity: `kind` is tile, plug, reducer, recessed-plug, door, door-open, chest-look, insert, cap, prop, decor, open, course (Maze Kit); tile, coast, wall, decor, ruin (Landscape Kit) |
| `bytes`, `vertices`, `faces`, `unit` | size of the payload |
| `bounds` | min and max in gibsons, world axes, in the piece's own frame |
| `origin` | where the origin is and how the piece is placed, in words |
| `bag` | `minHeight` (smallest bag that can hold it), `offsets` (where its point must sit in that cube), `note` |
| `constrain`, `opacity` | WALK collision and translucency, as the payload says |
| `tags`, `notes`, `blurb` | words to search and to read |
| `cells`, `footprint`, `levels`, `openings`, `floorSeals` | Maze Kit rooms: the tile cells, each opening's face, size and cell, and which ceiling hatches the floor seals |
| `plug`, `reducer`, `closes`, `host`, `cap`, `mount`, `size`, `decorGroup` | Maze Kit plugs, reducers, doors, inserts, caps and decor |
| `footprint`, `edges`, `base`, `step` | Landscape Kit tiles: size and the edge profile of each side |
| `wall` | Landscape Kit walls: kind (seam, step, ramp-step), length, height, centre line segments, the part that hides a step, the low side |
| `mount`, `size`, `solid`, `sink` | Landscape Kit decor and ruins |

Faces, cells, bounds and wall lines are in **world axes** (sno-core's model
frame: cyberspace x, y, z). The kits' own READMEs name faces in the SNO wire
frame, whose +z is world -z; the exporters convert.

## Installing and refreshing

Each kit's own repository (private) writes its folder:

    npm run export-local -- --out <kits dir>

run in the kit's checkout. It reads the kit's workshop zips for the
payloads (`--zips <dir>` for another folder) and its own piece list for the
metadata, writes the new folder beside the old one and swaps it in, so a
running server never reads half a kit; the server re-reads a catalog when
the file changes, with no restart. After a kit changes: build it, write its
zips, then run `export-local` again. The script reports pieces left out
(joins, flooded rooms and composites, which name other pieces by the
workshop's placeholder and only resolve after a workshop import) and any
piece of the checkout that is not in the zips yet. The Maze Kit's exporter
also copies the build briefs (they name pieces, so they live with the kits,
never here) to `<kits dir>/briefs`.

## Checking the tools against the kits

`CYBERSPACE_KITS_DIR=<kits> npm run eval:kits` runs the build briefs in
`<kits>/briefs` without a model: it drives `kit_piece`, `check_layout`,
`render` and `place` (with a recorder in place of hide, so nothing is
published) and checks each brief's assertions. evals/kits/README.md says how
to run the same briefs with the agent itself.
