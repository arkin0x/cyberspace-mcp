// init.ts: `cyberspace-mcp init`, the first run (arkinox, 2026-10-13). It
// makes the state directory and the agent's key, writes config.json with the
// operator, the name, the caps and the wake command, publishes the agent's
// profile (bot: true, the operator named) so the operator's ONOSENDAI can
// see it, and prints the MCP URL and the client configuration. Flags answer
// every question; on a terminal it asks for what the flags left out. The
// key is never printed: only the npub.

import { accessSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { nip19 } from 'nostr-tools'
import { Agent, type AgentConfig } from './agent.js'
import { parsePubkey } from './chain/resolve.js'
import { readFileConfig, readWalletFile, settingsFrom } from './config.js'
import { ensureToken, TOKEN_FILE } from './http.js'
import { DEFAULT_PORT, PROMPT_PLACEHOLDER, defaultStateDir, mcpUrl } from './serveConfig.js'
import { LockHeldError, StateDir } from './state/dir.js'
import { getPublicKey } from 'nostr-tools/pure'

export const INIT_USAGE = `cyberspace-mcp init: set up an agent, once.

Usage: cyberspace-mcp init [options]

  --state <dir>              The state directory. Default $CYBERSPACE_MCP_STATE, else ~/.cyberspace-mcp
  --operator <npub>          Your npub: the human this agent answers to (required).
  --name <name>              The agent's name in its profile.
  --about <text>             The agent's profile text.
  --cap-call-seconds <n>     The most compute one hop may spend. Default 60
  --cap-session-seconds <n>  The most compute a session may spend. Default 600
  --relay <url>              A relay; repeatable; the first is canonical. Default the ONOSENDAI relay.
  --client <name>            Who runs the agent's turns: claude (Claude Code), hermes, or none. Default: claude
                             when it is installed, else hermes when it is, else none.
  --hermes-profile <name>    The Hermes profile for --client hermes. Default cyberspace
  --reply-model <model>      A faster model for replies. Default haiku for claude; none for hermes.
  --wake-command <cmd>       A wake command of your own instead of a client's ({prompt} where the prompt goes).
  --reply-command <cmd>      The same, for replies.
  --port <n>                 The port serve will listen on. Default ${DEFAULT_PORT}
  --token                    Require a bearer token on the MCP URL (made now, kept in <state>/${TOKEN_FILE}).
  --no-publish               Do not publish the profile now (identity publishes it later).
  --yes                      Ask nothing; fail when --operator is missing.
  --help                     This text.

Run it again to change a setting: what you pass replaces what config.json says, and the rest stays.`

interface InitArgs {
  state?: string
  operator?: string
  name?: string
  about?: string
  capCallSeconds?: number
  capSessionSeconds?: number
  relays: string[]
  client?: 'claude' | 'hermes' | 'none'
  hermesProfile?: string
  replyModel?: string
  wakeCommand?: string
  replyCommand?: string
  port?: number
  token?: boolean
  publish: boolean
  yes: boolean
  help: boolean
}

function parseInitArgs(argv: string[]): InitArgs {
  const out: InitArgs = { relays: [], publish: true, yes: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    const positive = (): number => {
      const v = value()
      const n = Number(v)
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${a} must be a positive number; got ${JSON.stringify(v)}`)
      return n
    }
    switch (a) {
      case '--state': out.state = value(); break
      case '--operator': out.operator = value(); break
      case '--name': out.name = value(); break
      case '--about': out.about = value(); break
      case '--cap-call-seconds': out.capCallSeconds = positive(); break
      case '--cap-session-seconds': out.capSessionSeconds = positive(); break
      case '--relay': out.relays.push(value()); break
      case '--client': {
        const c = value()
        if (c !== 'claude' && c !== 'hermes' && c !== 'none') throw new Error(`--client must be claude, hermes or none; got ${JSON.stringify(c)}`)
        out.client = c
        break
      }
      case '--hermes-profile': out.hermesProfile = value(); break
      case '--reply-model': out.replyModel = value(); break
      case '--wake-command': out.wakeCommand = value(); break
      case '--reply-command': out.replyCommand = value(); break
      case '--port': {
        const n = Number(value())
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('--port must be a port number, 1 to 65535')
        out.port = n
        break
      }
      case '--token': out.token = true; break
      case '--no-publish': out.publish = false; break
      case '--yes': case '-y': out.yes = true; break
      case '--help': case '-h': out.help = true; break
      default: throw new Error(`unknown argument ${JSON.stringify(a)}; try cyberspace-mcp init --help`)
    }
  }
  return out
}

/** Where a command is on the PATH (no shell), or null. */
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    try {
      accessSync(join(dir, cmd), constants.X_OK)
      return join(dir, cmd)
    } catch { /* not here */ }
  }
  return null
}

/** Quote one word for a command line, so splitCommand gives it back whole. */
function q(word: string): string {
  return word !== '' && /^[A-Za-z0-9_@%+=:,./{}-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/** The wake commands of a client preset, as command lines config.json keeps. */
export function presetCommands(client: 'claude' | 'hermes', opts: { stateDir: string; hermesProfile: string; replyModel?: string; env?: NodeJS.ProcessEnv }): { command: string; replyCommand: string | null } {
  // The full path when it is on this PATH: serve under systemd or launchd starts with a short PATH that may not reach it.
  const exe = q(which(client, opts.env) ?? client)
  if (client === 'claude') {
    // -p runs one turn and exits; the prompt comes right after it, before the
    // flags that take lists. --tools '' removes every built-in tool (no
    // shell, no files, whatever the user's settings allow), so the turn has
    // only this server's tools, pre-approved by --allowedTools; it streams
    // its steps so the watchdog sees it working (checked with Claude Code
    // 2.1.294, arkinox 2026-10-13).
    const base = (model?: string): string => [
      exe, '-p', PROMPT_PLACEHOLDER,
      ...(model ? ['--model', q(model)] : []),
      '--mcp-config', q(join(opts.stateDir, 'claude-mcp.json')), '--strict-mcp-config',
      '--tools', q(''), '--allowedTools', 'mcp__cyberspace',
      '--output-format', 'stream-json', '--verbose',
    ].join(' ')
    const reply = opts.replyModel ?? 'haiku'
    return { command: base(), replyCommand: base(reply) }
  }
  const base = (model?: string): string => [exe, '-p', q(opts.hermesProfile), ...(model ? ['-m', q(model)] : []), '-z', PROMPT_PLACEHOLDER].join(' ')
  return { command: base(), replyCommand: opts.replyModel ? base(opts.replyModel) : null }
}

/** The Claude Code MCP configuration file for this server: the URL, and the token header when there is one. */
export function claudeMcpConfig(url: string, token: string | null): Record<string, unknown> {
  return { mcpServers: { cyberspace: { type: 'http', url, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) } } }
}

export interface InitDeps {
  print: (line: string) => void
  /** A question on a terminal; absent when nobody can answer. */
  ask?: (question: string, fallback?: string) => Promise<string>
  /** Tests: the fake network, a calibration, short waits. */
  agent?: Partial<AgentConfig>
  env?: NodeJS.ProcessEnv
}

/** Run init; returns the exit code. */
export async function runInit(argv: string[], deps: InitDeps): Promise<number> {
  const { print } = deps
  const env = deps.env ?? process.env
  const args = parseInitArgs(argv)
  if (args.help) {
    print(INIT_USAGE)
    return 0
  }
  const ask = args.yes ? undefined : deps.ask
  const stateDir = args.state ?? defaultStateDir(env)
  const configPath = join(stateDir, 'config.json')
  const existing: Record<string, unknown> = existsSync(configPath) ? safeJson(readFileSync(configPath, 'utf8')) : {}

  // The operator: the flag, else what config.json says, else the question.
  let operator = args.operator ?? (typeof existing.operator === 'string' ? existing.operator : undefined)
  if (!operator && ask) operator = (await ask('Your npub (the operator this agent answers to): ')).trim()
  if (!operator) {
    print('init needs your npub: cyberspace-mcp init --operator npub1...')
    return 2
  }
  const opHex = parsePubkey(operator)
  if (!opHex) {
    print(`That is not an npub: ${JSON.stringify(operator)}. Pass your npub1... (your public key; never your nsec).`)
    return 2
  }
  operator = nip19.npubEncode(opHex)
  let name = args.name ?? (typeof existing.name === 'string' ? existing.name : undefined)
  if (!name && ask) name = (await ask('A name for your agent: ', 'agent')).trim() || 'agent'

  // Who runs the turns.
  const wakeExisting = existing.wake && typeof existing.wake === 'object' ? existing.wake as Record<string, unknown> : {}
  let client = args.client
  if (!client && !args.wakeCommand && wakeExisting.command === undefined) {
    const guess = which('claude', env) ? 'claude' : which('hermes', env) ? 'hermes' : 'none'
    const answer = ask ? (await ask('Who runs your agent\'s turns: claude, hermes or none? ', guess)).trim() || guess : guess
    if (answer !== 'claude' && answer !== 'hermes' && answer !== 'none') {
      print(`Unknown client ${JSON.stringify(answer)}: claude, hermes or none.`)
      return 2
    }
    client = answer
  }
  let hermesProfile = args.hermesProfile ?? 'cyberspace'
  if (client === 'hermes' && !args.hermesProfile && ask) hermesProfile = (await ask('Hermes profile: ', 'cyberspace')).trim() || 'cyberspace'

  const dir = StateDir.open(stateDir)
  const port = args.port ?? (existing.serve && typeof (existing.serve as Record<string, unknown>).port === 'number' ? (existing.serve as Record<string, number>).port : DEFAULT_PORT)
  const url = mcpUrl(port)
  const tokenOn = args.token ?? (existing.serve && (existing.serve as Record<string, unknown>).token === true)
  const token = tokenOn ? ensureToken(stateDir).token : null

  // config.json: what was given replaces what was there; everything else stays.
  const config: Record<string, unknown> = { ...existing, operator }
  if (name) config.name = name
  if (args.about !== undefined) config.about = args.about
  if (args.capCallSeconds !== undefined) config.capCallSeconds = args.capCallSeconds
  if (args.capSessionSeconds !== undefined) config.capSessionSeconds = args.capSessionSeconds
  if (args.relays.length) config.relays = args.relays
  const serve: Record<string, unknown> = { ...(existing.serve && typeof existing.serve === 'object' ? existing.serve as Record<string, unknown> : {}) }
  if (args.port !== undefined) serve.port = args.port
  if (args.token) serve.token = true
  if (Object.keys(serve).length) config.serve = serve
  const wake: Record<string, unknown> = { ...wakeExisting }
  if (client === 'claude' || client === 'hermes') {
    const preset = presetCommands(client, { stateDir, hermesProfile, replyModel: args.replyModel, env })
    wake.command = preset.command
    if (preset.replyCommand) wake.replyCommand = preset.replyCommand
    else delete wake.replyCommand
  } else if (client === 'none') {
    delete wake.command
    delete wake.replyCommand
  }
  if (args.wakeCommand) wake.command = args.wakeCommand
  if (args.replyCommand) wake.replyCommand = args.replyCommand
  if (Object.keys(wake).length) config.wake = wake
  else delete config.wake
  dir.writeJson('config.json', config)
  if (client === 'claude' || (typeof wake.command === 'string' && /(^|\/)claude\s/.test(wake.command))) {
    writeFileSync(join(stateDir, 'claude-mcp.json'), JSON.stringify(claudeMcpConfig(url, token), null, 2) + '\n', { mode: 0o600 })
  }

  // The key: made now if there is none. Only its public half is ever shown.
  const sk = dir.loadOrCreateKey()
  const npub = nip19.npubEncode(getPublicKey(sk))
  print(`Agent: ${npub}`)
  print(`State: ${stateDir} (the key is in ${join(stateDir, 'key')}; never share it, never copy it to another agent)`)
  print(`Operator: ${operator}`)

  if (args.publish) await publishProfile(stateDir, deps, print)

  print('')
  print(`MCP URL: ${url}${token ? ` (bearer token in ${join(stateDir, TOKEN_FILE)})` : ''}`)
  print('')
  print('Connect a client to talk to your agent yourself:')
  const header = token ? ` --header "Authorization: Bearer $(cat ${join(stateDir, TOKEN_FILE)})"` : ''
  print(`  Claude Code:  claude mcp add --transport http cyberspace ${url}${header}`)
  print(`  Hermes:       hermes -p ${hermesProfile} mcp add cyberspace --url ${url}`)
  if (token) print(`                (with a token, add headers: { Authorization: "Bearer <token>" } under mcp_servers.cyberspace in the profile's config.yaml)`)
  print('')
  if (wake.command) print(`Waker: ${typeof wake.command === 'string' ? wake.command : JSON.stringify(wake.command)}`)
  else print('Waker: none. Your agent acts only when you prompt it. Set one with cyberspace-mcp init --client claude (or hermes, or --wake-command).')
  if (client === 'hermes') {
    print(`  Hermes needs the server in that profile once: hermes -p ${hermesProfile} mcp add cyberspace --url ${url}`)
  }
  print('')
  if (!which('cyberspace-mcp', env)) {
    print('cyberspace-mcp is not on your PATH yet (npx runs it from a cache). Install it so serve and doctor run by name:')
    print('  npm i -g github:arkin0x/cyberspace-mcp')
    print('')
  }
  print('Next:')
  print(`  1. In ONOSENDAI, signed in as ${operator}, follow ${npub}. Orders count only from an operator who follows the agent.`)
  print('  2. Your account needs a DM inbox (a kind 10050 relay list); doctor checks it.')
  print('  3. cyberspace-mcp serve        (keep it running; see QUICKSTART.md for systemd and launchd)')
  print('  4. cyberspace-mcp doctor       (says what is missing and how to fix it)')
  print('  5. Send your agent a DM in ONOSENDAI. It reacts 👀 within 15 s and answers when its turn ends.')
  return 0
}

/** Start the agent once to publish its profile, unless a server already holds the state directory. */
async function publishProfile(stateDir: string, deps: InitDeps, print: (line: string) => void): Promise<void> {
  const settings = settingsFrom({ state: stateDir, relays: [] }, readFileConfig(stateDir), readWalletFile(stateDir))
  let agent: Agent
  try {
    agent = await Agent.start({ ...settings, ...deps.agent })
  } catch (err) {
    if (err instanceof LockHeldError) {
      print('A cyberspace-mcp is running on this state directory, so the profile was not published from here. Restart serve to pick up the new settings.')
      return
    }
    print(`Could not start the agent to publish its profile: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  try {
    const r = await agent.identity({})
    const profile = r.data.profile as { status: string }
    print(profile.status === 'refused' ? `Profile NOT published: ${r.text.split('\n').find((l) => l.startsWith('Profile')) ?? ''}` : (r.text.split('\n').find((l) => l.startsWith('Profile')) ?? 'Profile published.'))
    // The agent's own DM inbox (kind 10050), copied from the operator's when they have one.
    try { await agent.operatorChannel.sync() } catch { /* doctor says it */ }
  } catch (err) {
    print(`Profile NOT published: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await agent.stop()
  }
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  } catch {
    return {}
  }
}
