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
// A ride can also be bought from HOSAKA (ride with prover: "hosaka"; arkinox,
// 2026-10-11, for XOR's 661,038-block ride). The plan is the same plan, the
// head is reserved the same way, and the proof HOSAKA returns goes through
// the same Level 1 self-verification the local runner does before any event
// is built, then through the same templates, reader check and publish. What
// differs is who pays: HOSAKA's invoice is sent to the operator by DM, the
// operator pays it or not, and the agent holds no wallet and spends nothing,
// so HOSAKA's compute is not counted against the caps (only the local
// verification is). The job lives in <state>/hosaka-ride.json with its
// idempotency key, so a restart resumes polling the same job and an answer
// lost on the way back asks again for that job, never a second one.

import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { hexToCoord, terrainK } from 'cyberspace-core'
import type { Budget } from './budget.js'
import { chainTemplateProblem, enterHyperspaceTemplate, hyperjumpTemplate } from './chain/builder.js'
import { buildChain, chainStatus, firstBreak, lookBack, openBracket, type ActionEvent } from './chain/events.js'
import type { ChainKeeper } from './chain/keeper.js'
import { HOSAKA_DEFAULT_URL, HosakaError, createHosaka, honorsKeys, rideIdempotencyKey, rideResultOf, rideService, type HosakaClient, type HosakaJob } from './hosaka.js'
import { computeEnterProof } from './hyperspace/enter.js'
import { LineStore, type LineStatus, type StationResult, type Stop, type SyncResult } from './hyperspace/line.js'
import { lineStateOf, rideBlocks, verifyRideLevel1, zeroLengthRideRefusal, type LineState, type RideProof, type RideVerifyResult } from './hyperspace/ride.js'
import { RideRunner, estimateRideSeconds, type RideProgress, type RideRunResult } from './hyperspace/rideRunner.js'
import { maxAxisLca } from './hyperspace/station.js'
import { nowSeconds, type EventTemplate, type NostrEvent } from './nostr/event.js'
import type { Outbox, OutboxEntry } from './nostr/outbox.js'
import type { PublishResult } from './nostr/relays.js'
import { projectCantorMs, type Calibration } from './space/calibration.js'
import { describePlace, placeFromHex } from './space/coords.js'
import type { StateDir } from './state/dir.js'
import { Refusal, type ToolResult } from './tool.js'

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
}

/** What a ride is, whoever computes its proof: what the signature will need. */
interface RidePlan {
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

/**
 * A ride between calls. The head it departs from is reserved from the first
 * call until the ride is signed, canceled, or found moved, so no hop and no
 * second ride can sign from that head meanwhile (one key, one mover). The
 * leaves and the price search live on disk under the previous event id
 * (rideCache.ts); this record holds only what the signature will need and
 * what the agent asks about.
 */
interface Flight extends RidePlan {
  quotedSeconds: number
  release: () => void
  startedAt: number
  calls: number
  workSeconds: number
  lastCallSeconds: number
  progress: RideProgress | null
  computing: boolean
}

/**
 * Where a HOSAKA ride stands, as the tools name it. `submitting` is a submit
 * whose answer has not come back; the rest are the job's own states as the
 * agent reads them. The head is reserved in the first four.
 */
export type HosakaRideState = 'submitting' | 'awaiting_payment' | 'computing' | 'done' | 'failed' | 'expired'

const HOLDS_HEAD: ReadonlySet<HosakaRideState> = new Set(['submitting', 'awaiting_payment', 'computing', 'done'])

/** Past the invoice's expiry by this much with the node still saying pending, the invoice is taken as lapsed. */
const EXPIRY_GRACE_S = 30

/** A ride bought from HOSAKA, between calls and across restarts: <state>/hosaka-ride.json. */
interface HosakaRide {
  version: 1
  apiUrl: string
  /** The submit's idempotency key; every submit for this ride sends it (hosaka.ts rideIdempotencyKey). */
  key: string
  state: HosakaRideState
  previousId: string
  prevCoordHex: string
  genesisId: string
  fromHeight: number
  toHeight: number
  asOf: number | null
  chained: boolean
  blocks: number
  createdAt: number
  jobId: string | null
  pollToken: string | null
  costMsats: number | null
  invoice: { depositId: string; bolt11: string; amountMsats: number; expiresAt: number; status: string } | null
  /** The invoice the operator was sent, by deposit id, and when. */
  dm: { depositId: string; at: number } | null
  dmError: string | null
  /** The job was paid from the agent's HOSAKA balance (a refund of a failed job), with no invoice. */
  paidFromBalance: boolean
  proof: RideProof | null
  /** HOSAKA's proof failed the agent's own Level 1 check: it is never signed, and asking again returns the same proof. */
  badProof: boolean
  error: string | null
  progressPercent: number | null
  etaSeconds: number | null
  polledAt: number | null
}

const HOSAKA_FILE = 'hosaka-ride.json'

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
  readonly hosaka: HosakaClient
  private flight: Flight | null = null
  private hosakaRide: HosakaRide | null
  private hosakaRelease: (() => void) | null = null
  /** One HOSAKA call sequence at a time: a ride_status during a ride call waits for it rather than racing it. */
  private hosakaBusy: Promise<unknown> = Promise.resolve()

  constructor(private readonly dir: StateDir, private readonly body: TransitBody, options: TransitOptions = {}) {
    this.store = LineStore.open(join(dir.path, 'line'), { manifestUrl: options.manifestUrl, fetch: options.fetch })
    this.threads = options.threads ?? Math.max(1, availableParallelism() - 1)
    this.runner = RideRunner.open(join(dir.path, 'rides'), { threads: this.threads, now: options.now })
    this.hosaka = createHosaka({ apiUrl: options.hosakaUrl ?? HOSAKA_DEFAULT_URL, sign: body.sign, fetch: options.hosakaFetch })
    const saved = dir.readJson<HosakaRide | null>(HOSAKA_FILE, null)
    this.hosakaRide = saved?.version === 1 ? saved : null
    // A restart in the middle of a paid ride: the head is reserved again before
    // any tool runs, so no hop can sign from the head the proof is bound to.
    if (this.hosakaRide && HOLDS_HEAD.has(this.hosakaRide.state)) this.holdHead()
  }

  /** Whether a ride holds the head between calls. */
  get riding(): boolean {
    return this.flight !== null || this.hosakaRide !== null
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
   * Ride the line to a block (DECK-0001 5). The first call quotes the whole
   * ride against the session cap, reserves the head and starts the work; each
   * call runs the ride for its budget (the per-call cap by default) and
   * returns progress until the proof is done, verified at Level 1 by the
   * runner, and signed. `cancel` releases the head and keeps the cache;
   * `forget` drops the cache too. With prover "hosaka" the proof is bought
   * instead (startHosaka); a HOSAKA ride in hand is continued by the same
   * call, whatever prover is named, so that one key never has two rides.
   */
  async ride(input: { to?: number; budget_seconds?: number; as_of?: number; cancel?: boolean; forget?: boolean; prover?: 'local' | 'hosaka' } = {}, signal?: AbortSignal): Promise<ToolResult> {
    const budgetSeconds = input.budget_seconds
    if (budgetSeconds !== undefined && (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0)) throw new Refusal('budget_seconds must be a positive number of seconds.')
    if (input.as_of !== undefined && !isHeight(input.as_of)) throw new Refusal('as_of must be a block height: a non-negative integer.')
    if (input.prover !== undefined && input.prover !== 'local' && input.prover !== 'hosaka') throw new Refusal('prover must be "local" (this machine computes the proof) or "hosaka" (HOSAKA computes it, and your operator pays its invoice).')
    if (input.cancel || input.forget) return this.hosakaRide ? this.serial(() => this.cancelHosaka(this.hosakaRide!, !!input.forget)) : this.releaseRide(!!input.forget)
    const to = input.to
    if (!isHeight(to)) throw new Refusal('Say which block to ride to: to, a block height. Or pass cancel: true to release a ride in flight, or forget: true to drop its cache too.')
    const bought = this.hosakaRide
    if (bought) {
      if (bought.toHeight !== to) throw new Refusal(`A HOSAKA ride to block ${bought.toHeight} is in hand (${this.hosakaWords(bought)}). Call ride with to: ${bought.toHeight} to continue it, ride_status to watch it, or cancel: true to let it go before riding elsewhere.`)
      if (input.prover === 'local') throw new Refusal(`A HOSAKA ride to block ${to} is in hand (${this.hosakaWords(bought)}); computing the same ride here as well would be a second ride from one head. Cancel it first to ride locally.`)
      return this.serial(() => this.continueHosaka(bought))
    }
    if (input.prover === 'hosaka') {
      if (this.flight) throw new Refusal(`A ride to block ${this.flight.toHeight} is computing on this machine (${this.flightWords(this.flight)}). Cancel it first (its work stays on disk) to buy the ride from HOSAKA instead.`)
      return this.serial(() => this.startHosaka(to, input.as_of))
    }
    if (this.flight?.computing) throw new Refusal(`The ride to block ${this.flight.toHeight} is computing in another call right now; wait for that call to return, then call ride again.`)
    if (this.flight && this.flight.toHeight !== to) {
      throw new Refusal(`A ride to block ${this.flight.toHeight} is in flight (${this.flightWords(this.flight)}). Call ride with to: ${this.flight.toHeight} to continue it, ride_status to watch it, or cancel: true to release the head before riding elsewhere.`)
    }
    if (this.flight) {
      if (input.as_of !== undefined && input.as_of !== this.flight.asOf) throw new Refusal(`The ride in flight ${this.flight.asOf === undefined ? 'declares no as_of (it leaves from a stop)' : `declares as_of ${this.flight.asOf}`}, fixed when it started, because the station and every leaf depend on it. Cancel it to ride under another as_of.`)
      await this.checkFlight(this.flight)
    } else {
      await this.startRide(to, input.as_of)
    }
    return this.continueRide(this.flight!, budgetSeconds, signal)
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
    const { blocks, fromHeight } = plan
    const seconds = estimateRideSeconds(this.body.calibration(), blocks, this.threads)
    const b = budget.state()
    if (!(seconds <= b.remainingSessionSeconds)) {
      const calls = Math.max(1, Math.ceil(seconds / b.capCallSeconds))
      throw new Refusal(`A ride of ${blocks} block(s) from block ${fromHeight} to block ${to} is expected to take about ${seconds.toFixed(1)} s on this machine (${threadWords(this.threads)}), and the session has ${b.remainingSessionSeconds.toFixed(1)} s of its ${b.capSessionSeconds} s left. One call is capped at ${b.capCallSeconds} s, so the ride would span about ${calls} call(s); the per-call cap bounds one call and the session cap bounds the whole ride. Pick a nearer block, ask your human to raise the session cap or start a new session, or buy the ride from HOSAKA with prover: "hosaka" (your operator pays its invoice).`)
    }
    let release: () => void
    try {
      release = keeper.reserve()
    } catch (err) {
      throw new Refusal(words(err))
    }
    this.flight = { ...plan, quotedSeconds: seconds, release, startedAt: Date.now(), calls: 0, workSeconds: 0, lastCallSeconds: 0, progress: null, computing: false }
  }

  /**
   * A later call: the head must still be the one the ride left from, because
   * every leaf is seeded by it (DECK-0001 5.3). Relays that cannot be asked
   * do not stop the work, which is local; they stop the signature.
   */
  private async checkFlight(flight: Flight): Promise<void> {
    const unconfirmed = await this.body.keeper.confirmHead()
    this.refuseIfMoved(flight)
    if (unconfirmed) flight.notes.push('The relays could not confirm the head before this call; the work went on, because it is local, and the signature waits for a confirmation.')
  }

  /** Drop the ride and refuse when the head is no longer the one it left from. */
  private refuseIfMoved(flight: Flight): void {
    const head = this.body.keeper.head()
    if (head?.id === flight.previousId) return
    this.dropFlight(flight, true)
    throw new Refusal(`The head moved while the ride to block ${flight.toHeight} was in flight: the relays hold a newer move (${head ? `${head.id.slice(0, 8)}...` : 'none'}), adopted now. Every leaf of the ride was seeded by the old head (DECK-0001 5.3), so the ride can never be signed; its cache was dropped and the head released. Board or ride again from where you stand.`)
  }

  private dropFlight(flight: Flight, forgetCache: boolean): void {
    flight.release()
    if (forgetCache) this.runner.forget(flight.previousId)
    if (this.flight === flight) this.flight = null
  }

  /** One call's worth of the ride, then the signature when the proof is done. */
  private async continueRide(flight: Flight, budgetSeconds: number | undefined, signal: AbortSignal | undefined): Promise<ToolResult> {
    const { budget, keeper } = this.body
    const before = budget.state()
    if (before.remainingSessionSeconds <= 0) throw new Refusal(`The session has spent its ${before.capSessionSeconds} s of work, so nothing more is computed this session. The ride stays in flight: cancel: true releases the head, and a new session resumes the ride from its cache. Ask your human to raise the session cap or start a new session.`)
    const allowed = Math.min(budgetSeconds ?? before.capCallSeconds, before.capCallSeconds, before.remainingSessionSeconds)
    const line = this.store.line
    // The store starts its walk over when the manifest changed under a held blob (line.ts reconcile), so a block verified when the ride started may not be held now.
    if (!line.has(flight.fromHeight) || !line.has(flight.toHeight)) throw new Refusal(`The line no longer holds blocks ${Math.min(flight.fromHeight, flight.toHeight)} to ${Math.max(flight.fromHeight, flight.toHeight)} (verified to block ${line.asOf()} now). Call station with sync: true to verify it again; the ride stays in flight and resumes from its cache.`)
    const job = {
      previousEventIdHex: flight.previousId, fromHeight: flight.fromHeight, toHeight: flight.toHeight,
      blockHashFor: (height: number): string => {
        const hash = line.blockHash(height)
        if (!hash) throw new Error(`block ${height} is not verified by this process`)
        return hash
      },
    }
    flight.computing = true
    let result: RideRunResult
    try {
      result = await this.runner.run(job, { budgetSeconds: allowed, signal, onProgress: (p) => { flight.progress = p } })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return this.progressResult(flight, 'The call was canceled by the client; everything computed so far is on disk, and the ride stays in flight.')
      throw err
    } finally {
      flight.computing = false
    }
    flight.calls++
    flight.lastCallSeconds = result.workSeconds
    flight.workSeconds += result.workSeconds
    budget.spendWork(result.workSeconds)
    flight.progress = result.progress
    if (!result.done) return this.progressResult(flight, null)

    // Confirm again, immediately before the signature: the machine was busy for a while.
    const again = await keeper.confirmHead()
    if (again) throw new Refusal(`${again} The ride's proof is finished and kept on disk: call ride again with to: ${flight.toHeight} once the relays answer, and it is signed without being recomputed.`)
    this.refuseIfMoved(flight)
    const toCoordHex = line.stopCoordHex(flight.toHeight)!
    let event: NostrEvent
    try {
      event = this.signRide(flight, result.proof)
    } catch (err) {
      // A bug, not a refusal: the head is released so the agent is not stuck, and the cache is kept.
      this.dropFlight(flight, false)
      throw err
    }
    const published = await this.publish(event)
    // Only now, with the event recorded by publish (before it was sent), is
    // the cache dropped (rideRunner.ts header): a crash between the proof and
    // the record resumes from disk instead of repaying the work.
    this.runner.forget(flight.previousId)
    flight.release()
    this.flight = null
    budget.moves++
    this.body.settle()
    const stop = line.stopAt(flight.toHeight)!
    const where = describePlace(placeFromHex(toCoordHex))
    const text = [
      `Ride ${event.id.slice(0, 8)}... signed: block ${flight.fromHeight} to block ${flight.toHeight} (${flight.blocks} block(s)${flight.asOf !== undefined ? `, as_of ${flight.asOf}` : ''}), ${flight.workSeconds.toFixed(1)} s of work over ${flight.calls} call(s), proof verified at Level 1 (${result.verification.checked} openings). You now stand at ${stopWords(stop, toCoordHex)}.`,
      ...this.relayWords(published.entry, published.result),
      ...flight.notes,
      ...result.progress.notes,
      `Ride again to another block, or hop or sidestep to leave the line (a target away from this stop is priced by plan_hop).`,
    ].join('\n')
    return {
      text,
      data: {
        eventId: event.id, action: 'hyperjump', fromHeight: flight.fromHeight, toHeight: flight.toHeight, asOf: flight.asOf ?? null, blocks: flight.blocks, where, stop: stopData(stop, toCoordHex),
        workSeconds: Number(flight.workSeconds.toFixed(3)), calls: flight.calls, verification: result.verification, root: result.proof.rootHex, mn: result.proof.mnHex,
        accepted: published.entry.accepted, refused: published.entry.refused ?? {}, canonicalPending: !published.entry.accepted.includes(this.body.canonical),
        notes: [...flight.notes, ...result.progress.notes], budget: budget.state(),
      },
    }
  }

  private releaseRide(forget: boolean): ToolResult {
    const flight = this.flight
    if (!flight) {
      if (!forget) throw new Refusal('No ride is in flight; nothing to cancel.')
      const head = this.body.keeper.head()
      if (!head) throw new Refusal('No ride is in flight and no chain is known; nothing to forget.')
      this.runner.forget(head.id)
      return { text: `No ride is in flight. The cached leaves and price searches of rides from your head ${head.id.slice(0, 8)}... were dropped.`, data: { inFlight: false, forgot: head.id } }
    }
    if (flight.computing) throw new Refusal(`The ride to block ${flight.toHeight} is computing in another call right now; wait for that call to return, then cancel.`)
    const said = this.flightWords(flight)
    const data = this.flightData(flight)
    this.dropFlight(flight, forget)
    return {
      text: `Canceled the ride to block ${flight.toHeight} (${said}). The head is released for other moves. ${forget ? 'Its cached leaves and price search were dropped.' : 'Its cached leaves and price search are kept on disk: a later ride to the same block from this head resumes them; forget: true drops them.'}`,
      data: { inFlight: false, canceled: data, forgot: forget ? flight.previousId : null },
    }
  }

  private progressResult(flight: Flight, note: string | null): ToolResult {
    const b = this.body.budget.state()
    const p = flight.progress
    const text = [
      note ?? '',
      `Ride to block ${flight.toHeight} from block ${flight.fromHeight} (${flight.blocks} block(s)${flight.asOf !== undefined ? `, as_of ${flight.asOf}` : ''}) in progress after ${flight.calls} call(s): ${this.flightWords(flight)}.`,
      `This call spent ${flight.lastCallSeconds.toFixed(1)} s of work, ${flight.workSeconds.toFixed(1)} s so far of about ${flight.quotedSeconds.toFixed(1)} s quoted; the session has ${b.remainingSessionSeconds.toFixed(1)} s left, at most ${b.capCallSeconds} s per call.`,
      `The head is reserved for this ride. Call ride again with to: ${flight.toHeight} to continue, ride_status to watch, cancel: true to release the head (the cache stays), or forget: true to drop the cache too.`,
      ...flight.notes,
      ...(p?.notes ?? []),
    ].filter(Boolean).join('\n')
    return { text, data: { done: false, inFlight: true, ride: this.flightData(flight), budget: b } }
  }

  /**
   * The ride in flight. Read only for a ride computed here. For a HOSAKA ride
   * it asks HOSAKA where the job stands, and moves a paid job along (claims
   * the operator's payment and starts the job, which HOSAKA charges once);
   * it never signs a hyperjump and never asks for a new job or invoice.
   */
  async rideStatus(): Promise<ToolResult> {
    const rec = this.hosakaRide
    if (rec) {
      return this.serial(async () => {
        const cur = this.hosakaRide
        if (!cur) return this.localRideStatus()
        const stale = this.body.keeper.head()?.id !== cur.previousId
        const notes = stale ? ['The head is no longer the one this ride departs from, so its proof can never be signed; the next ride call lets it go.'] : await this.pollHosaka(cur, false)
        const result = this.hosakaResult(cur, notes)
        return { ...result, data: { ...result.data, stale } }
      })
    }
    return this.localRideStatus()
  }

  private localRideStatus(): ToolResult {
    const flight = this.flight
    const state = lineStateOf(this.body.keeper.chain())
    const onLine = state === null ? 'You are not on the line; board first.' : state.fromHeight === null ? 'You are boarded; ride to a block to travel.' : `You stand at the stop for block ${state.fromHeight}; ride again, or hop to leave the line.`
    if (!flight) return { text: `No ride is in flight. ${onLine}`, data: { inFlight: false, onLine: state ? { boarded: true, atStop: state.fromHeight, head: state.previousId } : null } }
    const stale = this.body.keeper.head()?.id !== flight.previousId
    const text = [
      `Ride to block ${flight.toHeight} from block ${flight.fromHeight} (${flight.blocks} block(s)${flight.asOf !== undefined ? `, as_of ${flight.asOf}` : ''}): ${this.flightWords(flight)}.`,
      flight.computing ? 'A call is computing it right now.' : stale ? 'The head moved since the ride started, so this ride can never be signed; the next ride call drops it, or cancel: true releases it now.' : `The head is reserved for it; call ride with to: ${flight.toHeight} to continue.`,
    ].join(' ')
    return { text, data: { inFlight: true, stale, ride: this.flightData(flight) } }
  }

  private flightWords(flight: Flight): string {
    const p = flight.progress
    const since = Math.round((Date.now() - flight.startedAt) / 1000)
    if (!p) return `started ${since} s ago, nothing computed yet`
    const phase = p.phase === 'leaves' ? 'computing leaves' : p.phase === 'price' ? 'searching the price nonce' : p.phase === 'verify' ? 'self-verifying' : 'done'
    const eta = p.etaMs !== null && p.phase !== 'done' ? `, about ${Math.ceil(p.etaMs / 1000)} s to go` : ''
    return `${phase}, ${p.leavesDone} of ${p.leavesTotal} leaves (${p.leavesResumed} resumed from the cache), ${p.attempts} of about ${p.attemptsExpected} price attempt(s)${eta}, ${flight.workSeconds.toFixed(1)} s of work over ${flight.calls} call(s), started ${since} s ago`
  }

  private flightData(flight: Flight): Record<string, unknown> {
    return {
      previousId: flight.previousId, fromHeight: flight.fromHeight, toHeight: flight.toHeight, asOf: flight.asOf ?? null, chained: flight.chained, blocks: flight.blocks,
      quotedSeconds: Number(flight.quotedSeconds.toFixed(2)), calls: flight.calls, workSeconds: Number(flight.workSeconds.toFixed(3)), startedAt: flight.startedAt, computing: flight.computing,
      progress: flight.progress, notes: flight.notes,
    }
  }

  // ---- HOSAKA rides ------------------------------------------------------------

  /** Run HOSAKA call sequences one after another, so a status poll never races a ride call over the same job. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.hosakaBusy.then(work, work)
    this.hosakaBusy = next.catch(() => {})
    return next
  }

  private saveHosaka(): void {
    this.dir.writeJson(HOSAKA_FILE, this.hosakaRide)
  }

  /** Reserve the head for the HOSAKA ride, if it is not reserved already. Throws the keeper's words when a move holds it. */
  private holdHead(): void {
    if (!this.hosakaRelease) this.hosakaRelease = this.body.keeper.reserve()
  }

  private letGoOfHead(): void {
    this.hosakaRelease?.()
    this.hosakaRelease = null
  }

  /** Forget the HOSAKA ride: the file, the record and the reservation. */
  private dropHosaka(): void {
    this.hosakaRide = null
    this.saveHosaka()
    this.letGoOfHead()
  }

  /** Set the state, and hold or release the head to match it. */
  private setHosakaState(rec: HosakaRide, state: HosakaRideState): void {
    rec.state = state
    if (!HOLDS_HEAD.has(state)) this.letGoOfHead()
  }

  private hosakaWhere(): string {
    return `HOSAKA at ${this.hosaka.apiUrl}`
  }

  /**
   * Buy a ride from HOSAKA: the plan, then every check that can refuse before
   * an invoice exists (the operator can be sent a DM, HOSAKA sells rides and
   * honors idempotency keys, the head is confirmed), then the reservation,
   * the record with its key, the submit, and the invoice to the operator.
   * Returns at once: payment is the operator's, in their own time.
   */
  private async startHosaka(to: number, asOfInput: number | undefined): Promise<ToolResult> {
    const { keeper } = this.body
    if (this.hosakaRide) throw new Refusal(`A HOSAKA ride to block ${this.hosakaRide.toHeight} is already in hand (${this.hosakaWords(this.hosakaRide)}).`)
    const plan = await this.planRide(to, asOfInput)
    const undeliverable = await this.body.undeliverable()
    if (undeliverable) throw new Refusal(`${undeliverable} A HOSAKA ride is paid by your operator from an invoice sent to them by DM, so with no way to send it nothing was submitted to HOSAKA and no invoice exists.`)
    let provider
    try {
      provider = await this.hosaka.provider()
    } catch (err) {
      throw new Refusal(`${this.hosakaWhere()} could not be asked what it sells: ${words(err)}. Nothing was submitted.`)
    }
    const service = rideService(provider)
    if (!service) throw new Refusal(`${this.hosakaWhere()} does not sell rides (its /api/v1/provider lists no ride service). Nothing was submitted. Ride on this machine instead (station with destination quotes it), or tell your operator.`)
    if (service.maxBlocks !== null && plan.blocks > service.maxBlocks) throw new Refusal(`${this.hosakaWhere()} computes rides of at most ${service.maxBlocks} block(s), and this one passes ${plan.blocks}. Nothing was submitted. Pick a nearer block.`)
    if (!honorsKeys(provider)) throw new Refusal(`${this.hosakaWhere()} does not say it honors idempotency keys, so a submit whose answer was lost could not be asked about again without the risk of a second job and a second invoice. Nothing was submitted.`)
    try {
      this.holdHead()
    } catch (err) {
      throw new Refusal(words(err))
    }
    try {
      // The proof will be bound to this head (DECK-0001 5.3): confirm it before anyone pays for it.
      const unconfirmed = await keeper.confirmHead()
      if (unconfirmed) throw new Refusal(`${unconfirmed} Nothing was submitted to HOSAKA: a proof is bought only for a head the relays confirm.`)
      if (keeper.head()?.id !== plan.previousId) throw new Refusal(`The head moved while planning: the relays hold a newer move (${keeper.head()?.id.slice(0, 8)}...), adopted now. Nothing was submitted; call ride again from where you stand.`)
    } catch (err) {
      this.letGoOfHead()
      throw err
    }
    const rec: HosakaRide = {
      version: 1, apiUrl: this.hosaka.apiUrl, key: rideIdempotencyKey(plan.previousId, plan.fromHeight, plan.toHeight), state: 'submitting',
      previousId: plan.previousId, prevCoordHex: plan.prevCoordHex, genesisId: plan.genesisId, fromHeight: plan.fromHeight, toHeight: plan.toHeight,
      asOf: plan.asOf ?? null, chained: plan.chained, blocks: plan.blocks, createdAt: Date.now(),
      jobId: null, pollToken: null, costMsats: null, invoice: null, dm: null, dmError: null, paidFromBalance: false, proof: null, badProof: false,
      error: null, progressPercent: null, etaSeconds: null, polledAt: null,
    }
    // On disk before the submit goes out, so an answer lost on the way back, or a crash, asks again with this key.
    this.hosakaRide = rec
    this.saveHosaka()
    const notes = [...plan.notes, ...(await this.submitHosaka(rec, 'fresh'))]
    notes.push(...(await this.deliverInvoice(rec)))
    return this.hosakaResult(rec, notes)
  }

  /**
   * Submit the ride with its key. A lost answer leaves the record in
   * `submitting`, to be asked again with the same key; a refusal drops a
   * ride that has no job yet and is reported in HOSAKA's words.
   */
  private async submitHosaka(rec: HosakaRide, why: 'fresh' | 'again'): Promise<string[]> {
    let job: HosakaJob
    try {
      job = await this.hosaka.submitRide(rec.previousId, rec.fromHeight, rec.toHeight, rec.key)
    } catch (err) {
      if (err instanceof HosakaError && err.answerLost) {
        this.setHosakaState(rec, rec.jobId ? rec.state : 'submitting')
        this.saveHosaka()
        return [`HOSAKA's answer to the submit was lost (${err.message}). It may have made the job; the next ride call asks again with the same idempotency key, which gets back that job and never a second one or a second invoice.`]
      }
      if (why === 'fresh' || !rec.jobId) {
        this.dropHosaka()
        throw new Refusal(`${this.hosakaWhere()} refused the ride: ${words(err)}. No job was made and no invoice exists; the head is released.`)
      }
      throw new Refusal(`${this.hosakaWhere()} refused to start the job again: ${words(err)}. The ride stays in hand; cancel: true lets it go.`)
    }
    if (job.idempotency_key !== undefined && job.idempotency_key !== rec.key) {
      // A server that echoes some other key is not keeping ours; nothing more is asked of it on its own.
      rec.error = 'HOSAKA echoed a different idempotency key than the one sent'
    }
    if (job.status === 'computing' && job.balance_debited && !job.deposit) rec.paidFromBalance = true
    this.absorb(rec, job)
    this.saveHosaka()
    return job.idempotent_replay ? ['HOSAKA answered with the job this ride already had (same idempotency key): nothing new was made or charged.'] : []
  }

  /** Fold a job answer into the record. */
  private absorb(rec: HosakaRide, job: HosakaJob): void {
    if (typeof job.id === 'string' && job.id) rec.jobId = job.id
    if (typeof job.poll_token === 'string' && job.poll_token) rec.pollToken = job.poll_token
    if (typeof job.cost_msats === 'number') rec.costMsats = job.cost_msats
    const d = job.deposit
    if (d && typeof d.bolt11 === 'string' && typeof d.deposit_id === 'string') {
      rec.invoice = { depositId: d.deposit_id, bolt11: d.bolt11, amountMsats: Number(d.amount_msats) || 0, expiresAt: Number(d.expires_at) || 0, status: d.status }
    }
    rec.polledAt = Date.now()
    const progress = (job.result ?? null) as { progress_percent?: unknown; eta_seconds?: unknown } | null
    if (job.status === 'computing' && progress && typeof progress === 'object') {
      rec.progressPercent = typeof progress.progress_percent === 'number' ? progress.progress_percent : rec.progressPercent
      rec.etaSeconds = typeof progress.eta_seconds === 'number' ? progress.eta_seconds : rec.etaSeconds
    }
    switch (job.status) {
      case 'completed': {
        const r = rideResultOf(job)
        if (typeof r === 'string') {
          rec.error = `HOSAKA says the job completed, but ${r}`
          rec.badProof = true
          this.setHosakaState(rec, 'failed')
        } else if (r.previous_event_id !== rec.previousId || r.from_height !== rec.fromHeight || r.to_height !== rec.toHeight) {
          rec.error = `HOSAKA returned a proof for another ride (head ${String(r.previous_event_id).slice(0, 8)}..., blocks ${r.from_height} to ${r.to_height})`
          rec.badProof = true
          this.setHosakaState(rec, 'failed')
        } else {
          rec.proof = { rootHex: r.root, mp: r.mp, mnHex: r.mn }
          rec.error = null
          this.setHosakaState(rec, 'done')
        }
        break
      }
      case 'failed':
        rec.error = job.error || 'HOSAKA gave no reason'
        this.setHosakaState(rec, 'failed')
        break
      case 'computing':
        rec.error = null
        this.setHosakaState(rec, 'computing')
        break
      case 'pending':
        this.setHosakaState(rec, rec.invoice && rec.invoice.status === 'expired' ? 'expired' : 'awaiting_payment')
        break
    }
  }

  /**
   * Send the operator the invoice the job waits on, once per invoice. A DM
   * that cannot be delivered is retried by the next ride or ride_status call;
   * the invoice is in the tool's answer too.
   */
  private async deliverInvoice(rec: HosakaRide): Promise<string[]> {
    const inv = rec.invoice
    if (rec.state !== 'awaiting_payment' || !inv || inv.status !== 'pending' || rec.dm?.depositId === inv.depositId) return []
    const sats = Math.ceil(inv.amountMsats / 1000)
    const costSats = rec.costMsats !== null ? Math.ceil(rec.costMsats / 1000) : null
    const minutes = Math.max(0, Math.round((inv.expiresAt - Date.now() / 1000) / 60))
    const text = [
      `HOSAKA invoice for my hyperspace ride: ${sats} sats.`,
      `It pays HOSAKA to compute the proof for one ride, from block ${rec.fromHeight} to block ${rec.toHeight} (${rec.blocks} blocks), departing from my chain head ${rec.previousId.slice(0, 8)}. I check the proof myself before I sign anything.`,
      costSats !== null && costSats !== sats ? `The job costs ${costSats} sats; ${sats} sats are due now (HOSAKA invoices whole sats, and anything already in my HOSAKA balance counts).` : '',
      `It expires ${new Date(inv.expiresAt * 1000).toISOString()} (about ${minutes} min). If you do not pay, nothing happens: the invoice lapses and I stay where I am. I hold no wallet and pay nothing myself.`,
      `Job ${rec.jobId ?? '(unknown)'} at ${rec.apiUrl}.`,
      '',
      inv.bolt11,
    ].filter((l, i) => l !== '' || i === 5).join('\n')
    try {
      await this.body.messageOperator(text)
      rec.dm = { depositId: inv.depositId, at: Date.now() }
      rec.dmError = null
      this.saveHosaka()
      return [`The invoice (${sats} sats) was sent to your operator by DM.`]
    } catch (err) {
      rec.dmError = words(err)
      this.saveHosaka()
      return [`The invoice could NOT be sent to your operator: ${rec.dmError} The next ride or ride_status call tries again; the invoice is also below, to pass on another way your operator asked for.`]
    }
  }

  /**
   * Ask HOSAKA where the job stands and move it along as far as the
   * operator's payment allows: a paid invoice is claimed and the job started
   * (HOSAKA charges once, in one transaction, however often it is asked), a
   * computing job is read with its poll token. `again` is the ride call's
   * license to do what costs a decision: submit with the key again after a
   * lost answer or a failed job, and ask for a fresh invoice for an expired one.
   */
  private async pollHosaka(rec: HosakaRide, again: boolean): Promise<string[]> {
    const notes: string[] = []
    if (rec.apiUrl !== this.hosaka.apiUrl) {
      // The job lives at the HOSAKA it was bought from; another one would not know it, and a submit there would be a second job.
      notes.push(`This ride was bought from HOSAKA at ${rec.apiUrl}, but this server now talks to ${this.hosaka.apiUrl}, so the job was not asked about. Ask your human to start the server with --hosaka-url ${rec.apiUrl} again, or cancel: true to let the ride go.`)
      return notes
    }
    try {
      if (rec.state === 'submitting' || (again && rec.state === 'failed' && !rec.badProof)) {
        if (!again) return notes
        const provider = await this.hosaka.provider()
        if (!honorsKeys(provider)) {
          notes.push(`${this.hosakaWhere()} no longer says it honors idempotency keys, so the submit is not asked again (it could make a second job). Ask your operator whether a job ${rec.jobId ?? 'for this ride'} was paid; cancel: true lets the ride go.`)
          return notes
        }
        if (rec.state === 'failed') {
          this.holdHead()
          notes.push('Starting the failed job again with the same key: HOSAKA refunded the failed job to this agent\'s HOSAKA balance, so the new job is paid from that refund, not by a new payment.')
        }
        notes.push(...(await this.submitHosaka(rec, 'again')))
      } else if (rec.state === 'expired' && again) {
        this.holdHead()
        // /start credits an invoice paid even past its expiry; otherwise it issues a fresh one for the operator.
        this.absorb(rec, await this.hosaka.startJob(rec.jobId!))
      } else if (rec.state === 'awaiting_payment' && rec.jobId) {
        const inv = rec.invoice
        if (inv) {
          const dep = await this.hosaka.claimDeposit(inv.depositId)
          inv.status = dep.status
          if (dep.status === 'settled') {
            notes.push('Your operator paid the invoice; HOSAKA starts the job now.')
            this.absorb(rec, await this.hosaka.startJob(rec.jobId))
          } else if (dep.status === 'expired' || Date.now() / 1000 > inv.expiresAt + EXPIRY_GRACE_S) {
            inv.status = 'expired'
            this.setHosakaState(rec, 'expired')
          }
        } else {
          this.absorb(rec, await this.hosaka.startJob(rec.jobId))
        }
      } else if (rec.state === 'computing' && rec.jobId && rec.pollToken) {
        this.absorb(rec, await this.hosaka.getJob(rec.jobId, rec.pollToken))
      } else if (rec.state === 'computing' && rec.jobId) {
        // No poll token survived (an answer that carried none): /start answers a running job with where it stands.
        this.absorb(rec, await this.hosaka.startJob(rec.jobId))
      }
    } catch (err) {
      if (err instanceof Refusal) throw err
      notes.push(`${this.hosakaWhere()} could not be asked about the job just now: ${words(err)}. Nothing changed; ask again later.`)
    } finally {
      if (this.hosakaRide === rec) {
        // A retry that went nowhere leaves the ride waiting on a decision, and a ride waiting on one holds no head.
        if (!HOLDS_HEAD.has(rec.state)) this.letGoOfHead()
        this.saveHosaka()
      }
    }
    notes.push(...(await this.deliverInvoice(rec)))
    return notes
  }

  /** Whether the head is still the one the HOSAKA ride departs from; drops the ride and refuses when it is not. */
  private refuseIfHosakaStale(rec: HosakaRide): void {
    const head = this.body.keeper.head()
    if (head?.id === rec.previousId) return
    const paid = this.hosakaPaid(rec)
    this.dropHosaka()
    throw new Refusal(`The head moved since the HOSAKA ride to block ${rec.toHeight} was bought: the relays hold a newer move (${head ? `${head.id.slice(0, 8)}...` : 'none'}). HOSAKA's proof is bound to the old head (DECK-0001 5.3) and can never be signed, so the ride was let go.${paid ? ` Its job (${rec.jobId}) was paid; tell your operator with message_operator.` : rec.state === 'awaiting_payment' ? ' Its invoice was not paid; tell your operator not to pay it.' : ''} Board or ride again from where you stand.`)
  }

  /** A ride call on a HOSAKA ride in hand: move it along, and sign it once its proof is in and verified. */
  private async continueHosaka(rec: HosakaRide): Promise<ToolResult> {
    if (this.hosakaRide !== rec) throw new Refusal('The HOSAKA ride changed while this call waited for another one (canceled or signed meanwhile). Call ride_status to see where you stand.')
    await this.body.refreshChain()
    this.refuseIfHosakaStale(rec)
    if (rec.badProof) throw new Refusal(`HOSAKA's job ${rec.jobId} for the ride to block ${rec.toHeight} returned a proof this server refuses (${rec.error}). It was never signed, and asking again returns the same proof. Tell your operator with message_operator (they paid for it), then cancel: true to let the ride go.`)
    if (rec.state === 'failed' || rec.state === 'expired') {
      try {
        this.holdHead()
      } catch (err) {
        throw new Refusal(words(err))
      }
    }
    const notes = await this.pollHosaka(rec, true)
    if (rec.state !== 'done') return this.hosakaResult(rec, notes)
    return this.signHosaka(rec, notes)
  }

  /**
   * The proof is in: verify it here at Level 1 exactly as the local runner
   * verifies its own, then confirm the head, sign through the builder's and
   * the reader's checks, record, publish. A proof that does not verify is
   * never signed.
   */
  private async signHosaka(rec: HosakaRide, notes: string[]): Promise<ToolResult> {
    const { keeper, budget } = this.body
    const line = this.store.line
    const proof = rec.proof!
    if (!line.has(rec.fromHeight) || !line.has(rec.toHeight)) throw new Refusal(`HOSAKA's proof is in, but this process does not hold blocks ${rec.fromHeight} to ${rec.toHeight} of the line (verified to block ${line.asOf()}), so it cannot be checked. Call station with sync: true, then ride again; the proof is kept.`)
    const t0 = performance.now()
    let verification: RideVerifyResult
    try {
      verification = await verifyRideLevel1({
        previousEventIdHex: rec.previousId, fromHeight: rec.fromHeight, toHeight: rec.toHeight, rootHex: proof.rootHex, mp: proof.mp, mn: proof.mnHex,
        blockHashFor: (height) => {
          const hash = line.blockHash(height)
          if (!hash) throw new Error(`block ${height} is not verified by this process`)
          return hash
        },
      })
    } catch (err) {
      verification = { ok: false, checked: 0, reason: words(err), grandfathered: false }
    }
    const seconds = (performance.now() - t0) / 1000
    // The check is this machine's work, so it is counted; HOSAKA's compute is not.
    budget.spendWork(seconds)
    if (!verification.ok || verification.grandfathered) {
      rec.badProof = true
      rec.error = `it failed Level 1 self-verification: ${verification.reason ?? 'a ride signed now needs an mn'}`
      this.setHosakaState(rec, 'failed')
      this.saveHosaka()
      throw new Refusal(`HOSAKA's proof for the ride to block ${rec.toHeight} ${rec.error}. Nothing was signed and nothing reached a relay; the head is released. Tell your operator with message_operator: they paid for job ${rec.jobId} at ${rec.apiUrl}. cancel: true lets the ride go.`)
    }
    const again = await keeper.confirmHead()
    if (again) throw new Refusal(`${again} HOSAKA's proof is verified and kept: call ride again with to: ${rec.toHeight} once the relays answer, and it is signed.`)
    this.refuseIfHosakaStale(rec)
    const plan: RidePlan = { ...rec, asOf: rec.asOf ?? undefined, notes: [] }
    const event = this.signRide(plan, proof)
    const published = await this.publish(event)
    // Only now, with the event recorded by publish, is the job forgotten: a crash before this resumes at done, and the head check then sees the ride.
    this.dropHosaka()
    budget.moves++
    this.body.settle()
    const toCoordHex = line.stopCoordHex(rec.toHeight)!
    const stop = line.stopAt(rec.toHeight)!
    const where = describePlace(placeFromHex(toCoordHex))
    const text = [
      `Ride ${event.id.slice(0, 8)}... signed: block ${rec.fromHeight} to block ${rec.toHeight} (${rec.blocks} block(s)${rec.asOf !== null ? `, as_of ${rec.asOf}` : ''}), proof computed by HOSAKA (job ${rec.jobId}) and verified here at Level 1 (${verification.checked} openings, ${seconds.toFixed(1)} s). You now stand at ${stopWords(stop, toCoordHex)}.`,
      ...this.relayWords(published.entry, published.result),
      ...notes,
      'Ride again to another block, or hop or sidestep to leave the line (a target away from this stop is priced by plan_hop).',
    ].join('\n')
    return {
      text,
      data: {
        eventId: event.id, action: 'hyperjump', prover: 'hosaka', job: rec.jobId, fromHeight: rec.fromHeight, toHeight: rec.toHeight, asOf: rec.asOf, blocks: rec.blocks, where, stop: stopData(stop, toCoordHex),
        verification, verifySeconds: Number(seconds.toFixed(3)), root: proof.rootHex, mn: proof.mnHex,
        accepted: published.entry.accepted, refused: published.entry.refused ?? {}, canonicalPending: !published.entry.accepted.includes(this.body.canonical),
        notes, budget: budget.state(),
      },
    }
  }

  /** cancel or forget on a HOSAKA ride: let it go, release the head, and tell the operator not to pay an invoice still open. */
  private async cancelHosaka(rec: HosakaRide, forget: boolean): Promise<ToolResult> {
    if (this.hosakaRide !== rec) throw new Refusal('The HOSAKA ride changed while this call waited for another one (canceled or signed meanwhile). Call ride_status to see where you stand.')
    const notes: string[] = []
    if (rec.state === 'awaiting_payment' && rec.dm && rec.invoice?.status === 'pending') {
      try {
        await this.body.messageOperator(`Canceled: please do NOT pay the HOSAKA invoice I sent for my ride to block ${rec.toHeight} (job ${rec.jobId}). If you already paid it, the sats are credited to my HOSAKA balance when the job is next asked about, and pay for my next HOSAKA job.`)
        notes.push('Your operator was told by DM not to pay the invoice.')
      } catch (err) {
        notes.push(`Your operator could NOT be told not to pay the invoice (${words(err)}); tell them another way.`)
      }
    }
    const paid = this.hosakaPaid(rec)
    const said = this.hosakaWords(rec)
    this.dropHosaka()
    if (forget) this.runner.forget(rec.previousId)
    return {
      text: [
        `Let go of the HOSAKA ride to block ${rec.toHeight} (${said}). The head is released for other moves.`,
        rec.badProof
          ? `Its job (${rec.jobId}) was paid and its proof refused here; tell your operator with message_operator if you have not.`
          : paid ? `Its job (${rec.jobId}) was paid. Its proof stays bound to head ${rec.previousId.slice(0, 8)}...: a ride with prover "hosaka" to the same block from that same head, within HOSAKA's key retention, gets the same job back without paying again.` : '',
        ...notes,
      ].filter(Boolean).join('\n'),
      data: { inFlight: false, canceled: this.hosakaData(rec), prover: 'hosaka' },
    }
  }

  /** Whether the operator's money (or a refund of it) went into this ride's job. */
  private hosakaPaid(rec: HosakaRide): boolean {
    return rec.state === 'computing' || rec.state === 'done' || rec.paidFromBalance || rec.badProof
  }

  private hosakaWords(rec: HosakaRide): string {
    const inv = rec.invoice
    const sats = inv ? Math.ceil(inv.amountMsats / 1000) : null
    switch (rec.state) {
      case 'submitting': return 'the submit\'s answer has not come back; the next ride call asks again with the same key'
      case 'awaiting_payment': return `awaiting payment: ${sats ?? '?'} sats, invoice ${rec.dm?.depositId === inv?.depositId ? 'sent to your operator by DM' : 'NOT yet delivered to your operator'}${inv ? `, expires ${new Date(inv.expiresAt * 1000).toISOString()}` : ''}`
      case 'computing': return `paid; HOSAKA is computing${rec.progressPercent !== null ? ` (${rec.progressPercent}%${rec.etaSeconds !== null ? `, about ${Math.round(rec.etaSeconds)} s to go` : ''})` : ''}${rec.paidFromBalance ? ', paid from this agent\'s HOSAKA balance' : ''}`
      case 'done': return 'done: HOSAKA\'s proof is in; the next ride call verifies it here and signs'
      case 'failed': return rec.badProof ? `refused: ${rec.error}` : `failed at HOSAKA (${rec.error}); HOSAKA refunds a failed job to this agent's HOSAKA balance, and a ride call starts it again from that refund`
      case 'expired': return 'expired: the invoice lapsed unpaid and nothing was charged; a ride call asks HOSAKA for a fresh invoice and sends it to your operator'
    }
  }

  private hosakaData(rec: HosakaRide): Record<string, unknown> {
    return {
      prover: 'hosaka', state: rec.state, api: rec.apiUrl, job: rec.jobId, previousId: rec.previousId, fromHeight: rec.fromHeight, toHeight: rec.toHeight, asOf: rec.asOf, blocks: rec.blocks,
      costMsats: rec.costMsats, invoice: rec.invoice ? { sats: Math.ceil(rec.invoice.amountMsats / 1000), expiresAt: rec.invoice.expiresAt, status: rec.invoice.status, bolt11: rec.invoice.bolt11 } : null,
      invoiceSentToOperator: !!rec.invoice && rec.dm?.depositId === rec.invoice.depositId, dmError: rec.dmError, paidFromBalance: rec.paidFromBalance,
      progressPercent: rec.progressPercent, etaSeconds: rec.etaSeconds, error: rec.error, headReserved: HOLDS_HEAD.has(rec.state),
    }
  }

  /** The answer to a ride or ride_status call on a HOSAKA ride that is not signed yet. */
  private hosakaResult(rec: HosakaRide, notes: string[]): ToolResult {
    const next: Record<HosakaRideState, string> = {
      submitting: `Call ride with to: ${rec.toHeight} to ask HOSAKA again.`,
      awaiting_payment: `Nothing to do until your operator pays; ride_status checks. Do not call ride for this in a loop: HOSAKA charges nothing until paid, and the head stays reserved.`,
      computing: `Check with ride_status now and then; when it says done, call ride with to: ${rec.toHeight} to verify and sign.`,
      done: `Call ride with to: ${rec.toHeight} to verify the proof here and sign the hyperjump.`,
      failed: rec.badProof ? 'Tell your operator with message_operator, then cancel: true.' : `Call ride with to: ${rec.toHeight} to start it again, or cancel: true.`,
      expired: `Call ride with to: ${rec.toHeight} for a fresh invoice to your operator, or cancel: true.`,
    }
    const inv = rec.invoice
    const showInvoice = rec.state === 'awaiting_payment' && inv && inv.status === 'pending' && rec.dm?.depositId !== inv.depositId
    const text = [
      `HOSAKA ride to block ${rec.toHeight} from block ${rec.fromHeight} (${rec.blocks} block(s)${rec.asOf !== null ? `, as_of ${rec.asOf}` : ''}), job ${rec.jobId ?? '(not known yet)'}: ${this.hosakaWords(rec)}.`,
      ...notes,
      HOLDS_HEAD.has(rec.state) ? 'The head is reserved for this ride: no hop or other ride signs from it meanwhile.' : 'The head is not reserved while the ride waits on a decision.',
      showInvoice ? `Invoice (${Math.ceil(inv!.amountMsats / 1000)} sats): ${inv!.bolt11}` : '',
      next[rec.state],
      'Nothing was signed. HOSAKA\'s compute is paid by your operator and is not counted against your caps; you hold no wallet and pay nothing.',
    ].filter(Boolean).join('\n')
    return { text, data: { done: false, inFlight: true, ride: this.hosakaData(rec), notes } }
  }

  // ---- signing and publishing, shared ---------------------------------------

  /**
   * The hyperjump for a ride and its proof, signed through both checks
   * (signChainEvent), from the head the ride left from. The caller has
   * confirmed that head against the relays and verified the proof at Level 1;
   * nothing is recorded or sent here.
   */
  private signRide(plan: RidePlan, proof: RideProof): NostrEvent {
    const head = this.body.keeper.head()!
    const toCoordHex = this.store.line.stopCoordHex(plan.toHeight)!
    return this.signChainEvent(hyperjumpTemplate({
      createdAt: createdAtAfter(head), genesisId: plan.genesisId, previousId: plan.previousId, prevCoordHex: plan.prevCoordHex, toCoordHex,
      fromHeight: plan.fromHeight, toHeight: plan.toHeight, ...(plan.asOf !== undefined ? { asOf: plan.asOf } : {}),
      rootHex: proof.rootHex, mp: proof.mp, mnHex: proof.mnHex,
    }), 'ride')
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
