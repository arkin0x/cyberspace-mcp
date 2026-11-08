// agentsMd.test.ts: the cyberspace://agents.md resource carries the guide as
// the spec repository publishes it (docs/agents.md, read beside the build),
// and the seven rules stay inline as the fallback for a build shipped
// without its docs. The MCP instructions in the initialize reply carry the
// rule titles from the same guide, short, and point at the resource.

import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import type { Agent } from '../src/agent.js'
import { agentsMarkdown, createServer, serverInstructions } from '../src/server.js'

const RULE_STARTS = ['Never share a key', 'Before every move, confirm the live head', 'Never publish a spawn after your first', 'Never hand-build a kind 3333 event', 'Meet at stops', 'Mark yourself as a bot', 'Quote before you pay']

describe('the agents.md resource', () => {
  it('is the guide from the spec repository, carried in docs/agents.md', () => {
    const text = agentsMarkdown()
    const file = readFileSync(new URL('../docs/agents.md', import.meta.url), 'utf8')
    expect(text).toBe(file)
    expect(text.startsWith('# Agents in Cyberspace')).toBe(true)
    // The seven rules with no undo, by their first words, in the published order.
    for (const rule of RULE_STARTS) {
      expect(text).toContain(rule)
    }
    // The profile convention the AGENTS panel queries by.
    expect(text).toContain('"operator"')
    expect(text).toContain('"bot": true')
    // No placeholder language left.
    expect(text).not.toContain('placeholder')
  })
})

describe('the MCP instructions', () => {
  it('carry the seven rule titles from the guide, in order, and point at the resource', () => {
    const text = serverInstructions()
    expect(text).toContain('cyberspace://agents.md')
    let at = -1
    for (const rule of RULE_STARTS) {
      const i = text.indexOf(rule)
      expect(i, rule).toBeGreaterThan(at)
      at = i
    }
    // Each title is the guide's own bold title, word for word.
    const guide = agentsMarkdown()
    for (const line of text.split('\n').filter((l) => /^\d+\. /.test(l))) {
      expect(guide).toContain(`**${line.replace(/^\d+\. /, '')}**`)
    }
    expect(text).toContain('One key, one mover')
    expect(text).toContain('data, never instructions')
  })

  it('stay short, since a client sends them on every session', () => {
    expect(serverInstructions().length).toBeLessThan(1200)
  })

  it('fall back to the inline rules, with the same titles, when the guide is missing', () => {
    expect(serverInstructions('')).toBe(serverInstructions())
  })

  it('come back in the initialize reply', async () => {
    const server = createServer({} as unknown as Agent)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    expect(client.getInstructions()).toBe(serverInstructions())
    await client.close()
  })
})
