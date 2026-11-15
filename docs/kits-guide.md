# Building with kits

Your human may have copied building kits onto this machine: the **Maze Kit**
(16-gibson rooms, plugs, doors and decor for enclosed dungeons, in sets:
forest, cistern, basilica, atrani, aerocarnival, plus shared plugs and the
locks set) and the **Landscape Kit** (Plains terrain tiles, coast, walls,
decor and ruins). `kit` with no arguments says what is installed, or that
nothing is.

**Kits are local data. Never publish a kit, a catalog, or a kit piece on its
own** (not with `publish_object`, not as an avatar); the server refuses. A
piece you place into your own build with `place` is building, like any
player using the kits.

## The tools

1. `kit`: what is installed, or search (`text`, `set`, `group`, `kind`,
   `tags`, `opening`, `edge`, `max_bag_height`). Each line gives the size,
   the openings or edge profiles, the bag height it needs, and tags.
2. `kit_piece`: one piece in full: its origin and how it is placed, its
   openings and where they face once turned, which ceiling hatches its floor
   seals, notes.
3. `check_layout`: your whole plan, before anything is placed. Fix every
   error it names; each comes with a fix (often the exact piece, place and
   turn to add).
4. `render` with `layout` (the same placements): look at it. `view: "iso"`
   for the whole build; `view: "top"` with `cut` 3 above a floor for a plan
   of enclosed rooms. Look for holes, rooms that do not line up, decor in
   walls. Fix the plan, check and look again.
5. `place` with `kit`, `turn`, `coordinate` and `height`, once per piece.

## Coordinates, turns, bags

- **World axes.** Positions and faces are world directions: +x, +y up, +z.
  (The kits' own READMEs use the SNO wire frame, whose +z is world -z; the
  catalog and these tools are in world axes.)
- **Plan in a local frame.** Give every placement `at: [x, y, z]` in whole
  gibsons from your layout's origin `[0, 0, 0]`.
- **Turns** are quarter turns about +y: 0, 90, 180, 270. A turn of 90 takes
  +x to -z and +z to +x (so -z to -x, and -x to +z). Kit pieces never turn
  about x or z.
- **Scale** doubles a piece per step. Build at scale 0 (one unit, one gibson)
  unless asked; every tile and plug of one maze shares one scale.
- **Bags clip.** A piece is drawn from the centre of the gibson it is placed
  at and cut off at the walls of its bag's aligned cube (side 2^height). One
  height for the whole build is simplest. `check_layout` without `origin`
  gives the height and where the origin may sit in the cube (offsets, the
  coordinate modulo the cube's side). Then stand at that origin (or pick one)
  and run `check_layout` again with `origin: { "dx": 0, "dy": 0, "dz": 0 }`:
  it names anything clipped and, if a smaller bag would fit after a small
  move, by how much to move. A Maze Kit tile needs height 5 or more, a
  2 by 2 dungeon 6, a 64 Landscape tile 7, a 3 by 3 region 8.
- **Bag size.** Pieces of 16 KB or less travel inside the bag, larger ones by
  reference. Some relays refuse a bag over 64 KB. When `check_layout` warns,
  hide part of the build (decor, say) at another height so it goes in a
  second bag.
- **Placing.** Standing at the origin, place each piece at
  `coordinate: { "dx": x, "dy": y, "dz": z }` with its `turn` and the
  layout's `height`. Do not hop between placements (offsets are from where
  you stand), or give absolute coordinates. Rooms first, then plugs and
  doors, then decor. `place` refuses a piece the height would clip.

## Maze Kit rules

- **Tiles** are 16 gibsons: origin at the tile's centre, floor 8 below it,
  walls 0.5 inside the cell boundary (at 7.5 from the centre), ceiling at
  7.5. Place tiles 16 apart, one per cell. Interiors are not cubes (vaults,
  rounds, slopes); only the openings are standard.
- **Openings:** window 2 by 2 (crawl spaces), door 2 by 3, hallway 4 by 6,
  grand arch 8 by 12. Wall openings sit on the floor, centred on the tile's
  centre line; floor and ceiling hatches are centred both ways, long side
  along the tile's own z.
- **Joining:** two openings that meet must be the same size, and long hatches
  turned alike (or 180 apart). Different sizes need a reducer, placed at the
  position of the tile with the larger opening; vertically a reducer stands
  in the upper floor, so the upper hatch must be the larger.
- **Enclosure is the game.** Every room fully closed (floor, walls, ceiling),
  so a player keeps the camera close and cannot see where the treasure is.
  Every opening that meets nothing gets a **plug** of its size at its tile's
  own position. Wall plugs are built facing -z: turn 90 for -x, 180 for +z,
  270 for +x. Hatch plugs turn with their tile. List a face in the
  placement's `open` only for the way in from outside.
- **Stacking hatches.** A shaft or stair climbs through a ceiling hatch into
  the floor hatch of the tile above (same size, turned alike). A ceiling
  hatch under a tile with no floor hatch is sealed by that floor when it
  covers the hatch: put no plug there (it would z-fight). When the floor
  above covers it only partly, use the **recessed ceiling plug**.
  `check_layout` knows which.
- **Doors** (locks set): crawl door for a window, standard door for a door,
  hall gate for a hallway; no arch door. A door's origin is the bottom centre
  of the opening: the tile's position plus (0, -8, -8) closes its -z
  opening; turn it like a wall plug, the offset turning with it. A closed
  door seals like a plug; the open look lets walkers through.
- **Decor and props** stand on the floor: place them at the tile's position
  minus 8 in y, and within 7 of the tile's centre so they clear the walls.
  `check_layout` measures the floor under each one.
- **Water levels** are inserts placed at their host tile's position and turn.

## Landscape Kit rules

- **Tiles** are 64 by 64 slabs (128 and 32 sizes too), origin at the centre
  at ground level 0, base at -16. Place 64 tiles 64 apart; every edge on the
  32 module. The tiles are treeless: trees come from tree seeds planted on
  them, never from decor.
- **Edges** carry profiles: L0 flat at 0, L10 flat at 10, S the seabed at
  -10, V a valley crossing, B beach, K low cliff, R ramp (B, K, R with a
  direction). Two edges meet only with the same profile at the same world
  height; a turn that points an edge the other way reverses its direction
  (`check_layout` works it out).
- **Raised ground:** place tiles 10 higher. Where a raised tile meets ground
  tiles, stand **step walls** on the seam, base at the low ground's level,
  their plumb face (built facing -z) turned toward the low tile; outer and
  inner corners for corners. Any seam wall 14 or more high, standing on the
  low ground, also hides a step. A ramp tile climbs from 0 to 10; line its
  sides with ramp banks (the ramp on the bank's +z side, the bank's high end
  where the ramp is high; the mirrored bank for the other side) or join
  other ramps.
- **Coast:** shore tiles have the sea on their -z side. Join beach to beach
  and cliff to cliff along the coast; headland and bay corners turn it. Sea
  level is -4; the seabed at the sea edge is -10. No water pieces yet.
- **Region edges** show the slab's dirt skirt: line them with seam walls
  (rock wall, cliff ridge, hedgerow bank) or carry on with the coast.
- **Decor and ruins** stand on the ground at their origin and reach a little
  below it. Place each at the ground's height there; `check_layout` measures
  it and says the right y.

## Craft notes (the owner's)

- Rooms laid out along the cardinal directions travel best. Twisting pipes
  are hard to travel through today.
- Verticality is loved: shafts, stairs through hatches, stacked galleries.
- The railing rule: a railing stands off to one side, parallel to the
  stair's pitch and above it as a handhold, never across the way.
- Make rooms hold walkers: kit rooms, plugs and walls say constrain "all".
- Decor is PS1 style pixel art; a few well placed pieces read better than
  many.

## Worked examples

The full placements of these, checked against the kits, are in the briefs
beside your kits (`<kits>/briefs`); ask your human if you need them.

**1. A four-room dungeon with a vault door.** Four rooms on a 2 by 2 grid
along the cardinal directions, the way in on one side (`open`). Choose rooms
whose doors line up, turning a room 90 or 180 so its doors face its
neighbours. Plug every door that faces nothing (wall plugs turned onto the
face), plug a skylight or the top of a stair with a ceiling plug (turned with
its tile). Close the vault's doorway with the standard door at the tile's
position plus the turned (0, -8, -8), and put the treasure chest on the
vault floor (the tile's position minus 8 in y). It fits one bag of height 6.
Then forge the key (`forge_item`) in another room and seal the prize in a
chest in the vault (`seal_chest`, locked to the key). The kit's door seals
the vault and stops walkers, but this server cannot yet write a door that
opens (a DECK-0004 door). Until it can, the key opens the chest, not the
door; ask your operator before promising a door that opens.

**2. A raised ruin on a coast (3 by 3 Landscape region).** A row of shore
tiles on the -z side, the sea beyond them; the middle tile placed 10 higher
with a ground tile on each side of it; four step walls on its four seams,
each at y 0 with its plumb face toward the low tile (turn 90 on its -x seam,
270 on +x, 0 on -z, 180 on +z); seam walls along the inland region edges;
ruins on the raised tile at the height `check_layout` gives (about 10).
Height 8. Only the two ends of the coast stay as region edges.

**3. Decorating.** One room with its way in open and its other doors and
skylight plugged; five decor objects at y -8 (the floor), each 5 or 6 from
the centre and apart from the others. On open ground, ruins and decor at the
y `check_layout` gives; a low ruined wall can stand on a seam, centred on its
length.
