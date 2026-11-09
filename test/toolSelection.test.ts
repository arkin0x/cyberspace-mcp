// toolSelection.test.ts: the starter tool subset (D7, 2026-11-09). By default
// the server shows ten tools (identity, whereami, look, plan_hop, hop, say,
// listen, find, budget, inbox), about a fifth of the schema the whole list
// costs in every turn; --tools all (or "tools" in config.json) shows every
// one and --tools a,b,c picks. An agent whose human configured an operator
// keeps every tool, as before. The instructions say how to show more.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import type { Agent } from '../src/agent.js'
import { parseArgs, settingsFrom } from '../src/config.js'
import { STARTER_TOOLS, allToolNames, createServer, selectTools, serverInstructions, type ToolSelection } from '../src/server.js'

async function connect(tools?: ToolSelection): Promise<Client> {
  const server = createServer({} as unknown as Agent, () => {}, {}, tools === undefined ? {} : { tools })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
  return client
}

describe('the tool selection', () => {
  it('defaults to the starter set, and to every tool when an operator is configured', () => {
    expect(selectTools(undefined, false)).toEqual(STARTER_TOOLS)
    expect(selectTools(undefined, true)).toBe('all')
    expect(selectTools('all', false)).toBe('all')
    expect(selectTools('starter', true)).toEqual(STARTER_TOOLS)
    expect(selectTools(['hop', 'ride', 'hop'], false)).toEqual(['hop', 'ride'])
    expect(() => selectTools(['hop', 'teleport'], false)).toThrow(/no tool named "teleport".*ride/)
    expect(STARTER_TOOLS).toEqual(['identity', 'whereami', 'look', 'plan_hop', 'hop', 'say', 'listen', 'find', 'budget', 'inbox'])
    for (const name of STARTER_TOOLS) expect(allToolNames()).toContain(name)
    // The waker's tools are names too, though only serve with a waker registers them.
    expect(allToolNames()).toEqual(expect.arrayContaining(['wake_again', 'work_done']))
  })

  it('comes from --tools or config.json tools, the flag first', () => {
    const base = { state: '/tmp/x', relays: [] }
    expect(settingsFrom(base, {}).tools).toBeUndefined()
    expect(settingsFrom(parseArgs(['--state', '/tmp/x', '--tools', 'all']), {}).tools).toBe('all')
    expect(settingsFrom(parseArgs(['--state', '/tmp/x', '--tools', 'hop, ride ,station']), {}).tools).toEqual(['hop', 'ride', 'station'])
    expect(settingsFrom(base, { tools: ['place', 'items'] }).tools).toEqual(['place', 'items'])
    expect(settingsFrom(base, { tools: 'starter' }).tools).toBe('starter')
    expect(settingsFrom(parseArgs(['--state', '/tmp/x', '--tools', 'starter']), { tools: 'all' }).tools).toBe('starter')
    expect(() => parseArgs(['--tools', ''])).toThrow(/needs all, starter/)
    expect(() => settingsFrom(base, { tools: 7 })).toThrow(/config.json tools/)
  })
})

describe('the server', () => {
  it('with the starter set lists exactly those ten tools, and says in its instructions how to show more', async () => {
    const client = await connect(STARTER_TOOLS)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...STARTER_TOOLS].sort())
    const instructions = client.getInstructions() ?? ''
    expect(instructions).toContain(`shows 10 of its ${allToolNames().length} tools`)
    expect(instructions).toContain('--tools all')
    expect(instructions).toContain('"tools" in config.json')
    expect(instructions.length).toBeLessThan(1200)
    // About a fifth of the whole list's schema (61 KB, about 15k tokens, on 2026-11-09).
    expect(JSON.stringify(tools).length).toBeLessThan(15_000)
    // A tool left out is not there to call.
    const r = await client.callTool({ name: 'ride', arguments: { to: 1 } })
    expect(r.isError).toBe(true)
    await client.close()
  })

  it('with all (the default for a library caller) lists every tool and says nothing about --tools', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    // The waker's two tools are registered only when serve runs a waker.
    expect(tools.length).toBe(allToolNames().length - 2)
    expect(client.getInstructions()).toBe(serverInstructions())
    expect(client.getInstructions()).not.toContain('--tools')
    await client.close()
  })

  it('with a list shows that list', async () => {
    const client = await connect(selectTools(['hop', 'ride', 'station'], false))
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['hop', 'ride', 'station'])
    expect(client.getInstructions()).toContain('shows 3 of its')
    await client.close()
  })
})
