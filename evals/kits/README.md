# Kit build briefs

Builds to check the kit tools against real kits. A brief names pieces of its
kit, so briefs ship inside a kit's zip (`briefs/*.json`) and live with the
installed kit (`<kits>/<kit>/briefs/`), never in this repository. The format
is in docs/kits.md.

## Dry run, no model

    CYBERSPACE_KITS_DIR=<kits dir> npm run eval:kits

For every brief of every installed kit it calls the MCP tools the way an
agent does: `kit_piece` for every piece, `check_layout` (the brief's
assertions), `check_layout` again with the origin where it stands, `render`
(iso, and a top view cut through any rooms; the PNGs go to `KITS_EVAL_OUT`,
default `<tmp>/cyberspace-kits-eval`), then `place` for every piece, with a
recorder in place of hide: nothing is signed or published. It also checks the
rules against each kit's real geometry: every wall plug `check_layout` names
lands on the turned opening's rim, and for terrain tiles side by side the
meshes meet exactly when `check_layout` says the seam matches. Skipped when
`CYBERSPACE_KITS_DIR` is not set.

## With the agent

The dry run proves the tools; this measures the agent. Placing publishes
bags, so run it on a test agent, or on yours with your go.

1. Give the agent one brief's `brief` text as an order, with: "Plan it with
   kit and check_layout, look at it with render, and stop before placing:
   reply with your placements as JSON."
2. Copy the brief file into a scratch folder and replace its `solution` with
   the agent's placements.
3. Run `CYBERSPACE_KITS_DIR=<kits dir> KITS_EVAL_BRIEFS=<that folder> npm run
   eval:kits`. A failure names the assertion the answer missed.
4. Score per brief: errors (must be 0), the asserted warnings (must be
   absent), pieces of each kind, tool calls used, and whether it rendered
   before placing. Look at the render.
