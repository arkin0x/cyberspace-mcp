# Kit build briefs

Build briefs for the kit tools. They name kit pieces, so they are not in this
repository: they live with the kits, in `<kits>/briefs/*.json` (the Maze
Kit's exporter writes them there). Five today: a four-room dungeon with a
vault door, a two-level build joined by a stair and a shaft, a 3 by 3
Landscape region with a raised ruin behind step walls and a coastline, a
decorated room, and ruins scattered across a meadow.

Each file has the `brief` (the words an agent is given), a `solution` (the
placements a good build uses, checked against the kits) and `assert` (what
must hold of any answer: no errors, at least so many pieces of each kind, no
warnings of the named kinds, the bag height, levels, which region edges may
show).

## Dry run, no model

    CYBERSPACE_KITS_DIR=<kits dir> npm run eval:kits

For each brief it calls the MCP tools the way an agent does: `kit_piece`
for every piece, `check_layout` (the assertions), `check_layout` again with
the origin where it stands, `render` (iso and a top view cut through the
rooms; the PNGs go to `KITS_EVAL_OUT`, default `<tmp>/cyberspace-kits-eval`),
then `place` for every piece, with a recorder in place of hide: nothing is
signed or published. It passes when every brief's solution meets its
assertions and every piece goes through `place` as a valid payload under its
own name.

## With the agent (after the owner upgrades it)

The dry run proves the tools; this measures the agent. Run it on a test
agent first, or on XOR when the owner says so: placing publishes bags.

1. Give the agent one brief's `brief` text as an order, with: "Plan it with
   kit and check_layout, look at it with render, and stop before placing:
   reply with your placements as JSON." (Leave out the stop to let it build;
   only with the owner's go, since that publishes.)
2. Save its placements to `answer-<brief id>.json` as
   `{ "placements": [...] }`.
3. Check the answer against the same assertions: copy the brief file into a
   scratch folder, replace its `solution` with the agent's placements, and
   run `CYBERSPACE_KITS_DIR=... KITS_EVAL_BRIEFS=<that folder> npm run
   eval:kits`. A failure names the assertion the answer missed.
4. Score per brief: errors (must be 0), the asserted warnings (must be
   absent), pieces of each kind, tool calls used, and whether it rendered
   before placing. Look at the render.

Briefs to add as the kits grow: a basilica nave with side chapels (multi-tile
pieces), a cistern with water levels, an Atrani crag town on walkways, an
AeroCarnival course (its own rules: jump classes in the kit README).
