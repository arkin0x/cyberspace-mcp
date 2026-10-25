// walkConstrain.ts: whether a shard stops a walker in WALK, DECK-0003
// section 1.12 (`constrain`), and the default an authoring tool writes
// (arkinox, 2026-10-23, ONOSENDAI #476: "ALL shards should publish with the
// OPAQUE option on by default").
//
// The same rules as ONOSENDAI's src/lib/walkConstrain.ts (origin/v2 54dc7ca),
// which this file follows word for word where it can:
//
// | The payload says        | A walker meets (readConstrain) | What this server writes (authoredConstrain) |
// |-------------------------|--------------------------------|---------------------------------------------|
// | "all" / "opaque" / "off" | that                          | that                                        |
// | nothing                 | off                            | "opaque": nobody chose, so the default       |
// | anything else           | off                            | "opaque": not a choice either                |
//
// sno-core (0.1.19) does not know the field, so it rides in the model's
// `extra` and toPayload writes it after the fields it computes, exactly
// where ONOSENDAI's payloads carry it. OFF is written as "off", never as no
// field, so a deliberate OFF survives the next tool that opens the object.
// The default reaches only payloads this server writes: a new object, a copy
// placed inline, an object written again (moved, or its setting changed).
// Never an item carried in a bag as it was found, never a public object
// placed by reference (its author's), never an avatar (section 3.3).

import { fromPayload, readOpacity, type ShardModel } from 'sno-core/shards'

/** What a shard asks of a walker. */
export type Constrain = 'off' | 'all' | 'opaque'

/** What a shard whose author has not chosen is written as (DECK-0003 1.12). */
export const CONSTRAIN_DEFAULT: Constrain = 'opaque'

/** The three settings. */
export const CONSTRAINS: readonly Constrain[] = ['off', 'all', 'opaque']

/** The payload field (DECK-0003 1.12). */
export const CONSTRAIN_FIELD = 'constrain'

/** What each setting does, in the words the tools answer with. */
export const CONSTRAIN_WORDS: Readonly<Record<Constrain, string>> = {
  off: 'WALK passes through',
  all: 'WALK cannot cross any face',
  opaque: 'WALK cannot cross it while solid and opaque',
}

/** One of the three words exactly, or undefined. */
export function chosenConstrain(raw: unknown): Constrain | undefined {
  return raw === 'all' || raw === 'opaque' || raw === 'off' ? raw : undefined
}

/** A payload's `constrain` as a walker reads it: "all" or "opaque" exactly, anything else (absent and "off" included) off. */
export function readConstrain(raw: unknown): Constrain {
  return raw === 'all' || raw === 'opaque' ? raw : 'off'
}

/** A payload's `constrain` as its author chose it, and the default when nobody did (absent, or a malformed value). */
export function authoredConstrain(raw: unknown): Constrain {
  return chosenConstrain(raw) ?? CONSTRAIN_DEFAULT
}

/** The raw field a model carries, top level first, for a sno-core that has learned the field and lifted it out of `extra`. */
export function rawConstrain(s: Pick<ShardModel, 'extra'>): unknown {
  const top = (s as { constrain?: unknown }).constrain
  return top !== undefined ? top : s.extra?.[CONSTRAIN_FIELD]
}

/** The word a model's author chose, or undefined when nobody chose. */
export function chosenConstrainOf(s: Pick<ShardModel, 'extra'>): Constrain | undefined {
  return chosenConstrain(rawConstrain(s))
}

/** A model's setting as it is written: its author's word, or the default. */
export function authoredConstrainOf(s: Pick<ShardModel, 'extra'>): Constrain {
  return authoredConstrain(rawConstrain(s))
}

/**
 * `s` with its setting at `c`, written as the word itself ("off" is "off",
 * never no field). The same object when it already says exactly that; a
 * malformed value is replaced.
 */
export function withConstrain<T extends ShardModel>(s: T, c: Constrain): T {
  if (s.extra?.[CONSTRAIN_FIELD] === c) return s
  const { extra, ...rest } = s
  const kept: Array<[string, unknown]> = extra ? Object.entries(extra).filter(([k]) => k !== CONSTRAIN_FIELD) : []
  kept.push([CONSTRAIN_FIELD, c])
  return { ...rest, extra: Object.fromEntries(kept) } as T
}

/** `s` as it is written: its author's word kept, "opaque" for one whose author never chose. Never for an avatar. */
export function withAuthoredConstrain<T extends ShardModel>(s: T): T {
  return withConstrain(s, authoredConstrainOf(s))
}

/**
 * `s` at an opacity in whole percent (DECK-0003 1.11): 100 is fully opaque
 * and is written as no field, the canonical form; 1 to 99 as that percent.
 */
export function withOpacity<T extends ShardModel>(s: T, opacity: number): T {
  const { opacity: _old, ...rest } = s
  void _old
  return (opacity >= 100 ? rest : { ...rest, opacity }) as T
}

/** Whether an object can be seen through: below full opacity, or drawn as points or lines (DECK-0003 1.12 "Why opaque"). */
export function seeThrough(s: Pick<ShardModel, 'mode' | 'opacity'>): boolean {
  return readOpacity(s.opacity) !== undefined || s.mode !== 'solid'
}

/** Whether this object's own faces stop a walker now. */
export function blocks(s: Pick<ShardModel, 'mode' | 'opacity' | 'extra'>): boolean {
  const c = readConstrain(rawConstrain(s))
  return c === 'all' || (c === 'opaque' && !seeThrough(s))
}

/** The setting in words for an answer: what is written and what a walker meets. */
export function walkWords(s: Pick<ShardModel, 'mode' | 'opacity' | 'extra'>): string {
  const c = readConstrain(rawConstrain(s))
  const raw = rawConstrain(s)
  if (raw === undefined) return 'no constrain written (WALK passes through)'
  if (!chosenConstrain(raw)) return `constrain ${JSON.stringify(raw)}, not one of the three words (WALK passes through)`
  if (c === 'opaque' && seeThrough(s)) return `constrain "opaque", but it is see-through (${s.mode !== 'solid' ? `mode ${s.mode}` : `opacity ${readOpacity(s.opacity)}`}), so WALK passes through until it is solid and fully opaque`
  return `constrain "${raw as Constrain}" (${CONSTRAIN_WORDS[raw as Constrain]})`
}

/**
 * A placed shard's payload (JSON) written again with its WALK setting and
 * opacity, every other field kept exactly as found: an edit or a move of a
 * placement writes that placement's payload again (DECK-0003 1.12, "One
 * placement, one setting"). Not through sno-core's model, which would drop
 * a palette named by an nevent or naddr it has not fetched. `constrain`
 * left out keeps the author's word, or writes the default when nobody chose
 * (a move, ONOSENDAI #476); `opacity` left out keeps a valid one, and 100 is
 * written as no field. The two go last, opacity first, where sno-core's
 * toPayload puts them. Null when the payload does not read as SNO.
 */
export function rewritePayload(json: string, change: { constrain?: Constrain; opacity?: number } = {}): string | null {
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !fromPayload(raw, 'rewrite')) return null
  const p = raw as Record<string, unknown>
  const opacity = readOpacity(change.opacity !== undefined ? change.opacity : p.opacity)
  const constrain = change.constrain ?? authoredConstrain(p[CONSTRAIN_FIELD])
  // Built from entries, so a `__proto__` key in the payload stays data.
  const kept = Object.entries(p).filter(([k]) => k !== 'opacity' && k !== CONSTRAIN_FIELD)
  return JSON.stringify(Object.fromEntries([...kept, ...(opacity !== undefined ? [['opacity', opacity]] : []), [CONSTRAIN_FIELD, constrain]]))
}
