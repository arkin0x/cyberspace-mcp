// initDoctor.test.ts: `cyberspace-mcp init` and `cyberspace-mcp doctor` on a
// temporary state directory, against the fake relays (arkinox, 2026-10-13).
// init makes the key (never printing it), writes config.json with the
// operator, the name, the caps and a client's wake commands, writes the
// Claude Code MCP file, publishes the profile that names the operator, and
// prints the URL and the client snippets. doctor reads it all back and says
// what to fix, and never prints the key either.

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import { runDoctor, type Check } from '../src/doctor.js'
import { runInit } from '../src/init.js'
import { nowSeconds, type NostrEvent } from '../src/nostr/event.js'
import { RETIRED_HOSTS } from '../src/nostr/relays.js'
import { commandArgv } from '../src/serveConfig.js'
import type { Calibration } from '../src/space/calibration.js'
import { FakeNetwork, type FakeRelay } from './fakeRelay.js'

const CANONICAL = 'wss://canonical.example'
const GENERAL = 'wss://general.example'
const INBOX = 'wss://inbox.example/'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }

function world(): { network: FakeNetwork; canonical: FakeRelay; general: FakeRelay } {
  const network = new FakeNetwork()
  const canonical = network.add(CANONICAL)
  const general = network.add(GENERAL, { requireAuth: false })
  network.add(INBOX, { challengeOnReq: true, protectWraps: true, requireAuthToPublish: true })
  return { network, canonical, general }
}

const sign = (sk: Uint8Array, kind: number, tags: string[][]): NostrEvent => finalizeEvent({ kind, created_at: nowSeconds(), tags, content: '' }, sk) as NostrEvent

function tmp(): string {
  return join(mkdtempSync(join(tmpdir(), 'cyberspace-mcp-init-')), 'agent')
}

async function init(w: ReturnType<typeof world>, argv: string[]): Promise<{ code: number; out: string }> {
  const out: string[] = []
  const code = await runInit(argv, {
    print: (l) => out.push(l),
    agent: { websocketImplementation: w.network.WebSocket, calibration: cal, relayMaxWaitMs: 1500, lookupRelays: [GENERAL], ordersPollMs: 0 },
    env: { PATH: '' },
  })
  return { code, out: out.join('\n') }
}

async function doctor(w: ReturnType<typeof world>, state: string): Promise<{ code: number; checks: Check[]; out: string }> {
  const out: string[] = []
  const r = await runDoctor(['--state', state, '--port', '1'], { print: (l) => out.push(l), websocketImplementation: w.network.WebSocket, lookupRelays: [GENERAL], relayMaxWaitMs: 1500, versionTimeoutMs: 10_000 })
  return { ...r, out: out.join('\n') }
}

const RETIRED = `wss://${RETIRED_HOSTS[0]}`
const check = (checks: Check[], name: string): Check | undefined => checks.find((c) => c.name === name)

describe('init', () => {
  it('makes the key, writes the settings and the Claude Code file, publishes the profile, and prints the URL and the snippets, never the key', async () => {
    const w = world()
    const opSk = generateSecretKey()
    const op = nip19.npubEncode(getPublicKey(opSk))
    const state = tmp()
    const r = await init(w, ['--state', state, '--operator', op, '--name', 'courier', '--cap-call-seconds', '120', '--client', 'claude', '--relay', CANONICAL, '--yes'])
    expect(r.code).toBe(0)
    const key = JSON.parse(readFileSync(join(state, 'key'), 'utf8')) as { secret: string }
    expect(statSync(join(state, 'key')).mode & 0o777).toBe(0o600)
    expect(r.out).not.toContain(key.secret)
    const me = getPublicKey(Uint8Array.from(Buffer.from(key.secret, 'hex')))
    expect(r.out).toContain(nip19.npubEncode(me))
    expect(r.out).toContain('MCP URL: http://127.0.0.1:7777/mcp')
    expect(r.out).toContain('claude mcp add --transport http cyberspace http://127.0.0.1:7777/mcp')
    expect(r.out).toContain('hermes -p cyberspace mcp add cyberspace --url http://127.0.0.1:7777/mcp')
    expect(r.out).toContain('cyberspace-mcp serve')
    expect(r.out).toContain('Profile published')

    const config = JSON.parse(readFileSync(join(state, 'config.json'), 'utf8')) as Record<string, unknown> & { wake: { command: string; replyCommand: string } }
    expect(config.operator).toBe(op)
    expect(config.name).toBe('courier')
    expect(config.capCallSeconds).toBe(120)
    expect(config.relays).toEqual([CANONICAL])
    // The commands config.json keeps split into a usable argv, the prompt one word of it.
    const argv = commandArgv('wake.command', config.wake.command)
    expect(argv.slice(0, 3)).toEqual(['claude', '-p', '{prompt}'])
    expect(argv).toEqual(expect.arrayContaining(['--mcp-config', join(state, 'claude-mcp.json'), '--strict-mcp-config', '--allowedTools', 'mcp__cyberspace']))
    // No built-in tool: --tools with one empty word.
    expect(argv[argv.indexOf('--tools') + 1]).toBe('')
    expect(commandArgv('wake.replyCommand', config.wake.replyCommand)).toEqual(expect.arrayContaining(['--model', 'haiku']))
    const mcp = JSON.parse(readFileSync(join(state, 'claude-mcp.json'), 'utf8'))
    expect(mcp).toEqual({ mcpServers: { cyberspace: { type: 'http', url: 'http://127.0.0.1:7777/mcp' } } })

    // The profile on the relay: bot, and the operator named.
    const profile = w.canonical.published.find((e) => e.kind === 0 && e.pubkey === me)
    expect(profile).toBeDefined()
    expect(JSON.parse(profile!.content).bot).toBe(true)
    expect(profile!.tags).toContainEqual(expect.arrayContaining(['p', getPublicKey(opSk), '', 'operator']))

    // Run again with one change: the rest stays.
    const again = await init(w, ['--state', state, '--client', 'hermes', '--hermes-profile', 'xor', '--reply-model', 'anthropic/claude-haiku-5.5', '--yes', '--no-publish'])
    expect(again.code).toBe(0)
    const config2 = JSON.parse(readFileSync(join(state, 'config.json'), 'utf8')) as Record<string, unknown> & { wake: { command: string; replyCommand: string } }
    expect(config2.operator).toBe(op)
    expect(config2.capCallSeconds).toBe(120)
    expect(commandArgv('c', config2.wake.command)).toEqual(['hermes', '-p', 'xor', '-z', '{prompt}'])
    expect(commandArgv('c', config2.wake.replyCommand)).toEqual(['hermes', '-p', 'xor', '-m', 'anthropic/claude-haiku-5.5', '-z', '{prompt}'])
    expect(again.out).not.toContain(key.secret)
  })

  it('refuses without an operator when it may not ask, and refuses an nsec', async () => {
    const w = world()
    const state = tmp()
    expect((await init(w, ['--state', state, '--yes'])).code).toBe(2)
    const nsec = nip19.nsecEncode(generateSecretKey())
    const r = await init(w, ['--state', state, '--operator', nsec, '--yes'])
    expect(r.code).toBe(2)
    expect(existsSync(join(state, 'key'))).toBe(false)
  })

  it('makes a token with --token and puts it in the Claude Code file, without printing it', async () => {
    const w = world()
    const state = tmp()
    const r = await init(w, ['--state', state, '--operator', nip19.npubEncode(getPublicKey(generateSecretKey())), '--client', 'claude', '--token', '--no-publish', '--yes'])
    expect(r.code).toBe(0)
    const token = readFileSync(join(state, 'http-token'), 'utf8').trim()
    expect(r.out).not.toContain(token)
    expect(r.out).toContain('$(cat ')
    const mcp = JSON.parse(readFileSync(join(state, 'claude-mcp.json'), 'utf8'))
    expect(mcp.mcpServers.cyberspace.headers).toEqual({ Authorization: `Bearer ${token}` })
    expect(statSync(join(state, 'claude-mcp.json')).mode & 0o777).toBe(0o600)
  })
})

describe('doctor', () => {
  it('on a directory that is not there: one failure, and what to run', async () => {
    const w = world()
    const r = await doctor(w, tmp())
    expect(r.code).toBe(1)
    expect(check(r.checks, 'state directory')?.verdict).toBe('fail')
    expect(r.out).toContain('cyberspace-mcp init')
  })

  it('after init, with an operator who follows the agent and has a DM inbox: all good but serve, never the key', async () => {
    const w = world()
    const opSk = generateSecretKey()
    const op = getPublicKey(opSk)
    const state = tmp()
    // The wake command is node itself, which answers --version.
    const made = await init(w, ['--state', state, '--operator', nip19.npubEncode(op), '--name', 'courier', '--relay', CANONICAL, '--wake-command', `${process.execPath} -e 0 {prompt}`, '--yes', '--no-publish'])
    expect(made.code).toBe(0)
    const key = JSON.parse(readFileSync(join(state, 'key'), 'utf8')) as { secret: string }
    const me = getPublicKey(Uint8Array.from(Buffer.from(key.secret, 'hex')))

    // Before the operator follows and before a profile: doctor says what to fix.
    let r = await doctor(w, state)
    expect(r.code).toBe(1)
    expect(check(r.checks, 'profile')?.verdict).toBe('fail')
    expect(check(r.checks, 'operator follows the agent')?.verdict).toBe('fail')
    expect(r.out).toContain(`follow ${nip19.npubEncode(me)}`)
    expect(check(r.checks, 'operator DM inbox (10050)')?.verdict).toBe('fail')

    // The operator follows the agent and publishes a DM inbox; init publishes the profile and copies the inbox.
    w.general.seed(sign(opSk, 10050, [['relay', INBOX]]), sign(opSk, 3, [['p', me]]))
    expect((await init(w, ['--state', state, '--yes'])).code).toBe(0)
    r = await doctor(w, state)
    expect(check(r.checks, 'key')?.verdict).toBe('ok')
    expect(check(r.checks, 'operator')?.verdict).toBe('ok')
    expect(check(r.checks, 'profile')?.verdict).toBe('ok')
    expect(check(r.checks, 'relay')?.verdict).toBe('ok')
    expect(check(r.checks, 'operator follows the agent')?.verdict).toBe('ok')
    expect(check(r.checks, 'operator DM inbox (10050)')?.detail).toContain('inbox.example')
    expect(check(r.checks, 'agent DM inbox (10050)')?.verdict).toBe('ok')
    expect(check(r.checks, 'wake command')?.verdict).toBe('ok')
    // The lock: free, with the machine id the tests run under (test/noNetwork.ts).
    expect(check(r.checks, 'lock')?.verdict).toBe('ok')
    expect(check(r.checks, 'lock')?.detail).toBe('machine id cyberspace-mcp-tests ($CYBERSPACE_MCP_MACHINE_ID); lock free')
    // serve is not running here: a warning with the command, not a failure.
    expect(check(r.checks, 'serve')?.verdict).toBe('warn')
    expect(r.code).toBe(0)
    expect(r.out).not.toContain(key.secret)
  })

  it('warns, and does not fail or dial, when config.json still lists a retired relay; init never writes one', async () => {
    const w = world()
    const retired = w.network.add(RETIRED)
    const state = tmp()
    const made = await init(w, ['--state', state, '--operator', nip19.npubEncode(getPublicKey(generateSecretKey())), '--name', 'courier', '--relay', CANONICAL, '--relay', RETIRED])
    expect(made.code).toBe(0)
    const path = join(state, 'config.json')
    const config = JSON.parse(readFileSync(path, 'utf8')) as { relays: string[] }
    expect(config.relays).toEqual([CANONICAL])
    writeFileSync(path, JSON.stringify({ ...config, relays: [CANONICAL, RETIRED] }))
    const r = await doctor(w, state)
    const warned = r.checks.find((c) => c.name === 'relay' && c.detail.includes(RETIRED))
    expect(warned?.verdict).toBe('warn')
    expect(warned?.fix).toContain('config.json')
    expect(r.checks.filter((c) => c.name === 'relay' && c.verdict === 'fail')).toHaveLength(0)
    expect(retired.received).toHaveLength(0)
  })

  it('fails a wake command that is not installed, and warns about a paused waker', async () => {
    const w = world()
    const state = tmp()
    await init(w, ['--state', state, '--operator', nip19.npubEncode(getPublicKey(generateSecretKey())), '--wake-command', '/nonexistent/model-cli -z {prompt}', '--yes', '--no-publish'])
    writeFileSync(join(state, 'wake.pause'), '')
    const r = await doctor(w, state)
    const wake = check(r.checks, 'wake command')
    expect(wake?.verdict).toBe('fail')
    expect(wake?.fix).toContain('install')
    expect(r.checks.find((c) => c.name === 'waker')?.detail).toContain('paused')
  })
})
