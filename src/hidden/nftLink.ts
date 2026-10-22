/**
 * nftLink.ts: a nonfungible.cash claim link written in a hidden message, as
 * ONOSENDAI recognizes one (ONOSENDAI #440, merged as 5109448: src/lib/nftLink.ts
 * `findNftLinks`). This server only counts them, for a bag's `nft` contents
 * row (ONOSENDAI #441, 2311e07): it never opens or claims one, and this file
 * never returns a link's key.
 *
 *   https://nonfungible.cash/claim/<id>#<key>
 *
 * `id` is 32 lowercase hex characters; `key` is exactly 43 unpadded base64url
 * characters, the last one of sixteen (32 bytes fill only 256 of the 258
 * bits). The scheme and host are read in any case; the id and the key are
 * exact. The key is the secret that claims, so nothing here returns it.
 */

/**
 * What may come right before a link (ONOSENDAI BEFORE): the start of the
 * text, a space (a zero-width one too), an opening bracket or curly quote, a
 * straight quote, `*`, `>`, `|`, `,`, `;`, `:`, a backtick, or an en or em
 * dash (written as escapes here). A captured group, not a lookbehind.
 */
const BEFORE = '(^|[\\s\\u200b(\\[{<"\'\\u201c\\u2018*>|,;:\\u0060\\u2013\\u2014])'

const anyCase = (word: string): string => word.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`).replace(/\./g, '\\.')
const LINK = String.raw`${anyCase('https')}://${anyCase('nonfungible.cash')}/claim/([0-9a-f]{32})#([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])`

/** What may not come right after (ONOSENDAI AFTER): more key, padding, or more of a fragment. */
const AFTER = String.raw`(?![A-Za-z0-9_\-=+/%&#])`

const PATTERN = new RegExp(`${BEFORE}${LINK}${AFTER}`, 'g')

/**
 * How many claim links a text carries, each counted once (ONOSENDAI
 * findNftLinks(text).length): the same link twice in one text is one.
 */
export function nftLinkCount(text: unknown): number {
  if (typeof text !== 'string' || !text) return 0
  const seen = new Set<string>()
  for (const m of text.matchAll(PATTERN)) seen.add(`${m[2]}#${m[3]}`)
  return seen.size
}
