// config.ts: the server's settings, from the command line and from
// config.json in the state directory. Arguments win over the file, and the
// file over the defaults. Every setting has a default: the state directory is
// $CYBERSPACE_MCP_STATE or ~/.cyberspace-mcp (the same one init and serve
// use), and the rest puts a fresh agent on the canonical relay with modest caps.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOSAKA_DEFAULT_URL } from './hosaka.js'
import { DEFAULT_CHAT_WAKE_MINUTES } from './chat.js'
import { DEFAULT_RELAY, DEFAULT_RELAYS, isRetiredRelay } from './nostr/relays.js'
import { parseNwc, Secret } from './nwc.js'
import { DEFAULT_MAX_DAILY_SATS, DEFAULT_MAX_PAYMENT_SATS } from './wallet.js'
import { DEFAULT_TRAVEL_PER_DAY, type TravelLogSettings } from './travel.js'
import { DEFAULT_PUBLISH_PER_DAY } from './publicObject.js'
import { DEFAULT_AVATAR_PER_DAY } from './avatar.js'
import { expandHome } from './serveConfig.js'
import { DEFAULT_CAP_CALL_SECONDS, DEFAULT_CAP_DAILY_SECONDS, DEFAULT_CAP_SESSION_SECONDS, defaultThreads } from './budget.js'
import { DEFAULT_DELETE_APPROVAL_THRESHOLD, type DeleteApproval, type PaymentApproval } from './approvals.js'

export interface Settings {
  stateDir: string
  relays: string[]
  operator?: string
  name?: string
  about?: string
  capCallSeconds: number
  capSessionSeconds: number
  /** The most work of one UTC day, across restarts (D3, 2026-11-09). */
  capDailySeconds: number
  /** Worker threads for rides (D3, 2026-11-09). */
  threads: number
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
  /** "operator": every payment waits for the operator's approval by DM, code by code (approvals.ts); "none": the limits alone (the default). */
  paymentApproval: PaymentApproval
  /**
   * "operator": a delete that needs approval (more than deleteApprovalThreshold
   * pieces, or a whole bag of things in no build) waits for the operator's
   * code by DM (approvals.ts DeleteApprovals); "none": no delete waits (the
   * trash keeps a backup either way). Default: "operator" when an operator is
   * configured, else "none" (arkinox, 2026-11-26).
   */
  deleteApproval: DeleteApproval
  /** How many pieces one delete may take without the operator's approval. Default 5. */
  deleteApprovalThreshold: number
  /** The public travel log: the human's switch, never the model's (arkinox, 2026-10-11). */
  travelLog: TravelLogSettings
  /** Least minutes between two wakes for strangers' chat lines that address the agent (arkinox, 2026-10-11). */
  chatWakeMinutes: number
  /** The most public objects publish_object may publish in any 24 hours (arkinox, 2026-10-13). */
  publishMaxPerDay: number
  /** The most avatars set_avatar may publish in any 24 hours: with no work owed, the only brake on a loop. */
  avatarMaxPerDay: number
  /** Which tools the MCP server shows (D7, 2026-11-09): all, the starter set, a list, or undefined for the default (server.ts selectTools). */
  tools?: 'all' | 'starter' | string[]
  /** --machine-id: this machine's id for the lock, in place of $CYBERSPACE_MCP_MACHINE_ID and <state>.machine-id (lock.ts). Never from config.json, which travels with the state directory. */
  machineId?: string
  /** Where the building kits are (kits/library.ts); default the first of <state>/kits and <state>/../kits that holds one. */
  kitsDir?: string
  /**
   * Whose words reach the model (arkinox, 2026-11-23: "XOR should ignore all
   * input from any pubkey that isn't the operator, full stop"). "everyone"
   * (the default): chat, DMs and what others wrote, as before. "operator":
   * text authored by anyone but the operator and the agent itself is dropped
   * where it comes in, never stored for the model, never shown by a tool and
   * never a wake; the world (people's places, bags, objects) still shows, its
   * strangers' words left out. listen-to.ts says what that covers.
   */
  listenTo: ListenTo
}

export type ListenTo = 'everyone' | 'operator'

const DEFAULTS = {
  relays: DEFAULT_RELAYS,
  capCallSeconds: DEFAULT_CAP_CALL_SECONDS,
  capSessionSeconds: DEFAULT_CAP_SESSION_SECONDS,
  capDailySeconds: DEFAULT_CAP_DAILY_SECONDS,
  maxSidestepHeight: 24,
  allowRespawn: false,
  hosakaUrl: HOSAKA_DEFAULT_URL,
  maxPaymentSats: DEFAULT_MAX_PAYMENT_SATS,
  maxDailySats: DEFAULT_MAX_DAILY_SATS,
  chatWakeMinutes: DEFAULT_CHAT_WAKE_MINUTES,
  publishMaxPerDay: DEFAULT_PUBLISH_PER_DAY,
  avatarMaxPerDay: DEFAULT_AVATAR_PER_DAY,
} as const

export interface ParsedArgs {
  state?: string
  relays: string[]
  operator?: string
  name?: string
  about?: string
  capCallSeconds?: number
  capSessionSeconds?: number
  capDailySeconds?: number
  threads?: number
  maxSidestepHeight?: number
  allowRespawn?: boolean
  hosakaUrl?: string
  nwc?: Secret
  maxPaymentSats?: number
  maxDailySats?: number
  paymentApproval?: PaymentApproval
  deleteApproval?: DeleteApproval
  deleteApprovalThreshold?: number
  travelLog?: boolean
  travelLogMaxPerDay?: number
  chatWakeMinutes?: number
  publishMaxPerDay?: number
  avatarMaxPerDay?: number
  machineId?: string
  tools?: 'all' | 'starter' | string[]
  kitsDir?: string
  listenTo?: ListenTo
  help?: boolean
}

export const USAGE = `cyberspace-mcp: a local MCP server that gives an AI agent a body in cyberspace.

Usage: cyberspace-mcp init                     Set up an agent once: key, operator, waker (init --help).
       cyberspace-mcp serve [options]           One long-lived agent over HTTP at http://127.0.0.1:7777/mcp,
                                                with its waker (serve --help).
       cyberspace-mcp doctor                    Check what is missing, and how to fix it.
       cyberspace-mcp wake pause|resume|status  Pause or resume the waker.
       cyberspace-mcp kits add <zip>|list|remove <kit>
                                                The building kits on this machine (kits --help).
       cyberspace-mcp [stdio] [--state <dir>] [options]
                                                The stdio MCP server, for a client that starts it itself.

  --state <dir>                 The state directory: the key, the chain, the outbox. Default
                                $CYBERSPACE_MCP_STATE, else ~/.cyberspace-mcp (where init puts it).
                                A leading ~/ is your home directory, with or without a shell.
  --relay <url>                 A relay; repeatable. The first is the canonical relay. Default ${DEFAULT_RELAY}
  --operator <npub>             The human responsible for this agent, named in its profile.
  --name <name>                 The profile name.
  --about <text>                The profile text.
  --cap-call-seconds <n>        The most compute one hop may spend. Default ${DEFAULTS.capCallSeconds}
  --cap-session-seconds <n>     The most compute the session may spend. Default ${DEFAULTS.capSessionSeconds}
  --cap-daily-seconds <n>       The most compute one UTC day may spend, counted across restarts in
                                <state>/budget-daily.json. Default ${DEFAULTS.capDailySeconds}
  --threads <n>                 Worker threads for rides. Default min(2, cores - 1): ${defaultThreads()} here
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
  --payment-approval <who>      operator: every payment is held until your operator approves it
                                by DM with the code the server sends them (each code one payment,
                                expiring in 30 minutes); the limits above still apply. none: the
                                limits alone. Default none.
  --delete-approval <who>       operator: a delete that takes more than the threshold below, or a
                                whole bag of things in no build, is held until your operator
                                approves it by DM with the code the server sends them (each code
                                one delete of exactly the pieces previewed, expiring in 30
                                minutes). none: no delete waits. A backup goes to <state>/trash
                                either way. Default operator when an operator is set, else none.
  --delete-approval-threshold <n>
                                How many pieces one delete may take without approval. Default ${DEFAULT_DELETE_APPROVAL_THRESHOLD}
  --travel-log                  Let log_travel post public kind 1 notes about the agent's travels. Off by default.
  --travel-log-max-per-day <n>  The most travel log notes in any 24 hours. Default ${DEFAULT_TRAVEL_PER_DAY}
  --chat-wake-minutes <n>       A stranger's chat line that addresses the agent is reported for
                                waking at most once per this many minutes, in total and per
                                speaker; the operator's always. Default ${DEFAULTS.chatWakeMinutes}
  --publish-max-per-day <n>     The most public objects publish_object may publish in any 24 hours.
                                Default ${DEFAULTS.publishMaxPerDay}
  --avatar-max-per-day <n>      The most avatars set_avatar may publish in any 24 hours, clearing
                                included. Default ${DEFAULTS.avatarMaxPerDay}
  --tools <which>               The tools the server shows: starter (identity, whereami, look,
                                plan_hop, hop, say, listen, find, budget), all, or a
                                comma-separated list (config.json "tools": "all", "starter" or a list).
                                Default: starter, or all when an operator is configured.
  --machine-id <id>             This machine's id, which the state directory's lock records so a
                                restart of the same machine takes back its own lock. Default
                                $CYBERSPACE_MCP_MACHINE_ID, else <state>.machine-id (made once,
                                beside the state directory; never sync or copy it). An id given here
                                or in the environment must be unique to this machine.
  --kits-dir <dir>              Where the building kits are (one folder per kit, each with a
                                catalog.json; docs/kits.md). Default <state>/kits, else
                                <state>/../kits. Kits are local data and never published.
  --listen-to <who>             Whose words reach the model: everyone (default) or operator. With
                                operator, text from any other pubkey (chat, DMs, mentions, comments,
                                profile text, messages and names in bags and objects) is dropped
                                where it comes in: never stored, shown or a reason to wake. Places,
                                bags and objects still show. Needs an operator.
  --help                        This text.

The same keys may live in <state>/config.json: relays, operator, name, about,
capCallSeconds, capSessionSeconds, capDailySeconds, threads, maxSidestepHeight, allowRespawn, hosakaUrl,
nwc, maxPaymentSats, maxDailySats, paymentApproval, deleteApproval, deleteApprovalThreshold, chatWakeMinutes, publishMaxPerDay, avatarMaxPerDay, kitsDir, listenTo, and travelLog: { "enabled": true,
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
      case '--state': out.state = next(); if (!out.state) throw new Error('--state needs a directory'); out.state = expandHome(out.state); break
      case '--relay': { const r = next(); if (!r) throw new Error('--relay needs a URL'); out.relays.push(r); break }
      case '--operator': out.operator = next(); if (!out.operator) throw new Error('--operator needs an npub'); break
      case '--name': out.name = next(); if (out.name === undefined) throw new Error('--name needs a value'); break
      case '--about': out.about = next(); if (out.about === undefined) throw new Error('--about needs a value'); break
      case '--cap-call-seconds': out.capCallSeconds = num(a, next()); break
      case '--cap-session-seconds': out.capSessionSeconds = num(a, next()); break
      case '--cap-daily-seconds': out.capDailySeconds = num(a, next()); break
      case '--threads': out.threads = Math.max(1, Math.floor(num(a, next()))); break
      case '--max-sidestep-height': out.maxSidestepHeight = Math.floor(num(a, next())); break
      case '--allow-respawn': out.allowRespawn = true; break
      case '--hosaka-url': out.hosakaUrl = apiUrl(a, next()); break
      case '--nwc': out.nwc = nwcSecret(a, next()); break
      case '--max-payment-sats': out.maxPaymentSats = sats(a, next()); break
      case '--max-daily-sats': out.maxDailySats = sats(a, next()); break
      case '--travel-log': out.travelLog = true; break
      case '--travel-log-max-per-day': out.travelLogMaxPerDay = Math.max(1, Math.floor(num(a, next()))); break
      case '--chat-wake-minutes': out.chatWakeMinutes = num(a, next()); break
      case '--payment-approval': out.paymentApproval = paymentApprovalSetting(a, next()); break
      case '--delete-approval': out.deleteApproval = paymentApprovalSetting(a, next()); break
      case '--delete-approval-threshold': out.deleteApprovalThreshold = threshold(a, next()); break
      case '--listen-to': out.listenTo = listenToSetting(a, next()); break
      case '--publish-max-per-day': out.publishMaxPerDay = Math.max(1, Math.floor(num(a, next()))); break
      case '--avatar-max-per-day': out.avatarMaxPerDay = Math.max(1, Math.floor(num(a, next()))); break
      case '--machine-id': out.machineId = next(); if (!out.machineId) throw new Error('--machine-id needs a value'); break
      case '--tools': out.tools = toolsSetting('--tools', next()); break
      case '--kits-dir': out.kitsDir = next(); if (!out.kitsDir) throw new Error('--kits-dir needs a directory'); out.kitsDir = expandHome(out.kitsDir); break
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
  capDailySeconds?: unknown
  threads?: unknown
  maxSidestepHeight?: unknown
  allowRespawn?: unknown
  hosakaUrl?: unknown
  nwc?: unknown
  maxPaymentSats?: unknown
  maxDailySats?: unknown
  paymentApproval?: unknown
  deleteApproval?: unknown
  deleteApprovalThreshold?: unknown
  travelLog?: unknown
  chatWakeMinutes?: unknown
  publishMaxPerDay?: unknown
  avatarMaxPerDay?: unknown
  tools?: unknown
  kitsDir?: unknown
  listenTo?: unknown
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

/**
 * The words to log when the first relay listed, the canonical one, is retired and
 * was dropped: another relay is canonical now, and a chain only on the retired
 * one is out of reach. Null when that did not happen.
 */
export function retiredCanonicalWarning(args: ParsedArgs, file: FileConfig, settings: Settings): string | null {
  const listed = args.relays.length ? args.relays : Array.isArray(file.relays) ? file.relays : []
  const first: unknown = listed[0]
  if (typeof first !== 'string' || !isRetiredRelay(first)) return null
  return `WARNING: the first relay listed, ${first}, is retired and is not dialed, so the canonical relay is now ${settings.relays[0]}. A chain that lives only on the retired relay is out of reach: do not lose chain.json, and do not spawn over it. Remove it from --relay or config.json.`
}

/** The settings: defaults, then the file, then the arguments. The wallet string: --nwc, then wallet.json, then config.json. */
export function settingsFrom(args: ParsedArgs, file: FileConfig, walletFile: WalletFile = {}): Settings {
  if (!args.state) throw new Error('--state <dir> is required')
  // A retired relay in either list is dropped here, so a saved config stops dialing it with no edit.
  const fileRelays = Array.isArray(file.relays) ? file.relays.filter((r): r is string => typeof r === 'string' && !isRetiredRelay(r)) : []
  const argRelays = args.relays.filter((r) => !isRetiredRelay(r))
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
  const posNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)
  const tools = args.tools ?? (file.tools !== undefined ? toolsSetting('config.json tools', file.tools) : undefined)
  return {
    stateDir: args.state,
    relays: argRelays.length ? argRelays : fileRelays.length ? fileRelays : [...DEFAULTS.relays],
    operator: args.operator ?? str(file.operator),
    name: args.name ?? str(file.name),
    about: args.about ?? str(file.about),
    capCallSeconds: args.capCallSeconds ?? posNum(file.capCallSeconds) ?? DEFAULTS.capCallSeconds,
    capSessionSeconds: args.capSessionSeconds ?? posNum(file.capSessionSeconds) ?? DEFAULTS.capSessionSeconds,
    capDailySeconds: args.capDailySeconds ?? posNum(file.capDailySeconds) ?? DEFAULTS.capDailySeconds,
    threads: args.threads ?? (posNum(file.threads) !== undefined ? Math.max(1, Math.floor(posNum(file.threads)!)) : defaultThreads()),
    maxSidestepHeight: args.maxSidestepHeight ?? (posNum(file.maxSidestepHeight) !== undefined ? Math.floor(posNum(file.maxSidestepHeight)!) : DEFAULTS.maxSidestepHeight),
    allowRespawn: args.allowRespawn ?? (typeof file.allowRespawn === 'boolean' ? file.allowRespawn : DEFAULTS.allowRespawn),
    hosakaUrl: args.hosakaUrl ?? (str(file.hosakaUrl) !== undefined ? apiUrl('config.json hosakaUrl', str(file.hosakaUrl)) : DEFAULTS.hosakaUrl),
    ...nwcSetting(args, file, walletFile),
    maxPaymentSats: args.maxPaymentSats ?? (file.maxPaymentSats !== undefined ? sats('config.json maxPaymentSats', file.maxPaymentSats) : DEFAULTS.maxPaymentSats),
    maxDailySats: args.maxDailySats ?? (file.maxDailySats !== undefined ? sats('config.json maxDailySats', file.maxDailySats) : DEFAULTS.maxDailySats),
    paymentApproval: args.paymentApproval ?? (file.paymentApproval !== undefined ? paymentApprovalSetting('config.json paymentApproval', file.paymentApproval) : 'none'),
    // On by default whenever there is an operator to ask (arkinox, 2026-11-26).
    deleteApproval: args.deleteApproval ?? (file.deleteApproval !== undefined ? paymentApprovalSetting('config.json deleteApproval', file.deleteApproval) : (args.operator ?? str(file.operator)) ? 'operator' : 'none'),
    deleteApprovalThreshold: args.deleteApprovalThreshold ?? (file.deleteApprovalThreshold !== undefined ? threshold('config.json deleteApprovalThreshold', file.deleteApprovalThreshold) : DEFAULT_DELETE_APPROVAL_THRESHOLD),
    travelLog: travelLogSettings(args, file.travelLog),
    chatWakeMinutes: args.chatWakeMinutes ?? posNum(file.chatWakeMinutes) ?? DEFAULTS.chatWakeMinutes,
    publishMaxPerDay: args.publishMaxPerDay ?? (posNum(file.publishMaxPerDay) !== undefined ? Math.max(1, Math.floor(posNum(file.publishMaxPerDay)!)) : DEFAULTS.publishMaxPerDay),
    avatarMaxPerDay: args.avatarMaxPerDay ?? (posNum(file.avatarMaxPerDay) !== undefined ? Math.max(1, Math.floor(posNum(file.avatarMaxPerDay)!)) : DEFAULTS.avatarMaxPerDay),
    ...(args.machineId ? { machineId: args.machineId } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...((args.kitsDir ?? str(file.kitsDir)) ? { kitsDir: args.kitsDir ?? expandHome(str(file.kitsDir)!) } : {}),
    listenTo: args.listenTo ?? (file.listenTo !== undefined ? listenToSetting('config.json listenTo', file.listenTo) : 'everyone'),
  }
}

/** A whole number of pieces, 0 or more, or a thrown sentence. */
function threshold(where: string, raw: unknown): number {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new Error(`${where} must be a whole number of pieces, 0 or more; got ${JSON.stringify(raw)}`)
  return n
}

/** "operator" or "none" (paymentApproval and deleteApproval), or a thrown sentence: a typo must never quietly drop the approval the human asked for. */
function paymentApprovalSetting(where: string, raw: unknown): PaymentApproval {
  if (raw === 'operator' || raw === 'none') return raw
  throw new Error(`${where} must be "operator" or "none"; got ${JSON.stringify(raw)}`)
}

/** "everyone" or "operator", or a thrown sentence: a typo here must not quietly let everyone in. */
function listenToSetting(where: string, raw: unknown): ListenTo {
  if (raw === 'everyone' || raw === 'operator') return raw
  throw new Error(`${where} must be "everyone" or "operator"; got ${JSON.stringify(raw)}`)
}

/** "all", "starter", or tool names (a comma-separated string or, in config.json, a list); the names are checked against the tools when the server starts. */
function toolsSetting(where: string, raw: unknown): 'all' | 'starter' | string[] {
  const words = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null)
  if (!words || words.some((w) => typeof w !== 'string')) throw new Error(`${where} must be all, starter, or tool names (comma-separated, or a list in config.json)`)
  const names = (words as string[]).map((w) => w.trim()).filter(Boolean)
  if (names.length === 0) throw new Error(`${where} needs all, starter, or at least one tool name`)
  if (names.length === 1 && (names[0] === 'all' || names[0] === 'starter')) return names[0]
  return names
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
