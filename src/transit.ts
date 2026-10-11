// transit.ts: the hyperspace tools, station, board, ride and ride_status, as
// one object the agent owns beside its chat and its presence. It holds the
// line store (<state>/line), the ride runner (<state>/rides) and the one ride
// that may be in flight, and it follows agent.ts hop step for step: refuse
// early with a sentence, quote against the budget, reserve the head, confirm
// it against the relays, compute, confirm again, sign through the builder's
// self-check, publish, record. Where a ride differs from a hop this file says
// so: a ride can span many calls, so its head reservation outlives one call
// and its work resumes from disk; a boarding's price is the temporal tree at
// K alone.
//
// Plan: docs/plans/2026-10-10-hyperspace-rides.md tasks C1 to C4, D2, D3.
// ONOSENDAI's flow is followed where the plan does not say otherwise
// (src/store/useCyberspace.ts boardHyperspace and completeRide,
// src/hud/HyperspacePanel.tsx startRide, branch v2 at 0c1e01b): the chain
// head alone decides whether the next ride needs a boarding (lineStateOf);
// the first ride after a boarding declares the line's newest verified block
// as its as_of and the station under it as its from_height; a later ride
// starts at the previous ride's B and declares no as_of (DECK-0001 4.3,
// 5.2); and there is no zero-length ride (arkinox, 2026-10-07).
//
// A ride computes in the background (arkinox, 2026-10-11: "agents being
// responsive is top priority or else the feature feels broken"). `ride`
// starts the work, or reports on it, and returns at once; the work goes on
// between tool calls on a thread of its own (rideHost.ts), so inbox,
// message_operator, orders_waiting and every other tool answer while it
// runs. One ride at a time. The seconds it computes are charged to the
// session cap as they pass, and at the cap the ride pauses, resumable from
// the cache. `ride { pause: true }` pauses it on command (an operator's
// HOLD), keeping the head reserved; `ride { to }` resumes it. When the proof
// is ready, the next `ride` call signs it exactly as a ride always ended:
// confirm the head, the reader's check, sign, record, publish, forget. The
// signature is never made in the background. What a ride in flight is, is
// also written to <state>/rides/flight.json, so a restarted server can say
// that a ride was under way and whether it can still be resumed.
//
// A ride's proof can also be bought from HOSAKA (ride with prover: "hosaka";
// arkinox, 2026-10-11, for XOR's 661,038-block ride), in the background in
// the same way: hosakaRide.ts submits the job, pays the invoice from the
// human's wallet within the human's limits or sends it to the operator,
// follows the job, checks the proof at Level 1, and reports `ready`; the
// next ride call signs it here through the same templates, reader check and
// publish. ride_status and orders_waiting report both kinds of ride alike,
// with `awaiting_payment` the one state only a HOSAKA ride has.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { bytesToHex, hexToCoord, terrainK } from 'cyberspace-core'
import type { Budget } from './budget.js'
import { chainTemplateProblem, enterHyperspaceTemplate, hyperjumpTemplate } from './chain/builder.js'
import { buildChain, chainStatus, firstBreak, lookBack, openBracket, type ActionEvent } from './chain/events.js'
import type { ChainKeeper } from './chain/keeper.js'
import { HOSAKA_DEFAULT_URL, createHosaka, type HosakaClient } from './hosaka.js'
import { HosakaRides } from './hosakaRide.js'
import { computeEnterProof } from './hyperspace/enter.js'
import { LineStore, type LineStatus, type StationResult, type Stop, type SyncResult } from './hyperspace/line.js'
import { lineStateOf, rideBlocks, zeroLengthRideRefusal, type LineState, type RideProof } from './hyperspace/ride.js'
import { runRideInThread } from './hyperspace/rideHost.js'
import { RideRunner, estimateRideSeconds, type RideProgress, type RideRunOptions, type RideRunResult } from './hyperspace/rideRunner.js'
import { maxAxisLca } from './hyperspace/station.js'
import { nowSeconds, type EventTemplate, type NostrEvent } from './nostr/event.js'
import type { Outbox, OutboxEntry } from './nostr/outbox.js'
import type { PublishResult } from './nostr/relays.js'
import { projectCantorMs, type Calibration } from './space/calibration.js'
import { describePlace, placeFromHex } from './space/coords.js'
import type { StateDir } from './state/dir.js'
import { Refusal, type ToolResult } from './tool.js'
import type { Wallet } from './wallet.js'

/** What the agent lends this module: its chain, its budget, its outbox, its signature, and the two steps every tool takes around a move. */
export interface TransitBody {
  pubkey: string
  keeper: ChainKeeper
  budget: Budget
  outbox: Outbox
  canonical: string
  calibration: () => Calibration
  sign: (template: EventTemplate) => NostrEvent
  settle: () => void
  refreshChain: () => Promise<void>
  log: (line: string) => void
  /** Why a DM to the operator could not be sent now, or null (operator.ts undeliverable). */
  undeliverable: () => Promise<string | null>
  /** The message_operator tool's own path: a NIP-17 DM to the operator. */
  messageOperator: (text: string) => Promise<ToolResult>
  /** The human's wallet and limits; the only payer of HOSAKA invoices (wallet.ts). */
  wallet: Wallet
}

export interface TransitOptions {
  /** Where the headers manifest is read from; the default is the NTH headers-v1 manifest. */
  manifestUrl?: string
  /** Tests: a fetch that serves fixture blobs. */
  fetch?: typeof globalThis.fetch
  /** Worker threads for a ride; 0 computes on the calling thread. Default: the cores available less one. */
  threads?: number
  /** Tests: the ride runner's clock. */
  now?: () => number
  /** The HOSAKA API rides are bought from; the default is the production API ONOSENDAI uses. */
  hosakaUrl?: string
  /** Tests: a fetch that serves a fake HOSAKA. */
  hosakaFetch?: typeof globalThis.fetch
  /** Tests: how often the background asks HOSAKA, in ms. */
  hosakaPollMs?: number
}

/**
 * Where a ride stands, as ride_status and orders_waiting report it (arkinox,
 * 2026-10-11): `computing` in the background; `ready`, the proof is done and
 * waits for a ride call to sign it; `paused`, on command; `paused_cap`, at
 * the session cap; `failed`, the work stopped on an error (a ride call
 * retries it); `interrupted`, the server restarted while a ride was in
 * flight (a ride call to the same block resumes it from the cache);
 * `awaiting_payment`, a HOSAKA ride whose invoice is not paid yet.
 */
export type RideState = 'computing' | 'ready' | 'paused' | 'paused_cap' | 'failed' | 'interrupted' | 'awaiting_payment'

/** The ride's state for a waker: cheap, in memory, never a relay. */
export interface RideStateData {
  state: RideState | null
  to: number | null
  /** Leaves in hand, of the ride's total. */
  done: number
  total: number
  attempts: number
  attemptsExpected: number
  /** Estimated seconds of work left, when known. */
  etaSeconds: number | null
  /** Why the ride failed, or why it cannot resume; for a HOSAKA ride awaiting payment, what is happening to the invoice. */
  reason: string | null
  /** Who computes the proof: this machine, or HOSAKA (always set by this server; optional for callers that build one). */
  prover?: 'local' | 'hosaka' | null
}

/** What a ride is, whoever computes its proof: what the signature will need. */
export interface RidePlan {
  previousId: string
  prevCoordHex: string
  genesisId: string
  fromHeight: number
  toHeight: number
  /** Declared on the first ride after a boarding; undefined on a ride from a stop. */
  asOf: number | undefined
  chained: boolean
  blocks: number
  notes: string[]
}

type Ready = Extract<RideRunResult, { done: true }>

/**
 * A ride between calls. The head it departs from is reserved from the first
 * call until the ride is signed, canceled, or found moved, so no hop and no
 * second ride can sign from that head meanwhile (one key, one mover). The
 * leaves and the price search live on disk under the previous event id
 * (rideCache.ts); this record holds only what the signature will need, the
 * background work, and what the agent asks about.
 */
interface Flight {
  previousId: string
  prevCoordHex: string
  genesisId: string
  fromHeight: number
  toHeight: number
  /** Declared on the first ride after a boarding; undefined on a ride from a stop. */
  asOf: number | undefined
  chained: boolean
  blocks: number
  quotedSeconds: number
  release: () => void
  startedAt: number
  /** Ride calls made for this ride. */
  calls: number
  /** Seconds of work charged to the session for this ride, over every run. */
  workSeconds: number
  progress: RideProgress | null
  notes: string[]
  state: Exclude<RideState, 'interrupted' | 'awaiting_payment'>
  /** The background run while one is going, settled when it stops for any reason. */
  run: Promise<void> | null
  abort: AbortController | null
  /** A pause was asked for; the run stops at the next leaf and the state becomes paused. */
  pauseAsked: boolean
  /** Seconds of the current run already charged, by the runner's clock, and when (performance.now()). */
  charged: number
  chargedAt: number
  proof: Ready | null
  failure: string | null
  /** A ride call is signing this ride right now. */
  signing: boolean
  /** The last background look at the relays for a moved head (Date.now()), and the look in progress. */
  headCheckedAt: number
  headCheck: Promise<void> | null
  /** When flight.json was last written (Date.now()). */
  savedAt: number
}

/** flight.json: the ride in flight as a restarted server finds it. */
interface FlightRecord {
  version: 1
  /** live: in flight when written; canceled: released with its cache kept. */
  status: 'live' | 'canceled'
  previousId: string
  fromHeight: number
  toHeight: number
  asOf: number | null
  blocks: number
  leavesDone: number
  workSeconds: number
  savedAt: number
}

const FLIGHT_FILE = 'flight.json'
/** How often flight.json is rewritten while a ride computes. */
const RECORD_EVERY_MS = 30_000
/** How often, at most, a ride call looks at the relays for a moved head while the ride computes. */
const HEAD_CHECK_EVERY_MS = 60_000
/** How long a pause or a cancel waits for the background run to stop before it ends the run outright. */
const STOP_WAIT_MS = 10_000

/** How many stops `station` lists around the agent. */
const NEAREST_STOPS = 5

function threadWords(threads: number): string {
  return threads === 0 ? 'the calling thread' : `${threads} thread(s)`
}

function isHeight(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
}

function words(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * ONOSENDAI nextCreatedAt (useCyberspace.ts at 0c1e01b): never earlier than
 * the event before it, so a clock set back cannot put a ride before its
 * boarding in any reader that orders by time.
 */
function createdAtAfter(head: ActionEvent): number {
  return Math.max(nowSeconds(), head.createdAt)
}

/** A stop in words: its block, its kind, its coordinate and plane. */
function stopWords(stop: Stop, coordHex: string): string {
  const place = describePlace(placeFromHex(coordHex))
  return `block ${stop.height} (a ${stop.kind} at ${coordHex.slice(0, 12)}... in ${place.planeName}, sector ${place.sector})`
}

function stopData(stop: Stop, coordHex: string): Record<string, unknown> {
  return { height: stop.height, kind: stop.kind, blockHash: stop.blockHash, coordinate: describePlace(placeFromHex(coordHex)) }
}

/** What the agent is told about a ride priced but not started. */
interface RideQuote {
  destination: number
  /** Why the ride could not be started as quoted, or null. */
  refused: string | null
  fromHeight: number | null
  asOf: number | undefined
  chained: boolean
  blocks: number
  expectedSeconds: number | null
  threads: number
  fitsCall: boolean
  fitsSession: boolean
  calls: number
  stop: Record<string, unknown> | null
  /** Max-axis LCA height from the agent's head to the destination stop: how far the agent would be from where it stands now. */
  exitDistance: number | null
}

export class Transit {
  readonly store: LineStore
  readonly runner: RideRunner
  readonly threads: number
  private flight: Flight | null = null
  readonly hosaka: HosakaClient
  /** A ride bought from HOSAKA, in hand (hosakaRide.ts). */
  readonly bought: HosakaRides
  /** The ride flight.json held when this server started, if any: a restart came between its calls. */
  private interrupted: FlightRecord | null
  /** A ride the background dropped (its head moved), told once by the next ride call or status. */
  private ended: { to: number; reason: string } | null = null

  constructor(dir: StateDir, private readonly body: TransitBody, options: TransitOptions = {}) {
    this.store = LineStore.open(join(dir.path, 'line'), { manifestUrl: options.manifestUrl, fetch: options.fetch })
    this.threads = options.threads ?? Math.max(1, availableParallelism() - 1)
    this.runner = RideRunner.open(join(dir.path, 'rides'), { threads: this.threads, now: options.now })
    this.interrupted = this.readRecord()
    this.hosaka = createHosaka({ apiUrl: options.hosakaUrl ?? HOSAKA_DEFAULT_URL, sign: body.sign, fetch: options.hosakaFetch })
    this.bought = new HosakaRides({
      dir, keeper: body.keeper, budget: body.budget, store: this.store, hosaka: this.hosaka, wallet: body.wallet, log: body.log,
      refreshChain: body.refreshChain, planRide: (to, asOf) => this.planRide(to, asOf), undeliverable: body.undeliverable, messageOperator: body.messageOperator,
      signAndPublish: (plan, proof) => this.signAndPublish(plan, proof), stopWords: (to) => this.arrivalWords(to),
    }, { pollMs: options.hosakaPollMs })
  }

  /** Whether a ride holds the head between calls, or a HOSAKA ride is in hand. */
  get riding(): boolean {
    return this.flight !== null || this.bought.inHand
  }

  /** Start the background work a restart left in hand: a HOSAKA ride is followed again with no ride call. */
  resume(): void {
    this.bought.resume()
  }

  // ---- station ---------------------------------------------------------------

  /**
   * The line's state, the agent's station, the nearest stops, and with a
   * destination the quote for a ride there. With `sync` the line is advanced
   * first, within the budget (the per-call cap by default). Nothing is signed,
   * and the verification is not charged to the session: it is the same
   * sha256d a reader does to trust a header, not work on the agent's chain.
   */
  async station(input: { sync?: boolean; budget_seconds?: number; destination?: number } = {}): Promise<ToolResult> {
    const budgetSeconds = input.budget_seconds
    if (budgetSeconds !== undefined && (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0)) throw new Refusal('budget_seconds must be a positive number of seconds.')
    if (input.destination !== undefined && !isHeight(input.destination)) throw new Refusal('destination must be a block height: a non-negative integer.')
    let sync: SyncResult | null = null
    if (input.sync) {
      const allowed = Math.min(budgetSeconds ?? this.body.budget.capCallSeconds, this.body.budget.capCallSeconds)
      try {
        sync = await this.store.sync({ budgetSeconds: allowed })
      } catch (err) {
        throw new Refusal(`The line could not be synced: ${words(err)}.`)
      }
    }
    await this.body.refreshChain()
    const chain = this.body.keeper.chain()
    const here = this.body.keeper.place()
    const line = this.store.line
    const status = this.store.status()
    const state = lineStateOf(chain)
    const station = line.asOf() >= 0 ? line.station(here.hex) : null
    const nearest = line.asOf() >= 0 ? line.nearest(here.hex, NEAREST_STOPS) : []
    const quote = input.destination !== undefined ? this.quote(input.destination, state, here.hex) : null
    const stopHex = (s: StationResult): string => line.stopCoordHex(s.stop.height)!
    const text = [
      sync ? `Sync: ${sync.verified} blob(s) verified (${sync.fetched} fetched) in ${sync.elapsedSeconds.toFixed(1)} s${sync.failure ? `; stopped: ${sync.failure}` : ''}${sync.notes.length ? `. ${sync.notes.join(' ')}` : ''}.` : '',
      this.lineWords(status),
      station
        ? `Your station under as_of ${line.asOf()} (the newest verified block) is ${stopWords(station.stop, stopHex(station))}, ${station.distance === 0 ? 'and you stand on it' : `h${station.distance} from where you stand`}.`
        : 'No station can be named until the line holds a verified block.',
      nearest.length ? `Nearest stops: ${nearest.map((s) => `block ${s.stop.height} (${s.stop.kind}, h${s.distance})`).join(', ')}.` : '',
      state === null
        ? 'You are not on the line: board to ride.'
        : state.fromHeight === null
          ? `You are boarded (head ${state.previousId.slice(0, 8)}...): your first ride leaves from your station under the as_of it declares, the newest verified block unless you give one.`
          : `You stand at the stop for block ${state.fromHeight} (head ${state.previousId.slice(0, 8)}...): the next ride leaves from there and declares no as_of.`,
      quote ? this.quoteWords(quote) : '',
      this.flight ? `A ride to block ${this.flight.toHeight} is in flight (${this.flightWords(this.flight)}).` : '',
      this.bought.inHand ? `A ride to block ${this.bought.toHeight} bought from HOSAKA is in hand; ride_status says where it stands.` : '',
      'Nothing was signed.',
    ].filter(Boolean).join('\n')
    return {
      text,
      data: {
        line: { ...status, remainingBlobs: status.blobsTotal === null ? null : status.blobsTotal - status.blobsLoaded },
        sync,
        station: station ? { ...stopData(station.stop, stopHex(station)), distance: station.distance, asOf: line.asOf() } : null,
        nearest: nearest.map((s) => ({ height: s.stop.height, kind: s.stop.kind, distance: s.distance })),
        onLine: state ? { boarded: true, atStop: state.fromHeight, head: state.previousId } : null,
        quote,
        rideInFlight: this.flight ? this.flightData(this.flight) : null,
        here: describePlace(here),
        threads: this.threads,
        budget: this.body.budget.state(),
      },
    }
  }

  private lineWords(status: LineStatus): string {
    const held = status.asOf >= 0 ? `verified to block ${status.asOf}` : 'nothing verified yet'
    const promised = status.tip !== null ? ` of block ${status.tip}, which the manifest reaches (${status.blobsLoaded} of ${status.blobsTotal} blobs)` : ' (no manifest read yet)'
    const read = status.manifestReadAt ? `; manifest read ${status.manifestReadAt}` : ''
    const disk = status.onDiskVerifiedTo > status.asOf ? `; an earlier run verified to block ${status.onDiskVerifiedTo} on disk, held again as sync re-verifies it` : ''
    const remaining = status.blobsTotal === null ? null : status.blobsTotal - status.blobsLoaded
    const rest = remaining === 0 ? 'Nothing remains to verify.' : `${remaining === null ? 'The manifest' : `${remaining} blob(s)`} remain${remaining === null ? 's to be read' : ''}: call station with sync: true to advance the line.`
    return `Line: ${held}${promised}${read}${disk}. ${rest}`
  }

  /** The price of a ride to `destination` from where the chain says the agent would leave, without starting it. */
  private quote(destination: number, state: LineState | null, hereHex: string): RideQuote {
    const line = this.store.line
    const budget = this.body.budget.state()
    const base: RideQuote = { destination, refused: null, fromHeight: null, asOf: undefined, chained: false, blocks: 0, expectedSeconds: null, threads: this.threads, fitsCall: false, fitsSession: false, calls: 0, stop: null, exitDistance: null }
    if (!line.has(destination)) return { ...base, refused: this.beyondWords(destination) }
    const stopHex = line.stopCoordHex(destination)!
    base.stop = stopData(line.stopAt(destination)!, stopHex)
    base.exitDistance = maxAxisLca(hexToCoord(stopHex), hexToCoord(hereHex))
    const chained = state !== null && state.fromHeight !== null
    let fromHeight: number
    if (chained) {
      fromHeight = state!.fromHeight!
    } else {
      // DECK-0001 4.2: the station under the as_of the first ride will declare, the newest verified block.
      const station = line.station(state?.coordHex ?? hereHex, line.asOf())
      if (!station) return { ...base, refused: `No stop at or below block ${line.asOf()}, so no station can be named.` }
      fromHeight = station.stop.height
      base.asOf = line.asOf()
    }
    base.fromHeight = fromHeight
    base.chained = chained
    const zero = zeroLengthRideRefusal(fromHeight, destination, chained)
    if (zero) return { ...base, refused: zero }
    const blocks = rideBlocks(fromHeight, destination).length
    const seconds = estimateRideSeconds(this.body.calibration(), blocks, this.threads)
    return {
      ...base,
      blocks,
      expectedSeconds: Number(seconds.toFixed(2)),
      fitsCall: seconds <= budget.capCallSeconds,
      fitsSession: seconds <= budget.remainingSessionSeconds,
      calls: Math.max(1, Math.ceil(seconds / budget.capCallSeconds)),
    }
  }

  private quoteWords(q: RideQuote): string {
    const b = this.body.budget.state()
    if (q.refused) return `Quote to block ${q.destination}: REFUSED. ${q.refused}`
    const exit = q.exitDistance === 0 ? 'you stand on that stop now' : `that stop is h${q.exitDistance} from where you stand now`
    return `Quote to block ${q.destination}: from ${q.chained ? 'the stop you stand at' : 'your station'}, block ${q.fromHeight}${q.asOf !== undefined ? ` (as_of ${q.asOf})` : ''}, ${q.blocks} block(s), expected to take about ${q.expectedSeconds} s on this machine with ${threadWords(q.threads)}: ${q.fitsSession ? `within the session cap (${b.remainingSessionSeconds.toFixed(1)} s left)` : `ABOVE the session cap (${b.remainingSessionSeconds.toFixed(1)} s left of ${b.capSessionSeconds} s)`}, ${q.fitsCall ? 'within one call' : `about ${q.calls} calls at ${b.capCallSeconds} s each`}. After it you stand at ${stopWords(this.store.line.stopAt(q.destination)!, this.store.line.stopCoordHex(q.destination)!)}; ${exit}. Leaving the stop for another coordinate is a hop or a sidestep, priced by plan_hop.`
  }

  private beyondWords(height: number): string {
    const asOf = this.store.line.asOf()
    return asOf < 0
      ? `Block ${height} is beyond the verified line, which holds no block yet. Call station with sync: true to verify the line first.`
      : `Block ${height} is beyond the verified line, which reaches block ${asOf}. Call station with sync: true to advance it, or pick a block at or below ${asOf}.`
  }

  // ---- board -----------------------------------------------------------------

  /**
   * Board the line where the agent stands (DECK-0001 3.1). Reserves the head
   * for the call, as a hop does; the boarding's price is the temporal tree at
   * the terrain K of the coordinate (3.2), about a tenth of a second at most.
   */
  async board(input: { as_of?: number } = {}): Promise<ToolResult> {
    if (input.as_of !== undefined && !isHeight(input.as_of)) throw new Refusal('as_of must be a block height: a non-negative integer.')
    let release: () => void
    try {
      release = this.body.keeper.reserve()
    } catch (err) {
      throw new Refusal(words(err))
    }
    try {
      return await this.enter(input.as_of)
    } finally {
      release()
    }
  }

  private async enter(asOfInput: number | undefined): Promise<ToolResult> {
    const { keeper, budget } = this.body
    await this.body.refreshChain()
    const chain = this.chainToExtend('boarding')
    const state = lineStateOf(chain)
    if (state) {
      throw new Refusal(state.fromHeight === null
        ? `You are already on the line: your head is a boarding (${state.previousId.slice(0, 8)}...). A second boarding would add nothing; ride from here with ride, or hop to leave the line (DECK-0001 4.3).`
        : `You are already on the line, standing at the stop for block ${state.fromHeight}: your head is a ride. Ride again from here, or hop to leave the line (DECK-0001 4.3).`)
    }
    const head = chain[chain.length - 1]
    // The station is named now so the agent knows where its first ride would
    // leave from; the boarding itself carries no as_of. The first ride
    // declares the newest verified block then, which may be higher.
    const line = this.store.line
    if (line.asOf() < 0) throw new Refusal('The line holds no verified block yet, so your station cannot be named. Call station with sync: true to verify the line, then board.')
    const asOf = asOfInput ?? line.asOf()
    const station = this.stationUnder(head.coordHex, asOf)

    // Price: the entry proof is the temporal axis of a hop standing still (3.2), one Cantor tree at K.
    const k = terrainK(head.position.x, head.position.y, head.position.z, head.plane)
    const price = projectCantorMs(this.body.calibration().cantorMsByHeight, k) / 1000
    const refusal = budget.refusal(price)
    if (refusal) throw new Refusal(refusal)

    // Confirm the head, fresh, before any work; the head must be the one the plan was made from.
    const unconfirmed = await keeper.confirmHead()
    if (unconfirmed) throw new Refusal(unconfirmed)
    if (keeper.head()?.id !== head.id) throw new Refusal(`The head moved while planning: the relays hold a newer move (${keeper.head()?.id.slice(0, 8)}...), adopted now. Call board again from where you stand.`)
    if (keeper.status() !== 'valid') throw new Refusal(keeper.breakWords() ?? 'The chain is not valid.')

    const t0 = performance.now()
    const proofHash = this.entryProof(head)
    const seconds = (performance.now() - t0) / 1000
    budget.spendMove(seconds)

    // Confirm again, immediately before the signature: another device may have moved meanwhile.
    const again = await keeper.confirmHead()
    if (again) throw new Refusal(`${again} The entry proof (${seconds.toFixed(2)} s of work) was discarded unsigned.`)
    if (keeper.head()?.id !== head.id) throw new Refusal(`The head moved while the entry proof was computed: the relays hold a newer move (${keeper.head()?.id.slice(0, 8)}...), adopted now. The proof was discarded unsigned; call board again from where you stand.`)

    const template = enterHyperspaceTemplate({ createdAt: createdAtAfter(head), genesisId: chain[0].id, previousId: head.id, coordHex: head.coordHex, proofHash })
    const event = this.signChainEvent(template, 'boarding')
    const published = await this.publish(event)
    this.body.settle()
    const stopHex = line.stopCoordHex(station.stop.height)!
    const where = describePlace(placeFromHex(head.coordHex))
    const text = [
      `Boarding ${event.id.slice(0, 8)}... signed at ${where.hex} (${where.planeName}, sector ${where.sector}; entry proof at K ${k}, ${seconds.toFixed(2)} s of work). You are on the line and have not moved.`,
      `Your station under as_of ${asOf} is ${stopWords(station.stop, stopHex)}, ${station.distance === 0 ? 'where you stand' : `h${station.distance} from you`}. The first ride declares the line's newest verified block as its as_of when it is signed (${line.asOf()} now), and leaves from the station under that bound.`,
      ...this.relayWords(published.entry, published.result),
      'Ride with ride { to: <block height> }; a hop or a sidestep leaves the line.',
    ].join('\n')
    return {
      text,
      data: {
        eventId: event.id, action: 'enter-hyperspace', where, terrainK: k, workSeconds: Number(seconds.toFixed(3)),
        station: { ...stopData(station.stop, stopHex), distance: station.distance, asOf },
        lineAsOf: line.asOf(), accepted: published.entry.accepted, refused: published.entry.refused ?? {}, canonicalPending: !published.entry.accepted.includes(this.body.canonical),
        budget: budget.state(),
      },
    }
  }

  /** The entry proof for the head (DECK-0001 3.2): the work of a boarding, in its own method so a test can watch the head move under it. */
  entryProof(head: ActionEvent): string {
    return computeEnterProof(hexToCoord(head.coordHex), head.id)
  }

  /** The station for a coordinate under `asOf`, or the refusal that says to sync the line. */
  private stationUnder(coordHex: string, asOf: number): StationResult {
    let station: StationResult | null
    try {
      station = this.store.line.station(coordHex, asOf)
    } catch (err) {
      throw new Refusal(`${words(err)}. Call station with sync: true to advance the line, or pass a lower as_of.`)
    }
    if (!station) throw new Refusal(`No stop at or below block ${asOf}, so no station can be named under it.`)
    return station
  }

  /** The valid chain a boarding or a ride would extend, or the refusal that says why there is none. */
  private chainToExtend(what: 'boarding' | 'ride'): ActionEvent[] {
    const { keeper } = this.body
    const status = keeper.status()
    if (status === 'none') throw new Refusal(`You have no chain yet, and a ${what} links to the event before it. Hop first (your first hop signs your spawn), then board${what === 'ride' ? ', then ride' : ''}.`)
    if (status !== 'valid') throw new Refusal(`${keeper.breakWords()} A ${what} is a chain action and cannot be signed on this chain.`)
    const chain = keeper.chain()
    if (openBracket(chain)) throw new Refusal(`You are inside a game (an enter-virtual with no exit). A ${what} is a move through cyberspace, and inside a game only the game's own actions may stand (spec 8.11.4 rule 3). Leave the game first.`)
    return chain
  }

  // ---- ride ------------------------------------------------------------------

  /**
   * Ride the line to a block (DECK-0001 5), in the background (arkinox,
   * 2026-10-11). The first call quotes the whole ride against the session
   * cap, reserves the head, confirms it, starts the work and returns at once.
   * A later call with the same `to` reports where the work stands, resumes it
   * when it was paused (on command, at the cap, or by an error), and, once
   * the proof is ready, signs it. `wait_seconds` (or the older
   * `budget_seconds`) waits that long, at most the per-call cap, for the
   * proof before answering, and signs it if it is ready by then. `pause`
   * stops the work and keeps the head; `cancel` releases the head and keeps
   * the cache; `forget` drops the cache too.
   */
  async ride(input: { to?: number; budget_seconds?: number; wait_seconds?: number; as_of?: number; pause?: boolean; cancel?: boolean; forget?: boolean; prover?: 'local' | 'hosaka' } = {}, signal?: AbortSignal): Promise<ToolResult> {
    for (const [name, v] of [['budget_seconds', input.budget_seconds], ['wait_seconds', input.wait_seconds]] as const) {
      if (v !== undefined && (!Number.isFinite(v) || v <= 0)) throw new Refusal(`${name} must be a positive number of seconds.`)
    }
    if (input.as_of !== undefined && !isHeight(input.as_of)) throw new Refusal('as_of must be a block height: a non-negative integer.')
    if (input.prover !== undefined && input.prover !== 'local' && input.prover !== 'hosaka') throw new Refusal('prover must be "local" (this machine computes the proof) or "hosaka" (HOSAKA computes it, paid from your operator\'s wallet within their limits, or by your operator).')
    if (input.cancel || input.forget) {
      if (this.bought.inHand) {
        const result = await this.bought.cancel()
        if (input.forget) this.runner.forget((result.data.canceled as { previousId: string }).previousId)
        return result
      }
      return this.releaseRide(!!input.forget)
    }
    if (input.pause) {
      if (this.bought.inHand) throw new Refusal(`The ride to block ${this.bought.toHeight} is computed by HOSAKA, which cannot be paused from here. ride_status watches it; cancel: true lets it go.`)
      return this.pauseRide()
    }
    const to = input.to
    if (!isHeight(to)) throw new Refusal('Say which block to ride to: to, a block height. Or pass pause: true to pause the ride in flight, cancel: true to release it, or forget: true to drop its cache too.')
    // A HOSAKA ride in hand is continued by the same call, whatever prover is named, so one key never has two rides.
    if (this.bought.inHand) {
      if (input.prover === 'local' && this.bought.toHeight === to) throw new Refusal(`A HOSAKA ride to block ${to} is in hand; computing the same ride here as well would be a second ride from one head. Cancel it first to ride locally.`)
      return this.bought.continue(to, input.wait_seconds ?? input.budget_seconds, signal)
    }
    if (input.prover === 'hosaka') {
      if (this.flight) throw new Refusal(`A ride to block ${this.flight.toHeight} is computing on this machine (${this.flightWords(this.flight)}). Cancel it first (its work stays on disk) to buy the ride from HOSAKA instead.`)
      return this.bought.start(to, input.as_of)
    }
    if (this.flight && this.flight.toHeight !== to) {
      throw new Refusal(`A ride to block ${this.flight.toHeight} is in flight (${this.flightWords(this.flight)}). Call ride with to: ${this.flight.toHeight} to continue it, ride_status to watch it, pause: true to pause it, or cancel: true to release the head before riding elsewhere.`)
    }
    if (this.flight?.signing) throw new Refusal(`The ride to block ${to} is being signed in another call right now; call ride_status in a moment.`)
    const told: string[] = []
    if (this.ended) {
      told.push(`Earlier: ${this.ended.reason}`)
      this.ended = null
    }
    const fresh = !this.flight || this.flight.progress === null
    if (this.flight) {
      if (input.as_of !== undefined && input.as_of !== this.flight.asOf) throw new Refusal(`The ride in flight ${this.flight.asOf === undefined ? 'declares no as_of (it leaves from a stop)' : `declares as_of ${this.flight.asOf}`}, fixed when it started, because the station and every leaf depend on it. Cancel it to ride under another as_of.`)
    } else {
      await this.startRide(to, input.as_of)
    }
    const flight = this.flight!
    flight.calls++
    if (flight.state === 'computing' && flight.run) {
      this.watchHead(flight)
    } else if (flight.state !== 'ready') {
      // Started now, or resumed: the head must still be the one every leaf was seeded by.
      await this.checkFlight(flight)
      const was = flight.state
      this.launch(flight)
      if (!fresh && flight.state === 'computing') told.push(`Resumed from ${was === 'paused' ? 'the pause' : was === 'paused_cap' ? 'the session-cap pause' : 'the failure'} in the background; no finished leaf is computed again.`)
      else if (fresh && flight.state === 'computing') told.push(`Started the ride in the background on ${threadWords(this.threads)}. Other tools answer while it computes: keep reading inbox and answering your operator.`)
    }
    const wait = input.wait_seconds ?? input.budget_seconds
    if (wait !== undefined && flight.state === 'computing') await this.waitWhileComputing(flight, Math.min(wait, this.body.budget.capCallSeconds), signal)
    if (flight.state === 'ready' && this.flight === flight) return this.signRide(flight, told)
    if (flight.state === 'paused_cap') throw new Refusal([...told, this.capWords(flight)].join(' '))
    return this.progressResult(flight, told)
  }

  /**
   * What a ride from the agent's head to `to` would be, whoever computes it:
   * the chain, the line, the station or the stop, the as_of, the blocks.
   * Refuses in words; reserves nothing.
   */
  private async planRide(to: number, asOfInput: number | undefined): Promise<RidePlan> {
    await this.body.refreshChain()
    const chain = this.chainToExtend('ride')
    const state = lineStateOf(chain)
    const head = chain[chain.length - 1]
    if (!state) {
      const stood = lookBack(chain, chain.length)
      throw new Refusal(`You are not on the line: your head ${head.id.slice(0, 8)}... is ${stood ? `a ${stood.type === 'other' ? 'skipped event' : stood.type}` : 'not a recognized action'}, and a ride follows only a boarding or another ride (DECK-0001 4.3). Call board first.`)
    }
    const line = this.store.line
    if (!line.has(to)) throw new Refusal(this.beyondWords(to))
    const chained = state.fromHeight !== null
    const notes: string[] = []
    let fromHeight: number
    let asOf: number | undefined
    if (chained) {
      // DECK-0001 4.3, 5.2: a ride from a stop starts at that stop and declares no station bound.
      fromHeight = state.fromHeight!
      if (asOfInput !== undefined) notes.push(`as_of ${asOfInput} was ignored: a ride from a stop leaves from the stop and declares no station bound (DECK-0001 5.2).`)
      if (!line.has(fromHeight)) throw new Refusal(`You stand at the stop for block ${fromHeight}, which this process has not verified yet (the line reaches block ${line.asOf()}). Call station with sync: true to advance it.`)
    } else {
      // DECK-0001 4.2 as amended: the station set is bounded by a declared
      // as_of, the newest verified block unless the agent names a lower one;
      // never below the destination, which the station set must cover.
      asOf = asOfInput ?? line.asOf()
      if (asOf < to) throw new Refusal(`as_of (${asOf}) is below the block the ride goes to (${to}); the station bound covers the destination (DECK-0001 4.2, 5.2). Pass an as_of of at least ${to}, or leave it out to declare the newest verified block (${line.asOf()}).`)
      fromHeight = this.stationUnder(state.coordHex, asOf).stop.height
    }
    const zero = zeroLengthRideRefusal(fromHeight, to, chained)
    if (zero) throw new Refusal(zero)
    const blocks = rideBlocks(fromHeight, to).length
    return { previousId: state.previousId, prevCoordHex: state.coordHex, genesisId: chain[0].id, fromHeight, toHeight: to, asOf, chained, blocks, notes }
  }

  /** The first call of a ride computed here: the plan, the quote against the session cap, then the reservation. */
  private async startRide(to: number, asOfInput: number | undefined): Promise<void> {
    const { keeper, budget } = this.body
    const plan = await this.planRide(to, asOfInput)
    const { blocks, fromHeight, notes } = plan
    const seconds = estimateRideSeconds(this.body.calibration(), blocks, this.threads)
    const b = budget.state()
    if (!(seconds <= b.remainingSessionSeconds)) {
      throw new Refusal(`A ride of ${blocks} block(s) from block ${fromHeight} to block ${to} is expected to take about ${seconds.toFixed(1)} s on this machine (${threadWords(this.threads)}), and the session has ${b.remainingSessionSeconds.toFixed(1)} s of its ${b.capSessionSeconds} s left. The ride computes in the background and is charged to the session cap as it goes. Pick a nearer block, tell your operator by DM how many seconds it needs (a KEEP GOING from them renews the session budget), or buy the ride from HOSAKA with prover: "hosaka" (paid from your operator's wallet within their limits, or by your operator).`)
    }
    // A ride that was under way when this server last stopped, or that was canceled with its cache kept: say plainly whether this one picks it up.
    const earlier = this.interrupted
    if (earlier) {
      if (earlier.previousId === plan.previousId) {
        notes.push(`The ride ${earlier.status === 'live' ? 'under way when the server last stopped' : 'canceled earlier'} left from this same head, so its ${earlier.leavesDone} cached leaf(s) are picked up${earlier.toHeight === to ? '' : ` where they overlap (it went to block ${earlier.toHeight})`}; none is computed again.`)
      } else {
        notes.push(`The ride to block ${earlier.toHeight} ${earlier.status === 'live' ? 'under way when the server last stopped' : 'canceled earlier'} left from head ${earlier.previousId.slice(0, 8)}..., but your head is now ${plan.previousId.slice(0, 8)}...: every leaf of that ride was seeded by the old head (DECK-0001 5.3), so it cannot be resumed from here, and this ride starts fresh.`)
        this.runner.forget(earlier.previousId)
      }
    }
    let release: () => void
    try {
      release = keeper.reserve()
    } catch (err) {
      throw new Refusal(words(err))
    }
    this.interrupted = null
    this.flight = {
      previousId: plan.previousId, prevCoordHex: plan.prevCoordHex, genesisId: plan.genesisId, fromHeight, toHeight: to, asOf: plan.asOf, chained: plan.chained, blocks, quotedSeconds: seconds,
      release, startedAt: Date.now(), calls: 0, workSeconds: 0, progress: null, notes,
      state: 'paused', run: null, abort: null, pauseAsked: false, charged: 0, chargedAt: performance.now(), proof: null, failure: null, signing: false,
      headCheckedAt: 0, headCheck: null, savedAt: 0,
    }
    this.saveRecord(this.flight, true)
  }

  /**
   * Before work starts or resumes: the head must still be the one the ride
   * left from, because every leaf is seeded by it (DECK-0001 5.3). Relays
   * that cannot be asked do not stop the work, which is local; they stop the
   * signature.
   */
  private async checkFlight(flight: Flight): Promise<void> {
    const unconfirmed = await this.body.keeper.confirmHead()
    flight.headCheckedAt = Date.now()
    await this.refuseIfMoved(flight)
    if (unconfirmed) flight.notes.push('The relays could not confirm the head when the work started; the work went on, because it is local, and the signature waits for a confirmation.')
  }

  /** Drop the ride and refuse when the head is no longer the one it left from. */
  private async refuseIfMoved(flight: Flight): Promise<void> {
    const head = this.body.keeper.head()
    if (head?.id === flight.previousId) return
    // The run ends before the cache is dropped, so no late flush writes it back.
    await this.stopRun(flight, 'abort')
    this.dropFlight(flight, true)
    throw new Refusal(this.movedWords(flight, head?.id ?? null))
  }

  private movedWords(flight: Flight, headId: string | null): string {
    return `The head moved while the ride to block ${flight.toHeight} was in flight: the relays hold a newer move (${headId ? `${headId.slice(0, 8)}...` : 'none'}), adopted now. Every leaf of the ride was seeded by the old head (DECK-0001 5.3), so the ride can never be signed or resumed from there; its cache was dropped and the head released. Board or ride again from where you stand.`
  }

  /**
   * While the ride computes, a ride call also looks at the relays for a
   * newer head, in the background and at most once a minute, so a ride that
   * can never be signed stops costing work without the call waiting on a
   * relay. A moved head drops the ride; the next ride call or status says so.
   */
  private watchHead(flight: Flight): void {
    if (flight.headCheck || Date.now() - flight.headCheckedAt < HEAD_CHECK_EVERY_MS) return
    flight.headCheck = (async () => {
      await this.body.keeper.confirmHead()
      flight.headCheckedAt = Date.now()
      const head = this.body.keeper.head()
      if (this.flight !== flight || flight.signing || head?.id === flight.previousId) return
      await this.stopRun(flight, 'abort')
      if (this.flight !== flight || flight.signing) return
      this.ended = { to: flight.toHeight, reason: this.movedWords(flight, head?.id ?? null) }
      this.dropFlight(flight, true)
    })().catch((err) => this.body.log(`ride head check: ${words(err)}`)).finally(() => { flight.headCheck = null })
  }

  private dropFlight(flight: Flight, forgetCache: boolean): void {
    flight.release()
    if (forgetCache) this.runner.forget(flight.previousId)
    if (this.flight === flight) this.flight = null
    if (forgetCache) this.deleteRecord()
    else this.saveRecord(flight, true, 'canceled')
  }

  // ---- the background run -------------------------------------------------------

  /**
   * Start the background run, unless the session cap is spent (then the
   * ride stays paused at the cap). The run goes on between calls: on a
   * thread of its own (rideHost.ts), or with threads 0 on this thread,
   * yielding to the event loop between leaves. It is charged to the session
   * as its progress comes in, and cut when the session cap is reached or a
   * pause is asked; what it computed stays on disk.
   */
  private launch(flight: Flight): void {
    if (flight.run) return
    const { budget } = this.body
    const line = this.store.line
    // The store starts its walk over when the manifest changed under a held blob (line.ts reconcile), so a block verified when the ride started may not be held now.
    const hashes = line.rideHashes(flight.fromHeight, flight.toHeight)
    if (hashes === null) throw new Refusal(`The line no longer holds blocks ${Math.min(flight.fromHeight, flight.toHeight)} to ${Math.max(flight.fromHeight, flight.toHeight)} (verified to block ${line.asOf()} now). Call station with sync: true to verify it again; the ride stays in flight, paused, and resumes from its cache.`)
    const remaining = budget.state().remainingSessionSeconds
    if (remaining <= 0) {
      flight.state = 'paused_cap'
      return
    }
    flight.state = 'computing'
    flight.pauseAsked = false
    flight.failure = null
    flight.charged = 0
    flight.chargedAt = performance.now()
    const controller = new AbortController()
    flight.abort = controller
    const options: RideRunOptions = {
      budgetSeconds: remaining,
      signal: controller.signal,
      stop: () => flight.pauseAsked || this.overCap(flight),
      onProgress: (p) => {
        flight.progress = p
        this.charge(flight, p.elapsedMs / 1000)
        this.saveRecord(flight, false)
      },
    }
    const work: Promise<RideRunResult> = this.threads === 0
      ? this.runner.run({
        previousEventIdHex: flight.previousId, fromHeight: flight.fromHeight, toHeight: flight.toHeight,
        blockHashFor: (height) => {
          const lo = Math.min(flight.fromHeight, flight.toHeight)
          return bytesToHex(hashes.subarray((height - lo - 1) * 32, (height - lo) * 32))
        },
      }, options)
      : runRideInThread({ cachePath: this.runner.cache.path, threads: this.threads, previousEventIdHex: flight.previousId, fromHeight: flight.fromHeight, toHeight: flight.toHeight, hashes }, options)
    flight.run = work.then(
      (result) => {
        flight.run = null
        flight.abort = null
        this.charge(flight, result.workSeconds)
        flight.progress = result.progress
        if (result.done) {
          flight.state = 'ready'
          flight.proof = result
        } else if (flight.pauseAsked) {
          flight.state = 'paused'
        } else {
          flight.state = 'paused_cap'
          // A run's deadline is fixed when it starts; a renewal that came
          // while it ran leaves budget it could not see. With seconds left
          // and work done (no spin), it carries on by itself.
          if (this.flight === flight && result.workSeconds > 0 && this.body.budget.state().remainingSessionSeconds > 0) {
            try {
              this.launch(flight)
            } catch (err) {
              flight.state = 'failed'
              flight.failure = words(err)
            }
          }
        }
        this.saveRecord(flight, true)
      },
      (err: unknown) => {
        flight.run = null
        flight.abort = null
        if (err instanceof Error && err.name === 'AbortError') {
          flight.state = 'paused'
        } else {
          flight.state = 'failed'
          flight.failure = words(err)
          this.body.log(`ride failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
        }
        this.saveRecord(flight, true)
      },
    )
  }

  /** Charge the session for the current run up to `elapsed` seconds of it (by the runner's clock). */
  private charge(flight: Flight, elapsed: number): void {
    const delta = elapsed - flight.charged
    if (delta <= 0) return
    this.body.budget.spendWork(delta)
    flight.workSeconds += delta
    flight.charged = elapsed
    flight.chargedAt = performance.now()
  }

  /**
   * Whether the session cap is reached, counting the seconds the current run
   * has spent since its last progress report (a heavy leaf can be many
   * seconds; with threads 0 the runner's own clock is the only one, and
   * progress comes every leaf).
   */
  private overCap(flight: Flight): boolean {
    const { budget } = this.body
    const pending = this.threads === 0 ? 0 : (performance.now() - flight.chargedAt) / 1000
    return budget.spentSeconds + pending >= budget.capSessionSeconds
  }

  /**
   * Stop the background run: 'pause' cuts it at the next leaf (the leaves
   * in hand finish, within the runner's grace), 'abort' ends it at once
   * (finished leaves are flushed either way). Resolves once it stopped, or
   * after STOP_WAIT_MS, when it is aborted outright.
   */
  private async stopRun(flight: Flight, how: 'pause' | 'abort'): Promise<void> {
    const run = flight.run
    if (!run) return
    if (how === 'pause') flight.pauseAsked = true
    else flight.abort?.abort()
    let timer: ReturnType<typeof setTimeout> | null = null
    const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), STOP_WAIT_MS) })
    const outcome = await Promise.race([run.then(() => 'stopped' as const), late])
    if (timer !== null) clearTimeout(timer)
    if (outcome === 'late') {
      flight.abort?.abort()
      await run
    }
  }

  /** Wait while the ride computes, for at most `seconds` or until the call is canceled. */
  private async waitWhileComputing(flight: Flight, seconds: number, signal: AbortSignal | undefined): Promise<void> {
    const until = Date.now() + seconds * 1000
    while (flight.state === 'computing' && this.flight === flight && Date.now() < until && !signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, until - Date.now()))))
    }
  }

  /** Pause on command (an operator's HOLD): the work stops at the next leaf, the head stays reserved, and `ride` with the same `to` resumes it. */
  private async pauseRide(): Promise<ToolResult> {
    const flight = this.flight
    if (!flight) throw new Refusal('No ride is in flight; nothing to pause.')
    if (flight.signing) throw new Refusal(`The ride to block ${flight.toHeight} is being signed in another call right now, so it cannot be paused.`)
    if (flight.state !== 'computing') return this.progressResult(flight, [`The ride to block ${flight.toHeight} is not computing (${flight.state === 'ready' ? 'its proof is ready to sign' : flight.state}); nothing to pause.`])
    await this.stopRun(flight, 'pause')
    return this.progressResult(flight, [`Paused the ride to block ${flight.toHeight}. Every finished leaf is on disk and the head stays reserved for this ride. Call ride with to: ${flight.toHeight} to resume it, or cancel: true to release the head.`])
  }

  private async releaseRide(forget: boolean): Promise<ToolResult> {
    const flight = this.flight
    if (!flight) {
      if (!forget) throw new Refusal('No ride is in flight; nothing to cancel.')
      const head = this.body.keeper.head()
      if (!head) throw new Refusal('No ride is in flight and no chain is known; nothing to forget.')
      this.runner.forget(head.id)
      if (this.interrupted) this.runner.forget(this.interrupted.previousId)
      this.interrupted = null
      this.deleteRecord()
      return { text: `No ride is in flight. The cached leaves and price searches of rides from your head ${head.id.slice(0, 8)}... were dropped.`, data: { inFlight: false, forgot: head.id } }
    }
    if (flight.signing) throw new Refusal(`The ride to block ${flight.toHeight} is being signed in another call right now, so it cannot be canceled.`)
    await this.stopRun(flight, 'abort')
    if (this.flight !== flight) throw new Refusal('The ride ended while it was being canceled; call ride_status.')
    const said = this.flightWords(flight)
    const data = this.flightData(flight)
    this.dropFlight(flight, forget)
    if (!forget) this.interrupted = this.readRecord()
    return {
      text: `Canceled the ride to block ${flight.toHeight} (${said}). The head is released for other moves. ${forget ? 'Its cached leaves and price search were dropped.' : 'Its cached leaves and price search are kept on disk: a later ride from this same head resumes them; forget: true drops them.'}`,
      data: { inFlight: false, canceled: data, forgot: forget ? flight.previousId : null },
    }
  }

  /** Stop the background work for shutdown: finished leaves are flushed, and flight.json says a ride was under way. */
  async stop(): Promise<void> {
    const step = this.bought.stop()
    if (step) await step
    const flight = this.flight
    if (!flight) return
    await this.stopRun(flight, 'abort')
    this.saveRecord(flight, true)
  }

  // ---- signing --------------------------------------------------------------------

  /** The proof is ready: confirm the head, sign, publish, record, then forget the cache. Never called from the background. */
  private async signRide(flight: Flight, told: string[]): Promise<ToolResult> {
    const { budget, keeper } = this.body
    const proof = flight.proof!
    const line = this.store.line
    flight.signing = true
    let event: NostrEvent
    try {
      // Confirm again, immediately before the signature: the machine was busy for a while.
      const again = await keeper.confirmHead()
      if (again) throw new Refusal(`${again} The ride's proof is finished and kept: call ride again with to: ${flight.toHeight} once the relays answer, and it is signed without being recomputed.`)
      await this.refuseIfMoved(flight)
      const head = keeper.head()!
      const toCoordHex = line.stopCoordHex(flight.toHeight)
      if (!toCoordHex) throw new Refusal(`The line no longer holds block ${flight.toHeight} (verified to block ${line.asOf()} now). Call station with sync: true to verify it again; the proof is kept and signed on the next ride call.`)
      try {
        event = this.signChainEvent(hyperjumpTemplate({
          createdAt: createdAtAfter(head), genesisId: flight.genesisId, previousId: flight.previousId, prevCoordHex: flight.prevCoordHex, toCoordHex,
          fromHeight: flight.fromHeight, toHeight: flight.toHeight, ...(flight.asOf !== undefined ? { asOf: flight.asOf } : {}),
          rootHex: proof.proof.rootHex, mp: proof.proof.mp, mnHex: proof.proof.mnHex,
        }), 'ride')
      } catch (err) {
        // A bug, not a refusal: the head is released so the agent is not stuck, and the cache is kept.
        this.dropFlight(flight, false)
        throw err
      }
    } finally {
      flight.signing = false
    }
    const published = await this.publish(event)
    // Only now, with the event recorded by publish (before it was sent), is
    // the cache dropped (rideRunner.ts header): a crash between the proof and
    // the record resumes from disk instead of repaying the work.
    this.runner.forget(flight.previousId)
    flight.release()
    this.flight = null
    this.deleteRecord()
    budget.moves++
    this.body.settle()
    const toCoordHex = line.stopCoordHex(flight.toHeight)!
    const stop = line.stopAt(flight.toHeight)!
    const where = describePlace(placeFromHex(toCoordHex))
    const text = [
      ...told,
      `Ride ${event.id.slice(0, 8)}... signed: block ${flight.fromHeight} to block ${flight.toHeight} (${flight.blocks} block(s)${flight.asOf !== undefined ? `, as_of ${flight.asOf}` : ''}), ${flight.workSeconds.toFixed(1)} s of work in the background over ${flight.calls} ride call(s), proof verified at Level 1 (${proof.verification.checked} openings). You now stand at ${stopWords(stop, toCoordHex)}.`,
      ...this.relayWords(published.entry, published.result),
      ...flight.notes,
      ...proof.progress.notes,
      `Ride again to another block, or hop or sidestep to leave the line (a target away from this stop is priced by plan_hop).`,
    ].join('\n')
    return {
      text,
      data: {
        eventId: event.id, action: 'hyperjump', fromHeight: flight.fromHeight, toHeight: flight.toHeight, asOf: flight.asOf ?? null, blocks: flight.blocks, where, stop: stopData(stop, toCoordHex),
        workSeconds: Number(flight.workSeconds.toFixed(3)), calls: flight.calls, verification: proof.verification, root: proof.proof.rootHex, mn: proof.proof.mnHex,
        accepted: published.entry.accepted, refused: published.entry.refused ?? {}, canonicalPending: !published.entry.accepted.includes(this.body.canonical),
        notes: [...flight.notes, ...proof.progress.notes], budget: budget.state(),
      },
    }
  }

  // ---- what the agent is told -------------------------------------------------------

  /** The seconds the ride still needs, by the runner's estimate when it has one, else by the quote. */
  private needSeconds(flight: Flight): number {
    const p = flight.progress
    if (p?.etaMs !== null && p?.etaMs !== undefined) return p.etaMs / 1000
    return Math.max(0, flight.quotedSeconds - flight.workSeconds)
  }

  private capWords(flight: Flight): string {
    const b = this.body.budget.state()
    return `The ride to block ${flight.toHeight} is paused at the session cap: the session has spent its ${b.capSessionSeconds} s of work (${this.flightWords(flight)}). It needs about ${Math.ceil(this.needSeconds(flight))} s more. Everything computed is on disk and the head stays reserved. Tell your operator by DM how many more seconds the ride needs: a KEEP GOING from them renews the session budget, and the next ride call with to: ${flight.toHeight} resumes it from the cache. cancel: true releases the head.`
  }

  private stateWords(flight: Flight): string {
    switch (flight.state) {
      case 'computing': return `It is computing in the background; other tools answer meanwhile. Call ride with to: ${flight.toHeight} again later (ride_status or orders_waiting show when it is ready), or pause: true to pause it.`
      case 'ready': return `Its proof is ready: call ride with to: ${flight.toHeight} to sign it.`
      case 'paused': return `It is paused; the head stays reserved for it. Call ride with to: ${flight.toHeight} to resume it from the cache, or cancel: true to release the head.`
      case 'paused_cap': return this.capWords(flight)
      case 'failed': return `Its work stopped on an error (${flight.failure}); everything finished is on disk. Call ride with to: ${flight.toHeight} to try again from the cache, or cancel: true to release the head.`
    }
  }

  private progressResult(flight: Flight, told: string[]): ToolResult {
    const b = this.body.budget.state()
    const p = flight.progress
    const text = [
      ...told,
      `Ride to block ${flight.toHeight} from block ${flight.fromHeight} (${flight.blocks} block(s)${flight.asOf !== undefined ? `, as_of ${flight.asOf}` : ''}): ${flight.state}, ${this.flightWords(flight)}.`,
      this.stateWords(flight),
      `${flight.workSeconds.toFixed(1)} s of work so far of about ${flight.quotedSeconds.toFixed(1)} s quoted; the session has ${b.remainingSessionSeconds.toFixed(1)} s left. The head is reserved for this ride.`,
      ...flight.notes,
      ...(p?.notes ?? []),
    ].filter(Boolean).join('\n')
    return { text, data: { done: false, inFlight: true, state: flight.state, ride: this.flightData(flight), budget: b } }
  }

  /** The ride in flight, read only. */
  rideStatus(): ToolResult {
    if (this.bought.inHand) return this.bought.status()
    const flight = this.flight
    const state = lineStateOf(this.body.keeper.chain())
    const onLine = state === null ? 'You are not on the line; board first.' : state.fromHeight === null ? 'You are boarded; ride to a block to travel.' : `You stand at the stop for block ${state.fromHeight}; ride again, or hop to leave the line.`
    const ride = this.rideState()
    if (!flight) {
      const said: string[] = []
      if (this.ended) said.push(`The ride to block ${this.ended.to} ended: ${this.ended.reason}`)
      const let_go = this.bought.endedWords()
      if (let_go) said.push(let_go)
      const earlier = this.interrupted
      if (earlier && earlier.status === 'live') {
        said.push(ride.state === 'interrupted'
          ? `A ride to block ${earlier.toHeight} was in flight when the server last stopped, from your current head, with ${earlier.leavesDone} of ${earlier.blocks} leaves on disk. Call ride with to: ${earlier.toHeight} to resume it from the cache (sync the line with station first if it asks).`
          : `A ride to block ${earlier.toHeight} was in flight when the server last stopped, but it left from head ${earlier.previousId.slice(0, 8)}... and your head is now another: it cannot be resumed from that boarding.`)
      }
      return { text: [`No ride is in flight.`, ...said, onLine].join(' '), data: { inFlight: false, state: ride.state, rideState: ride, onLine: state ? { boarded: true, atStop: state.fromHeight, head: state.previousId } : null } }
    }
    const stale = this.body.keeper.head()?.id !== flight.previousId
    const text = [
      `Ride to block ${flight.toHeight} from block ${flight.fromHeight} (${flight.blocks} block(s)${flight.asOf !== undefined ? `, as_of ${flight.asOf}` : ''}): ${flight.state}, ${this.flightWords(flight)}.`,
      stale ? 'The head moved since the ride started, so this ride can never be signed; the next ride call drops it, or cancel: true releases it now.' : this.stateWords(flight),
    ].join(' ')
    return { text, data: { inFlight: true, stale, state: flight.state, rideState: ride, ride: this.flightData(flight) } }
  }

  /**
   * The ride's state for orders_waiting (arkinox, 2026-10-11): in memory and
   * on what this server already knows, never a relay, so a waker polling
   * every few seconds costs nothing.
   */
  rideState(): RideStateData {
    const none: RideStateData = { state: null, to: null, done: 0, total: 0, attempts: 0, attemptsExpected: 0, etaSeconds: null, reason: null, prover: null }
    const bought = this.bought.rideState()
    if (bought) return bought
    const flight = this.flight
    if (flight) {
      const p = flight.progress
      return {
        state: flight.state, to: flight.toHeight, done: p?.leavesDone ?? 0, total: flight.blocks, attempts: p?.attempts ?? 0, attemptsExpected: p?.attemptsExpected ?? 0,
        etaSeconds: flight.state === 'ready' ? 0 : Math.ceil(this.needSeconds(flight)), reason: flight.state === 'failed' ? flight.failure : null, prover: 'local',
      }
    }
    if (this.ended) return { ...none, state: 'failed', to: this.ended.to, reason: this.ended.reason, prover: 'local' }
    const earlier = this.interrupted
    if (earlier && earlier.status === 'live' && this.body.keeper.head()?.id === earlier.previousId) {
      return { ...none, state: 'interrupted', to: earlier.toHeight, done: earlier.leavesDone, total: earlier.blocks, prover: 'local' }
    }
    return none
  }

  private flightWords(flight: Flight): string {
    const p = flight.progress
    const since = Math.round((Date.now() - flight.startedAt) / 1000)
    if (!p) return `started ${since} s ago, nothing computed yet`
    const phase = p.phase === 'leaves' ? 'leaves' : p.phase === 'price' ? 'price nonce search' : p.phase === 'verify' ? 'self-verification' : 'done'
    const eta = flight.state !== 'ready' ? `, about ${Math.ceil(this.needSeconds(flight))} s of work to go` : ''
    return `${phase}, ${p.leavesDone} of ${p.leavesTotal} leaves (${p.leavesResumed} resumed from the cache), ${p.attempts} of about ${p.attemptsExpected} price attempt(s)${eta}, ${flight.workSeconds.toFixed(1)} s of work, started ${since} s ago`
  }

  private flightData(flight: Flight): Record<string, unknown> {
    return {
      previousId: flight.previousId, fromHeight: flight.fromHeight, toHeight: flight.toHeight, asOf: flight.asOf ?? null, chained: flight.chained, blocks: flight.blocks,
      quotedSeconds: Number(flight.quotedSeconds.toFixed(2)), calls: flight.calls, workSeconds: Number(flight.workSeconds.toFixed(3)), startedAt: flight.startedAt,
      state: flight.state, computing: flight.state === 'computing', needSeconds: flight.state === 'ready' ? 0 : Number(this.needSeconds(flight).toFixed(1)), failure: flight.failure,
      progress: flight.progress, notes: flight.notes,
    }
  }

  // ---- flight.json ------------------------------------------------------------------

  private recordPath(): string {
    return join(this.runner.cache.path, FLIGHT_FILE)
  }

  private readRecord(): FlightRecord | null {
    try {
      const r = JSON.parse(readFileSync(this.recordPath(), 'utf8')) as FlightRecord
      if (r?.version !== 1 || typeof r.previousId !== 'string' || !isHeight(r.toHeight) || !isHeight(r.fromHeight)) return null
      return r
    } catch {
      return null
    }
  }

  /** Write flight.json: always when `force`, else at most every RECORD_EVERY_MS (progress comes ten times a second). */
  private saveRecord(flight: Flight, force: boolean, status: FlightRecord['status'] = 'live'): void {
    const now = Date.now()
    if (!force && now - flight.savedAt < RECORD_EVERY_MS) return
    flight.savedAt = now
    const record: FlightRecord = {
      version: 1, status, previousId: flight.previousId, fromHeight: flight.fromHeight, toHeight: flight.toHeight, asOf: flight.asOf ?? null, blocks: flight.blocks,
      leavesDone: flight.progress?.leavesDone ?? 0, workSeconds: Number(flight.workSeconds.toFixed(3)), savedAt: now,
    }
    try {
      const tmp = `${this.recordPath()}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 })
      renameSync(tmp, this.recordPath())
    } catch (err) {
      this.body.log(`flight.json: ${words(err)}`)
    }
  }

  private deleteRecord(): void {
    try { unlinkSync(this.recordPath()) } catch { /* none */ }
  }

  // ---- signing and publishing, shared ---------------------------------------

  /**
   * A HOSAKA ride's hyperjump, for a plan and a proof hosakaRide.ts has
   * checked at Level 1 and a head it has confirmed: signed through both
   * checks (signChainEvent), recorded, published. The same template a ride
   * computed here is signed with.
   */
  private async signAndPublish(plan: RidePlan, proof: RideProof): Promise<{ event: NostrEvent; words: string[]; data: Record<string, unknown> }> {
    const head = this.body.keeper.head()!
    const toCoordHex = this.store.line.stopCoordHex(plan.toHeight)
    if (!toCoordHex) throw new Refusal(`The line no longer holds block ${plan.toHeight} (verified to block ${this.store.line.asOf()} now). Call station with sync: true to verify it again; the proof is kept and signed on the next ride call.`)
    const event = this.signChainEvent(hyperjumpTemplate({
      createdAt: createdAtAfter(head), genesisId: plan.genesisId, previousId: plan.previousId, prevCoordHex: plan.prevCoordHex, toCoordHex,
      fromHeight: plan.fromHeight, toHeight: plan.toHeight, ...(plan.asOf !== undefined ? { asOf: plan.asOf } : {}),
      rootHex: proof.rootHex, mp: proof.mp, mnHex: proof.mnHex,
    }), 'ride')
    const published = await this.publish(event)
    this.body.budget.moves++
    this.body.settle()
    return {
      event,
      words: this.relayWords(published.entry, published.result),
      data: { accepted: published.entry.accepted, refused: published.entry.refused ?? {}, canonicalPending: !published.entry.accepted.includes(this.body.canonical) },
    }
  }

  /** Where the agent stands after a ride to `to`, in words and data. */
  private arrivalWords(to: number): { text: string; data: Record<string, unknown> } {
    const line = this.store.line
    const toCoordHex = line.stopCoordHex(to)!
    const stop = line.stopAt(to)!
    return { text: `You now stand at ${stopWords(stop, toCoordHex)}.`, data: { where: describePlace(placeFromHex(toCoordHex)), stop: stopData(stop, toCoordHex) } }
  }

  /**
   * Sign a chain template after two checks (plan D1, D2): the builder's own
   * (chainTemplateProblem), and the reader's: the chain with this event on it
   * must resolve valid and end at it, so a ride whose as_of or from_height
   * the chain rules would break (events.ts rideBreak) is caught here, with
   * the rule's own words, and never reaches a relay. Nothing is recorded or
   * sent when either check fails.
   */
  private signChainEvent(template: EventTemplate, what: string): NostrEvent {
    const problem = chainTemplateProblem(template, this.body.pubkey)
    if (problem) throw new Error(`refusing to sign a malformed ${what}: ${problem}`)
    const event = this.body.sign(template)
    const after = buildChain([...this.body.keeper.events, event], this.body.pubkey)
    const last = after[after.length - 1]
    if (chainStatus(after) !== 'valid' || last?.id !== event.id) {
      const broken = firstBreak(after)
      throw new Error(`refusing to publish a ${what} the chain rules would break: ${broken ? broken.action.breaks : 'it does not extend the chain'}`)
    }
    return event
  }

  /** Record, then send: the event is on disk before any relay sees it (outbox.ts, crash safety). */
  private async publish(event: NostrEvent): Promise<{ entry: OutboxEntry; result: PublishResult }> {
    this.body.keeper.record(event, 'queued')
    const entry = this.body.outbox.add(event)
    const result = await this.body.outbox.send(entry)
    return { entry, result }
  }

  /** Every relay's answer, verbatim, as agent.ts moveResult says it. */
  private relayWords(entry: OutboxEntry, result: PublishResult): string[] {
    const accepted = entry.accepted
    const refused = entry.refused ?? {}
    return [
      accepted.length
        ? `Accepted by ${accepted.join(', ')}${accepted.includes(this.body.canonical) ? '' : '; the canonical relay has not taken it yet and will be retried in the background (see outbox)'}.`
        : `No relay has taken it yet${!result.ok ? ` (${result.reason})` : ''}; it waits in the outbox and is retried once the relays show the chain is clear of it.`,
      Object.keys(refused).length ? `Refused by ${Object.entries(refused).map(([u, r]) => `${u}: ${r}`).join('; ')} (verbatim; a refusal is not retried).` : '',
    ].filter(Boolean)
  }
}
