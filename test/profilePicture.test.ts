// profilePicture.test.ts: the agent's kind 0 carries a picture when asked
// (arkinox, 2026-10-11: XOR could not set the avatar he was given), and a
// field a later call leaves out keeps what the profile already said.

import { describe, expect, it } from 'vitest'
import { pictureUrl, profileTemplate, publishedFields } from '../src/profile.js'

describe('profile picture', () => {
  it('takes https URLs only', () => {
    expect(pictureUrl(' https://example.com/xor.png ')).toBe('https://example.com/xor.png')
    expect(pictureUrl('http://example.com/xor.png')).toBeNull()
    expect(pictureUrl('javascript:alert(1)')).toBeNull()
    expect(pictureUrl('https://example.com/a b.png')).toBeNull()
    expect(pictureUrl('https://example.com/' + 'a'.repeat(3000))).toBeNull()
  })

  it('rides in the kind 0 content beside bot: true', () => {
    const t = profileTemplate({ name: 'XOR', picture: 'https://example.com/xor.png', operator: 'e'.repeat(64) }, 1)
    expect(JSON.parse(t.content)).toEqual({ bot: true, name: 'XOR', picture: 'https://example.com/xor.png' })
  })

  it('reads back the fields a published profile carried', () => {
    expect(publishedFields(JSON.stringify({ bot: true, name: 'XOR', about: 'An agent', picture: 'https://x/y.png' }))).toEqual({ name: 'XOR', about: 'An agent', picture: 'https://x/y.png' })
    expect(publishedFields('not json')).toEqual({})
    expect(publishedFields(undefined)).toEqual({})
  })
})
