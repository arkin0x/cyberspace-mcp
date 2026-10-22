// serve.test.ts: `cyberspace-mcp serve` end to end (arkinox, 2026-10-13).
// The agent runs once against the fake relays; a real MCP client (the SDK's
// Streamable HTTP client) connects by URL on 127.0.0.1, twice, to the same
// agent; the token, the Host and the Origin checks hold; and the waker,
// in-process, starts a turn when the operator's DM lands in the inbox
// relay. The turn is test/fixtures/fakeAgent.mjs, which reads the inbox
// over HTTP as a model would, after which nothing wakes it again.

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import * as nip59 from 'nostr-tools/nip59'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import { bytesToHex, nowSeconds, type NostrEvent } from '../src/nostr/event.js'
import { startServe, type Serving } from '../src/serve.js'
import type { Calibration } from '../src/space/calibration.js'
import { KEY_GENERATED_BY, LockHeldError, StateDir } from '../src/state/dir.js'
import { FakeNetwork, type FakeRelay } from './fakeRelay.js'

const CANONICAL = 'wss://canonical.example'
const GENERAL = 'wss://general.example'
const INBOX = 'wss://inbox.example/'
const FAKE = fileURLToPath(new URL('./fixtures/fakeAgent.mjs', import.meta.url))
const ECHO = fileURLToPath(new URL('../docs/examples/wake-echo.mjs', import.meta.url))
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }

interface World { network: FakeNetwork; general: FakeRelay; inbox: FakeRelay }

function world(): World {
  const network = new FakeNetwork()
  network.add(CANONICAL, { refuse: (ev) => (ev.kind === 1059 ? 'blocked: kind 1059 is not accepted here' : null) })
  const general = network.add(GENERAL, { requireAuth: false })
  const inbox = network.add(INBOX, { challengeOnReq: true, protectWraps: true, requireAuthToPublish: true })
  return { network, general, inbox }
}

function dirWithKey(sk: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-serve-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
  return dir
}

const sign = (sk: Uint8Array, kind: number, tags: string[][]): NostrEvent => finalizeEvent({ kind, created_at: nowSeconds(), tags, content: '' }, sk) as NostrEvent

const running: Serving[] = []
afterEach(async () => { for (const s of running.splice(0)) await s.stop() })

async function serve(w: World, argv: string[], printed: string[] = [], logs: string[] = []): Promise<Serving> {
  const s = await startServe(['--port', '0', '--relay', CANONICAL, ...argv], {
    log: (l) => logs.push(l),
    print: (l) => printed.push(l),
    agent: { websocketImplementation: w.network.WebSocket, calibration: cal, relayMaxWaitMs: 1500, lookupRelays: [GENERAL], ordersPollMs: 0 },
    waker: { watchdogMs: 50 },
  })
  running.push(s)
  return s
}

async function connect(url: string, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
  return client
}

/** A raw request, for the headers fetch will not let a test set. */
function raw(port: number, headers: Record<string, string>, method = 'POST'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/mcp', method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on('error', reject)
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
  })
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('serve', () => {
  it('serves the one agent over HTTP to any number of MCP clients, and holds the lock', async () => {
    const w = world()
    const op = getPublicKey(generateSecretKey())
    const dir = dirWithKey(generateSecretKey())
    const s = await serve(w, ['--state', dir, '--operator', nip19.npubEncode(op), '--no-wake'])
    expect(s.http.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const a = await connect(s.http.url)
    const b = await connect(s.http.url)
    const { tools } = await a.listTools()
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['identity', 'inbox', 'orders_waiting', 'ride', 'message_operator']))
    // No waker, no wake_again.
    expect(tools.map((t) => t.name)).not.toContain('wake_again')
    const ida = await a.callTool({ name: 'identity', arguments: { name: 'courier' } })
    const idb = await b.callTool({ name: 'identity', arguments: {} })
    // Both clients talk to the same agent.
    expect((ida.structuredContent as { npub: string }).npub).toBe(s.agent.npub)
    expect((idb.structuredContent as { npub: string }).npub).toBe(s.agent.npub)
    await a.close()
    await b.close()
    // One key, one mover: a second serve on the same state directory refuses.
    await expect(serve(w, ['--state', dir, '--no-wake'])).rejects.toBeInstanceOf(LockHeldError)
  })

  it('requires the token when asked, printing it only when it is made, and answers only to this machine', async () => {
    const w = world()
    const dir = dirWithKey(generateSecretKey())
    const printed: string[] = []
    const s = await serve(w, ['--state', dir, '--token', '--no-wake'], printed)
    const token = readFileSync(join(dir, 'http-token'), 'utf8').trim()
    expect(statSync(join(dir, 'http-token')).mode & 0o777).toBe(0o600)
    expect(printed.filter((l) => l.includes(token))).toHaveLength(1)
    await expect(connect(s.http.url)).rejects.toThrow()
    await expect(connect(s.http.url, { authorization: 'Bearer wrong' })).rejects.toThrow()
    const c = await connect(s.http.url, { authorization: `Bearer ${token}` })
    expect((await c.listTools()).tools.length).toBeGreaterThan(10)
    await c.close()
    // A page that rebinds a name to 127.0.0.1, and a page on another origin, are refused.
    const auth = { authorization: `Bearer ${token}` }
    expect(await raw(s.http.port, { ...auth, host: `evil.example:${s.http.port}` })).toBe(403)
    expect(await raw(s.http.port, { ...auth, origin: 'https://evil.example' })).toBe(403)
    expect(await raw(s.http.port, { ...auth, origin: `http://localhost:${s.http.port}` })).toBe(200)
    expect(await raw(s.http.port, auth, 'GET')).toBe(405)
    await s.stop()
    running.splice(running.indexOf(s), 1)
    // The second start uses the same token and does not print it again.
    const again: string[] = []
    await serve(w, ['--state', dir, '--token', '--no-wake'], again)
    expect(again.join('\n')).not.toContain(token)
  })

  it('wakes the agent when its operator\'s DM arrives, and the turn reads it over HTTP; no second wake', async () => {
    const w = world()
    const opSk = generateSecretKey()
    const op = getPublicKey(opSk)
    const agentSk = generateSecretKey()
    const me = getPublicKey(agentSk)
    w.general.seed(sign(opSk, 10050, [['relay', INBOX]]), sign(opSk, 3, [['p', me]]))
    const dir = dirWithKey(agentSk)
    const turns = join(dir, 'turns.jsonl')
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      operator: nip19.npubEncode(op),
      wake: { command: [process.execPath, FAKE, 'inbox', turns, '{prompt}'], pollSeconds: 0.2 },
    }))
    const logs: string[] = []
    const s = await serve(w, ['--state', dir], [], logs)
    expect(s.waker).not.toBeNull()
    // The profile names the operator (as init publishes it), and the server has the operator's lists.
    await s.agent.identity({ name: 'courier' })
    // Nothing waits: no turn.
    await new Promise((r) => setTimeout(r, 600))
    expect(existsSync(turns)).toBe(false)
    // The operator writes, as any NIP-17 client would.
    w.inbox.seed(nip59.wrapEvent({ kind: 14, content: 'report your position', tags: [['p', me]], created_at: nowSeconds() - 5 }, opSk, me) as NostrEvent)
    await until(() => existsSync(turns) && readFileSync(turns, 'utf8').includes('"inbox":'))
    const lines = readFileSync(turns, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args?: string[]; url?: string; inbox?: { messages?: Array<{ text: string }> } })
    expect(lines[0].args).toHaveLength(1)
    expect(lines[0].args![0]).toContain('new orders by DM (1 unread)')
    expect(lines[0].url).toBe(s.http.url)
    expect(lines[1].inbox?.messages?.map((m) => m.text)).toEqual(['report your position'])
    // The turn read the order: polls go on, and nothing wakes the agent again.
    await new Promise((r) => setTimeout(r, 1000))
    expect(readFileSync(turns, 'utf8').trim().split('\n')).toHaveLength(2)
    expect(logs.some((l) => l.includes('waking the agent: 1 order(s) waiting'))).toBe(true)
    // The waker added wake_again for its turns.
    const c = await connect(s.http.url)
    expect((await c.listTools()).tools.map((t) => t.name)).toContain('wake_again')
    await c.close()
  })
  it('runs the generic example from the docs, wake-echo.mjs, which answers the operator over DM', async () => {
    const w = world()
    const opSk = generateSecretKey()
    const op = getPublicKey(opSk)
    const agentSk = generateSecretKey()
    const me = getPublicKey(agentSk)
    w.general.seed(sign(opSk, 10050, [['relay', INBOX]]), sign(opSk, 3, [['p', me]]))
    const dir = dirWithKey(agentSk)
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ operator: nip19.npubEncode(op), wake: { command: [process.execPath, ECHO, '{prompt}'], pollSeconds: 0.2 } }))
    const logs: string[] = []
    const s = await serve(w, ['--state', dir, '--token'], [], logs)
    await s.agent.identity({ name: 'courier' })
    w.inbox.seed(nip59.wrapEvent({ kind: 14, content: 'hello agent', tags: [['p', me]], created_at: nowSeconds() - 5 }, opSk, me) as NostrEvent)
    // The answer: a gift wrap to the operator, on the operator's DM inbox, that opens to "received: hello agent".
    const answered = (): string | null => {
      for (const e of w.inbox.published.filter((x) => x.kind === 1059 && x.tags.some((t) => t[0] === 'p' && t[1] === op))) {
        try {
          const rumor = nip59.unwrapEvent(e, opSk)
          // The 👀 on the order is a wrap too (a kind 7); the answer is the kind 14.
          if (rumor.kind === 14) return rumor.content
        } catch { /* not for the operator */ }
      }
      return null
    }
    await until(() => answered() !== null)
    expect(answered()).toBe('received: hello agent')
    await until(() => logs.some((l) => l.includes('turn ended (exit 0)') && l.includes('answered 1 message(s)')))
  })

  it('with a reply command, an order gets a quick reply turn, then a work turn that sees the open order in inbox (arkinox, 2026-10-22)', async () => {
    const w = world()
    const opSk = generateSecretKey()
    const op = getPublicKey(opSk)
    const agentSk = generateSecretKey()
    const me = getPublicKey(agentSk)
    w.general.seed(sign(opSk, 10050, [['relay', INBOX]]), sign(opSk, 3, [['p', me]]))
    const dir = dirWithKey(agentSk)
    const turns = join(dir, 'turns.jsonl')
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      operator: nip19.npubEncode(op),
      wake: {
        command: [process.execPath, FAKE, 'tools:inbox', turns, '{prompt}'],
        replyCommand: [process.execPath, FAKE, 'tools:inbox', turns, '{prompt}'],
        pollSeconds: 0.2,
      },
    }))
    const s = await serve(w, ['--state', dir])
    await s.agent.identity({ name: 'courier' })
    const c = await connect(s.http.url)
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(['wake_again', 'work_done']))
    await c.close()
    w.inbox.seed(nip59.wrapEvent({ kind: 14, content: 'build a fountain by the disco floor', tags: [['p', me], ['agent', 'strategy']], created_at: nowSeconds() - 5 }, opSk, me) as NostrEvent)
    type Line = { args?: string[]; tool?: string; text?: string }
    const lines = (): Line[] => (existsSync(turns) ? readFileSync(turns, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Line) : [])
    await until(() => lines().filter((l) => l.tool === 'inbox').length >= 2)
    const prompts = lines().filter((l) => l.args).map((l) => l.args![0])
    expect(prompts[0]).toContain('This is your quick reply turn')
    expect(prompts[1]).toContain('Work turn from your waker')
    const [replyInbox, workInbox] = lines().filter((l) => l.tool === 'inbox')
    expect(replyInbox.text).toContain('STRATEGY build a fountain by the disco floor')
    // The reply turn read it; the work turn still sees it, as open work.
    expect(workInbox.text).toContain('Still open from an earlier turn')
    expect(workInbox.text).toContain('build a fountain by the disco floor')
    expect(s.waker!.openWork?.ids).toHaveLength(1)
    // Nothing in the waker's file is the order's words.
    expect(readFileSync(join(dir, 'wake-work.json'), 'utf8')).not.toContain('fountain')
  })

  it('a reply turn that calls work_done is the whole answer: no work turn', async () => {
    const w = world()
    const opSk = generateSecretKey()
    const op = getPublicKey(opSk)
    const agentSk = generateSecretKey()
    const me = getPublicKey(agentSk)
    w.general.seed(sign(opSk, 10050, [['relay', INBOX]]), sign(opSk, 3, [['p', me]]))
    const dir = dirWithKey(agentSk)
    const turns = join(dir, 'turns.jsonl')
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      operator: nip19.npubEncode(op),
      wake: {
        command: [process.execPath, FAKE, 'log', turns, '{prompt}'],
        replyCommand: [process.execPath, FAKE, 'tools:inbox,work_done', turns, '{prompt}'],
        pollSeconds: 0.2,
      },
    }))
    const s = await serve(w, ['--state', dir])
    await s.agent.identity({ name: 'courier' })
    w.inbox.seed(nip59.wrapEvent({ kind: 14, content: 'stand by', tags: [['p', me]], created_at: nowSeconds() - 5 }, opSk, me) as NostrEvent)
    await until(() => existsSync(turns) && readFileSync(turns, 'utf8').includes('"tool":"work_done"'))
    await new Promise((r) => setTimeout(r, 1000))
    const modes = readFileSync(turns, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { mode: string; args?: string[] }).filter((l) => l.args).map((l) => l.mode)
    expect(modes).toEqual(['tools:inbox,work_done'])
    expect(s.waker!.openWork).toBeNull()
  })

  it('tells the operator once by DM when it stops resuming work whose turn failed', async () => {
    const w = world()
    const opSk = generateSecretKey()
    const op = getPublicKey(opSk)
    const agentSk = generateSecretKey()
    const me = getPublicKey(agentSk)
    w.general.seed(sign(opSk, 10050, [['relay', INBOX]]), sign(opSk, 3, [['p', me]]))
    const dir = dirWithKey(agentSk)
    const turns = join(dir, 'turns.jsonl')
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      operator: nip19.npubEncode(op),
      wake: { command: [process.execPath, FAKE, 'tools-fail:inbox', turns, '{prompt}'], pollSeconds: 0.2, maxResumes: 0, resumeDelaySeconds: 0.1 },
    }))
    const s = await serve(w, ['--state', dir])
    await s.agent.identity({ name: 'courier' })
    w.inbox.seed(nip59.wrapEvent({ kind: 14, content: 'sweep the plaza', tags: [['p', me]], created_at: nowSeconds() - 5 }, opSk, me) as NostrEvent)
    const told = (): string[] => w.inbox.published.filter((x) => x.kind === 1059 && x.tags.some((t) => t[0] === 'p' && t[1] === op)).flatMap((e) => {
      try {
        const rumor = nip59.unwrapEvent(e, opSk)
        return rumor.kind === 14 ? [rumor.content] : []
      } catch { return [] }
    })
    await until(() => told().length > 0)
    await new Promise((r) => setTimeout(r, 800))
    expect(told()).toHaveLength(1)
    expect(told()[0]).toContain('I stopped working on your orders')
    expect(told()[0]).toContain('it exited with code 3')
    expect(s.waker!.openWork).toBeNull()
  })
})
