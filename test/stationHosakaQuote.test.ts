// stationHosakaQuote.test.ts: station { destination } shows HOSAKA's own quote
// for the ride beside the local estimate, against a fake HOSAKA served by an
// injected fetch, never the real one. The fake answers the two routes the
// quote needs, GET /api/v1/provider and POST /api/v1/ride/quote, and each
// test swaps in how it answers.
//
// What would fail silently without these tests: a quote shown from a HOSAKA
// that sells no rides; a price in msats where sats were meant, or rounded
// down; a refusal shown as a price; a HOSAKA that is down, broken or slow
// failing or holding up the station tool, or losing its local estimate; a
// request station stopped waiting for left running in the background.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { Agent } from '../src/agent.js'
import { durationWords, rideQuoteOf } from '../src/hosaka.js'
import { FakeNetwork } from './fakeRelay.js'
import { MANIFEST_URL, TIP, cal, dirWithKey, fakeFetch, served } from './hosakaWorld.js'

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'
const HOSAKA = 'https://hosaka.test'
/** How long station waits for the quote in these tests, in ms. */
const WAIT_MS = 400

const network = new FakeNetwork()
network.add(CANONICAL)
network.add(MINE)

type Handler = (req: Request, path: string) => Promise<Response>
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const provider = (ride: boolean): Response => json(200, {
  version: 1, name: 'FAKE HOSAKA',
  services: [{ type: 'hop', max_height: 27 }, ...(ride ? [{ type: 'ride', max_blocks: 500_000, max_block_height: 900_000, min_msats: 1000 }] : [])],
})

/** A quote as HOSAKA answers one, for the ride asked about. */
async function quoteFor(req: Request, fields: Record<string, unknown>): Promise<Response> {
  const body = JSON.parse(await req.text()) as { from_height: number; to_height: number }
  const blocks = Math.abs(body.to_height - body.from_height)
  return json(200, {
    action: 'ride', from_height: body.from_height, to_height: body.to_height, blocks, attempts: 4,
    cost_msats: 21_500, within_cap: true, max_blocks: 500_000, max_block_height: 900_000,
    est_seconds: 720, est_time: '~12 min', est_source: 'benchmark', steps: ['leaves', 'merkle', 'grind'], refusal: null,
    ...fields,
  })
}

let handler: Handler = async () => json(404, { detail: 'Not Found' })
const requests: Array<{ method: string; path: string; body: string | null; signal: AbortSignal | null }> = []
const hosakaFetch: typeof globalThis.fetch = async (input, init) => {
  const req = new Request(input as string, init)
  const path = new URL(req.url).pathname
  requests.push({ method: req.method, path, body: init?.body ? String(init.body) : null, signal: init?.signal ?? null })
  return handler(req, path)
}
/** A fake that serves the provider and answers quotes with `quote`. */
const sellsRides = (quote: Handler): Handler => async (req, path) =>
  req.method === 'GET' && path === '/api/v1/provider' ? provider(true) : req.method === 'POST' && path === '/api/v1/ride/quote' ? quote(req, path) : json(404, { detail: 'Not Found' })

let agent: Agent
let S: number
let to: number
const running: Agent[] = []
afterAll(async () => { for (const a of running) await a.stop() })

beforeAll(async () => {
  handler = async () => { throw new TypeError('HOSAKA is not up yet') }
  agent = await Agent.start({
    stateDir: dirWithKey(generateSecretKey()), relays: [CANONICAL, MINE], capCallSeconds: 30, capSessionSeconds: 120, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1500,
    manifestUrl: MANIFEST_URL, lineFetch: fakeFetch(served), rideThreads: 0, hosakaUrl: HOSAKA, hosakaFetch, hosakaQuoteWaitMs: WAIT_MS,
  })
  running.push(agent)
  const synced = await agent.station({ sync: true, budget_seconds: 60 })
  expect((synced.data.line as { asOf: number }).asOf).toBe(TIP)
  S = (synced.data.station as { height: number }).height
  to = S === TIP ? S - 1 : S + 1
}, 60_000)

/** station { destination } with the fake answering as `h`; the requests it made and how long it took. */
async function stationWith(h: Handler) {
  handler = h
  requests.length = 0
  const t0 = performance.now()
  const r = await agent.station({ destination: to })
  return { r, ms: performance.now() - t0, made: [...requests] }
}

/** The local estimate is there whatever HOSAKA did. */
function expectLocalQuote(r: Awaited<ReturnType<Agent['station']>>): void {
  expect((r.data.quote as { refused: string | null; fromHeight: number }).refused).toBeNull()
  expect((r.data.quote as { fromHeight: number }).fromHeight).toBe(S)
  expect(r.text).toContain(`Quote to block ${to}: from your station, block ${S}`)
  expect(r.text).toContain('Nothing was signed')
}

describe('station shows HOSAKA\'s quote beside the local estimate', () => {
  it('a HOSAKA that sells rides: the price in sats, rounded up, and its estimated time, after the local quote', async () => {
    const { r, made } = await stationWith(sellsRides((req) => quoteFor(req, {})))
    expectLocalQuote(r)
    const quoteReq = made.find((m) => m.path === '/api/v1/ride/quote')!
    expect(quoteReq.method).toBe('POST')
    expect(JSON.parse(quoteReq.body!)).toEqual({ from_height: S, to_height: to })
    expect(r.data.hosakaQuote).toMatchObject({ status: 'quoted', apiUrl: HOSAKA, sats: 22, costMsats: 21_500, estimate: '~12 min', estSeconds: 720 })
    const lines = r.text.split('\n')
    const local = lines.findIndex((l) => l.startsWith(`Quote to block ${to}:`))
    expect(lines[local + 1]).toBe('HOSAKA quote for the same ride: 22 sats, estimated ~12 min on HOSAKA. Ride with prover: "hosaka" to buy it instead; your operator pays, and HOSAKA\'s compute does not count against your caps.')
  })

  it('with no est_time, the time is formatted from est_seconds', async () => {
    const { r } = await stationWith(sellsRides((req) => quoteFor(req, { est_time: undefined, est_seconds: 5400, cost_msats: 3000 })))
    expect(r.data.hosakaQuote).toMatchObject({ status: 'quoted', sats: 3, estimate: '~1.5 h' })
    expect(r.text).toContain('HOSAKA quote for the same ride: 3 sats, estimated ~1.5 h on HOSAKA.')
  })

  it('a refusal shows HOSAKA\'s hint, never a price', async () => {
    const { r } = await stationWith(sellsRides((req) => quoteFor(req, {
      cost_msats: null, within_cap: false,
      refusal: { error: 'too_many_blocks', hint: 'This ride passes more blocks than one job takes; ride part of the way first.', max_blocks: 500_000 },
    })))
    expectLocalQuote(r)
    expect(r.data.hosakaQuote).toMatchObject({ status: 'refused', error: 'too_many_blocks' })
    expect(r.text).toContain('HOSAKA quote for the same ride: REFUSED. This ride passes more blocks than one job takes; ride part of the way first.')
    expect(r.text).not.toMatch(/HOSAKA quote[^\n]*sats/)
  })

  it('a HOSAKA that sells no rides: no quote is asked for and nothing is said', async () => {
    const { r, made } = await stationWith(async (_req, path) => (path === '/api/v1/provider' ? provider(false) : json(500, { detail: 'should not be asked' })))
    expectLocalQuote(r)
    expect(made.map((m) => m.path)).toEqual(['/api/v1/provider'])
    expect(r.data.hosakaQuote).toBeNull()
    expect(r.text).not.toContain('HOSAKA quote')
  })

  it('without a destination, HOSAKA is not asked at all', async () => {
    handler = sellsRides((req) => quoteFor(req, {}))
    requests.length = 0
    const r = await agent.station()
    expect(requests).toEqual([])
    expect(r.data.hosakaQuote).toBeNull()
    expect(r.text).not.toContain('HOSAKA')
  })

  it('a local quote that is refused is not priced by HOSAKA', async () => {
    handler = sellsRides((req) => quoteFor(req, {}))
    requests.length = 0
    const r = await agent.station({ destination: S })
    expect((r.data.quote as { refused: string }).refused).toMatch(/your station/)
    expect(requests.some((m) => m.path === '/api/v1/ride/quote')).toBe(false)
    expect(r.text).not.toContain('HOSAKA quote')
  })

  it('HOSAKA down: "HOSAKA quote unavailable", and the local estimate stands', async () => {
    const { r } = await stationWith(async () => { throw new TypeError('fetch failed: connect ECONNREFUSED') })
    expectLocalQuote(r)
    expect(r.data.hosakaQuote).toMatchObject({ status: 'unavailable' })
    expect(r.text).toContain('HOSAKA quote unavailable: fetch failed: connect ECONNREFUSED.')
  })

  it('a provider check that answers 500 is unavailable too', async () => {
    const { r } = await stationWith(async () => json(500, { detail: 'Internal Server Error' }))
    expectLocalQuote(r)
    expect(r.text).toContain('HOSAKA quote unavailable: Internal Server Error.')
  })

  it('a quote that answers 500: unavailable', async () => {
    const { r } = await stationWith(sellsRides(async () => json(500, { detail: 'Internal Server Error' })))
    expectLocalQuote(r)
    expect(r.data.hosakaQuote).toMatchObject({ status: 'unavailable', reason: 'Internal Server Error' })
    expect(r.text).toContain('HOSAKA quote unavailable: Internal Server Error.')
  })

  it('a quote that is not JSON: unavailable', async () => {
    const { r } = await stationWith(sellsRides(async () => new Response('<html>bad gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } })))
    expectLocalQuote(r)
    expect(r.text).toContain('HOSAKA quote unavailable: the answer was not a JSON quote.')
  })

  it('a quote for another ride: unavailable', async () => {
    const { r } = await stationWith(sellsRides((req) => quoteFor(req, { from_height: 1 })))
    expect(r.text).toMatch(/HOSAKA quote unavailable: the answer prices a ride from block 1 to block \d+, not the one asked about\./)
  })

  it('a quote that never comes: unavailable within the wait, and the request is aborted', async () => {
    // This fake ignores the abort signal entirely, the worst case: only the wait can end it.
    const { r, ms, made } = await stationWith(sellsRides(() => new Promise<Response>(() => {})))
    expectLocalQuote(r)
    expect(ms).toBeLessThan(WAIT_MS + 1500)
    expect(r.data.hosakaQuote).toMatchObject({ status: 'unavailable' })
    expect(r.text).toContain('HOSAKA quote unavailable: no answer within 0.4 s.')
    const quoteReq = made.find((m) => m.path === '/api/v1/ride/quote')!
    expect(quoteReq.signal?.aborted).toBe(true)
  })

  it('a provider check that never comes: unavailable within the wait as well', async () => {
    const { r, ms, made } = await stationWith(() => new Promise<Response>(() => {}))
    expectLocalQuote(r)
    expect(ms).toBeLessThan(WAIT_MS + 1500)
    expect(r.text).toContain('HOSAKA quote unavailable')
    expect(made[0].signal?.aborted).toBe(true)
  })
})

describe('reading a HOSAKA ride quote', () => {
  it('rideQuoteOf keeps a quote and a refusal, and names what is wrong with anything else', () => {
    const q = { action: 'ride', from_height: 10, to_height: 13, blocks: 3, attempts: 1, cost_msats: 1001, within_cap: true, max_blocks: 9, max_block_height: 99, est_seconds: 5, est_time: '~5 s', est_source: 'x', steps: [], refusal: null }
    expect(rideQuoteOf(q, 10, 13)).toEqual(q)
    expect(rideQuoteOf({ ...q, cost_msats: null, within_cap: false, refusal: { error: 'e', hint: 'h' } }, 10, 13)).toMatchObject({ within_cap: false, refusal: { hint: 'h' } })
    expect(rideQuoteOf('not json', 10, 13)).toBe('the answer was not a JSON quote')
    expect(rideQuoteOf(null, 10, 13)).toBe('the answer was not a JSON quote')
    expect(rideQuoteOf({ ...q, within_cap: 'yes' }, 10, 13)).toMatch(/within its cap/)
    expect(rideQuoteOf({ ...q, cost_msats: '1001' }, 10, 13)).toMatch(/no readable price/)
    expect(rideQuoteOf({ ...q, cost_msats: null }, 10, 13)).toMatch(/names no price/)
    expect(rideQuoteOf(q, 10, 14)).toMatch(/not the one asked about/)
  })

  it('durationWords reads seconds the way est_time does', () => {
    expect(durationWords(0.2)).toBe('~1 s')
    expect(durationWords(45)).toBe('~45 s')
    expect(durationWords(720)).toBe('~12 min')
    expect(durationWords(5400)).toBe('~1.5 h')
  })
})
