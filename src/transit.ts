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

import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { hexToCoord, terrainK } from 'cyberspace-core'
import type { Budget } from './budget.js'
import { chainTemplateProblem, enterHyperspaceTemplate, hyperjumpTemplate } from './chain/builder.js'
import { buildChain, chainStatus, firstBreak, lookBack, openBracket, type ActionEvent } from './chain/events.js'
import type { ChainKeeper } from './chain/keeper.js'
import { computeEnterProof } from './hyperspace/enter.js'
import { LineStore, type LineStatus, type StationResult, type Stop, type SyncResult } from './hyperspace/line.js'
import { lineStateOf, rideBlocks, zeroLengthRideRefusal, type LineState } from './hyperspace/ride.js'
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
}

/**
 * A ride between calls. The head it departs from is reserved from the first
 * call until the ride is signed, canceled, or found moved, so no hop and no
 * second ride can sign from that head meanwhile (one key, one mover). The
 * leaves and the price search live on disk under the previous event id
 * (rideCache.ts); this record holds only what the signature will need and
 * what the agent asks about.
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
  calls: number
  workSeconds: number
  lastCallSeconds: number
  progress: RideProgress | null
  computing: boolean
  notes: string[]
}

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

  constructor(dir: StateDir, private readonly body: TransitBody, options: TransitOptions = {}) {
    this.store = LineStore.open(join(dir.path, 'line'), { manifestUrl: options.manifestUrl, fetch: options.fetch })
    this.threads = options.threads ?? Math.max(1, availableParallelism() - 1)
    this.runner = RideRunner.open(join(dir.path, 'rides'), { threads: this.threads, now: options.now })
  }

  /** Whether a ride holds the head between calls. */
  get riding(): boolean {
    return this.flight !== null
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
   * `forget` drops the cache too.
   */
  async ride(input: { to?: number; budget_seconds?: number; as_of?: number; cancel?: boolean; forget?: boolean } = {}, signal?: AbortSignal): Promise<ToolResult> {
    const budgetSeconds = input.budget_seconds
    if (budgetSeconds !== undefined && (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0)) throw new Refusal('budget_seconds must be a positive number of seconds.')
    if (input.as_of !== undefined && !isHeight(input.as_of)) throw new Refusal('as_of must be a block height: a non-negative integer.')
    if (input.cancel || input.forget) return this.releaseRide(!!input.forget)
    const to = input.to
    if (!isHeight(to)) throw new Refusal('Say which block to ride to: to, a block height. Or pass cancel: true to release a ride in flight, or forget: true to drop its cache too.')
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

  /** The first call: the chain, the line, the station, the quote, then the reservation. */
  private async startRide(to: number, asOfInput: number | undefined): Promise<void> {
    const { keeper, budget } = this.body
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
    const seconds = estimateRideSeconds(this.body.calibration(), blocks, this.threads)
    const b = budget.state()
    if (!(seconds <= b.remainingSessionSeconds)) {
      const calls = Math.max(1, Math.ceil(seconds / b.capCallSeconds))
      throw new Refusal(`A ride of ${blocks} block(s) from block ${fromHeight} to block ${to} is expected to take about ${seconds.toFixed(1)} s on this machine (${threadWords(this.threads)}), and the session has ${b.remainingSessionSeconds.toFixed(1)} s of its ${b.capSessionSeconds} s left. One call is capped at ${b.capCallSeconds} s, so the ride would span about ${calls} call(s); the per-call cap bounds one call and the session cap bounds the whole ride. Pick a nearer block, or ask your human to raise the session cap or start a new session.`)
    }
    let release: () => void
    try {
      release = keeper.reserve()
    } catch (err) {
      throw new Refusal(words(err))
    }
    this.flight = {
      previousId: state.previousId, prevCoordHex: state.coordHex, genesisId: chain[0].id, fromHeight, toHeight: to, asOf, chained, blocks, quotedSeconds: seconds,
      release, startedAt: Date.now(), calls: 0, workSeconds: 0, lastCallSeconds: 0, progress: null, computing: false, notes,
    }
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
    const head = keeper.head()!
    const toCoordHex = line.stopCoordHex(flight.toHeight)!
    let event: NostrEvent
    try {
      event = this.signChainEvent(hyperjumpTemplate({
        createdAt: createdAtAfter(head), genesisId: flight.genesisId, previousId: flight.previousId, prevCoordHex: flight.prevCoordHex, toCoordHex,
        fromHeight: flight.fromHeight, toHeight: flight.toHeight, ...(flight.asOf !== undefined ? { asOf: flight.asOf } : {}),
        rootHex: result.proof.rootHex, mp: result.proof.mp, mnHex: result.proof.mnHex,
      }), 'ride')
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

  /** The ride in flight, read only. */
  rideStatus(): ToolResult {
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

  // ---- signing and publishing, shared ---------------------------------------

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
