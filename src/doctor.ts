// doctor.ts: `cyberspace-mcp doctor` (arkinox, 2026-10-13). Checks what an
// agent needs to answer its operator, one line each, and says what to do
// about each thing that is missing: the state directory, the key (present
// and this server's own; never printed), the operator set, named in the
// profile and following the agent, the operator's DM inbox (kind 10050),
// the agent's own kind 10050, the relays answering, serve running, and the
// wake command starting (run with --version, so no model is called), and
// the lock with this machine's id for it. It reads; it writes nothing and
// takes no lock, so it runs beside serve.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { nip19 } from 'nostr-tools'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { parsePubkey } from './chain/resolve.js'
import { parseArgs, readFileConfig, readWalletFile, settingsFrom } from './config.js'
import { readToken } from './http.js'
import { GENERAL_RELAYS, Relays } from './nostr/relays.js'
import { mergeAnswers } from './nostr/relayOutcome.js'
import { defaultStateDir, mcpUrl, serveSettingsFrom, splitServeArgs, type ServeFileConfig } from './serveConfig.js'
import { PAUSE_FILE } from './waker.js'
import { ForeignKeyError, StateDir } from './state/dir.js'
import { describeLock, MACHINE_ID_ENV } from './state/lock.js'
import type { NostrEvent } from './nostr/event.js'

export type Verdict = 'ok' | 'warn' | 'fail'

export interface Check {
  name: string
  verdict: Verdict
  detail: string
  fix?: string
}

export interface DoctorDeps {
  print: (line: string) => void
  /** Tests: the fake network and the lookup relays. */
  websocketImplementation?: unknown
  lookupRelays?: string[]
  relayMaxWaitMs?: number
  /** Tests: how long the wake command's --version may take. */
  versionTimeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export const DOCTOR_USAGE = `cyberspace-mcp doctor: check that your agent can hear you and answer.

Usage: cyberspace-mcp doctor [--state <dir>] [--port <n>]

Reads only: it runs beside serve, and never prints the key or the token.
Exit code 0 when nothing failed, 1 otherwise.`

/** Whether a process with this pid exists here. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

/** Run argv[0] --version without a shell; resolves with the first line or the reason it failed. */
function version(cmd: string, timeoutMs: number): Promise<{ ok: boolean; line: string }> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (r: { ok: boolean; line: string }): void => { if (!done) { done = true; resolve(r) } }
    let child
    try {
      child = spawn(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    } catch (err) {
      finish({ ok: false, line: err instanceof Error ? err.message : String(err) })
      return
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } finish({ ok: false, line: `no answer in ${Math.round(timeoutMs / 1000)} s` }) }, timeoutMs)
    child.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8') })
    child.stderr?.on('data', (b: Buffer) => { out += b.toString('utf8') })
    child.on('error', (err) => { clearTimeout(timer); finish({ ok: false, line: (err as NodeJS.ErrnoException).code === 'ENOENT' ? `${cmd} is not installed or not on the PATH` : err.message }) })
    child.on('close', (code) => { clearTimeout(timer); finish({ ok: code === 0, line: (out.trim().split('\n')[0] ?? '') || `exit ${code}` }) })
  })
}

const newest = (events: NostrEvent[], kind: number, author: string): NostrEvent | null =>
  events.filter((e) => e.kind === kind && e.pubkey === author).sort((a, b) => b.created_at - a.created_at)[0] ?? null

/** Run every check; returns them (the tests read them) after printing. */
export async function runDoctor(argv: string[], deps: DoctorDeps): Promise<{ code: number; checks: Check[] }> {
  const { print } = deps
  const { serve, rest } = splitServeArgs(argv)
  const args = parseArgs(rest)
  if (args.help) {
    print(DOCTOR_USAGE)
    return { code: 0, checks: [] }
  }
  const stateDir = args.state ?? defaultStateDir(deps.env)
  const checks: Check[] = []
  const add = (c: Check): void => {
    checks.push(c)
    const mark = c.verdict === 'ok' ? 'ok  ' : c.verdict === 'warn' ? 'WARN' : 'FAIL'
    print(`${mark}  ${c.name}: ${c.detail}`)
    if (c.fix && c.verdict !== 'ok') print(`      fix: ${c.fix}`)
  }
  const done = (): { code: number; checks: Check[] } => {
    const failed = checks.filter((c) => c.verdict === 'fail').length
    const warned = checks.filter((c) => c.verdict === 'warn').length
    print('')
    print(failed ? `${failed} problem(s) to fix${warned ? `, ${warned} warning(s)` : ''}.` : warned ? `Nothing failed; ${warned} warning(s).` : 'All good: your agent can hear you and answer.')
    return { code: failed ? 1 : 0, checks }
  }

  const major = Number(process.versions.node.split('.')[0])
  add(major >= 22 ? { name: 'node', verdict: 'ok', detail: `v${process.versions.node}` } : { name: 'node', verdict: 'fail', detail: `v${process.versions.node}`, fix: 'install Node 22 or newer' })

  // The state directory and the key.
  if (!existsSync(stateDir)) {
    add({ name: 'state directory', verdict: 'fail', detail: `${stateDir} does not exist`, fix: 'cyberspace-mcp init --operator <your npub>' })
    return done()
  }
  const mode = statSync(stateDir).mode & 0o777
  add({ name: 'state directory', verdict: mode & 0o077 ? 'warn' : 'ok', detail: `${stateDir}${mode & 0o077 ? ` is readable by others (mode ${mode.toString(8)})` : ''}`, fix: `chmod 700 ${stateDir}` })
  let pubkey: string | null = null
  let sk: Uint8Array | null = null
  const keyPath = join(stateDir, 'key')
  if (!existsSync(keyPath)) {
    add({ name: 'key', verdict: 'fail', detail: 'none yet', fix: 'cyberspace-mcp init (or serve) makes it' })
  } else {
    try {
      sk = StateDir.open(stateDir).loadOrCreateKey()
      pubkey = getPublicKey(sk)
      const keyMode = statSync(keyPath).mode & 0o777
      add({ name: 'key', verdict: keyMode & 0o077 ? 'warn' : 'ok', detail: `present, the agent is ${nip19.npubEncode(pubkey)}${keyMode & 0o077 ? ` (mode ${keyMode.toString(8)}: others can read it)` : ''}`, fix: `chmod 600 ${keyPath}` })
    } catch (err) {
      add({ name: 'key', verdict: 'fail', detail: err instanceof ForeignKeyError ? 'the key file is not one this server wrote' : (err instanceof Error ? err.message : String(err)), fix: 'give the agent its own empty state directory; an agent never takes a human\'s key' })
    }
  }

  // The settings.
  let settings
  try {
    args.state = stateDir
    settings = settingsFrom(args, readFileConfig(stateDir), readWalletFile(stateDir))
  } catch (err) {
    add({ name: 'config.json', verdict: 'fail', detail: err instanceof Error ? err.message : String(err), fix: `edit ${join(stateDir, 'config.json')}` })
    return done()
  }
  const file = readFileConfig(stateDir) as ServeFileConfig
  let serveSettings
  try {
    serveSettings = serveSettingsFrom(serve, file)
  } catch (err) {
    add({ name: 'wake command', verdict: 'fail', detail: err instanceof Error ? err.message : String(err), fix: 'cyberspace-mcp init --client claude (or hermes), or fix wake.command in config.json' })
    serveSettings = serveSettingsFrom({ ...serve, noWake: true }, file)
  }
  const operator = settings.operator ? parsePubkey(settings.operator) : null
  if (!operator) add({ name: 'operator', verdict: 'fail', detail: settings.operator ? `not an npub: ${JSON.stringify(settings.operator)}` : 'not set', fix: 'cyberspace-mcp init --operator <your npub>' })
  else add({ name: 'operator', verdict: 'ok', detail: nip19.npubEncode(operator) })

  // The profile this server last published names the operator.
  const profile = StateDir.open(stateDir).readJson<{ tags?: string[][]; accepted?: string[] } | null>('profile.json', null)
  const named = profile?.tags?.find((t) => t[0] === 'p' && t[3] === 'operator')?.[1] ?? null
  if (!profile) add({ name: 'profile', verdict: 'fail', detail: 'never published', fix: 'cyberspace-mcp init publishes it (or the agent calls identity)' })
  else if (operator && named !== operator) add({ name: 'profile', verdict: 'fail', detail: named ? `names ${nip19.npubEncode(named)}, not the configured operator; no orders are read until they agree` : 'names no operator', fix: 'run cyberspace-mcp init again (with serve stopped) to republish it' })
  else if (!profile.accepted?.length) add({ name: 'profile', verdict: 'fail', detail: 'no relay accepted it', fix: 'check the relays below, then run cyberspace-mcp init again' })
  else add({ name: 'profile', verdict: 'ok', detail: `bot, operator named, on ${profile.accepted.join(', ')}` })

  // The relays, and what they say about the operator and the agent.
  if (pubkey && sk) {
    const secret = sk
    const relays = new Relays({
      urls: settings.relays,
      signAuth: async (t) => finalizeEvent(t, secret),
      websocketImplementation: deps.websocketImplementation,
      maxWaitMs: deps.relayMaxWaitMs ?? 6000,
    })
    try {
      const answers = await relays.queryEach({ kinds: [0], authors: [pubkey], limit: 1 }, deps.relayMaxWaitMs ?? 6000, settings.relays)
      for (const a of answers) {
        add(a.outcome === 'answered'
          ? { name: 'relay', verdict: 'ok', detail: `${a.url} answers` }
          : { name: 'relay', verdict: 'fail', detail: `${a.url}: ${a.outcome}${'reason' in a && a.reason ? ` (${a.reason})` : ''}`, fix: 'check the network, or the relays in config.json' })
      }
      if (operator) {
        const where = [...new Set([...settings.relays, ...(deps.lookupRelays ?? GENERAL_RELAYS)])]
        const lists = await relays.queryEach({ kinds: [3, 10050], authors: [operator, pubkey] }, deps.relayMaxWaitMs ?? 6000, where)
        if (!lists.some((a) => a.outcome === 'answered')) {
          add({ name: 'operator lists', verdict: 'fail', detail: `no relay answered (${where.join(', ')})`, fix: 'check the network' })
        } else {
          const events = mergeAnswers(lists)
          const contacts = newest(events, 3, operator)
          const opInbox = newest(events, 10050, operator)
          const mine = newest(events, 10050, pubkey)
          const follows = contacts?.tags.some((t) => t[0] === 'p' && t[1] === pubkey) ?? false
          add(follows
            ? { name: 'operator follows the agent', verdict: 'ok', detail: 'yes' }
            : { name: 'operator follows the agent', verdict: 'fail', detail: contacts ? 'no' : 'no contact list found', fix: `in ONOSENDAI (or any nostr client), signed in as your operator, follow ${nip19.npubEncode(pubkey)}; orders count only then` })
          const inboxRelays = (opInbox?.tags ?? []).filter((t) => t[0] === 'relay' && t[1]).map((t) => t[1])
          add(inboxRelays.length
            ? { name: 'operator DM inbox (10050)', verdict: 'ok', detail: inboxRelays.join(', ') }
            : { name: 'operator DM inbox (10050)', verdict: 'fail', detail: 'none published', fix: 'publish a DM relay list (kind 10050) from your operator account: in a NIP-17 client\'s settings (0xchat, Amethyst, Coracle), name one or two DM relays such as wss://auth.nostr1.com' })
          const mineRelays = (mine?.tags ?? []).filter((t) => t[0] === 'relay' && t[1]).map((t) => t[1])
          add(mineRelays.length
            ? { name: 'agent DM inbox (10050)', verdict: 'ok', detail: mineRelays.join(', ') }
            : { name: 'agent DM inbox (10050)', verdict: 'fail', detail: 'not published yet', fix: inboxRelays.length ? 'start cyberspace-mcp serve: it publishes one at boot, copied from your operator\'s' : 'publish your operator\'s first (above); serve copies it' })
        }
      }
    } finally {
      relays.close()
    }
  }

  // The lock, and this machine's id for it.
  try {
    const { machine, judgment, held } = describeLock(stateDir, { machineId: args.machineId, env: deps.env })
    const id = machine.id
      ? `machine id ${machine.id} (${machine.source === 'file' ? machine.path : machine.source === 'env' ? `$${MACHINE_ID_ENV}` : '--machine-id'})`
      : `no machine id yet${machine.path ? ` (serve makes ${machine.path})` : ''}`
    const older = held && !held.machineId ? ', older lock format without a machine id' : ''
    const note = machine.note ? `; ${machine.note}` : ''
    if (judgment.kind === 'free' || judgment.kind === 'ours' || (judgment.kind === 'held' && judgment.here)) {
      add({ name: 'lock', verdict: machine.note ? 'warn' : 'ok', detail: `${id}; lock ${judgment.kind === 'free' ? 'free' : judgment.detail}${older}${note}`, fix: `never sync or copy ${machine.path ?? 'the machine id file'}` })
    } else if (judgment.kind === 'stale' || judgment.kind === 'watch') {
      add({ name: 'lock', verdict: 'warn', detail: `${id}; lock ${judgment.detail}${older}${note}`, fix: judgment.kind === 'watch' ? 'the next serve takes it over by itself once its heartbeat has been silent for 25 s, and keeps the old lock as lock.stale-*' : 'the next serve takes it over by itself and keeps the old lock as lock.stale-*' })
    } else {
      add({ name: 'lock', verdict: 'warn', detail: `${id}; lock ${judgment.detail}${note}`, fix: `serve refuses this lock; when that server is gone for certain, rename ${join(stateDir, 'lock')} to lock.stale-<date>` })
    }
  } catch (err) {
    add({ name: 'lock', verdict: 'fail', detail: err instanceof Error ? err.message : String(err), fix: `fix --machine-id or $${MACHINE_ID_ENV}` })
  }

  // serve.
  const port = serveSettings.port
  const url = mcpUrl(port)
  const lock = (() => { try { return JSON.parse(readFileSync(join(stateDir, 'lock'), 'utf8')) as { pid?: number } } catch { return null } })()
  const running = !!lock && typeof lock.pid === 'number' && alive(lock.pid)
  let answering = false
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(3000) })
    // A stateless serve answers a GET with 405, or 401 when it wants the token.
    answering = res.status === 405 || res.status === 401
  } catch { answering = false }
  if (answering) add({ name: 'serve', verdict: 'ok', detail: `answering at ${url}${running ? ` (pid ${lock!.pid})` : ''}${readToken(stateDir) && serveSettings.token ? ', bearer token required' : ''}` })
  else if (running) add({ name: 'serve', verdict: 'warn', detail: `a cyberspace-mcp (pid ${lock!.pid}) holds the state directory but nothing answers at ${url}`, fix: 'it may be the stdio mode or another port: stop it and run cyberspace-mcp serve' })
  else add({ name: 'serve', verdict: 'warn', detail: `not running (nothing at ${url})`, fix: 'cyberspace-mcp serve (QUICKSTART.md shows systemd, launchd and nohup)' })

  // The waker.
  const wake = serveSettings.wake
  if (!wake) {
    add({ name: 'waker', verdict: 'warn', detail: 'no wake command: the agent acts only when you prompt it', fix: 'cyberspace-mcp init --client claude (or hermes), or set wake.command in config.json' })
  } else {
    const cmds = [...new Set([wake.command[0], ...(wake.replyCommand ? [wake.replyCommand[0]] : [])])]
    for (const cmd of cmds) {
      const v = await version(cmd, deps.versionTimeoutMs ?? 20_000)
      add(v.ok ? { name: 'wake command', verdict: 'ok', detail: `${cmd} runs (${v.line})` } : { name: 'wake command', verdict: 'fail', detail: `${cmd}: ${v.line}`, fix: `install ${cmd}, or give its full path in wake.command` })
    }
    if (existsSync(join(stateDir, PAUSE_FILE))) add({ name: 'waker', verdict: 'warn', detail: 'paused (wake.pause exists)', fix: 'cyberspace-mcp wake resume' })
  }
  return done()
}
