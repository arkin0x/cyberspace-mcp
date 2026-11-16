# Kits: building pieces for any agent

A **kit** is a set of SNO pieces made to fit together: rooms with standard
openings and the plugs and doors that seal them, or terrain tiles whose edges
match and the walls that hide their steps, with decor to furnish them. With a
kit installed, an agent searches it (`kit`, `kit_piece`), checks a planned
build against the rules the kit declares (`check_layout`), looks at it
(`render` with `layout`), and builds it (`place` with `kit`, `seal_door` for a
locked room).

Kits are local data. Nothing here downloads, publishes or sends a kit. A kit
you install stays on your machine; the agent places its pieces only inside
its own builds (into its bags, under the piece's own name, never the kit's),
and `publish_object` and `set_avatar` refuse a kit piece on its own. Kits of
your own can be as private as you like.

## Installing

    cyberspace-mcp kits add my-kit.zip
    cyberspace-mcp kits list
    cyberspace-mcp kits remove my-kit

`add` unpacks the zip into the kits directory as `<kits>/<kit>/`
(`pieces/`, `catalog.json`, `GUIDE.md`, `briefs/`), writing the new folder
beside the old one and swapping it in, so a running server never reads half
a kit; the server picks up the change with no restart. It only ever replaces
or removes a folder it wrote.

The kits directory is, in order: `--kits-dir <dir>`; `kitsDir` in
`<state>/config.json`; `<state>/kits` or `<state>/../kits`, whichever holds
kits (else `<state>/kits`). `cyberspace-mcp doctor` says which and how many
pieces. With no kits, every kit tool says so and where it looked.

## The kit zip (format cyberspace-kit-1)

    kit.json                       the manifest
    GUIDE.md                       optional: the kit's own building rules
    briefs/*.json                  optional: build briefs for the kit eval
    <kit>/<set>/<folder>/<piece>.json   the pieces' SNO payloads (DECK-0003)

The payloads sit in folders exactly as a workshop zip holds them (the same zip
ONOSENDAI's workshop imports can carry `kit.json` beside them). A piece's id
is its path without `.json`. A payload that is not valid SNO, or that places
other objects (parts), is left out and listed.

`add` measures every payload itself: its bytes, vertex and face counts, its
bounds, the bag height it needs and where its point may sit in that bag.
Those are never taken from the manifest. A name that starts with the kit's
title (`"Toy Blocks: arch"`) loses that prefix, so a placed copy never
carries the kit's name.

### kit.json

```json
{
  "format": "cyberspace-kit-1",
  "kit": "toy-blocks",
  "title": "Toy Blocks",
  "version": "1",
  "rules": { "family": "rooms", "tile": 12, "wallInset": 0.5, "floor": -6, "doorOffset": [0, -6, -6], "builtFacing": "-z" },
  "pieces": {
    "toy-blocks/rooms/hall": {
      "name": "hall", "kind": "tile", "tags": ["straight"],
      "cells": { "lo": [0, 0, 0], "hi": [0, 0, 0] },
      "openings": [{ "face": "+z", "size": "gate", "w": 2, "h": 3, "cell": [0, 0, 0] },
                   { "face": "-z", "size": "gate", "w": 2, "h": 3, "cell": [0, 0, 0] }],
      "floorSeals": [{ "cell": [0, 0, 0], "seals": ["slot", "gate", "gate-x"] }]
    },
    "toy-blocks/plugs/gate-plug": { "kind": "plug", "role": "plug:wall:gate", "plug": { "side": "wall", "size": "gate" } },
    "toy-blocks/doors/gate-door": { "kind": "door", "role": "door:gate", "closes": "gate" },
    "toy-blocks/doors/gate-door-open": { "kind": "door-open", "role": "door-open:gate", "closes": "gate" },
    "toy-blocks/decor/lamp": { "kind": "decor", "mount": "floor", "tags": ["light"] }
  }
}
```

- `kit`: lowercase letters, digits and dashes; also its folder name.
- `title`: the kit's name for people.
- `rules`: which family of rules `check_layout` applies to the kit, and the
  numbers it needs (below). A kit without rules is still searchable and
  placeable; `check_layout` then checks only overlaps and bags for it.
- `pieces`: what each piece is, by its id. A piece missing here is installed
  as kind `piece` with only what was measured. Every field is optional:

| Field | What it says |
|---|---|
| `name`, `kind`, `set`, `group`, `tags`, `notes`, `blurb`, `origin` | what the piece is and how it is placed, in words |
| `role` | a standard job (below), so a hint can name the piece without naming it in code |
| `cells`, `openings`, `floorSeals`, `levels`, `footprint` | rooms: the tile cells it fills, each opening (face, size name, width, height, cell), and which ceiling hatches its floor seals from above (`<size>` for a hatch lying along the tile's z, `<size>-x` along its x) |
| `plug`, `reducer`, `closes`, `host`, `cap`, `mount`, `size` | rooms: what a plug seals (`side`: wall, floor, ceiling, ceiling-recessed; `size`), what a reducer joins (`side`, `from`, `to`), the opening a door closes, an insert's host, decor's mount and size |
| `footprint`, `edges`, `base`, `step` | terrain: the tile's size in x and z, and the profile of each side (`px`, `nx`, `pz`, `nz`) |
| `wall` | terrain: `kind` (seam, step, ramp-step), `length`, `height`, `segments` (its centre line in its own frame), `hides` (the part that hides a step), `corner`, `highEnd` (for a ramp-step wall: +1 or -1 along its own x) |
| `solid`, `sink` | decor: whether it stops a walker, and how far below its origin it reaches |

Everything is in world axes, the frame a placed shard's vertices are in
(cyberspace x, y, z; sno-core's model frame). An SNO payload on the wire has
its z negated (DECK-0003 section 2), so a face a payload's author calls +z on
the wire is world -z. A turn is a quarter turn about +y that takes +x to -z
and +z to +x, as ONOSENDAI turns a deployed copy.

### Roles

Hints name roles and the server looks up the piece that does the job in the
local catalog, preferring the kit being checked. The roles `check_layout`
asks for: `plug:<side>:<size>` (side wall, floor, ceiling, ceiling-recessed),
`reducer:<side>:<from>-<to>`, `door:<size>`, `door-open:<size>`,
`step-wall:<length>`, `seam-wall:<length>`, `ramp-step-wall`, `ramp-step-mirror`.
A kit may give any other role it likes.

### Rules, and how generic they are

`rules.family` is `rooms` or `terrain`.

**Rooms** (`tile`, `wallInset`, `floor`, `doorOffset`, `builtFacing`):

- Generic, from the manifest alone: tiles on the kit's grid, one per cell;
  openings that meet must have the same size name, and long hatches (w and h
  differ) must lie the same way; a larger opening meets a smaller one only
  through a reducer at the larger one's tile (in an upper floor when vertical);
  every other opening is sealed by a plug of its size at its tile's position,
  turned onto the face it seals (`builtFacing` is the face plugs, reducers and
  doors are built on), by a door whose origin is the tile's position plus
  `doorOffset` turned with it, or declared open in the placement (`open`); a
  ceiling hatch under another tile is sealed by that tile's floor when its
  `floorSeals` says so, else it needs a recessed ceiling plug, and a plain
  ceiling plug there z-fights; decor stands on the floor (measured from the
  room's own faces) and inside the walls (`wallInset`).
- Sizes are ordered by area (w times h), so a kit names its sizes as it likes.

**Terrain** (`tile`, `module`, `minHideHeight`, `builtFacing`, `profiles`):

- Generic: two edges meet only where they carry the same profile at the same
  world height, read along the world axis after the turn; tiles sit on the
  `module`; tiles do not overlap; a region edge left open shows the slab's
  skirt; decor stands on the ground (measured from the tile's own faces).
- `profiles` says what each profile name means: `flat` (it is flat at this
  height above the tile's own level, so a flat edge meets any flat edge at
  the same world height), `reverse` (the profile read the other way, which a
  turn may need), `ramp` and `rises` (+1 or -1 along the axis), `open` (an
  edge left open on purpose, such as a sea side, that is not a skirt).
- Flag-driven, not yet fully generic: where two edges do not meet (a raised
  tile beside a lower one), the seam must be covered by walls standing on the
  low ground: a `step` wall with its plumb face (`builtFacing`) toward the low
  tile, a `seam` wall at least `minHideHeight` high, and, for a `ramp` edge,
  only a `ramp-step` wall with the ramp on its back side and its `highEnd`
  where the ramp rises. A more general "an edge at height H must be covered by
  a piece with role X" rule would replace this; for now these wall kinds are
  the vocabulary.

**Both:** pieces do not overlap; every piece fits its bag (a shard is drawn at
the centre of the gibson it is placed at and clipped to the aligned cube of
its bag's height); `check_layout` gives the height that holds the build and
where its origin may sit, or, with an origin, what is clipped and how far to
move.

## GUIDE.md

A kit's own building rules for the agent: its sizes, its conventions, its
craft notes, worked examples with real piece ids. While the kit is installed
the server serves the general workflow and every installed kit's guide as the
resource `cyberspace://kits.md`. It is local data, like the kit.

## Briefs

`briefs/*.json` are builds to check the tools against a kit:
`{ "id", "title", "brief" (the words an agent is given), "solution":
{ "placements": [...] }, "assert": { "ok", "atLeast": { "<kind>": n },
"noErrors": [codes], "noWarnings": [codes], "bagHeightAtMost", "levels",
"regionEdgesOnlyOn": [names] } }`. `CYBERSPACE_KITS_DIR=<kits> npm run
eval:kits` runs every installed kit's briefs without a model; evals/kits/README.md
says how.
