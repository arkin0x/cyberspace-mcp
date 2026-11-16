// faceName.ts: the shape DECK-0003 1.18 gives every facing mode's name.
// sno-core reads `face` (sno-core/face) but keeps this check to itself; this
// tool needs it to tell a mode a later revision may add, which an editor
// carries, from a malformed value, which it leaves off.

/** Whether `v` has the shape of a facing mode's name, "path", "upright" and any a later revision adds: 1 to 32 lowercase letters, digits and hyphens, from a letter. */
export function faceNameShaped(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(v)
}
