// config.ts: the server's settings, from the command line and from
// config.json in the state directory. Arguments win over the file, and the
// file over the defaults. Only --state is required; everything else has a
// default that puts a fresh agent on the canonical relay with modest caps.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOSAKA_DEFAULT_URL } from './hosaka.js'
import { DEFAULT_RELAY } from './nostr/relays.js'
import { parseNwc, Secret } from './nwc.js'
import { DEFAULT_MAX_DAILY_SATS, DEFAULT_MAX_PAYMENT_SATS } from './wallet.js'
import { DEFAULT_TRAVEL_PER_DAY, type TravelLogSettings } from './travel.js'

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
  /** The HOSAKA API a ride with prover "hosaka" is bought from. */
  hosakaUrl: string
  /** The Nostr Wallet Connect string HOSAKA rides are paid from, or null (arkinox, 2026-10-11). A Secret: it never prints. */
  nwc: Secret | null
  /** Where nwc came from, for error sentences: a flag or a file name, never the string. */
  nwcSource: string | null
  /** The most one payment may be, in sats; 0 turns paying off. */
  maxPaymentSats: number
  /** The most the payments of the rolling 24 hours may add up to, in sats; 0 turns paying off. */
  maxDailySats: number
  /** The public travel log: the human's switch, never the model's (arkinox, 2026-10-11). */
  travelLog: TravelLogSettings
}

const DEFAULTS = {
  relays: [DEFAULT_RELAY],
  capCallSeconds: 60,
  capSessionSeconds: 600,
  maxSidestepHeight: 24,
  allowRespawn: false,
  hosakaUrl: HOSAKA_DEFAULT_URL,
  maxPaymentSats: DEFAULT_MAX_PAYMENT_SATS,
  maxDailySats: DEFAULT_MAX_DAILY_SATS,
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
  hosakaUrl?: string
  nwc?: Secret
  maxPaymentSats?: number
  maxDailySats?: number
  travelLog?: boolean
  travelLogMaxPerDay?: number
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
  --hosaka-url <url>            The HOSAKA API rides are bought from (ride with prover "hosaka";
                                your operator pays the invoice). Default ${DEFAULTS.hosakaUrl}
  --nwc <uri>                   A Nostr Wallet Connect string (nostr+walletconnect://...) the
                                server pays its own HOSAKA rides from, within the limits below.
                                A spending key: prefer <state>/wallet.json, since a command line
                                can be read by other users of this machine.
  --max-payment-sats <n>        The most one payment may be. Default ${DEFAULTS.maxPaymentSats}; 0 turns paying off.
  --max-daily-sats <n>          The most the payments of the last 24 hours may add up to.
                                Default ${DEFAULTS.maxDailySats}; 0 turns paying off.
  --travel-log                  Let log_travel post public kind 1 notes about the agent's travels. Off by default.
  --travel-log-max-per-day <n>  The most travel log notes in any 24 hours. Default ${DEFAULT_TRAVEL_PER_DAY}
  --help                        This text.

The same keys may live in <state>/config.json: relays, operator, name, about,
capCallSeconds, capSessionSeconds, maxSidestepHeight, allowRespawn, hosakaUrl,
nwc, maxPaymentSats, maxDailySats, and travelLog: { "enabled": true,
"maxPerDay": 6, "tagOperator": false }. The wallet string may also be the "nwc" key
of <state>/wallet.json, which the server only reads.`

/** An http(s) URL without a trailing slash, or a thrown sentence. */
export function apiUrl(flag: string, value: string | undefined): string {
  if (!value) throw new Error(`${flag} needs a URL`)
  let u: URL
  try {
    u = new URL(value)
  } catch {
    throw new Error(`${flag} must be an http(s) URL; got ${JSON.stringify(value)}`)
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`${flag} must be an http(s) URL; got ${JSON.stringify(value)}`)
  return value.replace(/\/+$/, '')
}

/** A whole number of sats, zero or more, or a thrown sentence. */
function sats(flag: string, value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error(`${flag} must be a whole number of sats, 0 or more`)
  return n
}

/** A connection string, checked now so a bad one stops the server at start, in words that never quote it. */
function nwcSecret(where: string, value: unknown): Secret {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${where} needs a nostr+walletconnect:// string`)
  const secret = new Secret(value.trim())
  parseNwc(secret, where)
  return secret
}

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
      case '--hosaka-url': out.hosakaUrl = apiUrl(a, next()); break
      case '--nwc': out.nwc = nwcSecret(a, next()); break
      case '--max-payment-sats': out.maxPaymentSats = sats(a, next()); break
      case '--max-daily-sats': out.maxDailySats = sats(a, next()); break
      case '--travel-log': out.travelLog = true; break
      case '--travel-log-max-per-day': out.travelLogMaxPerDay = Math.max(1, Math.floor(num(a, next()))); break
      case '--help': case '-h': out.help = true; break
      // An argument that looks like a wallet string is never echoed, even into an error (arkinox, 2026-10-11).
      default: throw new Error(`unknown argument ${/walletconnect|secret=/i.test(a) ? '(it looks like a wallet connection string, so it is not repeated here; use --nwc <uri>)' : JSON.stringify(a)}; try --help`)
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
  hosakaUrl?: unknown
  nwc?: unknown
  maxPaymentSats?: unknown
  maxDailySats?: unknown
  travelLog?: unknown
}

/** <state>/wallet.json, which the human writes and the server only reads: {"nwc": "nostr+walletconnect://..."}. */
interface WalletFile {
  nwc?: unknown
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

/** <state>/wallet.json, or an empty object when there is none. A file that is there and unreadable stops the server, without its contents. */
export function readWalletFile(stateDir: string): WalletFile {
  let raw: string
  try {
    raw = readFileSync(join(stateDir, 'wallet.json'), 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('wallet.json in the state directory is not JSON; it should be {"nwc": "nostr+walletconnect://..."}')
  }
  return parsed && typeof parsed === 'object' ? (parsed as WalletFile) : {}
}

/** The settings: defaults, then the file, then the arguments. The wallet string: --nwc, then wallet.json, then config.json. */
export function settingsFrom(args: ParsedArgs, file: FileConfig, walletFile: WalletFile = {}): Settings {
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
    hosakaUrl: args.hosakaUrl ?? (str(file.hosakaUrl) !== undefined ? apiUrl('config.json hosakaUrl', str(file.hosakaUrl)) : DEFAULTS.hosakaUrl),
    ...nwcSetting(args, file, walletFile),
    maxPaymentSats: args.maxPaymentSats ?? (file.maxPaymentSats !== undefined ? sats('config.json maxPaymentSats', file.maxPaymentSats) : DEFAULTS.maxPaymentSats),
    maxDailySats: args.maxDailySats ?? (file.maxDailySats !== undefined ? sats('config.json maxDailySats', file.maxDailySats) : DEFAULTS.maxDailySats),
    travelLog: travelLogSettings(args, file.travelLog),
  }
}

function nwcSetting(args: ParsedArgs, file: FileConfig, walletFile: WalletFile): { nwc: Secret | null; nwcSource: string | null } {
  if (args.nwc) return { nwc: args.nwc, nwcSource: '--nwc' }
  if (walletFile.nwc !== undefined) return { nwc: nwcSecret('wallet.json nwc', walletFile.nwc), nwcSource: 'wallet.json nwc' }
  if (file.nwc !== undefined) return { nwc: nwcSecret('config.json nwc', file.nwc), nwcSource: 'config.json nwc' }
  return { nwc: null, nwcSource: null }
}

/**
 * The travel log's settings: off unless --travel-log or travelLog.enabled
 * true; the daily limit from the flag, the file, or the default; tagOperator
 * only from the file, and only when it is exactly true. Anything malformed
 * reads as off (arkinox, 2026-10-11).
 */
function travelLogSettings(args: ParsedArgs, raw: unknown): TravelLogSettings {
  const file = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const perDay = typeof file.maxPerDay === 'number' && Number.isFinite(file.maxPerDay) && file.maxPerDay >= 1 ? Math.floor(file.maxPerDay) : undefined
  return {
    enabled: args.travelLog === true || file.enabled === true,
    maxPerDay: args.travelLogMaxPerDay ?? perDay ?? DEFAULT_TRAVEL_PER_DAY,
    tagOperator: file.tagOperator === true,
  }
}
