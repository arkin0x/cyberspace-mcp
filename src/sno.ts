// sno.ts: validating an SNO object payload (DECK-0003 section 1.9) and
// saying, in plain words, what is wrong with it. sno-core's fromPayload is
// the arbiter: it returns a model or null and never a reason, so the checks
// of 1.9 are restated here to name the reason, and fromPayload has the last
// word.
//
// Two fields sno-core repairs rather than refuses (DECK-0003 1.11, 1.12):
// `opacity`, which sno-core 0.1.18 knows, and `constrain`, which it carries
// in `extra`. A valid one is kept as given; a malformed one is left out and
// named in `repaired`, and for `constrain` the default ("opaque") is written
// in its place when the object is published (walkConstrain.ts).
//
// `eye` (DECK-0003 1.17: where an avatar's own first-person viewer looks
// from), which sno-core 0.1.31 reads, is kept in `extra` like `constrain`
// when it is three whole numbers of ticks within the position bound, from
// -EYE_REACH to EYE_REACH (-491520 to 491520 since sno-core 0.1.34, which
// moved the bound from 64 units to 4,096: DECK-0003 1.8). A malformed one
// is left out and named in `repaired` (a reader takes it as the automatic eye,
// and a publisher never writes one); set_avatar refuses it instead.
//
// `face` (DECK-0003 1.18: how a worn avatar turns as it moves), which
// sno-core 0.1.32 reads, is kept in `extra` when it is "upright". "path", the
// default, is left out, since a publisher writes nothing for it. A name of
// the shape every mode's name has (1 to 32 lowercase letters, digits and
// hyphens, from a letter) that this version does not know is kept as found
// and named in `unknownFace`: a later revision may define it, an editor
// carries it, and a reader takes it as "path". Anything else (another case,
// an empty string, a number, null) is left out and named in `repaired` (a
// reader takes it as "path"). set_avatar refuses both in what the agent
// writes, and keeps an unknown name in an object it copies by address.
//
// `objects` (DECK-0003 1.10: the payloads of placed objects carried inside the
// object that places them), which sno-core 0.1.20 knows, is left out and named
// in `ignored`, as every unknown field was before: this tool writes no table
// until the spec section is merged (arkin0x/cyberspace#81), and then only with
// keys under the agent's own pubkey and never into a public event.

import { PART_REACH, blankName, fromPayload, readOpacity, toPayload, type ShardModel, type ShardPayload } from 'sno-core/shards'
import { EYE_FIELD, readEye } from 'sno-core/eye'
import { DEFAULT_FACE, FACE_FIELD, readFace } from 'sno-core/face'
import { faceNameShaped } from './faceName.js'
import { CONSTRAIN_FIELD, chosenConstrain } from './walkConstrain.js'

export type Validation =
  | {
      ok: true
      shard: ShardModel
      payload: ShardPayload
      bytes: number
      vertices: number
      faces: number
      /**
       * Top-level fields the payload carried that this tool does not know,
       * left out of `shard` and `payload`. sno-core (0.1.17) would carry them
       * through; an agent's tools publish only what they can validate, so an
       * invented or unknown field is named back to the agent instead of being
       * signed into a public event. `constrain` (DECK-0003 1.12) is not
       * among them: a valid word is kept in `shard.extra`, where sno-core
       * writes it.
       */
      ignored: string[]
      /** Fields whose value was malformed and is left out, as DECK-0003 repairs them: `opacity` (drawn opaque), `constrain` (not a choice, so the default is written), `eye` (the automatic eye), `face` ("path"). */
      repaired: string[]
      /** A `face` (DECK-0003 1.18) shaped like a mode's name that this version does not know, kept as found and read as "path"; absent when there is none. */
      unknownFace?: string
    }
  | { ok: false; errors: string[] }


const MODES = new Set(['solid', 'points', 'lines'])

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

function triple(v: unknown, pred: (n: unknown) => boolean): boolean {
  return Array.isArray(v) && v.length === 3 && v.every(pred)
}

/** The checks of DECK-0003 1.9 in order, each failure in words. */
export function validateSnoPayload(raw: unknown): Validation {
  const errors: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['The payload must be a JSON object (DECK-0003 1.1).'] }
  const p = raw as Record<string, unknown>
  if (p.v !== 1 && p.v !== 2) errors.push(`v must be 1 or 2; got ${JSON.stringify(p.v)} (1.9 rule 1).`)
  if (typeof p.name !== 'string') errors.push('name must be a string (1.1).')
  else if (blankName(p.name)) errors.push('name must not be blank (1.9 rule 1a).')
  for (const k of ['ticks', 'palette', 'facecolors', 'up', 'spin', 'refs', 'parts']) {
    if (p[k] === null) errors.push(`${k}, if present, must not be null: leave it out instead (1.1).`)
  }
  if (!Array.isArray(p.vertices)) errors.push('vertices must be an array (1.9 rule 2).')
  if (!Array.isArray(p.colors)) errors.push('colors must be an array (1.9 rule 2).')
  if (!Array.isArray(p.faces)) errors.push('faces must be an array (1.9 rule 2).')
  if (Array.isArray(p.vertices) && Array.isArray(p.colors) && p.vertices.length !== p.colors.length) {
    errors.push(`vertices and colors must have the same length; got ${p.vertices.length} vertices and ${p.colors.length} colors (1.9 rule 2).`)
  }
  if (typeof p.mode !== 'string' || !MODES.has(p.mode)) errors.push(`mode must be "solid", "points" or "lines"; got ${JSON.stringify(p.mode)} (1.9 rule 4).`)
  if (!isInt(p.unit) || p.unit < 0 || p.unit > 84) errors.push(`unit must be an integer from 0 to 84; got ${JSON.stringify(p.unit)} (1.9 rule 5).`)
  const vertices = Array.isArray(p.vertices) ? p.vertices : []
  vertices.forEach((v, i) => {
    if (!triple(v, isInt)) errors.push(`vertex ${i} must be three integers; got ${JSON.stringify(v)} (1.9 rule 6).`)
  })
  if (p.ticks !== undefined) {
    if (!Array.isArray(p.ticks)) errors.push('ticks, if present, must be an array (1.9 rule 7).')
    else {
      let count = 0
      let bad = false
      for (const t of p.ticks) {
        if (isInt(t) && t < 0) count += -t
        else if (triple(t, (n) => isInt(n) && (n as number) >= 0 && (n as number) <= 119)) count += 1
        else { bad = true; break }
      }
      if (bad) errors.push('every ticks entry must be three integers from 0 to 119, or a negative run count (1.9 rule 7).')
      else if (count !== vertices.length) errors.push(`ticks expands to ${count} entries for ${vertices.length} vertices; it must expand to exactly one per vertex (1.9 rule 7).`)
    }
  }
  const faces = Array.isArray(p.faces) ? p.faces : []
  faces.forEach((f, i) => {
    if (!triple(f, (n) => isInt(n) && (n as number) >= 0 && (n as number) < vertices.length) || new Set(f as number[]).size !== 3) {
      errors.push(`face ${i} must be three distinct vertex indices from 0 to ${vertices.length - 1}; got ${JSON.stringify(f)} (1.9 rule 8).`)
    }
  })
  if (p.v === 2 && Array.isArray(p.colors)) {
    const paletteLength = Array.isArray(p.palette) ? p.palette.length : 256
    p.colors.forEach((c, i) => {
      if (!isInt(c) || c < 0 || c >= paletteLength) errors.push(`color ${i} must be a palette index from 0 to ${paletteLength - 1} in a v2 payload; got ${JSON.stringify(c)} (1.9 rule 8b).`)
    })
  }
  if (p.v === 1 && Array.isArray(p.colors)) {
    p.colors.forEach((c, i) => {
      if (!triple(c, (n) => typeof n === 'number')) errors.push(`color ${i} must be three numbers in a v1 payload; got ${JSON.stringify(c)} (1.9 rule 8b).`)
    })
  }
  if (p.palette !== undefined && typeof p.palette !== 'string') {
    if (!Array.isArray(p.palette) || p.palette.length < 2 || p.palette.length > 256 || !p.palette.every((c) => triple(c, (n) => isInt(n) && (n as number) >= 0 && (n as number) <= 255))) {
      errors.push('palette, if present, must be a name, an nevent or naddr, or 2 to 256 entries of three integers 0..255 (1.9 rule 8a).')
    }
  }
  if (p.facecolors !== undefined && p.facecolors !== null) {
    const fc = p.facecolors
    let count = 0
    const ok = Array.isArray(fc) && fc.every((e, i) => isInt(e) && (e >= 0 ? (count += 1, true) : i > 0 && (count += -e, true)))
    if (!ok) errors.push('facecolors, if present, must be palette indices and negative run counts, starting with an index (1.9 rule 8c).')
    else if (count !== faces.length) errors.push(`facecolors expands to ${count} entries for ${faces.length} faces; it must expand to exactly one per face (1.9 rule 8c).`)
  }
  if (p.up !== undefined && typeof p.up !== 'boolean') errors.push('up, if present, must be a boolean (1.9 rule 10).')
  if (p.spin !== undefined && (!isInt(p.spin) || p.spin < 0 || p.spin > 359)) errors.push('spin, if present, must be an integer from 0 to 359 (1.9 rule 10).')
  if (p.refs !== undefined) {
    if (!Array.isArray(p.refs)) errors.push('refs, if present, must be an array (1.9 rule 11).')
    else p.refs.forEach((r, i) => {
      const ok = Array.isArray(r) && (r.length === 2 || r.length === 3) && typeof r[1] === 'string' &&
        ((r[0] === 'e' && /^[0-9a-f]{64}$/.test(r[1])) || (r[0] === 'a' && /^33331:[0-9a-f]{64}:/.test(r[1])))
      if (!ok) errors.push(`ref ${i} must be ["e", <64 hex>] or ["a", "33331:<64 hex>:<d>"], optionally with a relay URL (1.9 rule 11).`)
    })
  }
  if (p.parts !== undefined) {
    if (!Array.isArray(p.parts)) errors.push('parts, if present, must be an array (1.9 rule 12).')
    else {
      const refs = Array.isArray(p.refs) ? p.refs.length : 0
      if (refs === 0 && p.parts.length > 0) errors.push('parts without refs is a reason to reject (1.9 rule 12).')
      p.parts.forEach((part, i) => {
        const ok = Array.isArray(part) && part.length === 8 && part.every(isInt) &&
          part[0] >= 0 && part[0] < refs &&
          [1, 2, 3].every((k) => part[k] >= -PART_REACH && part[k] <= PART_REACH) &&
          [4, 5, 6].every((k) => part[k] >= 0 && part[k] <= 359)
        if (!ok) errors.push(`part ${i} must be eight integers: a refs index in range, three tick offsets in ${-PART_REACH}..${PART_REACH}, three whole degrees 0..359, and a scale step (1.9 rule 12).`)
      })
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  const read = fromPayload(raw, 'validate')
  if (!read) return { ok: false, errors: ['sno-core refuses this payload for a reason the checks above do not name; compare it with DECK-0003 section 1.'] }
  const { extra, objects: _held, ...bare } = read
  const carried = extra ?? {}
  const chosen = chosenConstrain(carried[CONSTRAIN_FIELD])
  // Carried in the version 2 frame, a version 1 payload's included (sno-core flips it with the vertices).
  const eye = Object.hasOwn(p, EYE_FIELD) ? readEye(carried[EYE_FIELD]) : undefined
  // Read from the payload as given: facing is a name, the same in either frame.
  const face = Object.hasOwn(p, FACE_FIELD) ? readFace(p[FACE_FIELD]) : undefined
  const ignored = Object.keys(carried).filter((k) => k !== CONSTRAIN_FIELD && k !== EYE_FIELD && k !== FACE_FIELD)
  // Not written yet (see the header): named back to the agent, as before 0.1.20.
  if (p.objects !== undefined) ignored.push('objects')
  const repaired: string[] = []
  if (p.opacity !== undefined && p.opacity !== 100 && readOpacity(p.opacity) === undefined) repaired.push('opacity')
  if (CONSTRAIN_FIELD in carried && !chosen) repaired.push(CONSTRAIN_FIELD)
  if (Object.hasOwn(p, EYE_FIELD) && !eye) repaired.push(EYE_FIELD)
  // A name of the right shape this version does not know is not malformed: kept, as an editor keeps it (DECK-0003 1.18).
  const unknownFace = Object.hasOwn(p, FACE_FIELD) && !face && faceNameShaped(p[FACE_FIELD]) ? p[FACE_FIELD] : undefined
  if (Object.hasOwn(p, FACE_FIELD) && !face && unknownFace === undefined) repaired.push(FACE_FIELD)
  const kept: Record<string, unknown> = {}
  if (chosen) kept[CONSTRAIN_FIELD] = chosen
  if (eye) kept[EYE_FIELD] = eye
  if (face && face !== DEFAULT_FACE) kept[FACE_FIELD] = face
  if (unknownFace !== undefined) kept[FACE_FIELD] = unknownFace
  const shard: ShardModel = Object.keys(kept).length ? { ...bare, extra: kept } : bare
  const payload = toPayload(shard)
  return { ok: true, shard, payload, bytes: new TextEncoder().encode(JSON.stringify(payload)).length, vertices: shard.vertices.length, faces: shard.faces.length, ignored, repaired, ...(unknownFace !== undefined ? { unknownFace } : {}) }
}
