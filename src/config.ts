// config.ts: the server's settings, from the command line and from
// config.json in the state directory. Arguments win over the file, and the
// file over the defaults. Only --state is required; everything else has a
// default that puts a fresh agent on the canonical relay with modest caps.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_RELAY } from './nostr/relays.js'

export interface Settings {
  stateDir: string
  relays: string[]
  operator?: string
  name?: string
  about?: string
  capCallSeconds: number
  capSessionSeconds: number
  maxSidestepHeight: number
  allowRespawn: boolean
}

const DEFAULTS = {
  relays: [DEFAULT_RELAY],
  capCallSeconds: 60,
  capSessionSeconds: 600,
  maxSidestepHeight: 24,
  allowRespawn: false,
} as const

export interface ParsedArgs {
  state?: string
  relays: string[]
  operator?: string
  name?: string
  about?: string
  capCallSeconds?: number
  capSessionSeconds?: number
  maxSidestepHeight?: number
  allowRespawn?: boolean
  help?: boolean
}

export const USAGE = `cyberspace-mcp: a local MCP server that gives an AI agent a body in cyberspace.

Usage: cyberspace-mcp --state <dir> [options]

  --state <dir>                 The state directory (required): the key, the chain, the outbox.
  --relay <url>                 A relay; repeatable. The first is the canonical relay. Default ${DEFAULT_RELAY}
  --operator <npub>             The human responsible for this agent, named in its profile.
  --name <name>                 The profile name.
  --about <text>                The profile text.
  --cap-call-seconds <n>        The most compute one hop may spend. Default ${DEFAULTS.capCallSeconds}
  --cap-session-seconds <n>     The most compute the session may spend. Default ${DEFAULTS.capSessionSeconds}
  --max-sidestep-height <h>     Sidesteps above this height are refused. Default ${DEFAULTS.maxSidestepHeight}
  --allow-respawn               Let hop sign a new spawn on a dead or frozen chain.
  --help                        This text.

The same keys may live in <state>/config.json: relays, operator, name, about,
capCallSeconds, capSessionSeconds, maxSidestepHeight, allowRespawn.`

function num(flag: string, value: string | undefined): number {
  if (value === undefined) throw new Error(`${flag} needs a value`)
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number; got ${JSON.stringify(value)}`)
  return n
}

/** Parse argv (without node and the script). Throws with a sentence on a bad flag. */
export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { relays: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string | undefined => argv[++i]
    switch (a) {
      case '--state': out.state = next(); if (!out.state) throw new Error('--state needs a directory'); break
      case '--relay': { const r = next(); if (!r) throw new Error('--relay needs a URL'); out.relays.push(r); break }
      case '--operator': out.operator = next(); if (!out.operator) throw new Error('--operator needs an npub'); break
      case '--name': out.name = next(); if (out.name === undefined) throw new Error('--name needs a value'); break
      case '--about': out.about = next(); if (out.about === undefined) throw new Error('--about needs a value'); break
      case '--cap-call-seconds': out.capCallSeconds = num(a, next()); break
      case '--cap-session-seconds': out.capSessionSeconds = num(a, next()); break
      case '--max-sidestep-height': out.maxSidestepHeight = Math.floor(num(a, next())); break
      case '--allow-respawn': out.allowRespawn = true; break
      case '--help': case '-h': out.help = true; break
      default: throw new Error(`unknown argument ${JSON.stringify(a)}; try --help`)
    }
  }
  return out
}

interface FileConfig {
  relays?: unknown
  operator?: unknown
  name?: unknown
  about?: unknown
  capCallSeconds?: unknown
  capSessionSeconds?: unknown
  maxSidestepHeight?: unknown
  allowRespawn?: unknown
}

/** config.json in the state directory, or an empty object when there is none or it is not JSON. */
export function readFileConfig(stateDir: string): FileConfig {
  try {
    const raw = readFileSync(join(stateDir, 'config.json'), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as FileConfig) : {}
  } catch {
    return {}
  }
}

/** The settings: defaults, then the file, then the arguments. */
export function settingsFrom(args: ParsedArgs, file: FileConfig): Settings {
  if (!args.state) throw new Error('--state <dir> is required')
  const fileRelays = Array.isArray(file.relays) ? file.relays.filter((r): r is string => typeof r === 'string') : []
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
  const posNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)
  return {
    stateDir: args.state,
    relays: args.relays.length ? args.relays : fileRelays.length ? fileRelays : [...DEFAULTS.relays],
    operator: args.operator ?? str(file.operator),
    name: args.name ?? str(file.name),
    about: args.about ?? str(file.about),
    capCallSeconds: args.capCallSeconds ?? posNum(file.capCallSeconds) ?? DEFAULTS.capCallSeconds,
    capSessionSeconds: args.capSessionSeconds ?? posNum(file.capSessionSeconds) ?? DEFAULTS.capSessionSeconds,
    maxSidestepHeight: args.maxSidestepHeight ?? (posNum(file.maxSidestepHeight) !== undefined ? Math.floor(posNum(file.maxSidestepHeight)!) : DEFAULTS.maxSidestepHeight),
    allowRespawn: args.allowRespawn ?? (typeof file.allowRespawn === 'boolean' ? file.allowRespawn : DEFAULTS.allowRespawn),
  }
}
