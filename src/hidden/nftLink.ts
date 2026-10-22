/**
 * nftLink.ts: a nonfungible.cash claim link written in a hidden message, as
 * ONOSENDAI recognizes one (ONOSENDAI #440, merged as 5109448: src/lib/nftLink.ts
 * `findNftLinks`), counted for a bag's `nft` contents row (ONOSENDAI #441,
 * 2311e07) as ONOSENDAI #444 (b892512) `countNftLinks` counts them under
 * spec 7.7. This server only counts them: it never opens or claims one, and
 * this file never returns a link's key.
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

/** A character a URL may be written with (RFC 3986: unreserved, reserved but `[` and `]`, and `%`). */
const URL_CHAR = /[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]/

/**
 * How many claim links a text carries for a bag's `nft` count (ONOSENDAI
 * countNftLinks, spec 7.7 Contents), each distinct link once. A link that
 * stands inside another URL's path or query is not counted: the URL
 * characters right before it, back to the first one a URL cannot hold,
 * contain a `://` with no `#` after it. So `https://a.example/?b=1;https://nonfungible.cash/...`
 * counts none, and `see;https://nonfungible.cash/...`, `[a page](https://nonfungible.cash/...)`
 * and two links joined by a comma (the second is in the first one's
 * fragment, not its path or query) count every link. Text with no scheme
 * before it (`a.example/?b=1;`) is not a URL here, and a character outside
 * RFC 3986 (`é`) ends one. One pass over the text, however many links.
 */
export function nftLinkCount(text: unknown): number {
  if (typeof text !== 'string' || !text) return 0
  const seen = new Set<string>()
  // The run of URL characters before position `i`: where its last `://` is (-1 for none), and whether a `#` came after that.
  let i = 0, scheme = -1, fragment = false
  for (const m of text.matchAll(PATTERN)) {
    const at = m.index! + m[1].length
    for (; i < at; i++) {
      const c = text[i]
      if (!URL_CHAR.test(c)) { scheme = -1; fragment = false }
      else if (c === ':' && text[i + 1] === '/' && text[i + 2] === '/') { scheme = i; fragment = false }
      else if (c === '#') fragment = true
    }
    if (scheme === -1 || fragment) seen.add(`${m[2]}#${m[3]}`)
  }
  return seen.size
}
