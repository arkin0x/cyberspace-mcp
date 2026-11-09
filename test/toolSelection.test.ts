// toolSelection.test.ts: the starter tool subset (D7, 2026-11-09, and its
// review). By default, with no operator configured, the server shows nine
// tools (identity, whereami, look, plan_hop, hop, say, listen, find, budget),
// about a sixth of the schema the whole list costs in every turn; --tools all
// (or "tools" in config.json) shows every one and --tools a,b,c picks. An
// agent whose human configured an operator keeps every tool, as before. The
// waker's tools come with the waker whatever the selection; inbox never comes
// without message_operator; the meet prompt only when its tools are shown;
// and the instructions name what is off and how to turn it on.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import type { Agent } from '../src/agent.js'
import { parseArgs, settingsFrom } from '../src/config.js'
import { STARTER_TOOLS, TOOL_NAMES, allToolNames, createServer, selectTools, serverInstructions, type ServerHooks, type ToolSelection } from '../src/server.js'

const WAKER: ServerHooks = { wakeAgain: () => '', workDone: () => '' }

async function connect(tools?: ToolSelection, hooks: ServerHooks = {}): Promise<Client> {
  const server = createServer({} as unknown as Agent, () => {}, hooks, tools === undefined ? {} : { tools })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
  return client
}

const names = async (c: Client): Promise<string[]> => (await c.listTools()).tools.map((t) => t.name).sort()
/** The prompts offered; a server that registers none does not offer prompts at all. */
const prompts = async (c: Client): Promise<string[]> => (c.getServerCapabilities()?.prompts ? (await c.listPrompts()).prompts.map((p) => p.name) : [])

describe('the tool names', () => {
  it('are exactly what createServer registers, waker tools included', () => {
    const seen: string[] = []
    createServer({} as unknown as Agent, () => {}, WAKER, { tools: [], seen })
    expect(seen).toEqual([...TOOL_NAMES])
    expect(allToolNames()).toEqual(TOOL_NAMES)
  })
})

describe('the tool selection', () => {
  it('defaults to the starter set, and to every tool when an operator is configured', () => {
    expect(selectTools(undefined, false)).toEqual(STARTER_TOOLS)
    expect(selectTools(undefined, true)).toBe('all')
    expect(selectTools('all', false)).toBe('all')
    expect(selectTools('starter', true)).toEqual(STARTER_TOOLS)
    expect(STARTER_TOOLS).toEqual(['identity', 'whereami', 'look', 'plan_hop', 'hop', 'say', 'listen', 'find', 'budget'])
    for (const name of STARTER_TOOLS) expect(TOOL_NAMES).toContain(name)
  })

  it('takes a list, drops repeats, refuses unknown names, and never gives inbox without message_operator', () => {
    expect(selectTools(['hop', 'ride', 'hop'], false)).toEqual(['hop', 'ride'])
    expect(() => selectTools(['hop', 'teleport'], false)).toThrow(/no tool named "teleport".*ride/)
    expect(selectTools(['identity', 'inbox'], false)).toEqual(['identity', 'inbox', 'message_operator'])
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
  it('with the starter set lists exactly those nine tools, no meet prompt, and instructions that name what is off', async () => {
    const client = await connect(STARTER_TOOLS)
    const tools = (await client.listTools()).tools
    expect(tools.map((t) => t.name).sort()).toEqual([...STARTER_TOOLS].sort())
    expect(await prompts(client)).toEqual([])
    const instructions = client.getInstructions() ?? ''
    // Without a waker its two tools do not exist, so 39 in all here.
    expect(instructions).toContain('shows 9 of its 39 tools')
    expect(instructions).toContain('--tools all')
    expect(instructions).toContain('"tools" in config.json')
    expect(instructions).toMatch(/: station, board, ride, ride_status, wait_for, hide, .*log_travel\.$/)
    expect(instructions).not.toMatch(/wake_again|work_done/)
    expect(instructions.length).toBeLessThan(1500)
    // About a sixth of the whole list's schema (61 KB, about 15k tokens, on 2026-11-09).
    expect(JSON.stringify(tools).length).toBeLessThan(12_000)
    // A tool left out is not there to call.
    const r = await client.callTool({ name: 'ride', arguments: { to: 1 } })
    expect(r.isError).toBe(true)
    await client.close()
  })

  it('keeps the waker\'s tools whenever a waker runs, whatever the selection', async () => {
    const client = await connect(STARTER_TOOLS, WAKER)
    expect(await names(client)).toEqual([...STARTER_TOOLS, 'wake_again', 'work_done'].sort())
    expect(client.getInstructions()).toContain('shows 11 of its 41 tools')
    await client.close()
  })

  it('with all (the default for a library caller) lists every tool and the meet prompt, and says nothing about --tools', async () => {
    const client = await connect()
    expect((await client.listTools()).tools.length).toBe(TOOL_NAMES.length - 2)
    expect(await prompts(client)).toEqual(['meet'])
    expect(client.getInstructions()).toBe(serverInstructions())
    expect(client.getInstructions()).not.toContain('--tools')
    await client.close()
  })

  it('with a list shows that list, and the meet prompt only once its plan\'s tools are all shown', async () => {
    const few = await connect(selectTools(['hop', 'ride', 'station'], false))
    expect(await names(few)).toEqual(['hop', 'ride', 'station'])
    expect(few.getInstructions()).toContain('shows 3 of its')
    expect(await prompts(few)).toEqual([])
    await few.close()
    // The line's tools alone are not enough: the plan's text also names inbox, message_operator and follow_operator.
    const lineOnly = selectTools([...STARTER_TOOLS, 'station', 'board', 'ride', 'ride_status', 'wait_for'], false)
    const noOperatorTools = await connect(lineOnly)
    expect(await prompts(noOperatorTools)).toEqual([])
    await noOperatorTools.close()
    const line = await connect(selectTools([...lineOnly, 'inbox', 'follow_operator'], false))
    expect(await prompts(line)).toEqual(['meet'])
    await line.close()
  })
})
