// agentsMd.test.ts: the cyberspace://agents.md resource carries the guide as
// the spec repository publishes it (docs/agents.md, read beside the build),
// and the seven rules stay inline as the fallback for a build shipped
// without its docs.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { agentsMarkdown } from '../src/server.js'

describe('the agents.md resource', () => {
  it('is the guide from the spec repository, carried in docs/agents.md', () => {
    const text = agentsMarkdown()
    const file = readFileSync(new URL('../docs/agents.md', import.meta.url), 'utf8')
    expect(text).toBe(file)
    expect(text.startsWith('# Agents in Cyberspace')).toBe(true)
    // The seven rules with no undo, by their first words, in the published order.
    for (const rule of ['Never share a key', 'Before every move, confirm the live head', 'Never publish a spawn after your first', 'Never hand-build a kind 3333 event', 'Meet at stops', 'Mark yourself as a bot', 'Quote before you pay']) {
      expect(text).toContain(rule)
    }
    // The profile convention the AGENTS panel queries by.
    expect(text).toContain('"operator"')
    expect(text).toContain('"bot": true')
    // No placeholder language left.
    expect(text).not.toContain('placeholder')
  })
})
