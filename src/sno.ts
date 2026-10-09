// sno.ts: validating an SNO object payload (DECK-0003 section 1.9) and
// saying, in plain words, what is wrong with it. sno-core's fromPayload is
// the arbiter: it returns a model or null and never a reason, so the checks
// of 1.9 are restated here to name the reason, and fromPayload has the last
// word.

import { fromPayload, toPayload, type ShardModel, type ShardPayload } from 'sno-core/shards'

export type Validation =
  | { ok: true; shard: ShardModel; payload: ShardPayload; bytes: number; vertices: number; faces: number }
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
          [1, 2, 3].every((k) => part[k] >= -7680 && part[k] <= 7680) &&
          [4, 5, 6].every((k) => part[k] >= 0 && part[k] <= 359)
        if (!ok) errors.push(`part ${i} must be eight integers: a refs index in range, three tick offsets in -7680..7680, three whole degrees 0..359, and a scale step (1.9 rule 12).`)
      })
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  const shard = fromPayload(raw, 'validate')
  if (!shard) return { ok: false, errors: ['sno-core refuses this payload for a reason the checks above do not name; compare it with DECK-0003 section 1.'] }
  const payload = toPayload(shard)
  return { ok: true, shard, payload, bytes: new TextEncoder().encode(JSON.stringify(payload)).length, vertices: shard.vertices.length, faces: shard.faces.length }
}
