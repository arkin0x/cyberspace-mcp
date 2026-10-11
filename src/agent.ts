// agent.ts: the agent's body, as one object the MCP tools call. It owns the
// state directory (and its lock), the key, the relays, the chain keeper,
// the outbox, the region keys, the chat room and the presence feed, and it
// implements every tool of v0 as a method that returns plain data or throws
// a Refusal whose message says why. The server (server.ts) only translates
// between MCP and these methods.
//
// Every rule the brief fixes is enforced here or in what this calls: the
// head is confirmed before every signature and reserved while a move is in
// flight; a spawn is signed only when the relays have said there is no chain,
// or when the human allowed a respawn; every event comes from a builder;
// every price is quoted and checked against the caps before work is spent;
// the chat rules are the chat room's; a relay's refusal is returned verbatim;
// an outbox event no relay has taken is sent only when the relays show the
// chain is clear of it, and dropped when they show a fork.

import { randomBytes } from 'node:crypto'
import { computeHopProof, computeSidestepProof, encodeNonce, encodeOpenings, type Plane } from 'cyberspace-core'
import { nip19 } from 'nostr-tools'
import type { Filter } from 'nostr-tools/filter'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { normalizeURL } from 'nostr-tools/utils'
import type { ShardModel } from 'sno-core/shards'
import { Budget } from './budget.js'
import { ACTION_KIND, chainTemplateProblem, hopTemplate, sidestepTemplate, spawnTemplate } from './chain/builder.js'
import { findDivergence } from './chain/divergence.js'
import { CHAIN_RULES_REVISION, buildChain, chainStatus, newestSpawn, type ActionEvent } from './chain/events.js'
import { Holders } from './chain/holders.js'
import { ChainKeeper } from './chain/keeper.js'
import { askChainEvents, parsePubkey } from './chain/resolve.js'
import { causeWords, decideSelfCheck } from './chain/selfCheck.js'
import { Chat, type ChatLine } from './chat.js'
import {
  HIDDEN_KIND, MAX_ITEM_NAME, MAX_MESSAGE_LENGTH, MAX_RIDDLE_LENGTH, OBJECT_KIND, REFERENCE_THRESHOLD_BYTES, bagEntries, bagSettingsOf, bagTemplate, chestInnerTemplate, heightHint, isReference,
  keyInnerTemplate, messageInnerTemplate, messagePreview, objectTemplate, referenceCount, referenceTo, shardInnerTemplate, unbag, wantsReference, entryKey,
  type BagEntry, type Hidden, type Reference,
} from './hidden/bags.js'
import { forgeKey, openWithSecret, openerFor, readContents, requiresLabel, sealEntries } from './hidden/chests.js'
import { hintFits, hintTags, parseHint, hintCandidatesExponent, type HintHeights } from './hidden/hint.js'
import { lookReport, type ChainFacts } from './look.js'
import { bytesToHex, hexToBytes, nowSeconds, signEvent, tagValue, type EventTemplate, type NostrEvent } from './nostr/event.js'
import { Outbox, type GuardVerdict } from './nostr/outbox.js'
import { unwrapMessage, wrapMessage } from './nostr/dm.js'
import { mergeAnswers } from './nostr/relayOutcome.js'
import { DEFAULT_RELAY, GENERAL_RELAYS, Relays, normalizeRelay, type PublishResult } from './nostr/relays.js'
import { OperatorWatch, type OperatorMove } from './follow.js'
import { OperatorChannel } from './operator.js'
import { Presence, neighborhoodFilter, sectorsApart, type Person } from './presence.js'
import { ROAM_MAX_MINUTES, ROAM_MIN_MINUTES, Roam, roamCandidates, searchRoam } from './roam.js'
import { profileTemplate, type ProfileFields, MAX_PICTURE_URL, pictureUrl, publishedFields } from './profile.js'
import { objectHandle, renderShard, type NamedView } from './render.js'
import { validateSnoPayload } from './sno.js'
import { hopCeiling, loadOrMeasure, projectCantorMs, type Calibration } from './space/calibration.js'
import { describePlace, distanceBetween, distanceWords, parseCoordinate, placeFromHex, placeOf, spawnPlace, type CoordinateInput, type Place } from './space/coords.js'
import { freeNeighbor } from './space/neighbors.js'
import { planSummary, priceNextStep, type Ceilings, type PricedStep } from './space/plan.js'
import { KeyStore, MAX_COMPUTE_HEIGHT, SCAN_MAX_HEIGHT, type EntrySummary, type HeldKey, type OpenedBag } from './space/regionKeys.js'
import { StateDir } from './state/dir.js'
import { Refusal, type ToolResult } from './tool.js'
import { Transit } from './transit.js'
import type { Secret } from './nwc.js'
import { DEFAULT_MAX_DAILY_SATS, DEFAULT_MAX_PAYMENT_SATS, Wallet } from './wallet.js'
import { DEFAULT_TRAVEL_PER_DAY, TravelLog, type TravelLogSettings } from './travel.js'

export { Refusal, type ToolResult } from './tool.js'

export interface AgentConfig {
  stateDir: string
  /** The relays, the canonical one first. */
  relays: string[]
  /** The operator's pubkey, npub or hex. */
  operator?: string
  name?: string
  about?: string
  capCallSeconds: number
  capSessionSeconds: number
  maxSidestepHeight: number
  allowRespawn: boolean
  /** Tests: the fake network's WebSocket, a known calibration, shorter relay waits. */
  websocketImplementation?: unknown
  calibration?: Calibration
  relayMaxWaitMs?: number
  log?: (line: string) => void
  /** The hyperspace line's manifest URL; the default is the NTH headers-v1 manifest. */
  manifestUrl?: string
  /** Worker threads for a ride; 0 computes on the calling thread. Default: the cores available less one. */
  rideThreads?: number
  /** Tests: a fetch that serves fixture blobs to the line store, and the ride runner's clock. */
  lineFetch?: typeof globalThis.fetch
  rideClock?: () => number
  /** Tests: the roam clock (unix seconds) and the roam candidates, in place of the clock and the random walk. */
  roamClock?: () => number
  roamCandidates?: (from: Place, hopCeiling: number) => Iterable<Place>
  /** Where the operator's kind 10050 and kind 3 are looked up besides the configured relays. Default GENERAL_RELAYS; tests pass fake ones. */
  lookupRelays?: string[]
  /** The HOSAKA API rides are bought from (--hosaka-url, config.json hosakaUrl); the default is the production API ONOSENDAI uses. */
  hosakaUrl?: string
  /** Tests: a fetch that serves a fake HOSAKA, and the background's pace in ms. */
  hosakaFetch?: typeof globalThis.fetch
  hosakaPollMs?: number
  /** The human's Nostr Wallet Connect string (--nwc, wallet.json, config.json nwc), or none. Never printed (nwc.ts Secret). */
  nwc?: Secret | null
  nwcSource?: string | null
  /** The human's limits on what the server pays, in sats (wallet.ts). */
  maxPaymentSats?: number
  maxDailySats?: number
  /** Tests: how long a pay_invoice answer is waited for, and the wallet's clock. */
  walletPayTimeoutMs?: number
  walletClock?: () => number
  /** The public travel log (kind 1): off unless the human turns it on (arkinox, 2026-10-11). */
  travelLog?: TravelLogSettings
}

/** The highest cube a key is derived for on request (hide, find, look): a key at h16 is about a second. */
export const MAX_KEY_HEIGHT = 16
/** How long a ride's arrival waits for the relays to say who stands at the stop. */
const FIXED_POINT_LOOK_MS = 2000
/** The most candidate regions a hinted sweep will try. */
const MAX_SWEEP_CANDIDATES = 1 << 16
/** The objects opened this session that render can draw by id; the oldest is forgotten past this. */
const OBJECTS_REMEMBERED = 64

interface ProfileFile {
  content: string
  tags: string[][]
  eventId: string
  accepted: string[]
  refused: Record<string, string>
}

export type Contents =
  | { message: string }
  | { object: unknown }
  | { key: { name: string; about?: string } }
  | { chest: { name: string; lock: string; requires?: string; entries: Array<{ message: string } | { object: unknown }> } }

export interface HintInput {
  coordinate: CoordinateInput
  heights: [number, number, number]
}

export class Agent {
  readonly pubkey: string
  readonly npub: string
  readonly relays: Relays
  readonly keeper: ChainKeeper
  readonly outbox: Outbox
  readonly keys: KeyStore
  readonly chat: Chat
  readonly presence: Presence
  readonly budget: Budget
  readonly holders: Holders
  /** The hyperspace tools: the line, the ride runner, and the ride in flight. */
  readonly transit: Transit
  /** The private NIP-17 channel to the operator: inbox, message_operator, STRATEGY. */
  readonly operatorChannel: OperatorChannel
  /** The follow watch: the operator's moves, verified, for follow_operator and orders_waiting (follow.ts). */
  readonly follow: OperatorWatch
  /** The roam switch, its interval and the cubes visited lately (roam.ts). */
  readonly roaming: Roam
  /** The human's wallet, if they connected one, and their limits: pays HOSAKA rides the server bought, nothing else. */
  readonly wallet: Wallet
  /** The public travel log, off unless the human turned it on (travel.ts). */
  readonly travel: TravelLog
  calibration: Calibration
  private readonly dir: StateDir
  private readonly sk: Uint8Array
  private readonly release: () => void
  private readonly log: (line: string) => void
  private name: string | null
  private stopped = false
  /**
   * The objects opened this session (found, placed, or inside an opened
   * chest), the newest 64, by the handle find lists (render.ts objectHandle),
   * so render can draw them. In memory
   * only: an object is the region's secret, and bags.json keeps labels, never
   * contents (arkinox, 2026-10-11).
   */
  private readonly objectsSeen = new Map<string, ShardModel>()

  private constructor(readonly config: AgentConfig, dir: StateDir, sk: Uint8Array, release: () => void, calibration: Calibration) {
    this.dir = dir
    this.sk = sk
    this.release = release
    this.log = config.log ?? (() => {})
    this.pubkey = getPublicKey(sk)
    this.npub = nip19.npubEncode(this.pubkey)
    this.calibration = calibration
    this.name = config.name ?? null
    const urls = config.relays.map((u) => normalizeRelay(u)).filter((u): u is string => !!u)
    if (urls.length === 0) throw new Error('no usable relay URL was given')
    this.relays = new Relays({ urls, signAuth: async (t) => finalizeEvent(t, this.sk), websocketImplementation: config.websocketImplementation, maxWaitMs: config.relayMaxWaitMs, log: this.log })
    this.holders = new Holders(dir, this.relays.canonical)
    this.keeper = new ChainKeeper(dir, this.relays, this.holders, this.pubkey, this.log)
    this.outbox = new Outbox(dir, this.relays, {
      log: this.log,
      onAccepted: (event, accepted) => {
        if (this.keeper.events.some((e) => e.id === event.id)) {
          this.keeper.markPublished(event.id, 'ok')
          this.holders.note(accepted)
        }
      },
      guard: (event) => this.guardChainEvent(event),
    })
    this.keys = new KeyStore(dir)
    this.budget = new Budget(config.capCallSeconds, config.capSessionSeconds)
    // The wallet talks to its own relays with the connection's own key; nothing of it reaches the agent's relays (wallet.ts, nwc.ts).
    this.wallet = new Wallet(dir, {
      nwc: config.nwc ?? null, source: config.nwcSource ?? 'the configuration', maxPaymentSats: config.maxPaymentSats ?? DEFAULT_MAX_PAYMENT_SATS, maxDailySats: config.maxDailySats ?? DEFAULT_MAX_DAILY_SATS,
      websocketImplementation: config.websocketImplementation, maxWaitMs: config.relayMaxWaitMs, log: this.log, now: config.walletClock, payTimeoutMs: config.walletPayTimeoutMs,
    })
    this.transit = new Transit(dir, {
      pubkey: this.pubkey, keeper: this.keeper, budget: this.budget, outbox: this.outbox, canonical: this.relays.canonical,
      calibration: () => this.calibration, sign: (t) => this.sign(t), settle: () => this.settle(), refreshChain: () => this.refreshChain(), log: this.log,
      // The operator channel is built below; these are called only from tool calls and the background, long after.
      undeliverable: () => this.operatorChannel.undeliverable(), messageOperator: (text) => this.operatorChannel.message(text), wallet: this.wallet,
    }, { manifestUrl: config.manifestUrl, fetch: config.lineFetch, threads: config.rideThreads, now: config.rideClock, hosakaUrl: config.hosakaUrl, hosakaFetch: config.hosakaFetch, hosakaPollMs: config.hosakaPollMs })
    this.chat = new Chat(dir, this.relays, this.keys, { pubkey: this.pubkey, name: () => this.name, sign: (t) => this.sign(t), log: this.log })
    this.presence = new Presence(this.relays, this.pubkey, this.log)
    this.presence.on('arrival', () => this.chat.arrival())
    this.operatorChannel = new OperatorChannel({
      pubkey: this.pubkey, relays: this.relays, dir, operator: () => this.operatorOfProfile(), operatorProblem: () => this.operatorProblem(), lookupRelays: config.lookupRelays ?? GENERAL_RELAYS,
      sign: (t) => this.sign(t),
      wrap: (recipient, text) => wrapMessage({ senderSk: this.sk, recipient, text, now: nowSeconds() }),
      unwrap: (wrap) => unwrapMessage(wrap, this.sk),
      now: nowSeconds, log: this.log, maxWaitMs: config.relayMaxWaitMs,
      // The operator's CONTINUE (KEEP GOING), and only it, renews the session budget (arkinox, 2026-10-11).
      renew: () => {
        const spent = this.budget.spentSeconds
        this.budget.renew()
        this.log(`session budget renewed by the operator's CONTINUE (renewal ${this.budget.renewals})`)
        const ride = this.transit.rideState()
        return `Your operator's CONTINUE (KEEP GOING) renewed your session budget: a fresh ${this.budget.capSessionSeconds} s of work (the session before it spent ${spent.toFixed(1)} s). The cap itself is unchanged.${ride.state === 'paused_cap' ? ` Your ride to block ${ride.to} is paused at the cap: call ride with to: ${ride.to} to resume it from the cache.` : ''}`
      },
    })
    this.follow = new OperatorWatch({
      relays: this.relays, dir,
      operator: () => (this.operatorProblem() ? null : this.operatorOfProfile()),
      follows: () => this.operatorChannel.operatorFollows(),
      now: nowSeconds, log: this.log,
    })
    this.roaming = new Roam(dir, config.roamClock ?? nowSeconds)
    this.travel = new TravelLog({
      settings: config.travelLog ?? { enabled: false, maxPerDay: DEFAULT_TRAVEL_PER_DAY, tagOperator: false },
      pubkey: this.pubkey, relays: this.relays, dir, defaults: config.lookupRelays ?? GENERAL_RELAYS,
      // Both the operator the profile names and the one the human configured are kept out of the note; a p tag names only an operator they agree on.
      operators: () => {
        const named = this.operatorOfProfile()
        const configured = this.config.operator ? parsePubkey(this.config.operator) : null
        return { all: [...new Set([named, configured].filter((k): k is string => !!k))], tag: this.operatorProblem() ? null : named ?? configured }
      },
      place: () => ({ place: this.keeper.place(), onChain: this.keeper.head() !== null }),
      privateTexts: () => this.operatorChannel.privateTexts(),
      sign: (t) => this.sign(t), now: nowSeconds, log: this.log, maxWaitMs: config.relayMaxWaitMs,
    })
  }

  /**
   * The operator the agent's own kind 0 names: the p tag marked operator in
   * the profile this server last signed. Only that operator gives orders; a
   * configured operator the profile does not carry yet gives none until
   * identity publishes it.
   */
  operatorOfProfile(): string | null {
    const last = this.dir.readJson<ProfileFile | null>('profile.json', null)
    const hex = last?.tags?.find((t) => t[0] === 'p' && t[3] === 'operator')?.[1]
    return hex && /^[0-9a-f]{64}$/.test(hex) ? hex : null
  }

  /**
   * Why the profile's operator may not give orders: the human configured an
   * operator (--operator or config.json) and the profile names someone else.
   * identity takes an operator from the model too, so text from cyberspace
   * that talked the model into naming a stranger must not make the stranger
   * its commander. Null when they agree or none was configured.
   */
  operatorProblem(): string | null {
    if (!this.config.operator) return null
    const configured = parsePubkey(this.config.operator)
    const named = this.operatorOfProfile()
    if (!configured || !named || configured === named) return null
    return `Your profile names ${nip19.npubEncode(named)} as operator, but your human started this server with operator ${nip19.npubEncode(configured)}. Only the operator your human configured gives orders, so no DM is read or sent until they agree. Call identity without operator to publish the configured one again.`
  }

  /** Copy the operator's DM inbox relays (kind 10050), in the background; a failure is logged and retried by the next DM tool. */
  private syncOperator(): void {
    void this.operatorChannel.sync().catch((err) => this.log(`operator inbox sync: ${err instanceof Error ? err.message : String(err)}`))
  }

  /** Whether the chain's truth is being read from a relay other than the default canonical one. */
  get nonDefaultCanonical(): boolean {
    return this.relays.canonical !== normalizeURL(DEFAULT_RELAY)
  }

  /**
   * Open the state directory, take its lock, load or create the key, measure
   * the machine once, replay the outbox, and start listening where the agent
   * stands. Throws LockHeldError when another server holds the directory.
   */
  static async start(config: AgentConfig): Promise<Agent> {
    const dir = StateDir.open(config.stateDir)
    const release = dir.lock()
    try {
      const sk = dir.loadOrCreateKey()
      const log = config.log ?? (() => {})
      let calibration = config.calibration
      if (!calibration) {
        const { calibration: c, measured } = loadOrMeasure(dir)
        calibration = c
        log(measured ? `calibrated: hop ceiling h${hopCeiling(c.cantorMsByHeight)}, ${Math.round(c.sha256PerSec / 1000)}k SHA-256/s` : 'calibration loaded from the state directory')
      }
      const agent = new Agent(config, dir, sk, release, calibration)
      if (agent.nonDefaultCanonical) {
        log(`WARNING: the canonical relay is ${agent.relays.canonical}, not the default ${DEFAULT_RELAY}. The chain's truth (which spawn is newest, where the head is) is read from there. A spawn signed because that relay shows no chain would end a chain this identity has on the default relay. Use this only for a relay that really holds this identity's chain.`)
      }
      await agent.boot()
      return agent
    } catch (err) {
      release()
      throw err
    }
  }

  private async boot(): Promise<void> {
    // What a crash left signed and unsent goes out first, when the relays show the chain is clear of it.
    const { sent, dropped, waiting } = await this.outbox.replay()
    if (sent.length || dropped.length || waiting.length) this.log(`outbox replay: ${sent.length} sent, ${dropped.length} dropped, ${waiting.length} waiting for the relays`)
    for (const d of dropped) this.log(`dropped ${d.event.id.slice(0, 8)}: ${d.dropped}`)
    this.settle()
    this.syncOperator()
    this.travel.start()
    // A watch left on keeps watching across a restart, and reads what the operator did meanwhile.
    this.follow.refresh()
    // A HOSAKA ride a restart left in hand is followed again in the background, with no ride call.
    this.transit.resume()
  }

  /**
   * Whether an event the outbox holds may be sent (the guard of H1): a
   * non-chain event always; a chain event only when the relays answered and
   * showed neither a fork at its point nor a chain started by another spawn.
   * Clear needs the canonical relay's own answer; any other answer can only
   * drop the event, never clear it.
   */
  private async guardChainEvent(event: NostrEvent): Promise<GuardVerdict> {
    if (event.kind !== ACTION_KIND) return { verdict: 'clear' }
    if (!this.keeper.events.some((e) => e.id === event.id)) return { verdict: 'fork', reason: 'this event is no longer on the chain this server keeps' }
    let answers
    try {
      answers = await askChainEvents(this.relays, this.holders, this.pubkey, this.keeper.genesisId(), this.keeper.events)
    } catch (err) {
      return { verdict: 'unknown', reason: `the relays could not be asked: ${err instanceof Error ? err.message : String(err)}` }
    }
    const verdict = decideSelfCheck(answers, this.relays.canonical)
    if (verdict.status === 'unknown') return { verdict: 'unknown', reason: `cannot tell whether another device moved from the same point: ${causeWords(verdict.cause)}` }
    const relayEvents = mergeAnswers(answers)
    const ours = newestSpawn(this.keeper.events, this.pubkey)
    const theirs = newestSpawn(relayEvents, this.pubkey)
    if (ours && theirs && theirs.id !== ours.id) {
      // The relays' chain starts from another spawn: ours is history, or would end theirs.
      const unpublished = new Set(this.keeper.events.filter((e) => this.keeper.published[e.id] !== 'ok').map((e) => e.id))
      this.keeper.dropLocal(unpublished)
      this.keeper.adopt(relayEvents)
      const theirsNewer = theirs.created_at > ours.created_at || (theirs.created_at === ours.created_at && theirs.id > ours.id)
      return {
        verdict: 'fork',
        reason: theirsNewer
          ? `the relays hold a newer spawn (${theirs.id.slice(0, 8)}...), so this event belongs to a chain that has ended; the relays' chain was adopted`
          : `the relays hold a chain started by another spawn (${theirs.id.slice(0, 8)}...), and publishing this would end it; a spawn is never signed over a human's chain without the human, so the relays' chain was adopted`,
      }
    }
    const div = findDivergence(this.keeper.events, this.keeper.published, relayEvents)
    if (div && div.local.some((a) => a.id === event.id)) {
      this.keeper.dropLocal(new Set(div.local.map((a) => a.id)))
      this.keeper.adopt(relayEvents)
      return { verdict: 'fork', reason: `another device published ${div.relay.length} move${div.relay.length === 1 ? '' : 's'} from the same point (event ${div.forkId.slice(0, 8)}...) while this one was unsent; publishing it would fork the chain and kill it, so it was dropped and the relays' version adopted` }
    }
    const canonical = answers.find((a) => a.url === this.relays.canonical)
    if (canonical?.outcome !== 'answered') {
      return { verdict: 'unknown', reason: `the canonical relay did not answer (${canonical ? canonical.reason : 'not asked'}); another relay showed no fork, but only the canonical relay's answer can say nothing newer was published there` }
    }
    this.keeper.adopt(relayEvents)
    return { verdict: 'clear' }
  }

  private sign(template: EventTemplate): NostrEvent {
    return signEvent(template, this.sk)
  }

  /** Stand where the chain says: scan the cubes there, listen for chat, watch the neighborhood. */
  private settle(): void {
    const place = this.keeper.place()
    this.keys.scanAround(place.position, SCAN_MAX_HEIGHT)
    this.chat.enter(place)
    void this.presence.enter(place.position).catch((err) => this.log(`presence: ${err instanceof Error ? err.message : String(err)}`))
  }

  private ceilings(): Ceilings {
    return { hop: Math.min(MAX_COMPUTE_HEIGHT, hopCeiling(this.calibration.cantorMsByHeight)), sidestep: this.config.maxSidestepHeight }
  }

  /** Bring the chain up to date with the relays: a self-check with no chain known, a head confirmation otherwise. */
  private async refreshChain(): Promise<void> {
    if (this.keeper.events.length === 0) {
      await this.keeper.selfCheck()
    } else {
      await this.keeper.confirmHead()
    }
    this.settle()
  }

  private chainFacts(now: number): ChainFacts {
    const head = this.keeper.head()
    return { status: this.keeper.status(), headId: head?.id ?? null, headAge: head ? Math.max(0, now - head.createdAt) : null, words: this.keeper.breakWords(), rules: CHAIN_RULES_REVISION }
  }

  // ---- the price of keys (M3) ----------------------------------------------

  /** The seconds deriving keys at these heights costs here: nothing up to the passive scan height, about three Cantor trees per height above it. */
  private keysSeconds(heights: number[]): number {
    let ms = 0
    for (const h of heights) if (h > SCAN_MAX_HEIGHT) ms += 3 * projectCantorMs(this.calibration.cantorMsByHeight, h)
    return ms / 1000
  }

  /** Why deriving these keys would break a cap, or null. */
  private keysRefusal(heights: number[]): string | null {
    const seconds = this.keysSeconds(heights)
    return seconds > 0 ? this.budget.refusal(seconds) : null
  }

  /** Derive keys through `derive`, timing it, and spend the time when any height is above the passive scan. */
  private deriveKeys<T>(heights: number[], derive: () => T): { result: T; ms: number } {
    const t0 = performance.now()
    const result = derive()
    const ms = performance.now() - t0
    if (heights.some((h) => h > SCAN_MAX_HEIGHT)) this.budget.spendWork(ms / 1000)
    return { result, ms }
  }

  // ---- identity -------------------------------------------------------------

  async identity(input: { name?: string; about?: string; picture?: string; operator?: string } = {}): Promise<ToolResult> {
    // The operator is locked (arkinox, 2026-10-11): the one the human
    // configured, else the one the published profile already names. The
    // model may name an operator only when there is none yet, so text read
    // in cyberspace can never talk the agent into a new commander. A real
    // hand-over is the human's: restart the server with another --operator.
    const locked = (this.config.operator ? parsePubkey(this.config.operator) : null) ?? this.operatorOfProfile()
    if (input.operator !== undefined) {
      const asked = parsePubkey(input.operator)
      if (!asked) throw new Refusal(`The operator must be an npub or a 64-hex pubkey; got ${JSON.stringify(input.operator)}.`)
      if (locked && asked !== locked) {
        throw new Refusal(`Your operator is locked to ${nip19.npubEncode(locked)}. Only your human can change it, by restarting this server with another --operator. Call identity without operator.`)
      }
    }
    const operatorRaw = input.operator ?? this.config.operator ?? (locked ? locked : undefined)
    const operator = operatorRaw ? parsePubkey(operatorRaw) : null
    if (operatorRaw && !operator) throw new Refusal(`The operator must be an npub or a 64-hex pubkey; got ${JSON.stringify(operatorRaw)}.`)
    if (input.name !== undefined) this.name = input.name
    const picture = input.picture === undefined ? undefined : input.picture.trim() === '' ? '' : pictureUrl(input.picture)
    if (picture === null) throw new Refusal(`The picture must be an https URL of at most ${MAX_PICTURE_URL} characters; got ${JSON.stringify(input.picture)}.`)
    const last = this.dir.readJson<ProfileFile | null>('profile.json', null)
    // A field left out keeps what the last published profile said, then the
    // configuration (arkinox, 2026-10-11: setting the picture must not drop
    // the about, nor a later call the picture). An empty picture removes it.
    const had = publishedFields(last?.content)
    const fields: ProfileFields = {
      name: input.name ?? had.name ?? this.config.name,
      about: input.about ?? had.about ?? this.config.about,
      picture: picture === '' ? undefined : picture ?? had.picture,
      operator: operator ?? undefined,
    }
    const template = profileTemplate(fields, nowSeconds())
    let publish: { status: 'unchanged' } | { status: 'published'; eventId: string; accepted: string[]; refused: Record<string, string> } | { status: 'refused'; eventId: string; refused: Record<string, string>; reason: string }
    if (last && last.content === template.content && JSON.stringify(last.tags) === JSON.stringify(template.tags) && last.accepted.length > 0) {
      publish = { status: 'unchanged' }
    } else {
      const event = this.sign(template)
      const entry = this.outbox.add(event)
      const result = await this.outbox.send(entry)
      const refused = entry.refused ?? {}
      this.dir.writeJson('profile.json', { content: template.content, tags: template.tags, eventId: event.id, accepted: entry.accepted, refused } satisfies ProfileFile)
      publish = result.ok && entry.accepted.length > 0
        ? { status: 'published', eventId: event.id, accepted: entry.accepted, refused }
        : { status: 'refused', eventId: event.id, refused, reason: result.ok ? 'no relay accepted it' : result.reason }
      this.syncOperator()
    }
    await this.refreshChain()
    const now = nowSeconds()
    const spawn = spawnPlace(this.pubkey)
    const chain = this.chainFacts(now)
    const text = [
      `You are ${this.npub} (hex ${this.pubkey}).`,
      `Your spawn coordinate is ${describePlace(spawn).hex} in ${describePlace(spawn).planeName}, sector ${describePlace(spawn).sector}.`,
      `Chain: ${chain.status}${chain.headId ? `, head ${chain.headId.slice(0, 8)}... from ${chain.headAge} s ago` : ' (no spawn yet; your first hop will spawn you)'}.${chain.words ? ` ${chain.words}` : ''} Chain rules: ${CHAIN_RULES_REVISION}.`,
      publish.status === 'unchanged' ? 'Profile: unchanged since it was last accepted; not republished.'
        : publish.status === 'published' ? `Profile published (bot: true${operator ? `, operator ${nip19.npubEncode(operator)}` : ''}) to ${publish.accepted.join(', ')}${Object.keys(publish.refused).length ? `; refused by ${Object.entries(publish.refused).map(([u, r]) => `${u} (${r})`).join(', ')}` : ''}.`
        : `Profile NOT published: ${publish.reason}${Object.keys(publish.refused).length ? `. Each relay said: ${Object.entries(publish.refused).map(([u, r]) => `${u}: ${r}`).join('; ')}` : ''}. The relay's words are verbatim; this server will not retry a refusal. Give the agent a relay of its own with --relay for its profile.`,
      operator ? '' : 'No operator was given: pass --operator <npub> at startup or `operator` to this tool so the profile names your human.',
      this.nonDefaultCanonical ? `WARNING: the chain's truth is being read from ${this.relays.canonical}, not the default canonical relay ${DEFAULT_RELAY}. A spawn signed because this relay shows no chain could derezz a chain this identity has elsewhere.` : '',
      this.operatorChannel.strategyLine(),
    ].filter(Boolean).join('\n')
    return { text, data: { npub: this.npub, pubkey: this.pubkey, spawn: describePlace(spawn), chain, profile: publish, operator: operator ? { hex: operator, npub: nip19.npubEncode(operator) } : null, canonical: this.relays.canonical, nonDefaultCanonical: this.nonDefaultCanonical, strategy: this.operatorChannel.strategy() } }
  }

  // ---- whereami -------------------------------------------------------------

  async whereami(): Promise<ToolResult> {
    await this.refreshChain()
    const now = nowSeconds()
    const place = this.keeper.place()
    const chain = this.chainFacts(now)
    const where = describePlace(place)
    const text = `You stand at ${where.hex}: ${where.planeName}, sector ${where.sector}, x ${where.x} y ${where.y} z ${where.z}. Chain ${chain.status}${chain.headId ? `, head ${chain.headId.slice(0, 8)}... signed ${chain.headAge} s ago` : ', no spawn yet: this is your spawn coordinate'}.${chain.words ? ` ${chain.words}` : ''}\n${this.operatorChannel.strategyLine()}`
    return { text, data: { where, chain, secondsSinceHead: chain.headAge, strategy: this.operatorChannel.strategy() } }
  }

  // ---- look -----------------------------------------------------------------

  async look(input: { radius_sectors?: number; heights?: number[] } = {}): Promise<ToolResult> {
    await this.refreshChain()
    const place = this.keeper.place()
    const blind: string[] = []
    if (input.radius_sectors !== undefined && input.radius_sectors !== 1) blind.push(`v0 sees exactly the 27 sectors around you (radius 1); a radius of ${input.radius_sectors} is not available.`)
    const heights = (input.heights ?? []).filter((h) => Number.isInteger(h) && h >= 1 && h <= MAX_KEY_HEIGHT)
    const priced = this.keysRefusal(heights)
    if (priced) throw new Refusal(priced)
    const { ms: keyMs } = this.deriveKeys(heights, () => { for (const h of heights) this.keys.keyAt(place.position, h, 'scan') })
    await this.presence.refresh()
    await this.presence.fetchProfiles()
    await this.presence.verdicts(12)
    const people = this.presence.others().filter((p) => sectorsApart(p.place.position, place.position) <= 1n)
    const unchecked = people.filter((p) => p.verdictAt !== p.actionId).length
    if (unchecked > 0) blind.push(`${unchecked} of the people here have chains this server has not read yet; their position is where their newest action says.`)
    blind.push(`Bags sealed to cubes above h${Math.max(SCAN_MAX_HEIGHT, ...heights)} here: no key held for them. Pass heights to look (priced above h${SCAN_MAX_HEIGHT}), or use find.`)
    blind.push('Chat said before this server started listening: the relay keeps none of it.')
    blind.push('Proofs are not re-verified: chain status follows the link and tag rules.')
    if (this.presence.loading) blind.push('The presence backfill has not finished; more people may appear.')
    const report = lookReport({
      me: { pubkey: this.pubkey, npub: this.npub, name: this.name },
      place,
      chain: this.chainFacts(nowSeconds()),
      keys: this.keys.keysContaining(place.position),
      bags: this.keys.bagsContaining(place.position),
      people,
      lines: this.chat.lines,
      budget: this.budget.state(),
      relays: { canonical: this.relays.canonical, others: this.relays.others },
      blind,
      scanHeight: SCAN_MAX_HEIGHT,
    }, nowSeconds())
    return { text: report.text, data: { ...report.data, keyMs: Math.round(keyMs) } }
  }

  // ---- nobody's gibson (arkinox, 2026-10-11) --------------------------------
  //
  // "don't ever let the agent land on the exact same gibson as the user,
  // because that is uncomfortable. Unless the situation requires it (game
  // entry, for example, enforces a single gibson entry point)." Every
  // coordinate the agent chooses to land on (hop, plan_hop, the follow
  // tool's aim) is checked against the people the server knows: the
  // operator wherever the follow watch or presence last saw them, and every
  // other avatar in the 27 sectors that is not known to be a bot (an
  // unknown profile is protected; bots may share a gibson). There is no
  // override. A point the protocol fixes (a ride exits exactly at its stop)
  // is the one exception, and the ride's result says so (fixedPointNote).

  /** Who stands where, by hex coordinate, from memory: the operator and every avatar nearby not known to be a bot. */
  private occupants(): Map<string, { pubkey: string; words: string; unknown: boolean }> {
    const out = new Map<string, { pubkey: string; words: string; unknown: boolean }>()
    const operator = this.operatorOfProfile()
    const seen = this.follow.latest()
    for (const p of this.presence.others()) {
      const isOperator = p.pubkey === operator
      if (!isOperator && p.profile?.bot === true) continue
      // Presence keeps the operator where they last were nearby; the watch's verified move, when newer, is where they are.
      if (isOperator && seen && seen.at >= p.lastActive) continue
      const name = p.profile?.name ? `${p.profile.name} (${p.pubkey.slice(0, 8)}...)` : `${p.pubkey.slice(0, 8)}...`
      out.set(p.place.hex, { pubkey: p.pubkey, words: isOperator ? 'Your operator' : p.profile ? `The human ${name}` : `${name}, not known to be a bot,`, unknown: !isOperator && !p.profile })
    }
    if (seen && operator) out.set(seen.coordHex, { pubkey: operator, words: 'Your operator', unknown: false })
    return out
  }

  /**
   * Why the agent may not land on `landing`, or null: a person stands on
   * that exact gibson. The refusal names the free gibson beside them that is
   * cheapest from `from`, so the model can retry there in one call. With
   * `fetch`, a profile not read yet is read first: a bot there is no bar.
   */
  private async gibsonRefusal(landing: Place, from: Place, fetch = true): Promise<string | null> {
    let occ = this.occupants()
    let who = occ.get(landing.hex)
    if (who?.unknown && fetch) {
      await this.presence.fetchProfiles()
      occ = this.occupants()
      who = occ.get(landing.hex)
    }
    if (!who) return null
    const free = freeNeighbor(landing, from, new Set([...occ.keys(), landing.hex]))
    return `${who.words} stands on ${landing.hex}, and you never land on the exact gibson a person stands on: it is uncomfortable for them. ${free ? (free.hex === from.hex ? 'You already stand beside it: stay.' : `Land beside them instead, at ${free.hex} (free, one gibson off): call plan_hop or hop with that target.`) : 'Every gibson beside it is taken; wait for them to move.'}`
  }

  /** The rule for one step: neither the target (a route toward a person's gibson is refused at its first step, not its last) nor where this step lands may be a person's gibson. */
  private async landingRefusal(step: PricedStep, target: Place, from: Place, fetch = true): Promise<string | null> {
    return (await this.gibsonRefusal(target, from, fetch)) ?? (step.to.hex !== target.hex ? this.gibsonRefusal(step.to, from, fetch) : null)
  }

  /**
   * The exception, said where it applies: a point the protocol fixes (a ride
   * exits exactly at its stop; a game's single entry gibson) may be shared,
   * and when a person stands on it the agent is told to step one gibson off
   * afterward, to the free neighbor plan_hop can price.
   */
  fixedPointNote(at: Place, why: string): { text: string; data: { why: string; sharedWith: string[]; stepOff: string | null } } {
    const occ = this.occupants()
    const who = occ.get(at.hex)
    const free = who ? freeNeighbor(at, at, new Set([...occ.keys(), at.hex])) : null
    const text = `${why} That is a single point the protocol fixes, so the rule against landing on a person's gibson yields here.${who ? ` ${who.words} stands on this exact gibson: step one gibson off now${free ? `, to ${free.hex} (plan_hop prices it)` : ''}.` : ''}`
    return { text, data: { why, sharedWith: who ? [who.pubkey] : [], stepOff: free?.hex ?? null } }
  }

  // ---- plan_hop and hop -----------------------------------------------------

  private target(input: CoordinateInput, from: Place): Place {
    try {
      return parseCoordinate(input, from)
    } catch (err) {
      throw new Refusal(err instanceof Error ? err.message : String(err))
    }
  }

  private describeStep(step: PricedStep, target: Place): Record<string, unknown> {
    const rest = planSummary(step.to.position, target.position, this.ceilings())
    return {
      kind: step.kind,
      from: describePlace(step.from),
      to: describePlace(step.to),
      heights: step.heights,
      maxHeight: step.maxHeight,
      terrainK: step.terrainK,
      expectedSeconds: Number(step.seconds.toFixed(2)),
      work: step.work,
      landsOnTarget: step.to.hex === target.hex,
      remainingAfter: rest,
      ceilings: this.ceilings(),
    }
  }

  /**
   * Why the target cannot be reached from here at all, or null: the tallest
   * wall between the two is crossed once on its axis, so the route is
   * feasible exactly when it fits a hop ceiling or the sidestep cap
   * (ONOSENDAI movePlan routeFeasible).
   */
  private routeRefusal(from: Place, target: Place): string | null {
    const c = this.ceilings()
    const d = distanceBetween(from, target)
    if (d.maxLca <= Math.max(c.hop, c.sidestep)) return null
    return `The target is across an h${d.maxLca} wall (${d.chebyshev.toString()} gibsons on the widest axis), and the highest wall this server crosses is h${c.sidestep} (the sidestep cap; hops reach h${c.hop}). Nobody hops that far: a coordinate that distant is reached by hyperspace, which exits only at stops. Ride the line to the stop nearest it (station, board, ride) and meet there, or pick a target within h${c.sidestep}.`
  }

  private stepRefusal(step: PricedStep | null, target: Place, cap?: number): string | null {
    if (!step) return 'You already stand at that coordinate.'
    const route = this.routeRefusal(step.from, target)
    if (route) return route
    if (step.aboveSidestepCap) return `The next step is a sidestep across an h${step.maxHeight} wall, above the configured cap of h${this.config.maxSidestepHeight}. Nobody can hop a wall that high on this machine; its price would be about ${step.seconds > 3600 ? `${(step.seconds / 3600).toFixed(1)} hours` : `${step.seconds.toFixed(0)} s`} of hashing. Pick a nearer target, or ask your human to raise --max-sidestep-height.`
    if (!step.feasible) return `The next step (${step.kind}, h${step.maxHeight}) is above what this machine computes (hop ceiling h${this.ceilings().hop}).`
    return this.budget.refusal(step.seconds, cap)
  }

  async planHop(input: { target: CoordinateInput }): Promise<ToolResult> {
    await this.refreshChain()
    const from = this.keeper.place()
    return this.planFrom(from, this.target(input.target, from))
  }

  /** plan_hop from where the agent stands, the chain already refreshed. */
  private async planFrom(from: Place, target: Place): Promise<ToolResult> {
    const step = priceNextStep(from, target, this.ceilings(), this.calibration)
    const refusal = this.stepRefusal(step, target) ?? (step ? await this.landingRefusal(step, target, from) : null)
    const plan = step ? this.describeStep(step, target) : null
    const chainWords = this.keeper.breakWords()
    const text = step
      ? `${refusal ? `REFUSED: ${refusal}` : 'Within the caps.'} Next step: a ${step.kind} of h${step.maxHeight} (x h${step.heights.x}, y h${step.heights.y}, z h${step.heights.z}; terrain K ${step.terrainK}) expected to take about ${step.seconds.toFixed(2)} s here${step.to.hex === target.hex ? ', landing on the target' : `, landing short of the target; ${(plan!.remainingAfter as { steps: number }).steps} more step(s) would follow`}.${this.keeper.status() === 'none' ? ' You have no chain yet: hop will sign your spawn first.' : ''}${chainWords ? ` ${chainWords}` : ''}`
      : refusal!
    return { text, data: { refused: refusal, plan, target: describePlace(target), chainStatus: this.keeper.status() } }
  }

  async hop(input: { target: CoordinateInput; cap_seconds?: number }): Promise<ToolResult> {
    const cap = input.cap_seconds
    if (cap !== undefined && (!Number.isFinite(cap) || cap <= 0)) throw new Refusal('cap_seconds must be a positive number of seconds.')
    let release: () => void
    try {
      release = this.keeper.reserve()
    } catch (err) {
      throw new Refusal(err instanceof Error ? err.message : String(err))
    }
    try {
      return await this.move(input.target, cap)
    } finally {
      release()
    }
  }

  private async move(targetInput: CoordinateInput, cap: number | undefined): Promise<ToolResult> {
    await this.refreshChain()
    let status = this.keeper.status()
    let spawned: NostrEvent | null = null
    const notes: string[] = []

    if (status === 'dead' || status === 'frozen') {
      if (!this.config.allowRespawn) {
        throw new Refusal(`${this.keeper.breakWords()} A respawn would start a new chain at your spawn coordinate, and a spawn is never signed without your human: ask them, and have the server started with --allow-respawn.`)
      }
      spawned = await this.spawn()
      notes.push(`Respawned, as the human allowed: the old chain (${status}) is history and you stand at your spawn coordinate.`)
      status = 'valid'
    } else if (status === 'none') {
      const verdict = await this.keeper.selfCheck()
      if (verdict.status === 'unknown') {
        throw new Refusal(`Cannot tell whether this identity already has a chain: ${causeWords(verdict.cause)}. A spawn signed now could end a chain you already have, so nothing was signed. Try again when the canonical relay answers.`)
      }
      if (verdict.status === 'found') {
        notes.push('The relays hold a chain for this identity; adopted it rather than spawning.')
      } else {
        spawned = await this.spawn()
        notes.push('No chain on the relays: signed your spawn, the first event of your chain.')
      }
    }

    const from = this.keeper.place()
    const target = this.target(targetInput, from)
    if (from.hex === target.hex) {
      if (spawned) return this.moveResult(spawned, 0, 0, notes, target)
      throw new Refusal('You already stand at that coordinate.')
    }

    const step = priceNextStep(from, target, this.ceilings(), this.calibration)
    const refusal = this.stepRefusal(step, target, cap) ?? (step ? await this.landingRefusal(step, target, from) : null)
    if (refusal || !step) throw new Refusal(`${refusal ?? 'Nothing to do.'}${spawned ? ' Your spawn was signed and stands.' : ''}`)

    // Confirm the head, fresh, before any work; the head must be the one the plan was made from.
    const headBefore = this.keeper.head()
    if (!headBefore) throw new Refusal('No head to extend; the spawn was not recorded.')
    const unconfirmed = await this.keeper.confirmHead()
    if (unconfirmed) throw new Refusal(unconfirmed)
    if (this.keeper.head()?.id !== headBefore.id) throw new Refusal(`The head moved while planning: the relays hold a newer move (${this.keeper.head()?.id.slice(0, 8)}...), adopted now. Plan again from where you stand.`)
    if (this.keeper.status() !== 'valid') throw new Refusal(this.keeper.breakWords() ?? 'The chain is not valid.')

    const chain = this.keeper.chain()
    const head = chain[chain.length - 1]
    const t0 = performance.now()
    const template = this.prove(step, head, chain[0].id)
    const seconds = (performance.now() - t0) / 1000
    this.budget.spendMove(seconds)

    // Confirm again, immediately before the signature: the machine was busy, and another device may have moved.
    const again = await this.keeper.confirmHead()
    if (again) throw new Refusal(`${again} The proof (${seconds.toFixed(1)} s of work) was discarded unsigned.`)
    if (this.keeper.head()?.id !== head.id) throw new Refusal(`The head moved while the proof was computed: the relays hold a newer move (${this.keeper.head()?.id.slice(0, 8)}...), adopted now. The proof was discarded unsigned; plan again from where you stand.`)
    // Someone may have stepped onto the landing gibson while the proof was computed: asked again from memory.
    const arrived = await this.landingRefusal(step, target, from, false)
    if (arrived) throw new Refusal(`${arrived} They arrived while the proof was computed, so it (${seconds.toFixed(1)} s of work) was discarded unsigned.`)

    const problem = chainTemplateProblem(template, this.pubkey)
    if (problem) throw new Error(`refusing to sign a malformed chain event: ${problem}`)
    const event = this.sign(template)
    this.keeper.record(event, 'queued')
    const entry = this.outbox.add(event)
    const result = await this.outbox.send(entry)
    this.settle()
    return this.moveResult(event, seconds, step.work, notes, target, result, step)
  }

  /**
   * The proof of one step, as the template it goes out as: the hop proof or
   * the sidestep proof from cyberspace-core, bound to the head's id. The
   * caller confirms the head before and after, because this is the work.
   */
  private prove(step: PricedStep, head: ActionEvent, genesisId: string): EventTemplate {
    const to = step.to
    if (step.kind === 'hop') {
      const proof = computeHopProof(head.position.x, head.position.y, head.position.z, to.position.x, to.position.y, to.position.z, to.plane, head.id, this.ceilings().hop)
      return hopTemplate({ createdAt: nowSeconds(), genesisId, previousId: head.id, prevCoordHex: head.coordHex, to: to.position, plane: to.plane, proofHash: proof.proofHash })
    }
    const proof = computeSidestepProof(head.position.x, head.position.y, head.position.z, to.position.x, to.position.y, to.position.z, to.plane, head.id)
    return sidestepTemplate({
      createdAt: nowSeconds(), genesisId, previousId: head.id, prevCoordHex: head.coordHex, to: to.position, plane: to.plane, proofHash: proof.proofHash,
      merkleRoots: [bytesToHex(proof.merkleX), bytesToHex(proof.merkleY), bytesToHex(proof.merkleZ)],
      openings: [encodeOpenings(proof.openings.x), encodeOpenings(proof.openings.y), encodeOpenings(proof.openings.z)],
      mnHex: encodeNonce(proof.nonce), lcaHeights: proof.lcaHeights,
    })
  }

  /** Sign and publish a spawn (spec 8.3). Exempt from head confirmation: a spawn is never a link. */
  private async spawn(): Promise<NostrEvent> {
    const template = spawnTemplate(this.pubkey, nowSeconds())
    const problem = chainTemplateProblem(template, this.pubkey)
    if (problem) throw new Error(`refusing to sign a malformed spawn: ${problem}`)
    const event = this.sign(template)
    this.keeper.record(event, 'queued')
    const entry = this.outbox.add(event)
    const result = await this.outbox.send(entry)
    if (!result.ok) this.log(`spawn not yet on any relay: ${result.reason}`)
    this.settle()
    return event
  }

  private moveResult(event: NostrEvent, seconds: number, work: number, notes: string[], target: Place, result?: PublishResult, step?: PricedStep): ToolResult {
    const place = this.keeper.place()
    const where = describePlace(place)
    const entry = this.outbox.entries.find((e) => e.event.id === event.id)
    const accepted = entry?.accepted ?? []
    const refused = entry?.refused ?? {}
    const rest = planSummary(place.position, target.position, this.ceilings())
    const action = tagValue(event, 'A')
    const text = [
      ...notes,
      `${action === 'spawn' ? 'Spawn' : action === 'hop' ? 'Hop' : 'Sidestep'} ${event.id.slice(0, 8)}... signed${step ? ` (h${step.maxHeight}, ${seconds.toFixed(2)} s of work)` : ''}; you now stand at ${where.hex} (${where.planeName}, sector ${where.sector}).`,
      accepted.length ? `Accepted by ${accepted.join(', ')}${accepted.includes(this.relays.canonical) ? '' : '; the canonical relay has not taken it yet and will be retried in the background (see outbox)'}.` : `No relay has taken it yet${result && !result.ok ? ` (${result.reason})` : ''}; it waits in the outbox and is retried once the relays show the chain is clear of it.`,
      Object.keys(refused).length ? `Refused by ${Object.entries(refused).map(([u, r]) => `${u}: ${r}`).join('; ')}.` : '',
      place.hex === target.hex ? 'You are on the target.' : `The target is ${rest.steps} step(s) further (${rest.hops} hop(s), ${rest.sidesteps} sidestep(s), tallest wall h${rest.tallestWall}); call hop again to continue.`,
    ].filter(Boolean).join('\n')
    return {
      text,
      data: {
        eventId: event.id, action, where, workSeconds: Number(seconds.toFixed(3)), work, accepted, refused, canonicalPending: !accepted.includes(this.relays.canonical),
        remainingToTarget: rest, onTarget: place.hex === target.hex, budget: this.budget.state(),
      },
    }
  }

  // ---- station, board, ride, ride_status (transit.ts) -----------------------

  /** The line's state, the agent's station, the nearest stops, and a quote for a ride; with `sync`, the line is advanced first. Nothing is signed. */
  station(input: { sync?: boolean; budget_seconds?: number; destination?: number } = {}): Promise<ToolResult> {
    return this.transit.station(input)
  }

  /** Board the line where the agent stands: the entry proof, signed and published as an enter-hyperspace (DECK-0001 3). */
  board(input: { as_of?: number } = {}): Promise<ToolResult> {
    return this.transit.board(input)
  }

  /** Ride the line to a block: the work runs in the background, and the ride call after the proof is ready signs the hyperjump (DECK-0001 5). */
  async ride(input: { to?: number; budget_seconds?: number; wait_seconds?: number; as_of?: number; pause?: boolean; cancel?: boolean; forget?: boolean; prover?: 'local' | 'hosaka' } = {}, signal?: AbortSignal): Promise<ToolResult> {
    const result = await this.transit.ride(input, signal)
    const where = result.data.where as { hex?: string } | undefined
    if (result.data.action !== 'hyperjump' || !where?.hex) return result
    // Arrived at the stop: who stands on it is asked of the relays, briefly, so a human there is seen before the agent is told to stay.
    await Promise.race([this.presence.refresh(), new Promise((r) => setTimeout(r, FIXED_POINT_LOOK_MS))])
    const note = this.fixedPointNote(placeFromHex(where.hex), `A ride exits exactly at its stop (DECK-0001), so you stand on the stop's own gibson.`)
    return { text: `${result.text}\n${note.text}`, data: { ...result.data, fixedPoint: note.data } }
  }

  /** The ride in flight, if any. */
  rideStatus(): ToolResult {
    return this.transit.rideStatus()
  }

  // ---- inbox, message_operator (operator.ts) --------------------------------

  /** New orders from the operator since the last read, oldest first, the current STRATEGY, and the ignored count. Marks them read. */
  async ordersWaiting(): Promise<ToolResult> {
    // The operator's newest unseen move, from memory (arkinox, 2026-10-11:
    // the follow watch), so the waker can wake the agent when its operator
    // moves. Read before the DM question, and kept when that question fails,
    // so an unreachable DM inbox never hides a move.
    this.follow.refresh()
    const moved = this.follow.unseen()
    const operatorMoved = moved ? this.moveData(moved) : null
    const movedWords = operatorMoved ? ` Your operator moved: ${operatorMoved.action} to ${operatorMoved.to} (${operatorMoved.distance} from you). Call follow_operator to see the way there.` : ''
    // Whether a roam step is due (arkinox, 2026-10-11): from memory, and
    // never while a ride or a move holds the head, so the waker wakes the
    // agent only for a step it can take. Kept, like a move, when the DM
    // question fails.
    const roamDue = this.roaming.due() && this.roamBusy() === null
    const roamWords = roamDue ? ' A roam step is due: call roam for a suggested destination.' : ''
    let result: ToolResult
    try {
      result = await this.operatorChannel.ordersWaiting()
    } catch (err) {
      if ((!operatorMoved && !roamDue) || !(err instanceof Refusal)) throw err
      result = { text: `Could not count orders: ${err.message}`, data: { orders: null, ordersError: err.message } }
    }
    // The ride's state rides along (arkinox, 2026-10-11), so the waker that
    // polls this can wake the agent when its proof is ready or its ride
    // stopped, without a second call. In memory; no relay is asked for it.
    const ride = this.transit.rideState()
    const said: Record<string, string> = {
      computing: `computing (${ride.done} of ${ride.total} leaves)`,
      ready: 'ready to sign: call ride',
      paused: 'paused',
      paused_cap: 'paused at the session cap',
      failed: `stopped on an error (${ride.reason})`,
      interrupted: 'interrupted by a restart: call ride to resume it',
      awaiting_payment: `awaiting payment to HOSAKA (${ride.reason})`,
    }
    const words = ride.state === null ? '' : ` A ride to block ${ride.to} is ${said[ride.state]}.`
    return { text: `${result.text}${words}${movedWords}${roamWords}`, data: { ...result.data, ride, operatorMoved, roamDue } }
  }

  /** A verified operator move as orders_waiting and follow_operator show it, with the distance from where the agent stands (from memory). */
  private moveData(m: OperatorMove): { to: string; plane: number; planeName: string; at: number; eventId: string; action: string; distance: string } {
    const there = placeFromHex(m.coordHex)
    return { to: m.coordHex, plane: m.plane, planeName: m.plane === 0 ? 'dataspace' : 'ideaspace', at: m.at, eventId: m.eventId, action: m.action, distance: distanceWords(distanceBetween(this.keeper.place(), there)) }
  }

  // ---- follow_operator (follow.ts) ------------------------------------------

  /**
   * Turn the follow watch on or off, and report where the operator is now:
   * how far, the free gibson beside them to aim for (never their own
   * gibson), and what plan_hop says about getting there within the caps, or
   * that it needs a ride. Marks the operator's newest move as seen. Never
   * moves the agent.
   */
  async followOperator(input: { on?: boolean } = {}): Promise<ToolResult> {
    if (input.on === false) {
      this.follow.setOn(false)
      return { text: 'Follow watch off: your operator\'s moves are no longer watched, and orders_waiting no longer reports them.', data: { on: false } }
    }
    const problem = this.operatorProblem()
    if (problem) throw new Refusal(problem)
    const op = this.operatorOfProfile()
    if (!op) throw new Refusal('Your profile names no operator, so there is nobody to follow. Call identity with operator (your human\'s npub), or have the server started with --operator.')
    if (input.on === true) this.follow.setOn(true)
    const on = this.follow.on
    if (!on) return { text: 'Follow watch off. Call follow_operator with on: true to watch your operator\'s moves and see where they are.', data: { on: false } }
    const watchWords = 'Follow watch on: when your operator moves, orders_waiting reports it and your waker wakes you.'
    // A fresh read of the operator's chain, the same read the watch runs on a move.
    this.follow.refresh()
    await this.follow.resolveNow()
    const latest = this.follow.latest()
    const notes = this.follow.notes().slice(-5).map((n) => n.text)
    if (!latest) {
      const text = [watchWords, 'Your operator\'s position is not known yet: no valid chain of theirs could be read and verified.', ...notes].join('\n')
      return { text, data: { on, operator: nip19.npubEncode(op), position: null, notes } }
    }
    this.follow.acknowledge()
    await this.refreshChain()
    const me = this.keeper.place()
    const there = placeFromHex(latest.coordHex)
    const move = this.moveData(latest)
    const taken = new Set(this.occupants().keys())
    taken.add(there.hex)
    const beside = freeNeighbor(there, me, taken)
    if (!beside) throw new Refusal(`Every gibson beside your operator at ${latest.coordHex} is taken; wait for them to move.`)
    const target = describePlace(beside)
    const besideAlready = beside.hex === me.hex
    const plan = besideAlready ? null : await this.planFrom(me, beside)
    const needsRide = this.routeRefusal(me, placeFromHex(target.hex)) !== null
    const advice = besideAlready
      ? 'You already stand beside your operator: no move is needed.'
      : needsRide
        ? 'Too far to hop: a coordinate that distant is reached by riding the line to the stop nearest it (station, board, ride). Follow your STRATEGY; if you cannot reach them, tell your operator with message_operator.'
        : plan!.data.refused
          ? `Not within your caps: ${plan!.data.refused as string} Follow your STRATEGY; tell your operator with message_operator if you cannot follow.`
          : `Within your caps: hop with target ${target.hex} to stand beside them (one step per hop call; plan_hop says how many remain). Moving is your decision, guided by your STRATEGY.`
    const text = [
      watchWords,
      `Your operator is at ${latest.coordHex} (${move.planeName}), by a ${latest.action} signed ${new Date(latest.at * 1000).toISOString()} (event ${latest.eventId.slice(0, 8)}..., verified on their chain). From you: ${move.distance}.`,
      `Aim for ${target.hex}, the free gibson beside them: never land on your operator's own gibson.`,
      plan ? `plan_hop: ${plan.text}` : '',
      advice,
      ...notes.map((n) => `Note: ${n}`),
    ].filter(Boolean).join('\n')
    return {
      text,
      data: {
        on, operator: nip19.npubEncode(op), position: { ...move, where: describePlace(there) }, beside: target, besideAlready, needsRide,
        plan: plan ? { refused: plan.data.refused, plan: plan.data.plan } : null, notes,
      },
    }
  }

  // ---- roam (roam.ts; arkinox, 2026-10-11) -----------------------------------

  /**
   * Why the agent may not roam now, or null: a ride computing, ready,
   * paused or interrupted needs the head it left from, a move in flight
   * holds the head, and a boarding is waiting for its ride. From memory.
   */
  private roamBusy(): string | null {
    const ride = this.transit.rideState()
    if (ride.state && ride.state !== 'failed') {
      return `Your ride to block ${ride.to} is ${ride.state === 'paused_cap' ? 'paused at the session cap' : ride.state}, and it needs the head it left from: a hop now would make it impossible to sign. Roaming waits until the ride is signed or released.`
    }
    if (this.keeper.moving) return 'Your head is reserved by a move in flight (a hop, a boarding or a ride), so roaming waits until it is done. One key, one mover.'
    if (this.keeper.head()?.name === 'enter-hyperspace') return 'You are boarded on the line, waiting to ride: a hop now would leave the line and waste the boarding. Ride first, or roam from the stop you arrive at.'
    return null
  }

  /**
   * The roam switch, or one roam step. With `on` or `every_minutes`, turns
   * roaming on or off and sets the interval; orders_waiting then reports
   * roamDue once the interval has passed since the last step. With neither,
   * suggests the next destination: one hop away in a random direction,
   * priced and within the caps, never on a person's gibson, preferring cubes
   * not visited lately; and marks the step taken. Never moves the agent.
   */
  async roam(input: { on?: boolean; every_minutes?: number } = {}): Promise<ToolResult> {
    if (input.on !== undefined || input.every_minutes !== undefined) {
      const every = input.every_minutes
      if (every !== undefined && (!Number.isFinite(every) || every < ROAM_MIN_MINUTES || every > ROAM_MAX_MINUTES)) {
        throw new Refusal(`every_minutes must be from ${ROAM_MIN_MINUTES} to ${ROAM_MAX_MINUTES} (a day); got ${every}. Roaming is a stroll every so often, not a patrol.`)
      }
      this.roaming.configure(input.on, every === undefined ? undefined : Math.round(every))
      const on = this.roaming.on
      const dueAt = this.roaming.dueAt()
      const text = on
        ? `Roaming on: every ${this.roaming.everyMinutes} min, orders_waiting reports roamDue and your waker wakes you; then call roam (with no arguments) for a suggested destination, hop there, look, and tell your operator what you saw if it is worth it. The next step is due at ${new Date(dueAt! * 1000).toISOString()}. Call roam now for a step right away.`
        : `Roaming off${input.every_minutes !== undefined ? ` (the interval is kept: every ${this.roaming.everyMinutes} min)` : ''}: orders_waiting no longer reports roamDue. roam with no arguments still suggests a step on request.`
      return { text, data: { on, everyMinutes: this.roaming.everyMinutes, dueAt, lastStepAt: this.roaming.lastStepAt } }
    }

    const busy = this.roamBusy()
    if (busy) throw new Refusal(busy)
    await this.refreshChain()
    const busyNow = this.roamBusy()
    if (busyNow) throw new Refusal(busyNow)
    const status = this.keeper.status()
    if (status === 'dead' || status === 'frozen') throw new Refusal(`${this.keeper.breakWords() ?? 'Your chain cannot be extended.'} Nowhere to roam until your human decides about a respawn.`)

    const from = this.keeper.place()
    const c = this.ceilings()
    const found = searchRoam({
      candidates: this.config.roamCandidates ? this.config.roamCandidates(from, c.hop) : roamCandidates(from, c.hop),
      price: (target) => priceNextStep(from, target, c, this.calibration),
      refusal: (step, target) => this.stepRefusal(step, target),
      // Every person the server knows of nearby, and the operator wherever the follow watch saw them; a profile not read yet is protected.
      taken: new Set(this.occupants().keys()),
      visited: this.roaming.visited(),
    })
    const skippedWords = [
      found.skipped.people ? `${found.skipped.people} on a person's gibson` : '',
      found.skipped.refused ? `${found.skipped.refused} over your caps` : '',
      found.skipped.notOneHop ? `${found.skipped.notOneHop} not one hop away` : '',
      found.skipped.visited ? `${found.skipped.visited} in cubes visited lately` : '',
    ].filter(Boolean).join(', ')
    if (!found.pick) {
      // Nothing fits: the clock restarts anyway, so the waker does not wake the agent for the same answer at every poll.
      this.roaming.markStep([from])
      throw new Refusal(`No roam step fits right now${found.lastRefusal ? `: ${found.lastRefusal}` : '.'} (Passed over: ${skippedWords || 'every candidate'}.) Roaming rests until the next interval${this.roaming.on ? ` (${this.roaming.everyMinutes} min)` : ''}.`)
    }
    const { target, step, fresh } = found.pick
    this.roaming.markStep([from, target])
    const plan = this.describeStep(step, target)
    const where = describePlace(target)
    const nextDue = this.roaming.dueAt()
    const text = [
      `Roam suggestion: ${where.hex} (${where.planeName}, sector ${where.sector}), ${distanceWords(distanceBetween(from, target))}, ${fresh ? 'a cube you have not been to lately' : 'a cube you have been to lately (nothing fresh fits your caps)'}.`,
      `One ${step.kind} of h${step.maxHeight}, about ${step.seconds.toFixed(2)} s here, within your caps; nobody stands on that gibson.${this.keeper.status() === 'none' ? ' You have no chain yet: hop will sign your spawn first.' : ''}`,
      `To go: hop with target ${where.hex}, then look, and tell your operator with message_operator if you saw something worth telling. Moving is your decision: your STRATEGY and your operator's orders come first.`,
      `This counts as your roam step${nextDue ? `; the next is due at ${new Date(nextDue * 1000).toISOString()}` : ''}.`,
    ].join('\n')
    return { text, data: { suggestion: where, plan, fresh, skipped: found.skipped, on: this.roaming.on, everyMinutes: this.roaming.everyMinutes, nextDueAt: nextDue } }
  }

  // ---- visit (arkinox, 2026-10-11) -------------------------------------------
  //
  // "visit a pubkey and leave a message ... hide at their head or spawn cube
  // from anywhere, since looking costs the same as walking." The note goes
  // into the agent's bag in the h12 cube where the person stands, the cube
  // every client scans for free around where it stands, so they see it the
  // next time they look there. The agent does not move.

  /** Leave a note for a person: hide it as a message at their live head's h12 cube, or their spawn cube when they have no chain. */
  async visit(input: { pubkey: string; note: string }): Promise<ToolResult> {
    const who = parsePubkey(String(input.pubkey ?? ''))
    if (!who) throw new Refusal(`pubkey must be an npub, an nprofile or a 64-hex pubkey; got ${JSON.stringify(input.pubkey)}.`)
    if (who === this.pubkey) throw new Refusal('That is your own pubkey. To leave something where you stand, use hide.')
    const note = String(input.note ?? '')
    if (!note.trim()) throw new Refusal('The note is empty: write what you want them to find.')
    if (note.length > MAX_MESSAGE_LENGTH) throw new Refusal(`The note is ${note.length} characters; a hidden message holds at most ${MAX_MESSAGE_LENGTH}. Shorten it.`)
    const npub = nip19.npubEncode(who)
    const operator = this.operatorProblem() ? null : this.operatorOfProfile()
    const forOperator = who === operator
    if (!forOperator) {
      // A note is signed by the agent's key; a stranger who finds it tells it came from a bot, and whose, only by the profile that key published.
      const last = this.dir.readJson<ProfileFile | null>('profile.json', null)
      if (!last || last.accepted.length === 0) {
        throw new Refusal(`${npub} is not your operator, and no relay has accepted your profile yet, so whoever finds the note could not tell it was left by a bot, or whose. Call identity first (it publishes bot: true and names your operator), then visit.`)
      }
    }

    // Where they stand: their chain as every chain read resolves it, asked of the relays with each answer kept, so silence is never taken for "no chain".
    const noHolders = { noteFrom: () => {} } as unknown as Holders
    let answers
    try {
      answers = await askChainEvents(this.relays, noHolders, who)
    } catch (err) {
      throw new Refusal(`Could not ask the relays where ${npub} is: ${err instanceof Error ? err.message : String(err)}. Nothing was hidden.`)
    }
    const verdict = decideSelfCheck(answers, this.relays.canonical)
    if (verdict.status === 'unknown') throw new Refusal(`Cannot tell where ${npub} is: ${causeWords(verdict.cause)}. A note left at a guess could sit where they never look, so nothing was hidden. Try again in a moment.`)
    const chain = verdict.status === 'found' ? buildChain(verdict.events, who) : []
    const status = chainStatus(chain)
    const head = chain.at(-1) ?? null
    const atSpawn = !head || status === 'dead'
    const at = atSpawn ? spawnPlace(who) : placeFromHex(head!.coordHex)
    const whereWords = !head
      ? `${forOperator ? 'Your operator has' : 'They have'} no chain yet, so the note is at their spawn cube: their first spawn puts them on that exact gibson, and they see it as soon as they arrive.`
      : status === 'dead'
        ? 'Their chain is dead, so their next spawn puts them back at their spawn coordinate; the note waits in that cube.'
        : `That is where their newest move (${head.name} ${head.id.slice(0, 8)}..., signed ${new Date(head.createdAt * 1000).toISOString()}) put them.`

    const hidden = await this.hide({ contents: { message: note }, coordinate: at.hex, height: SCAN_MAX_HEIGHT })
    const cube = hidden.data.cube as { base: { x: string; y: string; z: string } }
    const accepted = hidden.data.accepted as string[]
    const place = describePlace(at)
    const text = [
      `Left your note for ${forOperator ? 'your operator ' : ''}${npub} in the h${SCAN_MAX_HEIGHT} cube around ${place.hex} (${place.planeName}, sector ${place.sector}; cube base x ${cube.base.x} y ${cube.base.y} z ${cube.base.z}). ${whereWords}`,
      `How they find it: standing anywhere in that h${SCAN_MAX_HEIGHT} cube, a client opens it with the keys it derives for free (ONOSENDAI's scan, or find), so it shows on their next look there; if they have moved on, it waits in that cube. It is signed by your key (${this.npub}), whose profile says bot: true.`,
      accepted.length ? `Bag ${(hidden.data.bagId as string).slice(0, 8)}... accepted by ${accepted.join(', ')}.` : 'No relay accepted the bag yet; it waits in the outbox.',
      forOperator ? 'Tell your operator with message_operator that something is waiting for them, if your STRATEGY allows.' : 'You did not move.',
    ].join('\n')
    return {
      text,
      data: {
        for: { pubkey: who, npub, operator: forOperator }, at: place, atSpawn, chainStatus: status,
        head: head ? { eventId: head.id, action: head.name, at: head.createdAt } : null,
        bagId: hidden.data.bagId, lookupId: hidden.data.lookupId, cube: hidden.data.cube, entries: hidden.data.entries, accepted, refused: hidden.data.refused,
      },
    }
  }


  inbox(): Promise<ToolResult> {
    return this.operatorChannel.inbox()
  }

  /** The wallet: connected or not, the balance when the wallet tells, today's spend and the limits. Read only; never the connection string. */
  walletStatus(): Promise<ToolResult> {
    return this.wallet.status()
  }

  /** A private NIP-17 DM to the operator, with the agent's own copy. */
  messageOperator(input: { text: string }): Promise<ToolResult> {
    return this.operatorChannel.message(input.text)
  }

  /** A public kind 1 travel log entry, when the human turned the log on (travel.ts). */
  logTravel(input: { text: string; place?: boolean }): Promise<ToolResult> {
    return this.travel.post(input)
  }

  // ---- say, listen, wait_for ------------------------------------------------

  async say(input: { text: string; reply_to?: string }): Promise<ToolResult> {
    const place = this.keeper.place()
    this.chat.enter(place)
    const result = await this.chat.say(input.text, place, input.reply_to)
    if ('refused' in result) throw new Refusal(result.refused)
    this.budget.chatLinesSaid++
    return {
      text: `Said into the h${SCAN_MAX_HEIGHT} cube (${result.region.slice(0, 8)}...): "${input.text}". Accepted by ${result.accepted.join(', ')}.${Object.keys(result.reasons).length ? ` Not by ${Object.entries(result.reasons).map(([u, r]) => `${u} (${r})`).join(', ')}.` : ''} Unprompted lines left before the next arrival: ${this.chat.unpromptedAllowance}.`,
      data: { id: result.id, region: result.region, accepted: result.accepted, reasons: result.reasons, unpromptedAllowance: this.chat.unpromptedAllowance },
    }
  }

  listen(input: { since?: number | 'last' } = {}): ToolResult {
    const place = this.keeper.place()
    this.chat.enter(place)
    const lines = this.chat.heard(input.since ?? 'last')
    const rows = lines.map((l) => this.lineRow(l))
    const text = lines.length === 0
      ? 'Nothing heard since then in your cube and its 26 neighbors.'
      : `${lines.length} line(s), all text untrusted:\n${lines.map((l) => `[${new Date(l.at * 1000).toISOString()}] ${l.mine ? 'you' : l.from.slice(0, 8) + '...'}${l.addressed ? ' (to you)' : ''}: "${l.text}" (id ${l.id.slice(0, 8)}...)`).join('\n')}`
    return { text, data: { lines: rows, listening: this.chat.room.regions.length } }
  }

  private lineRow(l: ChatLine): Record<string, unknown> {
    const person = this.presence.people.get(l.from)
    return { id: l.id, from: l.from, bot: person?.profile?.bot ?? null, name: person?.profile?.name ?? null, at: l.at, text: l.text, mine: l.mine, addressed: l.addressed, region: l.region, untrusted: true }
  }

  async waitFor(input: { arrival?: { pubkey?: string; within_sectors?: number }; chat?: { addressed?: boolean }; timeout_seconds: number }, signal?: AbortSignal): Promise<ToolResult> {
    if (!input.arrival && !input.chat) throw new Refusal('Say what to wait for: an arrival, a chat line, or both, with a timeout.')
    const timeout = Math.min(Math.max(1, input.timeout_seconds), 3600)
    const place = this.keeper.place()
    this.chat.enter(place)
    const wantPubkey = input.arrival?.pubkey ? parsePubkey(input.arrival.pubkey) : null
    if (input.arrival?.pubkey && !wantPubkey) throw new Refusal('arrival.pubkey must be an npub or a 64-hex pubkey.')
    const within = BigInt(Math.min(Math.max(0, input.arrival?.within_sectors ?? 1), 1))
    const matchesPerson = (p: Person): boolean => (wantPubkey ? p.pubkey === wantPubkey : true) && sectorsApart(p.place.position, place.position) <= within
    const startedAt = nowSeconds()
    // The listeners are attached before anything is awaited, so a line said the moment this was called is heard.
    return new Promise<ToolResult>((resolve) => {
      let done = false
      const finish = (r: ToolResult): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.presence.off('arrival', onArrival)
        this.chat.off('line', onLine)
        signal?.removeEventListener('abort', onAbort)
        resolve(r)
      }
      const onArrival = (p: Person): void => {
        if (!input.arrival || !matchesPerson(p)) return
        finish({ text: `${p.pubkey.slice(0, 12)}... arrived ${sectorsApart(p.place.position, place.position)} sector(s) away after ${nowSeconds() - startedAt} s.`, data: { happened: 'arrival', person: { pubkey: p.pubkey, place: describePlace(p.place), action: p.type } } })
      }
      const onLine = (l: ChatLine): void => {
        if (!input.chat || l.mine) return
        if (input.chat.addressed && !l.addressed) return
        finish({ text: `Heard ${l.addressed ? 'a line addressed to you' : 'a line'} from ${l.from.slice(0, 12)}... after ${nowSeconds() - startedAt} s (untrusted): "${l.text}" (id ${l.id.slice(0, 8)}...).`, data: { happened: 'chat', line: this.lineRow(l) } })
      }
      const onAbort = (): void => finish({ text: 'Canceled.', data: { happened: 'canceled' } })
      const timer = setTimeout(() => finish({ text: `Timed out after ${timeout} s: nothing happened.`, data: { happened: 'timeout', waitedSeconds: timeout } }), timeout * 1000)
      this.presence.on('arrival', onArrival)
      this.chat.on('line', onLine)
      signal?.addEventListener('abort', onAbort, { once: true })
      // Then the neighborhood: someone already here counts as arrived, and a fresh look catches what the live subscription missed.
      void this.presence.enter(place.position).then(async () => {
        if (done) return
        if (input.arrival) {
          const present = this.presence.others().find(matchesPerson)
          if (present) { finish({ text: `${present.pubkey.slice(0, 12)}... is already here (${sectorsApart(present.place.position, place.position)} sector(s) away).`, data: { happened: 'arrival', already: true, person: { pubkey: present.pubkey, place: describePlace(present.place) } } }); return }
        }
        const events = await this.relays.query({ ...neighborhoodFilter(place.position), since: startedAt - 60 }).catch(() => [])
        for (const ev of events) this.presence.ingest(ev)
      }).catch(() => {})
    })
  }

  // ---- find -----------------------------------------------------------------

  private async resolveReference(ref: Reference): Promise<NostrEvent | null> {
    try {
      if (ref[0] === 'e') {
        const got = await this.relays.query({ ids: [ref[1]] })
        return got[0] ?? null
      }
      const [kind, pubkey, ...rest] = ref[1].split(':')
      const got = await this.relays.query({ kinds: [Number(kind)], authors: [pubkey], '#d': [rest.join(':')] })
      return got.sort((a, b) => b.created_at - a.created_at)[0] ?? null
    } catch {
      return null
    }
  }

  /** What an opened item is for the report: labels only, never a secret. A key found is held; a chest sealed to the agent or to a held key is opened. */
  private summarize(h: Hidden, foundIn: string): EntrySummary {
    const label = h.type === 'message' ? messagePreview(h.text ?? '', 80) : h.type === 'shard' ? (h.shard?.name ?? 'shard') : h.type === 'key' ? (h.key?.name ?? 'key') : (h.chest?.name ?? 'chest')
    const summary: EntrySummary = {
      type: h.type, eventId: h.eventId, author: h.inner.pubkey, at: { x: h.at.x.toString(), y: h.at.y.toString(), z: h.at.z.toString() }, plane: h.plane, createdAt: h.createdAt, label,
      ...(h.type === 'message' && /\bcashu[AB][A-Za-z0-9_-]+/.test(h.text ?? '') ? { coin: true } : {}),
      ...(h.ref ? { byReference: true } : {}),
      ...(h.shard ? { shard: { unit: h.shard.unit, vertices: h.shard.vertices.length, faces: h.shard.faces.length, extent: h.shard.extent, mode: h.shard.mode } } : {}),
    }
    if (h.shard) this.rememberObject(objectHandle(h.eventId), h.shard)
    if (h.key) {
      this.keys.holdItem({ itemPubkey: h.key.itemPubkey, secretHex: h.key.secretHex, name: h.key.name, about: h.key.about, foundIn, at: nowSeconds() })
      summary.key = { itemPubkey: h.key.itemPubkey, about: h.key.about }
    }
    if (h.chest) {
      const opener = openerFor(h.chest, this.keys.heldItems(), this.pubkey)
      if (!opener) {
        summary.chest = { lock: h.chest.lockPubkey, requires: requiresLabel(h.chest), opened: false }
      } else {
        try {
          const secret = opener.by === 'key' ? opener.key.secretHex : bytesToHex(this.sk)
          const contents = readContents(openWithSecret(h.chest, secret))
          summary.chest = {
            lock: h.chest.lockPubkey, requires: requiresLabel(h.chest), opened: true, openedWith: opener.by === 'key' ? 'held item' : 'own key',
            contents: contents.map((c) => ({
              type: c.body.type,
              label: c.body.type === 'message' ? messagePreview(c.body.text ?? '', 80) : c.body.type === 'shard' ? (c.body.shard?.name ?? 'shard') : c.body.type === 'key' ? (c.body.key?.name ?? 'key') : (c.body.chest?.name ?? 'chest'),
              author: c.event.pubkey, verified: c.verified,
            })),
          }
          for (const c of contents) if (c.body.shard) this.rememberObject(objectHandle(c.id), c.body.shard)
          for (const c of contents) if (c.body.key) this.keys.holdItem({ itemPubkey: c.body.key.itemPubkey, secretHex: c.body.key.secretHex, name: c.body.key.name, about: c.body.key.about, foundIn, at: nowSeconds() })
        } catch (err) {
          summary.chest = { lock: h.chest.lockPubkey, requires: requiresLabel(h.chest), opened: false }
          this.log(`chest ${h.eventId.slice(0, 8)} did not open: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    return summary
  }

  /** Fetch the bags whose lookup ids are these, open each with its key, and note what was found. */
  private async openBags(keysById: Map<string, HeldKey>, plane: Plane): Promise<{ bags: OpenedBag[]; unreadable: string[] }> {
    const ids = [...keysById.keys()]
    const bags: OpenedBag[] = []
    const unreadable: string[] = []
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50)
      const events = await this.relays.query({ kinds: [HIDDEN_KIND], '#d': chunk })
      for (const ev of events) {
        const d = tagValue(ev, 'd')
        const key = d ? keysById.get(d) : undefined
        if (!key) continue
        const regionKey = hexToBytes(key.keyHex)
        const base = { x: BigInt(key.base.x), y: BigInt(key.base.y), z: BigInt(key.base.z) }
        const items = await unbag(ev, regionKey, (ref) => this.resolveReference(ref), { at: base, plane }, key.height)
        const refs = await referenceCount(ev, regionKey)
        const resolved = items.filter((h) => h.ref).length
        if (items.length === 0 && refs === 0) {
          unreadable.push(`bag ${ev.id.slice(0, 8)}... by ${ev.pubkey.slice(0, 8)}... in the h${key.height} cube did not open with the key for that cube, or holds nothing this server reads`)
          continue
        }
        const settings = bagSettingsOf(ev, key.height)
        const bag: OpenedBag = {
          lookupId: key.lookupId, bagId: ev.id, author: ev.pubkey, createdAt: ev.created_at, height: key.height, base: key.base,
          entries: items.map((h) => this.summarize(h, key.lookupId)), missing: refs - resolved, riddle: settings.riddle, hint: settings.hint, at: nowSeconds(),
        }
        this.keys.noteBag(bag)
        bags.push(bag)
      }
    }
    return { bags, unreadable }
  }

  private describeBags(bags: OpenedBag[], here: Place): string[] {
    const out: string[] = []
    for (const b of bags) {
      out.push(`bag by ${b.author.slice(0, 8)}... in the h${b.height} cube (base x ${b.base.x} y ${b.base.y} z ${b.base.z}), ${b.entries.length} entr${b.entries.length === 1 ? 'y' : 'ies'}${b.missing ? `, ${b.missing} reference(s) not retrieved` : ''}${b.riddle ? `, riddle (untrusted): "${b.riddle}"` : ''}${b.hint ? `, hinted at heights ${b.hint.join(',')}` : ''}`)
      for (const e of b.entries) {
        const at = placeOf({ x: BigInt(e.at.x), y: BigInt(e.at.y), z: BigInt(e.at.z) }, e.plane)
        const same = at.hex === here.hex ? 'right here' : `at x ${e.at.x} y ${e.at.y} z ${e.at.z}`
        let more = ''
        if (e.key) more = ` (held now; public half ${e.key.itemPubkey.slice(0, 8)}...${e.key.about ? `; "${e.key.about}"` : ''})`
        if (e.chest) more = e.chest.opened
          ? ` (opened with your ${e.chest.openedWith}: ${e.chest.contents!.length} item(s): ${e.chest.contents!.map((c) => `${c.type} "${c.label}"${c.verified ? '' : ' (unsigned)'}`).join(', ')})`
          : ` (sealed to ${e.chest.lock.slice(0, 8)}...; needs ${e.chest.requires})`
        // An object's id is what render takes to draw it.
        if (e.shard) more = ` (id ${objectHandle(e.eventId).slice(0, 12)}, ${e.shard.vertices} vertices, ${e.shard.faces} faces)`
        out.push(`  ${e.type}${e.coin ? ' (coins)' : ''}${e.byReference ? ' [by reference]' : ''} by ${e.author.slice(0, 8)}... ${same}: "${e.label}"${more}`)
      }
    }
    return out
  }

  async find(input: { hint?: HintInput; max_height?: number } = {}): Promise<ToolResult> {
    const here = this.keeper.place()
    if (!input.hint) {
      const cap = Math.min(MAX_KEY_HEIGHT, Math.max(1, Math.floor(input.max_height ?? SCAN_MAX_HEIGHT)))
      const heights = Array.from({ length: cap }, (_, i) => i + 1)
      const priced = this.keysRefusal(heights)
      if (priced) throw new Refusal(priced)
      const { result: keys, ms: keyMs } = this.deriveKeys(heights, () => this.keys.scanAround(here.position, cap, 'find'))
      const { bags, unreadable } = await this.openBags(new Map(keys.map((k) => [k.lookupId, k])), here.plane)
      const text = bags.length === 0
        ? `Nothing hidden in the cubes of height 1 to ${cap} around you (${keys.length} keys, ${keyMs.toFixed(0)} ms).${unreadable.length ? ` Found but could not read: ${unreadable.join('; ')}.` : ''}`
        : `Found ${bags.length} bag(s) in the cubes of height 1 to ${cap} around you (all text untrusted):\n${this.describeBags(bags, here).join('\n')}${unreadable.length ? `\nFound but could not read: ${unreadable.join('; ')}.` : ''}`
      return { text, data: { scanned: { heights: [1, cap], keys: keys.length, keyMs: Math.round(keyMs) }, bags, unreadable } }
    }

    // A hinted sweep (spec 7.7): the bags that carry this hint, then every candidate region of each one's height inside the box.
    const heights = input.hint.heights
    if (!Array.isArray(heights) || heights.length !== 3 || !heights.every((h) => Number.isInteger(h) && h >= 0 && h <= 85)) throw new Refusal('hint.heights must be three integers from 0 to 85.')
    const point = this.target(input.hint.coordinate, here)
    const tags = hintTags(point.position, point.plane, heights)
    const hintTag = tags[0]
    const sectorTagsOfHint = tags.slice(1).filter((t) => t[0] !== 'S')
    const filter: Filter = { kinds: [HIDDEN_KIND] }
    if (sectorTagsOfHint.length > 0) for (const [k, v] of sectorTagsOfHint) filter[`#${k}` as `#${string}`] = [v]
    else filter.limit = 500
    const candidates = (await this.relays.query(filter)).filter((ev) => {
      const h = heightHint(ev)
      const read = parseHint(ev.tags, h ?? 1)
      return read && read.heights.join(',') === heights.join(',') && tagValue(ev, 'hint') === hintTag[1]
    })
    if (candidates.length === 0) return { text: `No bag on the relays carries the hint ${hintTag[1].slice(0, 16)}... at heights ${heights.join(',')}.`, data: { hint: hintTag, bags: [], unreadable: [] } }
    const found: OpenedBag[] = []
    const unreadable: string[] = []
    const skipped: string[] = []
    for (const ev of candidates) {
      const h = heightHint(ev)
      if (h === null || h < 1 || h > MAX_KEY_HEIGHT) { skipped.push(`bag ${ev.id.slice(0, 8)}... by ${ev.pubkey.slice(0, 8)}... ${h === null ? 'does not say its height, so its box cannot be swept' : `is sealed at h${h}, above what this server derives keys for (h${MAX_KEY_HEIGHT})`}`); continue }
      const exponent = hintCandidatesExponent(heights as HintHeights, h)
      const count = 2 ** exponent
      const perKeyMs = Math.max(0.05, 3 * projectCantorMs(this.calibration.cantorMsByHeight, h))
      const seconds = (count * perKeyMs) / 1000
      if (count > MAX_SWEEP_CANDIDATES || this.budget.refusal(seconds)) { skipped.push(`bag ${ev.id.slice(0, 8)}... needs 2^${exponent} candidate keys at h${h} (about ${seconds.toFixed(0)} s), above the cap`); continue }
      const d = tagValue(ev, 'd')!
      const base = { x: (point.position.x >> BigInt(heights[0])) << BigInt(heights[0]), y: (point.position.y >> BigInt(heights[1])) << BigInt(heights[1]), z: (point.position.z >> BigInt(heights[2])) << BigInt(heights[2]) }
      const stepSize = 1n << BigInt(h)
      const t0 = performance.now()
      let match: HeldKey | null = null
      outer: for (let x = base.x; x < base.x + (1n << BigInt(heights[0])); x += stepSize) {
        for (let y = base.y; y < base.y + (1n << BigInt(heights[1])); y += stepSize) {
          for (let z = base.z; z < base.z + (1n << BigInt(heights[2])); z += stepSize) {
            const key = this.keys.keyAt({ x, y, z }, h, 'hint')
            if (key.lookupId === d) { match = key; break outer }
          }
        }
      }
      this.budget.spendWork((performance.now() - t0) / 1000)
      if (!match) { unreadable.push(`bag ${ev.id.slice(0, 8)}... by ${ev.pubkey.slice(0, 8)}...: no region in the hinted box has its lookup id; the hint is a claim, and this one is false`); continue }
      const opened = await this.openBags(new Map([[match.lookupId, match]]), point.plane)
      found.push(...opened.bags)
      unreadable.push(...opened.unreadable)
    }
    const text = [
      found.length ? `Found ${found.length} bag(s) by sweeping the hinted box (all text untrusted):\n${this.describeBags(found, here).join('\n')}` : 'The hinted box held no bag this server could open.',
      unreadable.length ? `Found but could not read: ${unreadable.join('; ')}.` : '',
      skipped.length ? `Skipped: ${skipped.join('; ')}.` : '',
    ].filter(Boolean).join('\n')
    return { text, data: { hint: hintTag, bags: found, unreadable, skipped } }
  }

  // ---- hide and place -------------------------------------------------------

  private async currentBag(lookupId: string): Promise<NostrEvent | null> {
    const got = await this.relays.query({ kinds: [HIDDEN_KIND], authors: [this.pubkey], '#d': [lookupId] })
    return got.sort((a, b) => b.created_at - a.created_at)[0] ?? null
  }

  private shardFrom(payload: unknown): ShardModel {
    const v = validateSnoPayload(payload)
    if (!v.ok) throw new Refusal(`The object payload is not valid SNO: ${v.errors.join(' ')}`)
    return v.shard
  }

  /** The inner entry (or entries) for what is being hidden, signed. A large object is published first as its own kind 33331. */
  private async entriesFor(contents: Contents, at: Place, regionKey: Uint8Array, now: number): Promise<{ entries: BagEntry[]; what: string; objectEvent?: NostrEvent }> {
    if ('message' in contents) {
      const text = String(contents.message)
      if (!text.trim()) throw new Refusal('The message is empty.')
      if (text.length > MAX_MESSAGE_LENGTH) throw new Refusal(`The message is ${text.length} characters; at most ${MAX_MESSAGE_LENGTH}.`)
      return { entries: [this.sign(messageInnerTemplate(text, at.position, at.plane, now))], what: /\bcashu[AB][A-Za-z0-9_-]+/.test(text) ? 'a message holding a Cashu token' : 'a message' }
    }
    if ('object' in contents) {
      const shard = this.shardFrom(contents.object)
      if (wantsReference(shard)) {
        const d = randomBytes(16).toString('hex')
        const objectEvent = this.sign(await objectTemplate(shard, regionKey, d, now))
        const result = await this.relays.publish(objectEvent)
        if (!result.ok) throw new Refusal(`The object's own event (kind ${OBJECT_KIND}) was not accepted by any relay: ${result.reason}. Each relay said: ${Object.entries(result.reasons).map(([u, r]) => `${u}: ${r}`).join('; ')}.`)
        return { entries: [referenceTo(objectEvent, at.position, at.plane, result.accepted[0] ?? '')], what: `an object by reference (${shard.vertices.length} vertices)`, objectEvent }
      }
      return { entries: [this.sign(shardInnerTemplate(shard, at.position, at.plane, now))], what: `an object (${shard.vertices.length} vertices, inline)` }
    }
    if ('key' in contents) {
      const key = forgeKey(String(contents.key.name ?? 'key').slice(0, MAX_ITEM_NAME), contents.key.about ?? '')
      return { entries: [this.sign(keyInnerTemplate(key, at.position, at.plane, now))], what: `a key item "${key.name}" (public half ${key.itemPubkey.slice(0, 8)}...)` }
    }
    if ('chest' in contents) {
      const lock = parsePubkey(String(contents.chest.lock))
      if (!lock) throw new Refusal('chest.lock must be an npub, a 64-hex pubkey, or a key item\'s public half.')
      const inner: BagEntry[] = []
      for (const e of contents.chest.entries ?? []) {
        if ('message' in e) inner.push(this.sign(messageInnerTemplate(String(e.message), at.position, at.plane, now)))
        else if ('object' in e) inner.push(this.sign(shardInnerTemplate(this.shardFrom(e.object), at.position, at.plane, now)))
      }
      if (inner.length === 0) throw new Refusal('A chest needs at least one entry: a message or an object.')
      let sealed
      try { sealed = sealEntries(inner, lock) } catch (err) { throw new Refusal(err instanceof Error ? err.message : String(err)) }
      const chest = { name: String(contents.chest.name ?? 'chest').slice(0, MAX_ITEM_NAME), lockPubkey: lock, senderPubkey: sealed.senderPubkey, requires: (contents.chest.requires ?? '').slice(0, MAX_ITEM_NAME), payload: sealed.payload }
      return { entries: [this.sign(chestInnerTemplate(chest, at.position, at.plane, now))], what: `a chest "${chest.name}" sealed to ${lock.slice(0, 8)}... with ${inner.length} entr${inner.length === 1 ? 'y' : 'ies'}` }
    }
    throw new Refusal('contents must be one of: { message }, { object }, { key: { name } }, { chest: { name, lock, entries } }.')
  }

  /** The agent's bag in the cube of `height` at `at`, read before it is written, with the key priced and spent. */
  private async bagAt(at: Place, height: number): Promise<{ key: HeldKey; keyMs: number; regionKey: Uint8Array; current: NostrEvent | null; carried: BagEntry[] }> {
    if (!Number.isInteger(height) || height < 1 || height > MAX_KEY_HEIGHT) throw new Refusal(`height must be an integer from 1 to ${MAX_KEY_HEIGHT} (a bag's region is at least height 1, spec 7.6; above h${MAX_KEY_HEIGHT} a key costs more than a second).`)
    const priced = this.keysRefusal([height])
    if (priced) throw new Refusal(priced)
    const { result: key, ms: keyMs } = this.deriveKeys([height], () => this.keys.keyAt(at.position, height, 'hide'))
    const regionKey = hexToBytes(key.keyHex)
    // One bag per author per region: read before write, never replace.
    const current = await this.currentBag(key.lookupId)
    let carried: BagEntry[] = []
    if (current) {
      carried = await bagEntries(current, regionKey)
      if (carried.length === 0 && (await referenceCount(current, regionKey)) === 0) {
        const opens = (await unbag(current, regionKey, undefined, undefined, height)).length > 0
        if (!opens) throw new Refusal(`You already have a bag in that cube (${current.id.slice(0, 8)}...) and it does not open with the key derived now, so replacing it would destroy what is there. Nothing was published.`)
      }
    }
    return { key, keyMs, regionKey, current, carried }
  }

  async hide(input: { contents: Contents; coordinate: CoordinateInput; height: number; hint_heights?: [number, number, number]; riddle?: string }): Promise<ToolResult> {
    const here = this.keeper.place()
    const at = this.target(input.coordinate, here)
    const { key, keyMs, regionKey, current, carried } = await this.bagAt(at, input.height)
    const height = input.height
    const now = nowSeconds()
    const { entries, what, objectEvent } = await this.entriesFor(input.contents, at, regionKey, now)
    const have = new Set(carried.map(entryKey))
    const merged = [...carried, ...entries.filter((e) => !have.has(entryKey(e)))]
    const currentSettings = current ? bagSettingsOf(current, height) : null
    const hint = input.hint_heights ?? currentSettings?.hint ?? null
    if (hint && !hintFits(hint, height)) throw new Refusal(`hint_heights ${hint.join(',')} cannot contain a height ${height} region: each must be from ${height} to 85.`)
    const riddle = (input.riddle ?? currentSettings?.riddle ?? '').slice(0, MAX_RIDDLE_LENGTH)
    const createdAt = Math.max(now, (current?.created_at ?? 0) + 1)
    const template = await bagTemplate(merged, regionKey, key.lookupId, height, createdAt, HIDDEN_KIND, { heightTag: true, hint, riddle }, { at: at.position, plane: at.plane })
    const bag = this.sign(template)
    const entry = this.outbox.add(bag)
    const result = await this.outbox.send(entry)
    const opened = await unbag(bag, regionKey, (ref) => this.resolveReference(ref), { at: at.position, plane: at.plane }, height)
    const refs = merged.filter(isReference).length
    const summary: OpenedBag = {
      lookupId: key.lookupId, bagId: bag.id, author: this.pubkey, createdAt, height, base: key.base,
      entries: opened.map((h) => this.summarize(h, key.lookupId)), missing: refs - opened.filter((h) => h.ref).length, riddle, hint, at: now,
    }
    this.keys.noteBag(summary)
    const accepted = entry.accepted
    const refused = entry.refused ?? {}
    const text = [
      `Hid ${what} in the h${height} cube at base x ${key.base.x} y ${key.base.y} z ${key.base.z} (lookup id ${key.lookupId.slice(0, 12)}...). The bag ${bag.id.slice(0, 8)}... now holds ${merged.length} entr${merged.length === 1 ? 'y' : 'ies'}${current ? ` (${carried.length} carried forward from ${current.id.slice(0, 8)}...)` : ''}. Key cost ${keyMs.toFixed(0)} ms.`,
      accepted.length ? `Accepted by ${accepted.join(', ')}.` : `No relay accepted the bag${result.ok ? '' : `: ${result.reason}`}. It waits in the outbox.`,
      Object.keys(refused).length ? `Refused by ${Object.entries(refused).map(([u, r]) => `${u}: ${r}`).join('; ')} (verbatim; a refusal is not retried).` : '',
      hint ? `Hinted at heights ${hint.join(',')}${riddle ? `, riddle "${riddle}"` : ''}.` : 'No hint: only someone who derives this cube\'s key will find it.',
    ].filter(Boolean).join('\n')
    return { text, data: { bagId: bag.id, lookupId: key.lookupId, cube: { height, base: key.base, plane: at.plane }, entries: merged.length, carried: carried.length, keyMs: Math.round(keyMs), accepted, refused, hint, riddle, objectEventId: objectEvent?.id ?? null } }
  }

  async place(input: { object?: unknown; address?: string; coordinate: CoordinateInput; height: number }): Promise<ToolResult> {
    if (input.object !== undefined) {
      const v = validateSnoPayload(input.object)
      if (!v.ok) throw new Refusal(`Not placed: the payload is not valid SNO. ${v.errors.join(' ')}`)
      return this.hide({ contents: { object: input.object }, coordinate: input.coordinate, height: input.height })
    }
    if (input.address) {
      const { address, object } = await this.publicObject(input.address)
      if (object.tags.some((t) => t[0] === 'encrypted')) throw new Refusal('That object is sealed to a place of its own; it cannot be placed elsewhere by reference. Place its payload instead.')
      const check = validateSnoPayload(JSON.parse(object.content || 'null'))
      if (!check.ok) throw new Refusal(`The object at ${address} is not valid SNO: ${check.errors.join(' ')}`)
      const here = this.keeper.place()
      const at = this.target(input.coordinate, here)
      // Placing another author's public object is a placement (DECK-0003 3.2): a reference entry, carried in the bag.
      return this.hideReference(referenceTo(object, at.position, at.plane, this.relays.canonical), at, input.height, `object "${check.shard.name}" by ${object.pubkey.slice(0, 8)}... (public, by reference)`)
    }
    throw new Refusal('Give either an object payload or the address of a published kind 33331 object.')
  }

  /** The newest event at a kind 33331 address ("33331:<pubkey>:<d>" or its naddr) on the configured relays. */
  private async publicObject(given: string): Promise<{ address: string; object: NostrEvent }> {
    let address = given.trim()
    if (/^naddr1/i.test(address)) {
      try {
        const decoded = nip19.decode(address.toLowerCase())
        if (decoded.type !== 'naddr') throw new Error('not an naddr')
        address = `${decoded.data.kind}:${decoded.data.pubkey}:${decoded.data.identifier}`
      } catch {
        throw new Refusal('address must be an naddr or "33331:<pubkey>:<d>".')
      }
    }
    const m = /^33331:([0-9a-f]{64}):(.*)$/.exec(address)
    if (!m) throw new Refusal('address must name a kind 33331 object: "33331:<pubkey hex>:<d>" or its naddr.')
    const ref: Reference = ['a', address, '', '']
    const object = await this.resolveReference(ref)
    if (!object) throw new Refusal(`No event at ${address} on the configured relays.`)
    return { address, object }
  }

  /** Hide a reference entry in the agent's bag at a cube: the same read-before-write as hide. */
  private async hideReference(ref: Reference, at: Place, height: number, what: string): Promise<ToolResult> {
    const { key, keyMs, regionKey, current, carried } = await this.bagAt(at, height)
    const now = nowSeconds()
    const have = new Set(carried.map(entryKey))
    const merged = have.has(entryKey(ref)) ? carried : [...carried, ref]
    const settings = current ? bagSettingsOf(current, height) : { heightTag: true, hint: null, riddle: '' }
    const createdAt = Math.max(now, (current?.created_at ?? 0) + 1)
    const bag = this.sign(await bagTemplate(merged, regionKey, key.lookupId, height, createdAt, HIDDEN_KIND, { heightTag: true, hint: settings.hint, riddle: settings.riddle }, { at: at.position, plane: at.plane }))
    const entry = this.outbox.add(bag)
    const result = await this.outbox.send(entry)
    const opened = await unbag(bag, regionKey, (r) => this.resolveReference(r), { at: at.position, plane: at.plane }, height)
    this.keys.noteBag({ lookupId: key.lookupId, bagId: bag.id, author: this.pubkey, createdAt, height, base: key.base, entries: opened.map((h) => this.summarize(h, key.lookupId)), missing: merged.filter(isReference).length - opened.filter((h) => h.ref).length, riddle: settings.riddle, hint: settings.hint, at: now })
    const text = `Placed ${what} in the h${height} cube at base x ${key.base.x} y ${key.base.y} z ${key.base.z}; bag ${bag.id.slice(0, 8)}... holds ${merged.length} entr${merged.length === 1 ? 'y' : 'ies'}. Key cost ${keyMs.toFixed(0)} ms. ${entry.accepted.length ? `Accepted by ${entry.accepted.join(', ')}.` : `No relay accepted it${result.ok ? '' : `: ${result.reason}`}.`}${entry.refused ? ` Refused by ${Object.entries(entry.refused).map(([u, r]) => `${u}: ${r}`).join('; ')}.` : ''}`
    return { text, data: { bagId: bag.id, lookupId: key.lookupId, cube: { height, base: key.base, plane: at.plane }, entries: merged.length, keyMs: Math.round(keyMs), accepted: entry.accepted, refused: entry.refused ?? {} } }
  }

  // ---- render -----------------------------------------------------------------

  private rememberObject(id: string, shard: ShardModel): void {
    this.objectsSeen.delete(id)
    this.objectsSeen.set(id, shard)
    while (this.objectsSeen.size > OBJECTS_REMEMBERED) this.objectsSeen.delete(this.objectsSeen.keys().next().value!)
  }

  /**
   * A picture of an object, so an agent sees what it built (agents plan A3,
   * ruling D12 B; arkinox, 2026-10-11): a payload it is about to place, an
   * object it opened this session by the id find lists, or a public kind
   * 33331 by its address. Drawn on this machine's CPU (render.ts); nothing is
   * signed or published, and only an address asks a relay anything.
   */
  async render(input: { object?: unknown; id?: string; address?: string; view?: NamedView; yaw?: number; pitch?: number; size?: number }): Promise<ToolResult> {
    const given = [input.object, input.id, input.address].filter((x) => x !== undefined).length
    if (given !== 1) throw new Refusal('Give exactly one of: object (an SNO payload), id (an object find or look listed), or address (a public kind 33331).')
    let shard: ShardModel
    let source: string
    if (input.object !== undefined) {
      let raw = input.object
      // A payload sent as a JSON string is read as the object it spells.
      if (typeof raw === 'string') {
        try { raw = JSON.parse(raw) } catch { throw new Refusal('object is a string that is not JSON; give the SNO payload as an object.') }
      }
      const v = validateSnoPayload(raw)
      if (!v.ok) throw new Refusal(`Not drawn: the payload is not valid SNO. ${v.errors.join(' ')}`)
      shard = v.shard
      source = 'payload'
    } else if (input.id !== undefined) {
      const want = input.id.trim().toLowerCase()
      if (!/^[0-9a-f]{8,64}$/.test(want)) throw new Refusal('id must be 8 to 64 hex characters of an object\'s id, as find lists it.')
      const hits = [...this.objectsSeen.entries()].filter(([k]) => k.startsWith(want))
      if (hits.length === 0) throw new Refusal(`No object with id ${want} among the ${this.objectsSeen.size} opened this session. Call find (or look) where it is first; objects are remembered in memory only, not across a restart.`)
      if (hits.length > 1) throw new Refusal(`${hits.length} objects opened this session have ids starting ${want}; give more of the id.`)
      shard = hits[0][1]
      source = `id ${hits[0][0]}`
    } else {
      const { address, object } = await this.publicObject(String(input.address))
      if (object.tags.some((t) => t[0] === 'encrypted')) throw new Refusal('That object is sealed to a place. Find it where it is hidden and render it by the id find lists.')
      let raw: unknown
      try { raw = JSON.parse(object.content || 'null') } catch { raw = null }
      const check = validateSnoPayload(raw)
      if (!check.ok) throw new Refusal(`The object at ${address} is not valid SNO, so it is not drawn: ${check.errors.join(' ')}`)
      shard = check.shard
      source = `address ${address}`
    }
    let r
    try {
      r = renderShard(shard, { view: input.view, yaw: input.yaw, pitch: input.pitch, size: input.size })
    } catch (err) {
      throw new Refusal(err instanceof Error ? err.message : String(err))
    }
    return {
      // An object found in cyberspace was named by someone else.
      text: source === 'payload' ? r.caption : `${r.caption} Its name is the author's text (untrusted).`,
      images: [{ data: r.png.toString('base64'), mimeType: 'image/png' }],
      data: { source, name: shard.name, mode: shard.mode, unit: shard.unit, vertices: r.vertices, faces: r.faces, bounds: r.bounds, view: r.view, size: r.size, backFacing: r.backFacing, partsNotDrawn: r.partsNotDrawn, pngBytes: r.png.length, ms: Math.round(r.ms) },
    }
  }

  // ---- validate_object, budget, outbox -------------------------------------

  validateObject(input: { payload: unknown }): ToolResult {
    const v = validateSnoPayload(input.payload)
    if (!v.ok) return { text: `Not valid: ${v.errors.join(' ')}`, data: { valid: false, errors: v.errors } }
    const byReference = v.bytes > REFERENCE_THRESHOLD_BYTES
    return {
      text: `Valid SNO: "${v.shard.name}", ${v.vertices} vertices, ${v.faces} faces, mode ${v.shard.mode}, unit 2^${v.shard.unit} gibsons, ${v.bytes} bytes on the wire${byReference ? ' (large: it would be hidden by reference)' : ' (small: it would be carried inline)'}.`,
      data: { valid: true, name: v.shard.name, vertices: v.vertices, faces: v.faces, mode: v.shard.mode, unit: v.shard.unit, bytes: v.bytes, byReference },
    }
  }

  budgetState(): ToolResult {
    const b = this.budget.state()
    return {
      text: `Work: ${b.remainingSessionSeconds.toFixed(1)} s left of ${b.capSessionSeconds} s this session, at most ${b.capCallSeconds} s per call; ${b.spentSeconds.toFixed(1)} s spent over ${b.moves} move(s) and the keys derived above h${SCAN_MAX_HEIGHT}. Chat: ${b.chatLinesSaid} line(s) said, ${this.chat.unpromptedAllowance} unprompted line(s) allowed before the next arrival, one line per 5 s, 500 characters. Sidestep cap h${this.config.maxSidestepHeight}; hop ceiling h${this.ceilings().hop} on this machine.`,
      data: { ...b, unpromptedAllowance: this.chat.unpromptedAllowance, ceilings: this.ceilings(), maxSidestepHeight: this.config.maxSidestepHeight },
    }
  }

  outboxState(): ToolResult {
    const s = this.outbox.state()
    const row = (e: typeof s.pending[number]): Record<string, unknown> => ({ id: e.event.id, kind: e.event.kind, action: tagValue(e.event, 'A') ?? null, signedAt: e.signedAt, accepted: e.accepted, refused: e.refused ?? {}, attempts: e.attempts, lastError: e.lastError ?? null, dropped: e.dropped ?? null })
    const text = [
      s.pending.length ? `${s.pending.length} event(s) not yet on the canonical relay (${this.relays.canonical})${s.nextRetryMs !== null ? `, next retry in about ${Math.round(s.nextRetryMs / 1000)} s` : ''}:\n${s.pending.map((e) => `  ${e.event.id.slice(0, 8)}... kind ${e.event.kind}${tagValue(e.event, 'A') ? ` ${tagValue(e.event, 'A')}` : ''}, accepted by ${e.accepted.length ? e.accepted.join(', ') : 'nobody yet'}, ${e.attempts} attempt(s)${e.lastError ? `, last: ${e.lastError}` : ''}`).join('\n')}` : 'Nothing pending: every signed event is on the canonical relay or was refused.',
      s.refused.length ? `Refused (verbatim, not retried):\n${s.refused.map((e) => `  ${e.event.id.slice(0, 8)}... kind ${e.event.kind}: ${Object.entries(e.refused ?? {}).map(([u, r]) => `${u}: ${r}`).join('; ')}`).join('\n')}` : '',
      s.dropped.length ? `Dropped:\n${s.dropped.map((e) => `  ${e.event.id.slice(0, 8)}...: ${e.dropped}`).join('\n')}` : '',
    ].filter(Boolean).join('\n')
    return { text, data: { pending: s.pending.map(row), refused: s.refused.map(row), dropped: s.dropped.map(row), nextRetryMs: s.nextRetryMs, canonical: this.relays.canonical } }
  }

  /** Where the agent stands right now, without asking the relays. */
  here(): Place {
    return this.keeper.place()
  }

  /** Stop listening, close the sockets, release the lock. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    // A ride computing in the background ends first, its finished leaves flushed to disk (arkinox, 2026-10-11).
    await this.transit.stop()
    this.wallet.stop()
    this.outbox.stop()
    this.follow.stop()
    this.operatorChannel.stop()
    this.chat.stop()
    this.presence.stop()
    this.relays.close()
    this.release()
  }
}
