#!/usr/bin/env node
// bin.ts: the command. Parses the arguments and config.json, starts the
// agent (lock, key, calibration, outbox replay), and serves MCP over stdio.
// stdout is the MCP channel, so every line of diagnostics goes to stderr,
// and the console's stdout writers are pointed there too, in case a library
// logs. A second server on the same state directory prints the lock's
// message and exits 1.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Agent } from './agent.js'
import { parseArgs, readFileConfig, settingsFrom, USAGE } from './config.js'
import { createServer } from './server.js'
import { LockHeldError } from './state/dir.js'

const log = (line: string): void => { process.stderr.write(`[cyberspace-mcp] ${line}\n`) }

// Nothing but MCP frames may reach stdout.
console.log = (...args: unknown[]) => log(args.map(String).join(' '))
console.info = console.log
console.debug = console.log

async function main(): Promise<void> {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}\n`)
    process.exit(2)
  }
  if (args.help) {
    process.stderr.write(`${USAGE}\n`)
    process.exit(0)
  }
  let settings
  try {
    settings = settingsFrom(args, args.state ? readFileConfig(args.state) : {})
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}\n`)
    process.exit(2)
  }

  let agent: Agent
  try {
    agent = await Agent.start({ ...settings, log })
  } catch (err) {
    if (err instanceof LockHeldError) {
      process.stderr.write(`${err.message}\n`)
      process.exit(1)
    }
    throw err
  }
  log(`agent ${agent.npub} on ${settings.relays.join(', ')} (canonical ${settings.relays[0]}); state in ${settings.stateDir}`)

  const server = createServer(agent, log)
  const transport = new StdioServerTransport()
  let stopping = false
  const stop = async (why: string): Promise<void> => {
    if (stopping) return
    stopping = true
    log(`stopping: ${why}`)
    try { await agent.stop() } catch { /* already down */ }
    try { await server.close() } catch { /* already closed */ }
    process.exit(0)
  }
  process.on('SIGINT', () => { void stop('SIGINT') })
  process.on('SIGTERM', () => { void stop('SIGTERM') })
  transport.onclose = () => { void stop('the client closed the connection') }
  await server.connect(transport)
}

main().catch((err) => {
  process.stderr.write(`cyberspace-mcp failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
