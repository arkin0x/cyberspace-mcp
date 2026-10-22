// contentsSpec.test.ts: a bag's `contents` rows as spec 7.7 "Contents" reads
// them (arkin0x/cyberspace#75, merged as ba87bbd): a row whose count is there
// but is not a positive integer (no sign, no leading zero, no cap) is ignored,
// `["contents", "cashu"]` with no count is the money-alone form, and a
// nonfungible.cash claim link inside another URL is not counted.

import { describe, expect, it } from 'vitest'
import { bagSettingsOf, bagTemplate, HIDDEN_KIND } from '../src/hidden/bags.js'
import { regionKeyAt } from '../src/hidden/crypto.js'
import { nftLinkCount } from '../src/hidden/nftLink.js'

const LINK = `https://nonfungible.cash/claim/${'6f'.repeat(16)}#${'A'.repeat(42)}w`
const LINK2 = `https://nonfungible.cash/claim/${'0a'.repeat(16)}#${'b_-'.repeat(14)}Q`

const settingsOf = (rows: string[][]) => {
  const ev = { id: '0'.repeat(64), pubkey: 'p', created_at: 1, kind: HIDDEN_KIND, content: '', sig: '', tags: [['d', 'x'], ['H', '8'], ...rows] }
  const s = bagSettingsOf(ev, 8)
  return { contents: s.contents, money: s.money }
}

describe('reading contents counts (spec 7.7)', () => {
  it('reads a count of any size: no cap', () => {
    for (const count of ['1', '999999', '1000000', '9007199254740993', '9'.repeat(400)]) {
      expect(settingsOf([['contents', 'shard', count]]), count).toEqual({ contents: true, money: false })
    }
  })

  it('ignores a count with a sign, a leading zero, an exponent, a zero or anything else', () => {
    for (const count of ['0', '00', '03', '+3', '-3', '1e2', '0x3', '3.0', '1.5', ' 3', '3 ', '', 'x', 'Infinity', '٣']) {
      expect(settingsOf([['contents', 'shard', count]]), JSON.stringify(count)).toEqual({ contents: false, money: false })
    }
    expect(settingsOf([['contents', 'shard', 3 as unknown as string]])).toEqual({ contents: false, money: false })
  })

  it('reads money alone only from the cashu row with no count, and never from a cashu row with a bad count', () => {
    expect(settingsOf([['contents', 'cashu']])).toEqual({ contents: false, money: true })
    expect(settingsOf([['contents', 'cashu', '0']])).toEqual({ contents: false, money: false })
    expect(settingsOf([['contents', 'cashu', 'x']])).toEqual({ contents: false, money: false })
    expect(settingsOf([['contents', 'cashu', '1']])).toEqual({ contents: true, money: false })
    // A bare row of any other kind says nothing.
    for (const kind of ['shard', 'message', 'key', 'chest', 'nft']) expect(settingsOf([['contents', kind]]), kind).toEqual({ contents: false, money: false })
  })

  it('a rewrite keeps a bag with a large count saying its contents', async () => {
    const s = settingsOf([['contents', 'message', '1000000']])
    const k = regionKeyAt({ x: 1n << 40n, y: 1n << 40n, z: 1n << 40n }, 8, 20)
    const message = { id: '1'.repeat(64), pubkey: 'p', created_at: 1, kind: 1, tags: [], content: 'hi', sig: '' }
    const t = await bagTemplate([message], k.key, k.lookupId, 8, 1, HIDDEN_KIND, { heightTag: true, hint: null, riddle: '', ...s })
    expect(t.tags.filter((x) => x[0] === 'contents')).toEqual([['contents', 'message', '1']])
  })
})

describe('counting nonfungible.cash claim links (spec 7.7)', () => {
  it('does not count a link inside another URL, after any mark a URL may hold', () => {
    for (const before of [';', ',', ':', '(', "'", '*']) {
      for (const url of ['https://a.example/?b=1', 'https://a.example/x', 'HTTPS://A.EXAMPLE/x', 'https://a.example/#top;https://b.example/?q']) {
        expect(nftLinkCount(`${url}${before}${LINK}`), `${url}${before}`).toBe(0)
        expect(nftLinkCount(`see ${url}${before}${LINK} now`), `${url}${before}`).toBe(0)
      }
    }
  })

  it('still counts a link after those marks in words, and after a URL that ended', () => {
    for (const text of [`see;${LINK}`, `one,${LINK}`, `(${LINK})`, `link:${LINK}`, `a.example/?b=1;${LINK}`, `[https://a.example](${LINK})`, `https://a.example/x ${LINK}`, `<https://a.example/>;${LINK}`]) {
      expect(nftLinkCount(text), text).toBe(1)
    }
    expect(nftLinkCount(`${LINK}, ${LINK2}`)).toBe(2)
    // A link in another URL's fragment counts (spec 7.7 names path and query), so two links joined by a mark count two.
    expect(nftLinkCount(`https://a.example/#top;${LINK}`)).toBe(1)
    for (const mark of [',', ';', ':', '(']) expect(nftLinkCount(`${LINK}${mark}${LINK2}`), mark).toBe(2)
    expect(nftLinkCount(`https://a.example/?b=1;${LINK2} and ${LINK}`)).toBe(1)
  })
})
