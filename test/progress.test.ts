// progress.test.ts: a long tool call that carries a progressToken hears
// progress notifications (audit B5): a heartbeat every few seconds from any
// tool, and from hop what it is doing, sent before the proof holds the
// thread. Over stdio-like transports and over serve's HTTP, where such a
// call is answered as a short event stream and every other call stays
// plain JSON. A call without a progressToken hears nothing. No network:
// the relays are the fake ones (test/fakeRelay.ts).

import { mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Progress as SdkProgress } from '@modelcontextprotocol/sdk/types.js'
import { generateSecretKey } from 'nostr-tools/pure'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agent } from '../src/agent.js'
import { wantsProgressStream } from '../src/http.js'
import { bytesToHex } from '../src/nostr/event.js'
import { HEARTBEAT_MS, startProgress, type ProgressExtra } from '../src/progress.js'
import { startServe, type Serving } from '../src/serve.js'
import { createServer } from '../src/server.js'
import type { Calibration } from '../src/space/calibration.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork } from './fakeRelay.js'

const CANONICAL = 'wss://canonical.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }

type Sent = { progressToken: string | number; progress: number; message?: string }
function recorder(token: string | number | null, fail = false): { extra: ProgressExtra; sent: Sent[] } {
  const sent: Sent[] = []
  const extra: ProgressExtra = {
    ...(token === null ? {} : { _meta: { progressToken: token } }),
    sendNotification: async (n) => {
      if (fail) throw new Error('the client is gone')
      sent.push(n.params)
    },
  }
  return { extra, sent }
}

function dirWithKey(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-progress-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(generateSecretKey()), createdAt: 'test' }), { mode: 0o600 })
  return dir
}

const agents: Agent[] = []
const serving: Serving[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const s of serving.splice(0)) await s.stop()
  for (const a of agents.splice(0)) await a.stop()
})

describe('startProgress', () => {
  it('sends nothing, and sets no timer, when the request carried no progressToken', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { extra, sent } = recorder(null)
    const p = startProgress('hop', extra)
    await p.report('computing')
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3)
    p.stop()
    expect(sent).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('beats every interval with the phase, and says a new phase at once; progress always grows', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { extra, sent } = recorder(7)
    const p = startProgress('wait_for', extra)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(sent.map((s) => s.message?.replace(/ \(\d+ s\)$/, ''))).toEqual(['wait_for: working'])
    await p.report('waiting for an arrival')
    expect(sent.at(-1)!.message).toMatch(/^wait_for: waiting for an arrival \(\d+ s\)$/)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2)
    expect(sent).toHaveLength(4)
    expect(sent.at(-1)!.message).toMatch(/^wait_for: waiting for an arrival/)
    for (let i = 1; i < sent.length; i++) expect(sent[i].progress).toBeGreaterThan(sent[i - 1].progress)
    expect(sent.every((s) => s.progressToken === 7)).toBe(true)
    p.stop()
    await p.report('after the end')
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2)
    expect(sent).toHaveLength(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops when the call is cancelled, and starts nothing for a call already cancelled', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { extra, sent } = recorder('t')
    const abort = new AbortController()
    const p = startProgress('wait_for', { ...extra, signal: abort.signal })
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(sent).toHaveLength(1)
    abort.abort()
    expect(vi.getTimerCount()).toBe(0)
    await p.report('after the cancel')
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2)
    expect(sent).toHaveLength(1)
    p.stop()
    const late = startProgress('wait_for', { ...extra, signal: abort.signal })
    await late.report('never sent')
    expect(sent).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never throws when a notification cannot be sent', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { extra } = recorder('t', true)
    const p = startProgress('hop', extra)
    await expect(p.report('computing')).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    p.stop()
  })
})

describe('progress over MCP', () => {
  it('a long call hears the heartbeat while it runs, and nothing after it ends', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let finish: () => void = () => {}
    const stub = {
      notices: () => null,
      waitFor: () => new Promise((resolve) => { finish = () => resolve({ text: 'timeout', data: { happened: 'timeout' } }) }),
    } as unknown as Agent
    const server = createServer(stub)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const heard: SdkProgress[] = []
    const call = client.callTool({ name: 'wait_for', arguments: { timeout_seconds: 60 } }, undefined, { onprogress: (p) => heard.push(p) })
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2 + 10)
    expect(heard.map((h) => h.message?.replace(/ \(\d+ s\)$/, ''))).toEqual(['wait_for: working', 'wait_for: working'])
    finish()
    const result = await call
    expect(result.isError).toBeFalsy()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2)
    expect(heard).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
    await client.close()
  })

  it('a call that throws stops its heartbeat, and its answer is the error', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let fail: () => void = () => {}
    const stub = {
      notices: () => null,
      waitFor: () => new Promise((_, reject) => { fail = () => reject(new Error('the relay went away')) }),
    } as unknown as Agent
    const server = createServer(stub)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const heard: SdkProgress[] = []
    const call = client.callTool({ name: 'wait_for', arguments: { timeout_seconds: 60 } }, undefined, { onprogress: (p) => heard.push(p) })
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS + 10)
    expect(heard).toHaveLength(1)
    fail()
    const result = await call
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('the relay went away')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2)
    expect(heard).toHaveLength(1)
    await client.close()
  })

  it('a call the client cancels stops its heartbeat while the tool winds down', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const stub = { notices: () => null, waitFor: () => new Promise(() => {}) } as unknown as Agent
    const server = createServer(stub)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const heard: SdkProgress[] = []
    const abort = new AbortController()
    const call = client.callTool({ name: 'wait_for', arguments: { timeout_seconds: 60 } }, undefined, { signal: abort.signal, onprogress: (p) => heard.push(p) })
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS + 10)
    expect(heard).toHaveLength(1)
    abort.abort()
    await expect(call).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(10)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2)
    expect(heard).toHaveLength(1)
    await client.close()
  })

  it('hop says the proof is computing before it computes, and when it is done', async () => {
    const network = new FakeNetwork()
    network.add(CANONICAL)
    const agent = await Agent.start({ stateDir: dirWithKey(), relays: [CANONICAL], capCallSeconds: 30, capSessionSeconds: 600, maxSidestepHeight: 24, allowRespawn: false, websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1000 })
    agents.push(agent)
    const server = createServer(agent)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const heard: string[] = []
    const result = await client.callTool({ name: 'hop', arguments: { target: { dx: 2 } } }, undefined, { onprogress: (p) => heard.push(p.message ?? '') })
    expect(result.isError).toBeFalsy()
    const computing = heard.findIndex((m) => /^hop: computing the proof \(a hop of h\d+, about \d+ s here\)/.test(m))
    const done = heard.findIndex((m) => /^hop: proof done in [\d.]+ s; confirming the head, then signing and publishing/.test(m))
    expect(computing, heard.join('\n')).toBeGreaterThanOrEqual(0)
    expect(done).toBeGreaterThan(computing)
    // Without onprogress the client sends no progressToken, and the hop goes as before.
    const quiet = await client.callTool({ name: 'hop', arguments: { target: { dx: 1 } } })
    expect(quiet.isError).toBeFalsy()
    await client.close()
  }, 60_000)
})

describe('progress over serve (HTTP)', () => {
  it('streams only a tools/call that asked for progress and accepts an event stream', () => {
    const call = (meta?: object) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hop', arguments: {}, ...(meta ? { _meta: meta } : {}) } })
    const both = 'application/json, text/event-stream'
    expect(wantsProgressStream(call({ progressToken: 1 }), both)).toBe(true)
    expect(wantsProgressStream(call({ progressToken: 'x' }), both)).toBe(true)
    expect(wantsProgressStream([{ jsonrpc: '2.0', method: 'notifications/initialized' }, call({ progressToken: 1 })], both)).toBe(true)
    expect(wantsProgressStream(call(), both)).toBe(false)
    expect(wantsProgressStream(call({ progressToken: 1 }), 'application/json')).toBe(false)
    expect(wantsProgressStream(call({ progressToken: 1 }), undefined)).toBe(false)
    expect(wantsProgressStream({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { progressToken: 1 } } }, both)).toBe(false)
    expect(wantsProgressStream(null, both)).toBe(false)
  })

  it('a hop over HTTP hears its progress; other calls are answered as JSON', async () => {
    const network = new FakeNetwork()
    network.add(CANONICAL)
    const s = await startServe(['--port', '0', '--relay', CANONICAL, '--state', dirWithKey()], {
      log: () => {},
      print: () => {},
      agent: { websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1000, lookupRelays: [CANONICAL], ordersPollMs: 0 },
      waker: { watchdogMs: 50 },
    })
    serving.push(s)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(s.http.url)))
    const heard: string[] = []
    const result = await client.callTool({ name: 'hop', arguments: { target: { dx: 2 } } }, undefined, { onprogress: (p) => heard.push(p.message ?? '') })
    expect(result.isError).toBeFalsy()
    expect(heard.some((m) => m.startsWith('hop: computing the proof')), heard.join('\n')).toBe(true)
    expect(heard.some((m) => m.startsWith('hop: proof done'))).toBe(true)
    await client.close()

    // The answer's form, as a client without the SDK sees it.
    const contentType = (body: object): Promise<string> => new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: s.http.port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, (res) => { res.resume(); resolve(String(res.headers['content-type'])) })
      req.on('error', reject)
      req.end(JSON.stringify(body))
    })
    expect(await contentType({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).toMatch(/^application\/json/)
    expect(await contentType({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ride_status', arguments: {} } })).toMatch(/^application\/json/)
    expect(await contentType({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ride_status', arguments: {}, _meta: { progressToken: 'p' } } })).toMatch(/^text\/event-stream/)
    // A body that is not JSON is refused as the SDK would.
    const bad = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: s.http.port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      req.end('{not json')
    })
    expect(bad).toBe(400)
  }, 60_000)
})
