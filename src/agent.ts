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
import { v2 as nip44 } from 'nostr-tools/nip44'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { normalizeURL } from 'nostr-tools/utils'
import { toPayload, type ShardModel } from 'sno-core/shards'
import { Budget } from './budget.js'
import { ACTION_KIND, chainTemplateProblem, hopTemplate, sidestepTemplate, spawnTemplate } from './chain/builder.js'
import { findDivergence } from './chain/divergence.js'
import { CHAIN_RULES_REVISION, buildChain, chainStatus, newestSpawn, type ActionEvent } from './chain/events.js'
import { Holders } from './chain/holders.js'
import { ChainKeeper } from './chain/keeper.js'
import { askChainEvents, parsePubkey } from './chain/resolve.js'
import { causeWords, decideSelfCheck } from './chain/selfCheck.js'
import { AVATAR_KIND, MAX_AVATAR_BYTES, avatarPrice, avatarSeconds, avatarTemplate, nonceTagged, paidShard, verifyAvatarWork } from './avatar.js'
import { avatarThreads, mineAvatar } from './avatarMine.js'
import { Chat, type ChatLine } from './chat.js'
import {
  HIDDEN_KIND, MAX_ABOUT, MAX_ITEM_NAME, MAX_MESSAGE_LENGTH, MAX_RIDDLE_LENGTH, OBJECT_KIND, REFERENCE_THRESHOLD_BYTES, bagSettingsOf, bagTemplate, chestInnerTemplate, heightHint, isReference,
  itemLineage, keyInnerTemplate, messageInnerTemplate, messagePreview, objectTemplate, referenceCount, referenceTo, shardInnerTemplate, unbag, wantsReference, entryKey,
  type BagEntry, type Hidden, type HiddenType, type KeyItem, type Reference,
} from './hidden/bags.js'
import { MAX_COMMENT_LENGTH, itemKind, sealedComment, type CommentParent, type CommentSubject } from './hidden/comments.js'
import { forgeKey, openWithSecret, openerFor, readContents, requiresLabel, sealEntries, type ChestEntry } from './hidden/chests.js'
import { CASHU_TOKEN, chestStatus, contentLine, contentRow, handle, itemRow, placeWords, purposeOf, takenRow, type ContentRow } from './items.js'
import { hintFits, hintTags, parseHint, hintCandidatesExponent, type HintHeights } from './hidden/hint.js'
import { lookReport, type ChainFacts } from './look.js'
import { bytesToHex, hexToBytes, nowSeconds, signEvent, tagValue, type EventTemplate, type NostrEvent } from './nostr/event.js'
import { Outbox, type GuardVerdict } from './nostr/outbox.js'
import { unwrapMessage, wrapMessage, wrapReaction } from './nostr/dm.js'
import { mergeAnswers } from './nostr/relayOutcome.js'
import { DEFAULT_RELAY, GENERAL_RELAYS, Relays, normalizeRelay, type PublishResult } from './nostr/relays.js'
import { OperatorWatch, type OperatorMove } from './follow.js'
import { ORDERS_POLL_MS, OperatorChannel } from './operator.js'
import { Presence, neighborhoodFilter, sectorsApart, type Person } from './presence.js'
import { ROAM_MAX_MINUTES, ROAM_MIN_MINUTES, Roam, roamCandidates, searchRoam } from './roam.js'
import { profileTemplate, type ProfileFields, MAX_PICTURE_URL, pictureUrl, publishedFields } from './profile.js'
import { objectHandle, renderShard, type NamedView } from './render.js'
import { validateSnoPayload } from './sno.js'
import { DEFAULT_PUBLISH_PER_DAY, MAX_ALT_LENGTH, MAX_NAME_LENGTH, dProblem, newObjectId, objectPointers, publicObjectTemplate } from './publicObject.js'
import { hopCeiling, loadOrMeasure, projectCantorMs, type Calibration } from './space/calibration.js'
import { describePlace, distanceBetween, distanceWords, parseCoordinate, placeFromHex, placeOf, spawnPlace, type CoordinateInput, type Place } from './space/coords.js'
import { apartOnBestAxis, nearestClear, overlapping, spacingFor, type Body } from './space/personalSpace.js'
import { AvatarSizes } from './avatarSizes.js'
import { planSummary, priceNextStep, type Ceilings, type PricedStep } from './space/plan.js'
import { KeyStore, MAX_COMPUTE_HEIGHT, SCAN_MAX_HEIGHT, SCAN_MIN_HEIGHT, type EntrySummary, type HeldItem, type HeldKey, type ItemPlace, type OpenedBag, type SeenChest } from './space/regionKeys.js'
import { StateDir } from './state/dir.js'
import { Refusal, type ToolResult } from './tool.js'
import { Transit } from './transit.js'
import type { Secret } from './nwc.js'
import { DEFAULT_MAX_DAILY_SATS, DEFAULT_MAX_PAYMENT_SATS, Wallet } from './wallet.js'
import { Placements } from './placed.js'
import { DEFAULT_TRAVEL_PER_DAY, TravelLog, repeatsPrivate, type TravelLogSettings } from './travel.js'

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
  /** Tests: how long station waits for HOSAKA's ride quote, in ms. */
  hosakaQuoteWaitMs?: number
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
  /** Least minutes between two wakes for strangers' chat lines that address the agent, in total and per speaker (arkinox, 2026-10-11). */
  chatWakeMinutes?: number
  /** Tests: threads an avatar is mined on. */
  avatarThreads?: number
  /** The most public objects publish_object may publish in any 24 hours (default 20). */
  publishMaxPerDay?: number
  /** How often the server checks for new operator orders on its own, in ms (default 15 s; 0 turns the poll off, for tests). */
  ordersPollMs?: number
  /** Tests: how long a failed 👀 waits before its one retry. */
  reactionRetryMs?: number
}

/** Where publish_object counts what it published, so the daily limit survives a restart. */
const PUBLISHED_FILE = 'published.json'
interface PublishedFile { posts: number[] }
const DAY_SECONDS = 24 * 60 * 60

/** The highest cube a key is derived for on request (hide, find, look): a key at h16 is about a second. */
export const MAX_KEY_HEIGHT = 16
/** How long a ride's arrival waits for the relays to say who stands at the stop. */
const FIXED_POINT_LOOK_MS = 2000
/** The most candidate regions a hinted sweep will try. */
const MAX_SWEEP_CANDIDATES = 1 << 16
/** The objects opened this session that render can draw by id; the oldest is forgotten past this. */
const OBJECTS_REMEMBERED = 64

/** A person the agent's avatar must not overlap (space/personalSpace.ts). */
interface Occupant extends Body {
  pubkey: string
  /** How the refusal names them. */
  words: string
  /** Their profile has not been read: protected until it says bot. */
  unknown: boolean
}

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
  | { chest: { name: string; lock: string; requires?: string; entries: ChestContentInput[] } }

/**
 * One thing to seal in a chest (B1 3.1): a message (which may hold a Cashu
 * token: a coin), an SNO object, a new item forged into it (chaining: the
 * agent holds it too), or a copy of an item the agent holds, by its name or
 * public key.
 */
export type ChestContentInput = { message: string } | { object: unknown } | { key: { name: string; about?: string } } | { item: string }

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
  /** How far each nearby person's avatar reaches, read in the background (avatarSizes.ts). */
  readonly avatars: AvatarSizes
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
  /** What the agent placed: listing it, taking it down, moving it (placed.ts). */
  readonly placements: Placements
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
        // A deletion of one of the agent's bags that a relay took on a retry counts as done from then on (placed.ts).
        if (event.kind === 5) {
          for (const t of event.tags) {
            const m = t[0] === 'a' ? /^33330:([0-9a-f]{64}):(.+)$/.exec(t[1] ?? '') : null
            if (m && m[1] === this.pubkey) this.keys.noteOwnDeletion(m[2], event.created_at, true)
          }
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
    }, { manifestUrl: config.manifestUrl, fetch: config.lineFetch, threads: config.rideThreads, now: config.rideClock, hosakaUrl: config.hosakaUrl, hosakaFetch: config.hosakaFetch, hosakaPollMs: config.hosakaPollMs, hosakaQuoteWaitMs: config.hosakaQuoteWaitMs })
    this.chat = new Chat(dir, this.relays, this.keys, {
      pubkey: this.pubkey, name: () => this.name, sign: (t) => this.sign(t), log: this.log,
      // The same operator DMs answer to: the one the profile names, unless the human configured another.
      operator: () => (this.operatorProblem() ? null : this.operatorOfProfile()),
      wakeMinutes: config.chatWakeMinutes,
    })
    this.presence = new Presence(this.relays, this.pubkey, this.log)
    this.presence.on('arrival', () => this.chat.arrival())
    this.avatars = new AvatarSizes(this.relays, this.log)
    // Someone arrives: their avatar is read now, so its size is known before the agent plans a landing near them.
    this.presence.on('arrival', (p: Person) => this.avatars.want([p.pubkey]))
    this.operatorChannel = new OperatorChannel({
      pubkey: this.pubkey, relays: this.relays, dir, operator: () => this.operatorOfProfile(), operatorProblem: () => this.operatorProblem(), lookupRelays: config.lookupRelays ?? GENERAL_RELAYS,
      sign: (t) => this.sign(t),
      wrap: (recipient, text) => wrapMessage({ senderSk: this.sk, recipient, text, now: nowSeconds() }),
      unwrap: (wrap) => unwrapMessage(wrap, this.sk),
      // The 👀 on each order, the first time the server sees it (arkinox, 2026-10-12).
      wrapReaction: (recipient, eventId) => wrapReaction({ senderSk: this.sk, recipient, eventId, now: nowSeconds() }),
      reactionRetryMs: config.reactionRetryMs,
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
    this.placements = new Placements({
      pubkey: this.pubkey, relays: this.relays, outbox: this.outbox, keys: this.keys,
      sign: (t) => this.sign(t), resolveReference: (ref) => this.resolveReference(ref),
      keyFor: (at, height) => {
        const priced = this.keysRefusal([height])
        if (priced) throw new Refusal(priced)
        const { result: key, ms } = this.deriveKeys([height], () => this.keys.keyAt(at, height, 'hide'))
        return { key, ms }
      },
      summarize: (h, lookupId) => this.summarize(h, lookupId),
      here: () => this.keeper.place(),
      maxHeight: MAX_KEY_HEIGHT, minHeight: SCAN_MIN_HEIGHT, log: this.log,
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
      // From here on the server notices the operator's orders by itself, mid-turn included (arkinox, 2026-10-12).
      agent.operatorChannel.startPolling(config.ordersPollMs ?? ORDERS_POLL_MS)
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
    // The agent's own avatar and its operator's, read in the background, for the rule that the two never overlap.
    const operator = this.operatorOfProfile()
    this.avatars.want(operator ? [this.pubkey, operator] : [this.pubkey])
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

  // ---- nobody's space (arkinox, 2026-10-11) ---------------------------------
  //
  // "don't ever let the agent land on the exact same gibson as the user,
  // because that is uncomfortable. Unless the situation requires it (game
  // entry, for example, enforces a single gibson entry point)." Then, seeing
  // XOR's avatar beside him: "the avatar is larger than 1 gibson, so I don't
  // want him to be adjacent to me. avatar overlap feels wrong." So the agent
  // never stands where its avatar would overlap a person's: on some axis the
  // two centers are at least both avatars' radii plus a gibson apart
  // (space/personalSpace.ts says how ONOSENDAI sizes an avatar). Every
  // coordinate the agent chooses to land on (hop, plan_hop, the follow tool's
  // aim, a roam step) is checked against the people the server knows: the
  // operator wherever the follow watch or presence last saw them, and every
  // other avatar in the 27 sectors that is not known to be a bot (an unknown
  // profile is protected; bots may overlap bots). Each person's avatar is
  // their kind 11333 when it has been read (avatarSizes.ts, in the
  // background), else the default. There is no override. A point the
  // protocol fixes (a ride exits exactly at its stop) is the one exception,
  // and the ride's result says so (fixedPointNote).

  /** Who stands where: the operator and every avatar nearby not known to be a bot, with how far their avatar reaches. From memory. */
  private occupants(): Occupant[] {
    const out = new Map<string, Occupant>()
    const operator = this.operatorOfProfile()
    const seen = this.follow.latest()
    const put = (pubkey: string, place: Place, words: string, unknown: boolean): void => {
      out.set(pubkey, { pubkey, place, words, unknown, radius: this.avatars.radius(pubkey) })
    }
    for (const p of this.presence.others()) {
      const isOperator = p.pubkey === operator
      if (!isOperator && p.profile?.bot === true) continue
      // Presence keeps the operator where they last were nearby; the watch's verified move, when newer, is where they are.
      if (isOperator && seen && seen.at >= p.lastActive) continue
      const name = p.profile?.name ? `${p.profile.name} (${p.pubkey.slice(0, 8)}...)` : `${p.pubkey.slice(0, 8)}...`
      put(p.pubkey, p.place, isOperator ? 'Your operator' : p.profile ? `The human ${name}` : `${name}, not known to be a bot,`, !isOperator && !p.profile)
    }
    if (seen && operator) put(operator, placeFromHex(seen.coordHex), 'Your operator', false)
    return [...out.values()]
  }

  /** How far the agent's own avatar reaches, in gibsons: what set_avatar last published, else its kind 11333 as read, else the default. */
  private myRadius(): number {
    return this.avatars.radius(this.pubkey)
  }

  /** Whether the agent may stand at `p`: clear of every person's avatar. For roam's candidates. */
  private clearForMe(p: Place): boolean {
    const mine = this.myRadius()
    return overlapping(p, this.occupants(), mine).length === 0
  }

  /** The words for one person's box: how far their avatar reaches, and how far apart the two must stand. */
  private spaceWords(who: Occupant, mine: number): string {
    const avatar = this.avatars.describe(who.pubkey)
    const theirs = avatar.name ? `Their avatar "${avatar.name}" reaches ${who.radius.toFixed(2)} gibsons from its center on each axis` : `Their avatar reaches ${who.radius.toFixed(2)} gibsons from its center on each axis (${avatar.read ? 'the default' : 'the default until theirs is read'})`
    return `${theirs} and yours ${mine.toFixed(2)}, so you keep at least ${spacingFor(mine, who.radius)} gibsons from them on some axis (both avatars and a gibson between, at true scale: at coarser zooms every avatar nearby overlaps on screen by design)`
  }

  /**
   * Why the agent may not land on `landing`, or null: its avatar there would
   * overlap a person's. The refusal names the clear coordinate nearest it
   * that is cheapest from `from`, so the model can retry there in one call.
   * With `fetch`, a profile not read yet is read first: a bot there is no
   * bar. Avatar sizes are never waited for: an avatar not read yet counts
   * as the default.
   */
  private async gibsonRefusal(landing: Place, from: Place, fetch = true): Promise<string | null> {
    const mine = this.myRadius()
    let occ = this.occupants()
    let hit = overlapping(landing, occ, mine)
    if (hit.some((o) => o.unknown) && fetch) {
      await this.presence.fetchProfiles()
      occ = this.occupants()
      hit = overlapping(landing, occ, mine)
    }
    const who = hit[0]
    if (!who) return null
    const free = nearestClear(landing, from, occ, mine)
    const apart = apartOnBestAxis(landing, who)
    const where = apart === 0n ? `stands on ${landing.hex}` : `stands at ${who.place.hex}, ${apart.toString()} gibson${apart === 1n ? '' : 's'} from ${landing.hex}`
    return `${who.words} ${where}, and your avatar never overlaps a person's: it is uncomfortable for them. ${this.spaceWords(who, mine)}. ${free ? (free.hex === from.hex ? 'You already stand clear of them, just outside: stay.' : `Land just outside instead, at ${free.hex} (clear of every avatar nearby): call plan_hop or hop with that target.`) : 'No coordinate near it is clear; wait for them to move.'}`
  }

  /** The rule for one step: neither the target (a route toward a person is refused at its first step, not its last) nor where this step lands may overlap a person's avatar. */
  private async landingRefusal(step: PricedStep, target: Place, from: Place, fetch = true): Promise<string | null> {
    return (await this.gibsonRefusal(target, from, fetch)) ?? (step.to.hex !== target.hex ? this.gibsonRefusal(step.to, from, fetch) : null)
  }

  /**
   * The exception, said where it applies: a point the protocol fixes (a ride
   * exits exactly at its stop; a game's single entry gibson) may be shared,
   * and when the agent's avatar there overlaps a person's it is told to step
   * off afterward, by enough gibsons to clear their avatar, to the cheapest
   * clear coordinate beside the stop (nearestClear: the lowest wall first,
   * then the fewest gibsons), with that step's price.
   */
  fixedPointNote(at: Place, why: string): { text: string; data: { why: string; sharedWith: string[]; stepOff: string | null; stepOffGibsons: string | null; stepOffSeconds: number | null } } {
    const mine = this.myRadius()
    const occ = this.occupants()
    const hit = overlapping(at, occ, mine)
    const who = hit[0]
    const free = who ? nearestClear(at, at, occ, mine) : null
    const step = free && free.hex !== at.hex ? priceNextStep(at, free, this.ceilings(), this.calibration) : null
    const gibsons = free ? distanceBetween(at, free).chebyshev : null
    const price = step ? ` (one ${step.kind} of h${step.maxHeight}, about ${step.seconds.toFixed(2)} s here; plan_hop prices it)` : ''
    const stepWords = free ? `step off by ${gibsons!.toString()} gibsons now, to ${free.hex}${price}` : 'step off as soon as a clear coordinate opens near it'
    const text = `${why} That is a single point the protocol fixes, so the rule that your avatar never overlaps a person's yields here.${who ? ` ${who.words} ${apartOnBestAxis(at, who) === 0n ? 'stands on this exact gibson' : `stands ${apartOnBestAxis(at, who).toString()} gibsons from it`}, so your avatars overlap. ${this.spaceWords(who, mine)}. ${stepWords[0].toUpperCase()}${stepWords.slice(1)}.` : ''}`
    return { text, data: { why, sharedWith: hit.map((o) => o.pubkey), stepOff: free?.hex ?? null, stepOffGibsons: gibsons?.toString() ?? null, stepOffSeconds: step ? Number(step.seconds.toFixed(2)) : null } }
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
    // Chat heard in the room and not yet listened to (arkinox, 2026-10-11),
    // from memory. Only lines that address the agent (a mention) carry wake,
    // and a stranger's are rate limited in chat.ts; the rest are context.
    const chatHeard = this.chat.unreadSummary()
    const chatWords = chatHeard.addressed > 0
      ? ` Chat: ${chatHeard.addressed} unread line(s) address you${chatHeard.addressedFromOperator ? `, ${chatHeard.addressedFromOperator} from your operator` : ''}: call listen, and answer with say (reply_to the line).`
      : ''
    let result: ToolResult
    try {
      result = await this.operatorChannel.ordersWaiting()
    } catch (err) {
      if ((!operatorMoved && !roamDue && chatHeard.wake === null) || !(err instanceof Refusal)) throw err
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
    return { text: `${result.text}${words}${movedWords}${roamWords}${chatWords}`, data: { ...result.data, ride, operatorMoved, roamDue, chatHeard } }
  }

  /** A verified operator move as orders_waiting and follow_operator show it, with the distance from where the agent stands (from memory). */
  private moveData(m: OperatorMove): { to: string; plane: number; planeName: string; at: number; eventId: string; action: string; distance: string } {
    const there = placeFromHex(m.coordHex)
    return { to: m.coordHex, plane: m.plane, planeName: m.plane === 0 ? 'dataspace' : 'ideaspace', at: m.at, eventId: m.eventId, action: m.action, distance: distanceWords(distanceBetween(this.keeper.place(), there)) }
  }

  // ---- follow_operator (follow.ts) ------------------------------------------

  /**
   * Turn the follow watch on or off, and report where the operator is now:
   * how far, the clear coordinate just outside their avatar to aim for
   * (never inside it: arkinox, 2026-10-11), and what plan_hop says about getting there within the caps, or
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
    // Their avatar's size is read alongside, never waited for: by the time the chain read answers it is usually in.
    this.avatars.want([op, this.pubkey])
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
    // Just outside the operator's box (their avatar, yours and a gibson between), never inside it.
    const occ = this.occupants()
    if (!occ.some((o) => o.pubkey === op)) occ.push({ pubkey: op, place: there, words: 'Your operator', unknown: false, radius: this.avatars.radius(op) })
    const beside = nearestClear(there, me, occ, this.myRadius())
    if (!beside) throw new Refusal(`No coordinate near your operator at ${latest.coordHex} is clear of every avatar; wait for them to move.`)
    const target = describePlace(beside)
    const besideAlready = beside.hex === me.hex
    const plan = besideAlready ? null : await this.planFrom(me, beside)
    const needsRide = this.routeRefusal(me, placeFromHex(target.hex)) !== null
    const advice = besideAlready
      ? 'You already stand just outside your operator\'s avatar: no move is needed.'
      : needsRide
        ? 'Too far to hop: a coordinate that distant is reached by riding the line to the stop nearest it (station, board, ride). Follow your STRATEGY; if you cannot reach them, tell your operator with message_operator.'
        : plan!.data.refused
          ? `Not within your caps: ${plan!.data.refused as string} Follow your STRATEGY; tell your operator with message_operator if you cannot follow.`
          : `Within your caps: hop with target ${target.hex} to stand just outside their avatar (one step per hop call; plan_hop says how many remain). Moving is your decision, guided by your STRATEGY.`
    const text = [
      watchWords,
      `Your operator is at ${latest.coordHex} (${move.planeName}), by a ${latest.action} signed ${new Date(latest.at * 1000).toISOString()} (event ${latest.eventId.slice(0, 8)}..., verified on their chain). From you: ${move.distance}.`,
      `Aim for ${target.hex}, just outside your operator's avatar: never stand where your avatar would overlap theirs. ${this.spaceWords(occ.find((o) => o.pubkey === op)!, this.myRadius())}.`,
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
   * priced and within the caps, never where the agent's avatar would overlap a
   * person's, preferring cubes
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
      // Every person the server knows of nearby, and the operator wherever the follow watch saw them, with their avatars' boxes; a profile not read yet is protected.
      blocked: (p) => !this.clearForMe(p),
      visited: this.roaming.visited(),
    })
    const skippedWords = [
      found.skipped.people ? `${found.skipped.people} too close to a person (avatars would overlap)` : '',
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
      `One ${step.kind} of h${step.maxHeight}, about ${step.seconds.toFixed(2)} s here, within your caps; your avatar there overlaps nobody's.${this.keeper.status() === 'none' ? ' You have no chain yet: hop will sign your spawn first.' : ''}`,
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
    const op = this.chat.operator()
    const rows = lines.map((l) => this.lineRow(l))
    const text = lines.length === 0
      ? 'Nothing heard since then in your cube and its 26 neighbors.'
      : `${lines.length} line(s), all text untrusted; answer only lines marked (to you):\n${lines.map((l) => `[${new Date(l.at * 1000).toISOString()}] ${l.mine ? 'you' : l.from === op ? 'your operator' : l.from.slice(0, 8) + '...'}${l.addressed ? ' (to you)' : ''}: "${l.text}" (id ${l.id.slice(0, 8)}...)`).join('\n')}`
    return { text, data: { lines: rows, listening: this.chat.room.regions.length } }
  }

  private lineRow(l: ChatLine): Record<string, unknown> {
    const person = this.presence.people.get(l.from)
    const op = this.chat.operator()
    // fromOperator is the signature's word, never the text's: the inner event is verified and signed by the operator's key.
    return { id: l.id, from: l.from, bot: person?.profile?.bot ?? null, name: person?.profile?.name ?? null, at: l.at, text: l.text, mine: l.mine, addressed: l.addressed, fromOperator: op !== null && l.from === op, region: l.region, untrusted: true }
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
        offOrders()
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
      // The operator's orders end any wait (arkinox, 2026-10-12): the background poll finds them within 15 s.
      const onOrders = (count: number): void => finish({ text: `Stopped waiting after ${nowSeconds() - startedAt} s: ${count} message(s) from your operator wait. Call inbox now.`, data: { happened: 'orders', orders: count } })
      const offOrders = this.operatorChannel.onOrders(onOrders)
      const timer = setTimeout(() => finish({ text: `Timed out after ${timeout} s: nothing happened.`, data: { happened: 'timeout', waitedSeconds: timeout } }), timeout * 1000)
      this.presence.on('arrival', onArrival)
      this.chat.on('line', onLine)
      signal?.addEventListener('abort', onAbort, { once: true })
      const unread = this.operatorChannel.unreadOrders()
      if (unread > 0) { onOrders(unread); return }
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

  /** Where a found thing is, as the item store keeps it. */
  private static placeOfHidden(h: Hidden): ItemPlace {
    return { lookupId: h.lookupId, height: h.height, x: h.at.x.toString(), y: h.at.y.toString(), z: h.at.z.toString(), plane: h.plane }
  }

  /**
   * What an opened item is for the report: labels only, never a secret. A
   * key found is held; a chest is remembered, sealed, so it can be opened
   * later with an item found since, and one sealed to the agent or to an
   * item it holds is opened now.
   */
  private summarize(h: Hidden, foundIn: string): EntrySummary {
    const label = h.type === 'message' ? messagePreview(h.text ?? '', 80) : h.type === 'shard' ? (h.shard?.name ?? 'shard') : h.type === 'key' ? (h.key?.name ?? 'key') : (h.chest?.name ?? 'chest')
    const summary: EntrySummary = {
      type: h.type, eventId: h.eventId, author: h.inner.pubkey, at: { x: h.at.x.toString(), y: h.at.y.toString(), z: h.at.z.toString() }, plane: h.plane, createdAt: h.createdAt, label,
      ...(h.type === 'message' && CASHU_TOKEN.test(h.text ?? '') ? { coin: true } : {}),
      ...(h.ref ? { byReference: true } : {}),
      ...(!h.ref && itemLineage(h.inner) !== h.eventId ? { lineage: itemLineage(h.inner)! } : {}),
      ...(h.shard ? { shard: { unit: h.shard.unit, vertices: h.shard.vertices.length, faces: h.shard.faces.length, extent: h.shard.extent, mode: h.shard.mode } } : {}),
    }
    if (h.shard) this.rememberObject(objectHandle(h.eventId), h.shard)
    const place = Agent.placeOfHidden(h)
    if (h.key) {
      this.keys.holdItem({
        itemPubkey: h.key.itemPubkey, secretHex: h.key.secretHex, name: h.key.name, about: h.key.about, foundIn, at: nowSeconds(),
        source: h.inner.pubkey === this.pubkey ? 'forged' : 'found', hider: h.inner.pubkey, eventId: h.eventId, place,
      })
      summary.key = { itemPubkey: h.key.itemPubkey, about: h.key.about }
    }
    if (h.chest) {
      const seen: SeenChest = { id: h.eventId, name: h.chest.name, lockPubkey: h.chest.lockPubkey, senderPubkey: h.chest.senderPubkey, requires: h.chest.requires, payload: h.chest.payload, author: h.inner.pubkey, bagAuthor: h.author, place, seenAt: nowSeconds() }
      this.keys.noteChest(seen)
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
          this.reveal(seen, contents)
        } catch (err) {
          summary.chest = { lock: h.chest.lockPubkey, requires: requiresLabel(h.chest), opened: false }
          this.log(`chest ${h.eventId.slice(0, 8)} did not open: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    return summary
  }

  /**
   * What opening a chest makes known: its objects can be rendered, its items
   * are held (reading an item is holding it, B1 2.1), and a chest inside it
   * is remembered so it can be opened in turn.
   */
  private reveal(chest: SeenChest, contents: ChestEntry[]): void {
    const from = { chestId: chest.id, chestName: chest.name }
    this.keys.noteChestContents(chest.id, contents.map((c) => ({ id: c.id, type: c.body.type })))
    for (const c of contents) {
      if (c.body.shard) this.rememberObject(objectHandle(c.id), c.body.shard)
      if (c.body.key) {
        this.keys.holdItem({
          itemPubkey: c.body.key.itemPubkey, secretHex: c.body.key.secretHex, name: c.body.key.name, about: c.body.key.about, foundIn: chest.place.lookupId, at: nowSeconds(),
          source: 'found', hider: c.event.pubkey, eventId: c.id, place: chest.place, from,
        })
      }
      if (c.body.chest) {
        this.keys.noteChest({ id: c.id, name: c.body.chest.name, lockPubkey: c.body.chest.lockPubkey, senderPubkey: c.body.chest.senderPubkey, requires: c.body.chest.requires, payload: c.body.chest.payload, author: c.event.pubkey, bagAuthor: chest.bagAuthor ?? chest.author, place: chest.place, inChest: chest.id, seenAt: nowSeconds() })
      }
    }
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
        if (e.key) more = ` (an item: you hold it now; public key ${e.key.itemPubkey}${e.key.about ? `; "${e.key.about}"` : ''}; items lists what it opens)`
        if (e.chest) more = e.chest.opened
          ? ` (chest ${handle(e.eventId)}, opened with your ${e.chest.openedWith}: ${e.chest.contents!.length} thing(s): ${e.chest.contents!.map((c) => `${c.type} "${c.label}"${c.verified ? '' : ' (unsigned)'}`).join(', ')}; open_chest ${handle(e.eventId)} for all of it and what each is for, take to keep it)`
          : ` (chest ${handle(e.eventId)}, sealed to ${e.chest.lock.slice(0, 8)}...; needs ${e.chest.requires}; remembered: open_chest works once you hold that item)`
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
      const cap = Math.min(MAX_KEY_HEIGHT, Math.max(SCAN_MIN_HEIGHT, Math.floor(input.max_height ?? SCAN_MAX_HEIGHT)))
      const heights = Array.from({ length: cap - SCAN_MIN_HEIGHT + 1 }, (_, i) => i + SCAN_MIN_HEIGHT)
      // Which cubes were looked in, said plainly, so an agent knows what a "nothing here" covers (arkinox, 2026-10-12).
      const scannedWords = `Scanned the ${heights.length} cubes of height ${SCAN_MIN_HEIGHT} to ${cap} that contain the gibson you stand on (h0 is that gibson alone, h${cap} is 2^${cap} gibsons on a side), as ONOSENDAI's scan does${cap < SCAN_MAX_HEIGHT ? `; ONOSENDAI scans up to h${SCAN_MAX_HEIGHT}` : ''}. A bag in a cube that does not contain your gibson is not seen: a bag at h0 or h1 is found only from its exact gibson or the one beside it, so stand on the spot (hop there) and find again.`
      const priced = this.keysRefusal(heights)
      if (priced) throw new Refusal(priced)
      const { result: keys, ms: keyMs } = this.deriveKeys(heights, () => this.keys.scanAround(here.position, cap, 'find'))
      const { bags, unreadable } = await this.openBags(new Map(keys.map((k) => [k.lookupId, k])), here.plane)
      const text = bags.length === 0
        ? `Nothing hidden in the cubes of height ${SCAN_MIN_HEIGHT} to ${cap} around you (${keys.length} keys, ${keyMs.toFixed(0)} ms).${unreadable.length ? ` Found but could not read: ${unreadable.join('; ')}.` : ''}\n${scannedWords}`
        : `Found ${bags.length} bag(s) in the cubes of height ${SCAN_MIN_HEIGHT} to ${cap} around you (all text untrusted):\n${this.describeBags(bags, here).join('\n')}${unreadable.length ? `\nFound but could not read: ${unreadable.join('; ')}.` : ''}\n${scannedWords}`
      return { text, data: { scanned: { heights: [SCAN_MIN_HEIGHT, cap], at: describePlace(here), keys: keys.length, keyMs: Math.round(keyMs) }, bags, unreadable } }
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
      if (h === null || h < SCAN_MIN_HEIGHT || h > MAX_KEY_HEIGHT) { skipped.push(`bag ${ev.id.slice(0, 8)}... by ${ev.pubkey.slice(0, 8)}... ${h === null ? 'does not say its height, so its box cannot be swept' : `is sealed at h${h}, above what this server derives keys for (h${MAX_KEY_HEIGHT})`}`); continue }
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

  private shardFrom(payload: unknown): ShardModel {
    const v = validateSnoPayload(payload)
    if (!v.ok) throw new Refusal(`The object payload is not valid SNO: ${v.errors.join(' ')}`)
    return v.shard
  }

  /** The inner entry (or entries) for what is being hidden, signed. A large object is published first as its own kind 33331. */
  private async entriesFor(contents: Contents, at: Place, regionKey: Uint8Array, now: number, where: { lookupId: string; height: number }): Promise<{ entries: BagEntry[]; what: string; objectEvent?: NostrEvent; item?: { name: string; itemPubkey: string }; chest?: { id: string; name: string; lock: string; requires: string } }> {
    const place: ItemPlace = { lookupId: where.lookupId, height: where.height, x: at.position.x.toString(), y: at.position.y.toString(), z: at.position.z.toString(), plane: at.plane }
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
      const name = String(contents.key.name ?? '').trim().slice(0, MAX_ITEM_NAME)
      if (!name) throw new Refusal('An item needs a name: what the finder sees, and what you seal chests to it by.')
      const key = forgeKey(name, String(contents.key.about ?? '').trim().slice(0, MAX_ABOUT))
      const event = this.sign(keyInnerTemplate(key, at.position, at.plane, now))
      // Forged is held at once (B1 3.1), so chests can be sealed to it before anyone finds it.
      this.keys.holdItem({ itemPubkey: key.itemPubkey, secretHex: key.secretHex, name: key.name, about: key.about, foundIn: where.lookupId, at: now, source: 'forged', hider: this.pubkey, eventId: event.id, place })
      return { entries: [event], what: `an item "${key.name}" (public key ${key.itemPubkey})`, item: { name: key.name, itemPubkey: key.itemPubkey } }
    }
    if ('chest' in contents) {
      const name = String(contents.chest.name ?? '').trim().slice(0, MAX_ITEM_NAME)
      if (!name) throw new Refusal('A chest needs a name: what a finder sees before it opens.')
      const lock = this.resolveLock(String(contents.chest.lock ?? ''))
      const inner: NostrEvent[] = []
      const forged: Array<{ key: KeyItem; event: NostrEvent }> = []
      for (const e of contents.chest.entries ?? []) {
        if ('message' in e) {
          const text = String(e.message)
          if (!text.trim()) throw new Refusal('A message in the chest is empty.')
          if (text.length > MAX_MESSAGE_LENGTH) throw new Refusal(`A message in the chest is ${text.length} characters; at most ${MAX_MESSAGE_LENGTH}.`)
          inner.push(this.sign(messageInnerTemplate(text, at.position, at.plane, now)))
        } else if ('object' in e) {
          inner.push(this.sign(shardInnerTemplate(this.shardFrom(e.object), at.position, at.plane, now)))
        } else if ('key' in e) {
          const keyName = String(e.key?.name ?? '').trim().slice(0, MAX_ITEM_NAME)
          if (!keyName) throw new Refusal('An item forged into a chest needs a name.')
          const key = forgeKey(keyName, String(e.key.about ?? '').trim().slice(0, MAX_ABOUT))
          const event = this.sign(keyInnerTemplate(key, at.position, at.plane, now))
          inner.push(event)
          forged.push({ key, event })
        } else if ('item' in e) {
          // A copy of an item the agent holds, signed by the agent: the same keypair, so the same chests open for the finder.
          const held = this.heldItemBy(String(e.item))
          inner.push(this.sign(keyInnerTemplate({ name: held.name, about: held.about, itemPubkey: held.itemPubkey, secretHex: held.secretHex }, at.position, at.plane, now)))
        } else {
          throw new Refusal('Each chest entry is one of: { message }, { object }, { key: { name, about } } (a new item), or { item } (an item you hold, by name or public key).')
        }
      }
      if (inner.length === 0) throw new Refusal('A chest needs at least one entry: a message, an object or an item.')
      let sealed
      try { sealed = sealEntries(inner, lock.pubkey) } catch (err) { throw new Refusal(err instanceof Error ? err.message : String(err)) }
      // ONOSENDAI's composer defaults (ChestCompose): "the <item>" for an item, "being the one it was sealed for" for a person.
      const requires = (contents.chest.requires ?? (lock.item ? `the ${lock.item.name}` : lock.person ? 'being the one it was sealed for' : '')).trim().slice(0, MAX_ITEM_NAME)
      const chest = { name, lockPubkey: lock.pubkey, senderPubkey: sealed.senderPubkey, requires, payload: sealed.payload }
      const event = this.sign(chestInnerTemplate(chest, at.position, at.plane, now))
      for (const f of forged) {
        this.keys.holdItem({ itemPubkey: f.key.itemPubkey, secretHex: f.key.secretHex, name: f.key.name, about: f.key.about, foundIn: where.lookupId, at: now, source: 'forged', hider: this.pubkey, eventId: f.event.id, place, from: { chestId: event.id, chestName: name } })
      }
      const counts = (['message', 'object', 'item'] as const).map((k) => [k, (contents.chest.entries ?? []).filter((e) => k in e || (k === 'item' && 'key' in e)).length] as const).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`)
      return {
        entries: [event],
        what: `a chest "${name}" (id ${handle(event.id)}) sealed to ${lock.words}, holding ${counts.join(', ')}${forged.length ? `; you hold the new item(s) ${forged.map((f) => `"${f.key.name}" (public key ${f.key.itemPubkey})`).join(', ')}` : ''}`,
        chest: { id: event.id, name, lock: lock.pubkey, requires },
      }
    }
    throw new Refusal('contents must be one of: { message }, { object }, { key: { name } }, { chest: { name, lock, entries } }.')
  }

  /** The key for the cube of `height` at `at`, priced against the caps and spent. */
  private regionAt(at: Place, height: number): { key: HeldKey; keyMs: number; regionKey: Uint8Array } {
    if (!Number.isInteger(height) || height < SCAN_MIN_HEIGHT || height > MAX_KEY_HEIGHT) throw new Refusal(`height must be an integer from ${SCAN_MIN_HEIGHT} to ${MAX_KEY_HEIGHT} (h0 is the one gibson, as ONOSENDAI hides and scans; above h${MAX_KEY_HEIGHT} a key costs more than a second).`)
    const priced = this.keysRefusal([height])
    if (priced) throw new Refusal(priced)
    const { result: key, ms: keyMs } = this.deriveKeys([height], () => this.keys.keyAt(at.position, height, 'hide'))
    return { key, keyMs, regionKey: hexToBytes(key.keyHex) }
  }

  async hide(input: { contents: Contents; coordinate: CoordinateInput; height: number; hint_heights?: [number, number, number]; riddle?: string }): Promise<ToolResult> {
    const here = this.keeper.place()
    const at = this.target(input.coordinate, here)
    const { key, keyMs, regionKey } = this.regionAt(at, input.height)
    // One bag per author per region: read before write, never replace; one change to a bag at a time (placed.ts).
    return this.placements.withBags([key.lookupId], async () => {
    const { current, entries: carried } = await this.placements.ownBag(key.lookupId, regionKey)
    const height = input.height
    const now = nowSeconds()
    // The hint is checked before anything is signed or forged, so a refusal leaves no item held that was never hidden.
    const currentSettings = current ? bagSettingsOf(current, height) : null
    const hint = input.hint_heights ?? currentSettings?.hint ?? null
    if (hint && !hintFits(hint, height)) throw new Refusal(`hint_heights ${hint.join(',')} cannot contain a height ${height} region: each must be from ${height} to 85.`)
    const { entries, what, objectEvent, item, chest } = await this.entriesFor(input.contents, at, regionKey, now, { lookupId: key.lookupId, height })
    const have = new Set(carried.map(entryKey))
    const merged = [...carried, ...entries.filter((e) => !have.has(entryKey(e)))]
    const riddle = (input.riddle ?? currentSettings?.riddle ?? '').slice(0, MAX_RIDDLE_LENGTH)
    const createdAt = Math.max(now, (current?.created_at ?? 0) + 1, this.placements.floor(key.lookupId))
    const template = await bagTemplate(merged, regionKey, key.lookupId, height, createdAt, HIDDEN_KIND, { heightTag: currentSettings?.heightTag ?? true, hint, riddle, contents: currentSettings?.contents, money: currentSettings?.money }, { at: at.position, plane: at.plane })
    const bag = this.sign(template)
    // Recorded whole before it is sent, so no later rewrite builds on an older copy, whichever relays take it.
    this.keys.noteOwnBag(key, createdAt, { bagId: bag.id, event: bag })
    const entry = this.outbox.add(bag)
    const result = await this.outbox.send(entry)
    if (entries[0]) this.keys.notePlaced(key.lookupId, entryKey(entries[0]), createdAt)
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
      `Its id is ${handle(objectEvent ? objectEvent.id : !isReference(entries[0]) ? (entries[0] as NostrEvent).id : objectHandle(`${key.lookupId}/${entryKey(entries[0])}`))}: placed lists it, remove_placed takes it down, move_placed moves it.`,
    ].filter(Boolean).join('\n')
    return { text, data: { bagId: bag.id, lookupId: key.lookupId, cube: { height, base: key.base, plane: at.plane }, entries: merged.length, carried: carried.length, keyMs: Math.round(keyMs), accepted, refused, hint, riddle, objectEventId: objectEvent?.id ?? null, ...(item ? { item } : {}), ...(chest ? { chest } : {}) } }
    })
  }

  async place(input: { object?: unknown; address?: string; id?: string; coordinate: CoordinateInput; height: number }): Promise<ToolResult> {
    // An object find or open_chest listed, or one taken from a chest, by its id: its payload is placed as given.
    if (input.id !== undefined && input.object === undefined && input.address === undefined) {
      return this.hide({ contents: { object: toPayload(this.objectById(input.id).shard) }, coordinate: input.coordinate, height: input.height })
    }
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
    const { key, keyMs, regionKey } = this.regionAt(at, height)
    return this.placements.withBags([key.lookupId], async () => {
    const { current, entries: carried } = await this.placements.ownBag(key.lookupId, regionKey)
    const now = nowSeconds()
    const have = new Set(carried.map(entryKey))
    const merged = have.has(entryKey(ref)) ? carried : [...carried, ref]
    const settings = current ? bagSettingsOf(current, height) : { heightTag: true, hint: null, riddle: '' }
    const createdAt = Math.max(now, (current?.created_at ?? 0) + 1, this.placements.floor(key.lookupId))
    const bag = this.sign(await bagTemplate(merged, regionKey, key.lookupId, height, createdAt, HIDDEN_KIND, settings, { at: at.position, plane: at.plane }))
    // Recorded whole before it is sent, so no later rewrite builds on an older copy, whichever relays take it.
    this.keys.noteOwnBag(key, createdAt, { bagId: bag.id, event: bag })
    const entry = this.outbox.add(bag)
    const result = await this.outbox.send(entry)
    this.keys.notePlaced(key.lookupId, entryKey(ref), createdAt)
    const opened = await unbag(bag, regionKey, (r) => this.resolveReference(r), { at: at.position, plane: at.plane }, height)
    this.keys.noteBag({ lookupId: key.lookupId, bagId: bag.id, author: this.pubkey, createdAt, height, base: key.base, entries: opened.map((h) => this.summarize(h, key.lookupId)), missing: merged.filter(isReference).length - opened.filter((h) => h.ref).length, riddle: settings.riddle, hint: settings.hint, at: now })
    const text = `Placed ${what} in the h${height} cube at base x ${key.base.x} y ${key.base.y} z ${key.base.z}; bag ${bag.id.slice(0, 8)}... holds ${merged.length} entr${merged.length === 1 ? 'y' : 'ies'}. Key cost ${keyMs.toFixed(0)} ms. ${entry.accepted.length ? `Accepted by ${entry.accepted.join(', ')}.` : `No relay accepted it${result.ok ? '' : `: ${result.reason}`}.`}${entry.refused ? ` Refused by ${Object.entries(entry.refused).map(([u, r]) => `${u}: ${r}`).join('; ')}.` : ''}`
    return { text, data: { bagId: bag.id, lookupId: key.lookupId, cube: { height, base: key.base, plane: at.plane }, entries: merged.length, keyMs: Math.round(keyMs), accepted: entry.accepted, refused: entry.refused ?? {} } }
    })
  }

  // ---- what the agent placed ---------------------------------------------------

  /** placed: the agent's bags and everything in them (placed.ts). */
  placed(input: { match?: string } = {}): Promise<ToolResult> {
    return this.placements.list(input)
  }

  /** remove_placed: take one placed thing down, or a whole bag (placed.ts). */
  removePlaced(input: { target?: string; type?: string; bag?: string; whole_bag?: boolean }): Promise<ToolResult> {
    return this.placements.remove(input)
  }

  /** move_placed: move one placed thing by an offset or to a coordinate, keeping its lineage (placed.ts). */
  movePlaced(input: { target?: string; type?: string; by?: { dx?: string | number; dy?: string | number; dz?: string | number }; to?: CoordinateInput; height?: number }): Promise<ToolResult> {
    return this.placements.move(input)
  }

  // ---- items and chests --------------------------------------------------------
  //
  // Keys and Chests B1 as ONOSENDAI plays it (arkinox, 2026-10-12). An item
  // is a keypair hidden in a bag: reading it is holding it. A chest is a list
  // of things sealed to a public key: an item's (the item is its key) or a
  // person's (a gift). The tools: items (what the agent holds and which
  // chests each opens), forge_item and seal_chest (hide one), open_chest
  // (read one it holds the key to), take (keep its contents). An item's
  // secret is never in any answer or log.

  /**
   * What a chest is locked to: a public key (npub or hex; an item's or a
   * person's), or the name of an item the agent holds. Refuses a key that is
   * not a point on the curve, so nothing is sealed that nobody can open.
   */
  private resolveLock(given: string): { pubkey: string; item: HeldItem | null; person: boolean; words: string } {
    const g = given.trim()
    if (!g) throw new Refusal('Say what the chest is locked to (lock): the name or public key of an item you hold (items lists them), an item public key you were given, or a person\'s npub (a gift only they can open).')
    const hex = parsePubkey(g)
    if (hex) {
      try { nip44.utils.getConversationKey(generateSecretKey(), hex) } catch { throw new Refusal(`${g.slice(0, 16)}... is not a public key a chest can be sealed to (not a point on the curve).`) }
      const item = this.keys.items.get(hex) ?? null
      if (item) return { pubkey: hex, item, person: false, words: `your item "${item.name}"` }
      if (hex === this.pubkey) return { pubkey: hex, item: null, person: true, words: 'yourself' }
      // A pasted hex may be an item someone gave out or a person; an npub is a person (ONOSENDAI ChestCompose parseLock).
      return { pubkey: hex, item: null, person: g.startsWith('npub1') || g.startsWith('nprofile1'), words: `${hex.slice(0, 8)}...` }
    }
    const item = this.heldItemBy(g)
    return { pubkey: item.itemPubkey, item, person: false, words: `your item "${item.name}"` }
  }

  /** An item the agent holds, by its public key (or at least 8 hex of it) or its name, or a refusal that lists what it holds. */
  private heldItemBy(given: string): HeldItem {
    const g = given.trim()
    const all = [...this.keys.items.values()]
    const byKey = /^[0-9a-f]{8,64}$/.test(g) ? all.filter((i) => i.itemPubkey.startsWith(g)) : []
    const hits = byKey.length ? byKey : all.filter((i) => i.name.toLowerCase() === g.toLowerCase())
    if (hits.length === 1) return hits[0]
    const held = all.length ? `You hold: ${all.map((i) => `"${i.name}" (${i.itemPubkey.slice(0, 12)}...)`).join(', ')}.` : 'You hold no items: forge one with forge_item, or find one with find.'
    if (hits.length > 1) throw new Refusal(`${hits.length} of your items match "${g}"; give its public key instead. ${held}`)
    throw new Refusal(`You hold no item named or keyed "${g}". ${held}`)
  }

  /** A chest the agent has seen, by its id (at least 8 hex, as find and items list it) or its name. */
  private chestBy(given: string): SeenChest {
    const g = String(given ?? '').trim()
    const all = [...this.keys.chests.values()]
    const byId = /^[0-9a-f]{8,64}$/.test(g) ? all.filter((c) => c.id.startsWith(g)) : []
    const hits = byId.length ? byId : all.filter((c) => c.name.toLowerCase() === g.toLowerCase())
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) throw new Refusal(`${hits.length} chests you have seen match "${g}": ${hits.map((c) => `"${c.name}" (${handle(c.id)})`).join(', ')}. Give its id.`)
    throw new Refusal(`You have seen no chest "${g}". Chests are seen with find (and inside opened chests); items lists the ones you have seen.`)
  }

  /** Open a seen chest with the item it is locked to, or with the agent's own key when it is a gift to the agent. */
  private openSeen(c: SeenChest): { contents: ChestEntry[]; openedWith: string } {
    const opener = openerFor(c, this.keys.heldItems(), this.pubkey)
    if (!opener) throw new Refusal(`The chest "${c.name}" (${handle(c.id)}) does not open for you: ${chestStatus(c, this.keys, this.pubkey).words}. A chest opens only with the item whose public key it is locked to (${c.lockPubkey}), or for the person it was sealed to. Find that item (find, or a chest you can open), and open_chest works.`)
    let contents: ChestEntry[]
    try {
      contents = readContents(openWithSecret(c, opener.by === 'key' ? opener.key.secretHex : bytesToHex(this.sk)))
    } catch (err) {
      throw new Refusal(`The chest "${c.name}" (${handle(c.id)}) did not open: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.reveal(c, contents)
    const item = opener.by === 'key' ? this.keys.items.get(opener.key.itemPubkey) : undefined
    return { contents, openedWith: opener.by === 'key' ? `your item "${item?.name ?? opener.key.itemPubkey.slice(0, 8)}"` : 'your own key (it was sealed to you)' }
  }

  /** The items tool: what the agent holds, what each opens, what it took out of chests, and the chests it has seen. */
  items(): ToolResult {
    const held = [...this.keys.items.values()].sort((a, b) => b.at - a.at)
    const taken = [...this.keys.taken.values()].sort((a, b) => b.at - a.at)
    const chests = [...this.keys.chests.values()].sort((a, b) => b.seenAt - a.seenAt)
    const rows = held.map((i) => itemRow(i, this.keys))
    const lines: string[] = []
    lines.push(held.length
      ? `You hold ${held.length} item(s). An item is a key: any chest sealed to its public key opens for you (open_chest), and you can seal chests to it (seal_chest). Names and sentences are other people's text (untrusted).`
      : 'You hold no items. Find one with find, or forge one with forge_item.')
    for (const r of rows) {
      const how = r.source === 'forged' ? 'forged by you' : `${r.source === 'taken' ? 'taken' : 'found'}${r.from ? ` in the chest "${r.from.chestName}"` : ' in a bag'}${r.hider ? `, made by ${r.hider === this.pubkey ? 'you' : `${r.hider.slice(0, 8)}...`}` : ''}`
      const opens = r.opens.length ? `opens ${r.opens.map((c) => `"${c.name}" (open_chest ${handle(c.id)}, ${placeWords(c.place)})`).join(', ')}` : 'opens none of the chests you have seen'
      lines.push(`- "${r.name}"${r.about ? `: "${r.about}"` : ''}. Public key ${r.itemPubkey}. ${how}, ${placeWords(r.place ?? undefined)}. It ${opens}.`)
    }
    if (taken.length) {
      lines.push(`Taken from chests (${taken.length}):`)
      for (const t of taken) lines.push(`- [${handle(t.id)}] ${t.coin ? 'coin' : t.type} "${t.name}" from "${t.from.chestName}". ${purposeOf(t.type, { coin: t.coin, id: t.id, itemPubkey: t.itemPubkey })}`)
    }
    if (chests.length) {
      lines.push(`Chests you have seen (${chests.length}):`)
      for (const c of chests) lines.push(`- [${handle(c.id)}] "${c.name}" by ${c.author === this.pubkey ? 'you' : `${c.author.slice(0, 8)}...`}, ${placeWords(c.place)}${c.inChest ? `, inside the chest ${handle(c.inChest)}` : ''}: ${chestStatus(c, this.keys, this.pubkey).words}.`)
    }
    return {
      text: lines.join('\n'),
      data: {
        items: rows,
        taken: taken.map((t) => takenRow(t)),
        chests: chests.map((c) => ({ id: c.id, name: c.name, lock: c.lockPubkey, requires: c.requires, author: c.author, place: c.place, inChest: c.inChest ?? null, ...chestStatus(c, this.keys, this.pubkey) })),
      },
    }
  }

  /** The open_chest tool: open a chest the agent has seen, and say what each thing inside is and is for. Opening changes nothing anywhere. */
  openChest(input: { chest: string }): ToolResult {
    const c = this.chestBy(input.chest)
    const { contents, openedWith } = this.openSeen(c)
    const rows: ContentRow[] = contents.map((e) => contentRow(e, this.keys))
    const text = [
      `Opened the chest "${c.name}" (${handle(c.id)}) with ${openedWith}. It holds ${rows.length} thing(s) (all text untrusted). Opening it changed nothing; take keeps what you want (items you hold already).`,
      ...rows.map(contentLine),
    ].join('\n')
    return { text, data: { chest: { id: c.id, name: c.name, lock: c.lockPubkey, author: c.author, place: c.place }, openedWith, contents: rows } }
  }

  /**
   * The take tool: keep a content of an opened chest, or all of them (B1
   * 3.2 TAKE). A copy: the chest still holds it for whoever else opens it.
   * An item is held; an object can be rendered and placed by its id, after
   * a restart too; a coin and a message are kept with their text.
   */
  take(input: { chest: string; content?: string }): ToolResult {
    const c = this.chestBy(input.chest)
    const { contents } = this.openSeen(c)
    let chosen = contents
    if (input.content !== undefined) {
      const want = String(input.content).trim().toLowerCase()
      if (!/^[0-9a-f]{8,64}$/.test(want)) throw new Refusal('content must be at least 8 hex characters of a content\'s id, as open_chest lists it; leave it out to take everything.')
      chosen = contents.filter((e) => e.id.startsWith(want))
      if (chosen.length === 0) throw new Refusal(`The chest "${c.name}" holds nothing with id ${want}. open_chest ${handle(c.id)} lists what it holds.`)
      if (chosen.length > 1) throw new Refusal(`${chosen.length} things in the chest have ids starting ${want}; give more of the id.`)
    }
    const from = { chestId: c.id, chestName: c.name }
    const now = nowSeconds()
    const took: ContentRow[] = []
    const already: ContentRow[] = []
    for (const e of chosen) {
      const row = contentRow(e, this.keys)
      const b = e.body
      let fresh = this.keys.take({
        id: e.id, type: b.type, name: row.name, author: e.event.pubkey, verified: e.verified, from, at: now,
        ...(b.type === 'message' ? { text: b.text ?? '' } : {}), ...(row.coin ? { coin: true } : {}),
        ...(b.shard ? { payload: toPayload(b.shard) } : {}), ...(b.key ? { itemPubkey: b.key.itemPubkey } : {}),
      })
      if (b.key) fresh = this.keys.holdItem({ itemPubkey: b.key.itemPubkey, secretHex: b.key.secretHex, name: b.key.name, about: b.key.about, foundIn: c.place.lookupId, at: now, source: 'taken', hider: e.event.pubkey, eventId: e.id, place: c.place, from }) || fresh
      ;(fresh ? took : already).push(row)
    }
    const text = [
      took.length ? `Took ${took.length} thing(s) from the chest "${c.name}" (${handle(c.id)}); the chest still holds them for others. items lists what you hold.` : `Nothing new to take from the chest "${c.name}" (${handle(c.id)}).`,
      ...took.map(contentLine),
      already.length ? `Already yours: ${already.map((r) => `${r.type} "${r.name}" [${handle(r.id)}]`).join(', ')}.` : '',
    ].filter(Boolean).join('\n')
    return { text, data: { chest: { id: c.id, name: c.name }, took, already: already.map((r) => r.id) } }
  }

  /** The forge_item tool: forge an item and hide it, held at once (B1 3.1). */
  forgeItem(input: { name: string; about?: string; coordinate?: CoordinateInput; height: number; hint_heights?: [number, number, number]; riddle?: string }): Promise<ToolResult> {
    return this.hide({ contents: { key: { name: input.name, about: input.about } }, coordinate: input.coordinate ?? { dx: 0, dy: 0, dz: 0 }, height: input.height, hint_heights: input.hint_heights, riddle: input.riddle })
  }

  /** The seal_chest tool: seal things to a public key and hide the chest (B1 3.1). */
  sealChest(input: { name: string; lock: string; requires?: string; contents: ChestContentInput[]; coordinate?: CoordinateInput; height: number; hint_heights?: [number, number, number]; riddle?: string }): Promise<ToolResult> {
    return this.hide({ contents: { chest: { name: input.name, lock: input.lock, requires: input.requires, entries: input.contents } }, coordinate: input.coordinate ?? { dx: 0, dy: 0, dz: 0 }, height: input.height, hint_heights: input.hint_heights, riddle: input.riddle })
  }

  /**
   * What a comment on `given` answers (ONOSENDAI comments.ts itemParent): an
   * item in a bag the agent opened, a chest, or a thing revealed from a chest
   * it opened, by at least 8 hex of its id. The root is always the bag; the
   * region key is the bag's, held or derived again from its place.
   */
  private commentTarget(given: string): { subject: CommentSubject; parent: CommentParent; key: Uint8Array; what: string } {
    const want = String(given ?? '').trim().toLowerCase()
    if (!/^[0-9a-f]{8,64}$/.test(want)) throw new Refusal('target must be at least 8 hex characters of an id find, open_chest or items listed: an item in a bag, a chest, or a thing inside an opened chest.')
    type Hit = { id: string; lineage?: string; type: HiddenType; author: string; lookupId: string; height: number; base: { x: string; y: string; z: string }; byReference?: boolean; label: string }
    const hits = new Map<string, Hit>()
    for (const bag of this.keys.bags.values()) {
      for (const e of bag.entries) if (e.eventId.startsWith(want) || e.lineage?.startsWith(want)) hits.set(e.eventId, { id: e.eventId, lineage: e.lineage, type: e.type, author: bag.author, lookupId: bag.lookupId, height: bag.height, base: bag.base, byReference: e.byReference, label: e.label })
    }
    for (const c of this.keys.chests.values()) {
      for (const x of c.contents ?? []) {
        if (x.id.startsWith(want) && !hits.has(x.id)) hits.set(x.id, { id: x.id, type: x.type, author: c.bagAuthor ?? c.author, lookupId: c.place.lookupId, height: c.place.height, base: { x: c.place.x, y: c.place.y, z: c.place.z }, label: `a ${x.type} inside the chest "${c.name}"` })
      }
    }
    if (hits.size === 0) throw new Refusal(`Nothing you opened has an id starting ${want}. find lists the ids of what is in a bag, open_chest the ids of what is in a chest.`)
    if (hits.size > 1) throw new Refusal(`${hits.size} things you opened have ids starting ${want}; give more of the id.`)
    const hit = [...hits.values()][0]
    if (hit.byReference) throw new Refusal('That object is hidden by reference; this server comments only on items carried in the bag itself, and on chests and what they hold.')
    const key = this.keys.byLookupId(hit.lookupId) ?? this.keys.keyAt({ x: BigInt(hit.base.x), y: BigInt(hit.base.y), z: BigInt(hit.base.z) }, hit.height, 'find')
    if (key.lookupId !== hit.lookupId) throw new Refusal('The key for the bag that holds it could not be derived again; call find there first.')
    return {
      subject: { author: hit.author, lookupId: hit.lookupId },
      // A moved item is answered by its first version's id, so its comments follow it (ONOSENDAI #369, SecretModal: item.lineage ?? item.key).
      parent: { id: hit.lineage ?? hit.id, kind: itemKind(hit.type), pubkey: hit.author },
      key: hexToBytes(key.keyHex),
      what: `${hit.type} "${hit.label}" in the bag of ${hit.author === this.pubkey ? 'yours' : `${hit.author.slice(0, 8)}...`} (h${hit.height})`,
    }
  }

  /**
   * The comment tool: a NIP-22 comment (kind 1111) on something the agent
   * opened, written exactly as ONOSENDAI writes one, so it shows under that
   * thing in ONOSENDAI. The words are sealed to the place: whoever reaches it
   * reads them, everyone else sees a placeholder. Publishes to the agent's
   * relays.
   */
  async comment(input: { target: string; text: string }): Promise<ToolResult> {
    const text = String(input.text ?? '').trim()
    if (!text) throw new Refusal('Say something: the comment is empty.')
    if (text.length > MAX_COMMENT_LENGTH) throw new Refusal(`The comment is ${text.length} characters; at most ${MAX_COMMENT_LENGTH}.`)
    // Whoever reaches the place reads it: never the operator's DMs, as the travel log refuses them (travel.ts), and never a coin.
    if (repeatsPrivate(text, this.operatorChannel.privateTexts())) throw new Refusal('That comment repeats what your operator told you, or you told them, in private. Comments are read by whoever reaches the place; say it in your own words, without the private part. Nothing was published.')
    if (CASHU_TOKEN.test(text)) throw new Refusal('That comment holds a Cashu token, which is money anyone who reads it can spend. Nothing was published.')
    const { subject, parent, key, what } = this.commentTarget(input.target)
    const event = this.sign(await sealedComment(subject, parent, text, nowSeconds(), key))
    const result = await this.relays.publish(event)
    const refused = Object.entries(result.reasons ?? {})
    if (!result.ok) throw new Refusal(`The comment was not published: ${refused.map(([u, r]) => `${u}: ${r}`).join('; ') || result.reason}. The relays' words are verbatim.`)
    return {
      text: `Commented on the ${what}: accepted by ${result.accepted.join(', ')}${refused.length ? `; refused by ${refused.map(([u, r]) => `${u} (${r})`).join(', ')}` : ''}. The words are sealed to that place: whoever finds the bag reads them (ONOSENDAI shows them under it), and everyone else sees only a placeholder.`,
      data: { id: event.id, target: parent.id, kind: parent.kind, bag: `33330:${subject.author}:${subject.lookupId}`, accepted: result.accepted, refused: Object.fromEntries(refused) },
    }
  }

  /** An object by the id find, open_chest or items listed: opened this session, or taken from a chest (kept across restarts). */
  private objectById(given: string): { id: string; shard: ShardModel } {
    const want = given.trim().toLowerCase()
    if (!/^[0-9a-f]{8,64}$/.test(want)) throw new Refusal('id must be 8 to 64 hex characters of an object\'s id, as find, open_chest or items lists it.')
    const seen = [...this.objectsSeen.entries()].filter(([k]) => k.startsWith(want)).map(([id, shard]) => ({ id, shard }))
    const taken = [...this.keys.taken.values()].filter((t) => t.type === 'shard' && t.payload !== undefined && objectHandle(t.id).startsWith(want) && !seen.some((x) => x.id === objectHandle(t.id)))
      .flatMap((t) => { const v = validateSnoPayload(t.payload); return v.ok ? [{ id: objectHandle(t.id), shard: v.shard }] : [] })
    const hits = [...seen, ...taken]
    if (hits.length === 0) throw new Refusal(`No object with id ${want} among the ${this.objectsSeen.size} opened this session or those you took from chests. Call find (or look) where it is first; objects you did not take are remembered in memory only, not across a restart.`)
    if (hits.length > 1) throw new Refusal(`${hits.length} objects have ids starting ${want}; give more of the id.`)
    return hits[0]
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
      const hit = this.objectById(input.id)
      shard = hit.shard
      source = `id ${hit.id}`
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

  // ---- set_avatar (avatar.ts, avatarMine.ts) -------------------------------

  /** The avatar being mined, so a second set_avatar waits its turn instead of mining twice. */
  private avatarBusy = false
  /**
   * The created_at of the last avatar this server signed. A replaceable tie
   * on created_at goes to the lower id (NIP-01), and a mined id starts with
   * zeros, so a clear signed in the same second as a mined avatar would lose
   * to it: each avatar is signed at least a second after the last.
   */
  private lastAvatarAt = 0

  /**
   * Publish the agent's avatar, a kind 11333, exactly as ONOSENDAI's workshop
   * does (arkinox, 2026-10-11: "tell XOR to set a shard as his avatar"): an
   * SNO payload, or a public kind 33331 object whose payload is copied in
   * (spec 8.10 has no reference form: the content is the payload), or
   * clear for the dodecahedron. The work is priced against the caps first,
   * then mined on threads of its own so every other tool keeps answering,
   * stopped at the per-call cap, verified with cyberspace-core's own check
   * before anything is signed, and charged to the session.
   */
  async setAvatar(input: { object?: unknown; address?: string; clear?: boolean }, signal?: AbortSignal): Promise<ToolResult> {
    const given = [input.object, input.address, input.clear ? true : undefined].filter((x) => x !== undefined).length
    if (given !== 1) throw new Refusal('Give exactly one of: object (an SNO payload), address (a public kind 33331 object), or clear: true (the default dodecahedron).')
    if (this.avatarBusy) throw new Refusal('An avatar is being mined already; wait for that call to answer.')
    let shard: ShardModel | null = null
    let source = 'clear'
    if (input.object !== undefined) {
      let raw = input.object
      if (typeof raw === 'string') {
        try { raw = JSON.parse(raw) } catch { throw new Refusal('object is a string that is not JSON; give the SNO payload as an object.') }
      }
      const v = validateSnoPayload(raw)
      if (!v.ok) throw new Refusal(`Not set: the payload is not valid SNO. ${v.errors.join(' ')}`)
      if (v.bytes > MAX_AVATAR_BYTES) throw new Refusal(`Not set: the payload is ${v.bytes} bytes, and an avatar is at most ${MAX_AVATAR_BYTES} (every try of the work hashes the whole event). Use fewer vertices.`)
      shard = v.shard
      source = 'payload'
    } else if (input.address !== undefined) {
      const { address, object } = await this.publicObject(String(input.address))
      if (object.tags.some((t) => t[0] === 'encrypted')) throw new Refusal('That object is sealed to a place; an avatar is public. Find it, then give its payload.')
      let raw: unknown
      try { raw = JSON.parse(object.content || 'null') } catch { raw = null }
      const v = validateSnoPayload(raw)
      if (!v.ok) throw new Refusal(`The object at ${address} is not valid SNO: ${v.errors.join(' ')}`)
      if (v.bytes > MAX_AVATAR_BYTES) throw new Refusal(`The object at ${address} is ${v.bytes} bytes; an avatar is at most ${MAX_AVATAR_BYTES}.`)
      shard = v.shard
      source = `address ${address} (payload copied: an avatar carries its shape, not a reference)`
    }
    const createdAt = Math.max(nowSeconds(), this.lastAvatarAt + 1)
    let template: EventTemplate = avatarTemplate(shard, createdAt)
    let mined: { bits: number; tries: number; seconds: number; estimate: number } | null = null
    if (shard) {
      const payload = JSON.parse(template.content)
      const { bits, eventBytes } = avatarPrice(payload, template, this.pubkey)
      const threads = this.config.avatarThreads ?? avatarThreads()
      const estimate = avatarSeconds(bits, eventBytes, this.calibration.sha256PerSec, threads)
      const over = this.budget.refusal(estimate)
      if (over) throw new Refusal(`This avatar owes ${bits} bits of work (spec 8.10: reach and detail), about ${estimate.toFixed(1)} s expected on ${threads} thread(s). ${over} A smaller shape (nearer the build origin, fewer vertices and faces) costs less.`)
      const limit = Math.min(this.budget.capCallSeconds, this.budget.capSessionSeconds - this.budget.spentSeconds)
      this.avatarBusy = true
      let outcome
      try {
        outcome = await mineAvatar({ ...template, pubkey: this.pubkey }, bits, { threads, deadlineMs: Math.max(1, limit) * 1000, signal })
      } finally {
        this.avatarBusy = false
      }
      const seconds = outcome.elapsedMs / 1000
      this.budget.spendWork(seconds)
      if (!outcome.found) {
        throw new Refusal(outcome.why === 'aborted'
          ? `Mining stopped by the caller after ${seconds.toFixed(1)} s and ${outcome.tries} tries; nothing was published.`
          : `No nonce within the ${limit.toFixed(0)} s this call may spend (${outcome.tries} tries; ${bits} bits expects about ${(2 ** bits).toLocaleString('en-US')}, about ${estimate.toFixed(1)} s). The work is luck: call set_avatar again to try afresh. ${seconds.toFixed(1)} s were charged.`)
      }
      template = nonceTagged(template, outcome.nonce, bits)
      mined = { bits, tries: outcome.tries, seconds, estimate }
    }
    const event = this.sign(template)
    // The reader's check before any relay sees it: what ONOSENDAI would not draw is never published.
    if (shard) {
      const verdict = verifyAvatarWork(event)
      if (!verdict.ok || !paidShard(event)) throw new Refusal(`The signed avatar did not verify (${verdict.reason}); nothing was published. This is a bug in the server.`)
    }
    if (event.kind !== AVATAR_KIND) throw new Refusal('internal: not an avatar event')
    this.lastAvatarAt = event.created_at
    const entry = this.outbox.add(event)
    const result = await this.outbox.send(entry)
    // The size the personal-space rule gives the agent's own avatar from now on (space/personalSpace.ts).
    if (entry.accepted.length) this.avatars.set(this.pubkey, shard)
    const relayWords = entry.accepted.length ? `Accepted by ${entry.accepted.join(', ')}.` : `No relay accepted it${result.ok ? '' : `: ${result.reason}`}.`
    const refusedWords = entry.refused ? ` Refused by ${Object.entries(entry.refused).map(([u, r]) => `${u}: ${r}`).join('; ')}.` : ''
    if (!shard) {
      return { text: `Avatar cleared: you are drawn as the dodecahedron again (kind 11333 ${event.id.slice(0, 8)}..., empty content, no work owed). ${relayWords}${refusedWords}`, data: { eventId: event.id, cleared: true, accepted: entry.accepted, refused: entry.refused ?? {} } }
    }
    let r
    try {
      r = renderShard(shard, {})
    } catch (err) {
      throw new Refusal(`Published as ${event.id}, but the picture failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return {
      text: `Avatar set: "${shard.name}" (${source}), kind 11333 ${event.id.slice(0, 8)}..., ${mined!.bits} bits of work in ${mined!.seconds.toFixed(1)} s (${mined!.tries} tries; about ${mined!.estimate.toFixed(1)} s was expected). ONOSENDAI draws it in place of your dodecahedron wherever you are seen. ${relayWords}${refusedWords} ${r.caption}`,
      images: [{ data: r.png.toString('base64'), mimeType: 'image/png' }],
      data: { eventId: event.id, name: shard.name, source, bits: mined!.bits, tries: mined!.tries, seconds: mined!.seconds, estimateSeconds: mined!.estimate, accepted: entry.accepted, refused: entry.refused ?? {}, vertices: r.vertices, faces: r.faces, pngBytes: r.png.length },
    }
  }

  // ---- publish_object (publicObject.ts) -------------------------------------

  /**
   * Publish an SNO object to the feed, a public kind 33331 (DECK-0003 3.1),
   * as ONOSENDAI's PUBLISH does (arkinox, 2026-10-13, amending D11: agents
   * may publish objects; placing public shards, kind 33332, waits for a
   * price). Validated as place validates, signed, and sent through the
   * outbox. The same `d` again replaces the object in place. At most
   * publishMaxPerDay in any 24 hours, counted on disk so a restart does not
   * reset it, so an agent in a loop cannot flood the feed.
   */
  async publishObject(input: { object?: unknown; d?: string; name?: string; description?: string }): Promise<ToolResult> {
    if (input.object === undefined) throw new Refusal('Give object, the SNO payload to publish (render it first).')
    let raw = input.object
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw) } catch { throw new Refusal('object is a string that is not JSON; give the SNO payload as an object.') }
    }
    if (input.name !== undefined && raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const name = String(input.name).trim().replace(/\s+/g, ' ')
      if (!name) throw new Refusal('name, when given, must not be empty.')
      if (name.length > MAX_NAME_LENGTH) throw new Refusal(`name must be at most ${MAX_NAME_LENGTH} characters.`)
      raw = { ...(raw as Record<string, unknown>), name }
    }
    const v = validateSnoPayload(raw)
    if (!v.ok) throw new Refusal(`Not published: the payload is not valid SNO. ${v.errors.join(' ')}`)
    const replacing = input.d !== undefined
    const d = replacing ? String(input.d) : newObjectId()
    const bad = dProblem(d)
    if (bad) throw new Refusal(`Not published: ${bad}`)
    let alt: string | undefined
    if (input.description !== undefined) {
      alt = String(input.description).trim().replace(/\s+/g, ' ')
      if (!alt) alt = undefined
      else if (alt.length > MAX_ALT_LENGTH) throw new Refusal(`description must be at most ${MAX_ALT_LENGTH} characters.`)
    }
    const now = nowSeconds()
    const limit = this.config.publishMaxPerDay ?? DEFAULT_PUBLISH_PER_DAY
    const log = this.dir.readJson<PublishedFile>(PUBLISHED_FILE, { posts: [] })
    const recent = (Array.isArray(log.posts) ? log.posts : []).filter((t) => typeof t === 'number' && t > now - DAY_SECONDS)
    if (recent.length >= limit) {
      const next = Math.min(...recent) + DAY_SECONDS
      throw new Refusal(`You have published ${recent.length} objects in the last 24 hours, the most your human allows (publishMaxPerDay). The next may go after ${new Date(next * 1000).toISOString()}. Nothing was published.`)
    }
    // An edit replaces by created_at (NIP-01): never sign two versions of one d in the same second.
    const createdAt = Math.max(now, (this.lastPublishedAt.get(d) ?? 0) + 1)
    const event = this.sign(publicObjectTemplate(v.shard, d, createdAt, alt))
    const entry = this.outbox.add(event)
    const result = await this.outbox.send(entry)
    const { address, naddr } = objectPointers(this.pubkey, d, this.relays.urls)
    const refusedWords = entry.refused ? ` Refused by ${Object.entries(entry.refused).map(([u, r]) => `${u}: ${r}`).join('; ')}.` : ''
    if (!entry.accepted.length) {
      // Kept in the outbox, which retries it; it counts against the day only once a relay takes it.
      return {
        text: `Signed "${v.shard.name}" as kind 33331 ${event.id.slice(0, 8)}..., but no relay accepted it yet${result.ok ? '' : `: ${result.reason}`}.${refusedWords} The outbox retries it. Address ${address}.`,
        data: { eventId: event.id, address, naddr, d, name: v.shard.name, replaced: replacing, accepted: [], refused: entry.refused ?? {}, publishedToday: recent.length, maxPerDay: limit },
      }
    }
    this.lastPublishedAt.set(d, createdAt)
    this.dir.writeJson(PUBLISHED_FILE, { posts: [...recent, now] } satisfies PublishedFile)
    const left = Math.max(0, limit - recent.length - 1)
    return {
      text: `Published "${v.shard.name}" to the feed${replacing ? ` under d "${d}" (it replaces any earlier version there)` : ''}: kind 33331 ${event.id.slice(0, 8)}..., ${v.vertices} vertices, ${v.faces} faces, ${v.bytes} bytes. Accepted by ${entry.accepted.join(', ')}.${refusedWords} Address ${address} (naddr ${naddr}). This publishes the object; it does not place it in the world. To hide it at a place, call place with this address. To change it later, publish again with d "${d}". ${left} more today.`,
      data: { eventId: event.id, address, naddr, d, name: v.shard.name, replaced: replacing, accepted: entry.accepted, refused: entry.refused ?? {}, publishedToday: recent.length + 1, maxPerDay: limit },
    }
  }

  /** The created_at last signed per d this run, so two edits in one second still order. */
  private readonly lastPublishedAt = new Map<string, number>()

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

  /**
   * What every tool result says on top of its own answer (arkinox,
   * 2026-10-12): that the operator's orders wait unread, from the
   * background poll, and that the operator tagged the agent in chat. A model
   * deep in a long sweep sees it on its next tool call. Null when there is
   * nothing to say. Counts only; never a message's words.
   */
  notices(): { lines: string[]; newOrders: number; operatorTaggedInChat: number } | null {
    const newOrders = this.operatorChannel.unreadOrders()
    const operatorTaggedInChat = this.chat.unreadSummary().addressedFromOperator
    const lines: string[] = []
    if (newOrders > 0) lines.push(`NEW ORDERS: ${newOrders} message(s) from your operator wait. Call inbox now, before continuing.`)
    if (operatorTaggedInChat > 0) lines.push('Your operator tagged you in chat: call listen.')
    return lines.length ? { lines, newOrders, operatorTaggedInChat } : null
  }

  /** Stop listening, close the sockets, release the lock. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    // A ride computing in the background ends first, its finished leaves flushed to disk (arkinox, 2026-10-11).
    await this.transit.stop()
    // A 👀 already on its way gets a moment to land (arkinox, 2026-10-12). Only when one is: from here to the close nothing yields, so no subscription opens on a closing socket.
    this.operatorChannel.stop()
    if (this.operatorChannel.reacting()) await Promise.race([this.operatorChannel.reactionsSettled(), new Promise((r) => setTimeout(r, 3000).unref())])
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
