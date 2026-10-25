#!/usr/bin/env node
// bin.ts: the command. With no subcommand (or `stdio`) it is the stdio MCP
// server it always was: parses the arguments and config.json, starts the
// agent (lock, key, calibration, outbox replay), and serves MCP over stdio.
// stdout is the MCP channel there, so every line of diagnostics goes to
// stderr, and the console's stdout writers are pointed there too, in case a
// library logs. A second server on the same state directory prints the
// lock's message and exits 1.
//
// The subcommands (arkinox, 2026-10-13): `serve` (one long-lived agent over
// HTTP on 127.0.0.1, with its waker), `init` (the first run), `doctor` (what
// is missing), and `wake pause|resume|status`.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Agent } from './agent.js'
import { parseArgs, readFileConfig, readWalletFile, settingsFrom, USAGE } from './config.js'
import { createServer } from './server.js'
import { LockHeldError } from './state/dir.js'
import { runDoctor } from './doctor.js'
import { runInit } from './init.js'
import { HelpRequested, startServe } from './serve.js'
import { defaultStateDir, SERVE_USAGE } from './serveConfig.js'
import { PAUSE_FILE } from './waker.js'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'

const log = (line: string): void => { process.stderr.write(`[cyberspace-mcp] ${line}\n`) }

// Nothing but MCP frames may reach stdout.
console.log = (...args: unknown[]) => log(args.map(String).join(' '))
console.info = console.log
console.debug = console.log

async function stdio(argv: string[]): Promise<void> {
  let args
  try {
    args = parseArgs(argv)
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
    settings = settingsFrom(args, args.state ? readFileConfig(args.state) : {}, args.state ? readWalletFile(args.state) : {})
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
  const stop = async (why: string, code = 0): Promise<void> => {
    if (stopping) return
    stopping = true
    log(`stopping: ${why}`)
    try { await agent.stop() } catch { /* already down */ }
    try { await server.close() } catch { /* already closed */ }
    process.exit(code)
  }
  // A server that lost its lock stops and exits non-zero, so its supervisor restarts it through the lock (lock.ts).
  agent.onLockLost((reason) => { void stop(`this server lost its lock (${reason})`, 1) })
  process.on('SIGINT', () => { void stop('SIGINT') })
  process.on('SIGTERM', () => { void stop('SIGTERM') })
  transport.onclose = () => { void stop('the client closed the connection') }
  await server.connect(transport)
}

const print = (line: string): void => { process.stdout.write(`${line}\n`) }

async function serve(argv: string[]): Promise<void> {
  let serving
  try {
    serving = await startServe(argv, { log, print })
  } catch (err) {
    if (err instanceof HelpRequested) {
      print(SERVE_USAGE)
      process.exit(0)
    }
    if (err instanceof LockHeldError) {
      process.stderr.write(`${err.message}\n`)
      process.exit(1)
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(err instanceof Error && /^(--|config\.json|unknown argument|the command)/.test(err.message) ? 2 : 1)
  }
  let stopping = false
  const stop = async (why: string, code = 0): Promise<void> => {
    if (stopping) return
    stopping = true
    log(`stopping: ${why}`)
    try { await serving.stop() } catch (err) { log(`stop: ${err instanceof Error ? err.message : String(err)}`) }
    process.exit(code)
  }
  // A server that lost its lock stops (the waker and every turn with it) and exits non-zero, so its supervisor restarts it through the lock (lock.ts).
  serving.agent.onLockLost((reason) => { void stop(`this server lost its lock (${reason})`, 1) })
  process.on('SIGINT', () => { void stop('SIGINT') })
  process.on('SIGTERM', () => { void stop('SIGTERM') })
  // A long-lived server outlives a library's stray promise: nostr-tools sends
  // an AUTH from a promise nobody awaits, which rejects when that one socket
  // has just closed. Logged, and the agent goes on (arkinox, 2026-10-13).
  process.on('unhandledRejection', (err) => {
    log(`unhandled rejection (the server goes on): ${err instanceof Error ? err.message : String(err)}`)
  })
}

async function init(argv: string[]): Promise<void> {
  const tty = process.stdin.isTTY && process.stdout.isTTY
  const rl = tty ? createInterface({ input: process.stdin, output: process.stdout }) : null
  try {
    const code = await runInit(argv, {
      print,
      ask: rl ? async (question, fallback) => (await rl.question(fallback ? `${question}[${fallback}] ` : question)) || fallback || '' : undefined,
    })
    process.exitCode = code
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 2
  } finally {
    rl?.close()
  }
}

async function doctor(argv: string[]): Promise<void> {
  try {
    const { code } = await runDoctor(argv, { print })
    process.exit(code)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  }
}

/** wake pause | resume | status [--state <dir>]: the pause file the waker reads every poll. */
function wake(argv: string[]): void {
  const [verb, ...rest] = argv
  let state = defaultStateDir()
  for (let i = 0; i < rest.length; i++) if (rest[i] === '--state' && rest[i + 1]) state = rest[++i]
  const file = join(state, PAUSE_FILE)
  if (verb === 'pause') {
    writeFileSync(file, `paused ${new Date().toISOString()}\n`)
    print(`Waker paused (${file}). A turn under way runs to its end. Resume with: cyberspace-mcp wake resume`)
  } else if (verb === 'resume') {
    if (existsSync(file)) unlinkSync(file)
    print('Waker resumed: it looks again within one poll.')
  } else if (verb === 'status') {
    let lock: { pid?: number } | null = null
    try { lock = JSON.parse(readFileSync(join(state, 'lock'), 'utf8')) as { pid?: number } } catch { lock = null }
    print(`${existsSync(file) ? 'paused' : 'not paused'}; ${lock?.pid ? `a server holds ${state} (pid ${lock.pid})` : `no server holds ${state}`}`)
  } else {
    process.stderr.write('Usage: cyberspace-mcp wake pause|resume|status [--state <dir>]\n')
    process.exit(2)
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const [first, ...rest] = argv
  switch (first) {
    case 'serve': return serve(rest)
    case 'init': return init(rest)
    case 'doctor': return doctor(rest)
    case 'wake': return wake(rest)
    case 'stdio': return stdio(rest)
    default: return stdio(argv)
  }
}

main().catch((err) => {
  process.stderr.write(`cyberspace-mcp failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
