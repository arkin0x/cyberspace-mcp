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
import { type Plane } from 'cyberspace-core'
import { nip19 } from 'nostr-tools'
import type { Filter } from 'nostr-tools/filter'
import { v2 as nip44 } from 'nostr-tools/nip44'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { normalizeURL } from 'nostr-tools/utils'
import { TICKS_PER_UNIT, readOpacity, ticksOf, toPayload, type ShardModel } from 'sno-core/shards'
import { EYE_FIELD, EYE_REACH, drawnEye, eyeChosen, readEye, type Eye } from 'sno-core/eye'
import { FACE_FIELD, FACE_MODES, drawnFace, readFace, type FaceMode } from 'sno-core/face'
import { Budget, DAILY_BUDGET_FILE, DEFAULT_CAP_DAILY_SECONDS } from './budget.js'
import { ACTION_KIND, chainTemplateProblem, hopTemplate, sidestepTemplate, spawnTemplate } from './chain/builder.js'
import { findDivergence } from './chain/divergence.js'
import { CHAIN_RULES_REVISION, buildChain, chainStatus, newestSpawn, type ActionEvent } from './chain/events.js'
import { Holders } from './chain/holders.js'
import { hopEventProblems, isVersion1Hop } from './chain/hopProofs.js'
import { ProofAborted, proveInThread, type ProofJob, type ProofResult } from './chain/proofWorker.js'
import { ChainKeeper } from './chain/keeper.js'
import { askChainEvents, parsePubkey } from './chain/resolve.js'
import { causeWords, decideSelfCheck } from './chain/selfCheck.js'
import { AVATAR_CONTENT_WARN, AVATAR_KIND, DEFAULT_AVATAR_PER_DAY, avatarContentBytes, avatarTemplate, avatarTooLarge, avatarTooLargeWords, paidShard, verifyAvatar } from './avatar.js'
import { Chat, type ChatLine } from './chat.js'
import {
  CHAT_KIND, HIDDEN_KIND, bagGrowthRefusal, MAX_ABOUT, MAX_ITEM_NAME, bagEntries, carriedTags, hintPlaneFor, namesNoPlane, planeOfEntry, sameHintBox, MAX_MESSAGE_LENGTH, MAX_RIDDLE_LENGTH, OBJECT_KIND, bagSettingsOf, bagTemplate, chestInnerTemplate, heightHint, isReference,
  audioLabel, itemLineage, keyInnerTemplate, messageInnerTemplate, messagePreview, objectTemplate, payloadBytes, referenceCount, referenceTo, rumorOf, shardInnerTemplate, unbag, wantsReference, entryKey,
  type BagEntry, type Hidden, type HiddenType, type KeyItem, type Reference, type Rumor,
} from './hidden/bags.js'
import { MAX_COMMENT_LENGTH, itemKind, sealedComment, type CommentParent, type CommentSubject } from './hidden/comments.js'
import { forgeKey, openWithSecret, openerFor, readContents, requiresLabel, sealEntries, type ChestEntry } from './hidden/chests.js'
import { CASHU_TOKEN, chestStatus, contentLine, contentRow, handle, itemRow, placeWords, purposeOf, takenRow, type ContentRow } from './items.js'
import { hintFits, hintTags, parseHint, hintCandidatesExponent, type HintHeights } from './hidden/hint.js'
import { lookOf } from './hidden/itemModel.js'
import { lookReport, type ChainFacts } from './look.js'
import { attributed, bytesToHex, hexToBytes, nowSeconds, signEvent, tagValue, type EventTemplate, type NostrEvent } from './nostr/event.js'
import { Outbox, type GuardVerdict } from './nostr/outbox.js'
import { unwrapMessage, wrapMessage, wrapReaction } from './nostr/dm.js'
import { mergeAnswers } from './nostr/relayOutcome.js'
import { DEFAULT_RELAY, GENERAL_RELAYS, Relays, isDefaultRelay, normalizeRelay, type PublishResult } from './nostr/relays.js'
import { OperatorWatch, type OperatorMove } from './follow.js'
import { ORDERS_POLL_MS, OperatorChannel, noOperatorWords } from './operator.js'
import { Presence, neighborhoodFilter, sectorsApart, type Person } from './presence.js'
import { ROAM_MAX_MINUTES, ROAM_MIN_MINUTES, Roam, roamCandidates, searchRoam } from './roam.js'
import { profileTemplate, type ProfileFields, MAX_PICTURE_URL, pictureUrl, publishedFields } from './profile.js'
import { objectHandle, renderShard, type NamedView } from './render.js'
import { validateSnoPayload } from './sno.js'
import { DoorStore, MAX_LOOK_BYTES, ROOM_BAG_SETTINGS, roomEntries, roomKey, roomLookupId, type OwnDoor } from './hidden/doors.js'
import { turnModel } from './kits/transform.js'
import { KitLibrary, kitsDirCandidates, type KitQuery } from './kits/library.js'
import type { PlacementInput } from './kits/layout.js'
import { KIT_PUBLISH_REFUSAL, checkLayoutTool, clipWords, kitCall, kitPieceIn, kitPieceTool, kitShard, kitTool, renderLayout } from './kits/tools.js'
import { kitObject } from './kits/transform.js'
import { chosenConstrainOf, walkWords, withAuthoredConstrain } from './walkConstrain.js'
import { DEFAULT_PUBLISH_PER_DAY, MAX_ALT_LENGTH, MAX_NAME_LENGTH, dProblem, newObjectId, objectPointers, publicObjectTemplate } from './publicObject.js'
import { hopCeiling, loadOrMeasure, projectCantorMs, type Calibration } from './space/calibration.js'
import { describePlace, distanceBetween, distanceWords, parseCoordinate, placeFromHex, placeOf, spawnPlace, type CoordinateInput, type Place, type Position } from './space/coords.js'
import { MAX_AVATAR_REACH, apartOnBestAxis, nearestClear, overlapping, spacingFor, type Body } from './space/personalSpace.js'
import { AvatarSizes } from './avatarSizes.js'
import { planSummary, priceNextStep, type Ceilings, type PricedStep } from './space/plan.js'
import { bagInPlane, KeyStore, keyItemOfHeld, planeName, MAX_COMPUTE_HEIGHT, SCAN_MAX_HEIGHT, SCAN_MIN_HEIGHT, sealerOfSeen, type EntrySummary, type HeldItem, type HeldKey, type ItemPlace, type OpenedBag, type SeenChest } from './space/regionKeys.js'
import { StateDir, type HeldLock } from './state/dir.js'
import { Refusal, type ToolResult } from './tool.js'
import { Transit } from './transit.js'
import type { Secret } from './nwc.js'
import { DEFAULT_MAX_DAILY_SATS, DEFAULT_MAX_PAYMENT_SATS, Wallet } from './wallet.js'
import { NOTICE_RELAY, UpdateWatch } from './updates.js'
import { DEFAULT_DELETE_APPROVAL_THRESHOLD, Placements, labelOf } from './placed.js'
import { Builds, cleanLabel, type BuildPiece } from './builds.js'
import { Trash } from './trash.js'
import { Notes } from './notes.js'
import { DEFAULT_TRAVEL_PER_DAY, TravelLog, repeatsPrivate, type TravelLogSettings } from './travel.js'
import type { Progress } from './progress.js'
import { DeleteApprovals, deleteRequestWords, type DeleteApproval, type PaymentApproval } from './approvals.js'
import { Listener, WITHHELD, publishable, scrubSaved, withholdWords } from './listenTo.js'
import type { ListenTo } from './config.js'

export { Refusal, type ToolResult } from './tool.js'

export interface AgentConfig {
  stateDir: string
  /** Where the kits are (kitsDir in config.json, --kits-dir); default the first of <state>/kits and <state>/../kits that holds one (kits/library.ts). */
  kitsDir?: string
  /** The relays, the canonical one first. */
  relays: string[]
  /** The operator's pubkey, npub or hex. */
  operator?: string
  /** "operator": every payment waits for the operator's approval by DM (approvals.ts). */
  paymentApproval?: PaymentApproval
  /** Tests: how long an approval request waits. */
  approvalTtlMs?: number
  /**
   * "operator": a delete that needs approval (more than deleteApprovalThreshold
   * pieces, or a whole bag of things in no build) waits for the operator's code
   * by DM (approvals.ts DeleteApprovals). Default: "operator" when an operator
   * is configured, else "none".
   */
  deleteApproval?: DeleteApproval
  /** How many pieces one delete may take without approval. Default 5. */
  deleteApprovalThreshold?: number
  /** Tests: how long a delete approval request waits. */
  deleteApprovalTtlMs?: number
  /** Whose words reach the model: "everyone" (default) or only the operator's (listenTo.ts). */
  listenTo?: ListenTo
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
  /** This machine's id for the lock (--machine-id); else $CYBERSPACE_MCP_MACHINE_ID, else <state>.machine-id. */
  machineId?: string
  /** The hyperspace line's manifest URL; the default is the NTH headers-v1 manifest. */
  manifestUrl?: string
  /** The most work of one UTC day, counted across restarts in the state directory (D3). Default 1800 s. */
  capDailySeconds?: number
  /** Worker threads for rides (--threads). Default min(2, cores - 1). */
  threads?: number
  /** Tests: the daily cap's clock (unix ms), to cross a UTC midnight. */
  budgetClock?: () => number
  /** Worker threads for a ride; 0 computes on the calling thread. Default: threads. */
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
  /** The most public objects publish_object may publish in any 24 hours (default 20). */
  publishMaxPerDay?: number
  /** The most avatars set_avatar may publish in any 24 hours (default 12). */
  avatarMaxPerDay?: number
  /** How often the server checks for new operator orders on its own, in ms (default 15 s; 0 turns the poll off, for tests). */
  ordersPollMs?: number
  /** Tests: how long a failed 👀 waits before its one retry. */
  reactionRetryMs?: number
  /** Tests only: the key whose update notices are trusted, in place of the compiled-in release key (updates.ts). Never read from a flag or config.json. */
  releasePubkey?: string
  /** Tests only: the version this copy claims to run, in place of package.json's. */
  runningVersion?: string
  /** Where update notices are asked for; default the configured relays and wss://relay.onosendai.tech. */
  noticeRelays?: string[]
}

/** Where publish_object counts what it published, so the daily limit survives a restart. */
const PUBLISHED_FILE = 'published.json'
interface PublishedFile { posts: number[] }
const DAY_SECONDS = 24 * 60 * 60
/** When set_avatar published, for its limit per 24 hours: the times (Unix seconds) a relay took one. */
const AVATARS_FILE = 'avatars-set.json'

/** The highest cube a key is derived for on request (hide, find, look): a key at h16 is about a second. */
export const MAX_KEY_HEIGHT = 16
/** How long a ride's arrival waits for the relays to say who stands at the stop. */
const FIXED_POINT_LOOK_MS = 2000
/** The most candidate regions a hinted sweep will try. */
const MAX_SWEEP_CANDIDATES = 1 << 16
/** The objects opened this session that render can draw by id; the oldest is forgotten past this. */
const OBJECTS_REMEMBERED = 64

/** What the agent is told when the server switched its follow watch off (arkinox, 2026-10-22). */
/**
 * The fields of an agent's payload that were left out because this tool does
 * not know them (sno.ts `ignored`), in words; empty when there were none.
 */
function ignoredNote(ignored: string[], repaired: string[] = [], unknownFace?: string): string {
  const left = ignored.length ? ` Left out, not fields this tool knows (DECK-0003 section 1.1): ${ignored.map((k) => JSON.stringify(k)).join(', ')}.` : ''
  const fixed = repaired.map((k) => (k === 'opacity'
    ? ' "opacity" was not a whole percent from 0 to 100, so it is left out and the object is drawn fully opaque (DECK-0003 1.11).'
    : k === EYE_FIELD
      ? ` "eye" was not three whole numbers of ticks from ${-EYE_REACH} to ${EYE_REACH}, so it is left out: worn as an avatar, it looks from the automatic eye (DECK-0003 1.17).`
      : k === FACE_FIELD
        ? ` "face" was not ${faceNames()}, so it is left out: worn as an avatar, it faces along its path (DECK-0003 1.18).`
        : ' "constrain" was not one of "off", "all" or "opaque", so it is not a choice: the default "opaque" is written (DECK-0003 1.12).')).join('')
  return left + fixed + unknownFaceNote(unknownFace)
}

/** One line for an object at opacity 0 (DECK-0003 1.11, since sno-core 0.1.30): nothing of it is drawn. */
function opacityNote(shard: ShardModel): string {
  return readOpacity(shard.opacity) === 0 ? ' Opacity 0: a reader draws nothing of this object\'s own (DECK-0003 1.11; a glow still shows).' : ''
}

const gib = (n: number): string => String(Math.round(n * 1000) / 1000)

/**
 * What ONOSENDAI does to an avatar or its eye past MAX_AVATAR_REACH (4)
 * gibsons from its origin on an axis (src/lib/avatar.ts; DECK-0003 1.17): it
 * shrinks the shape to reach 4 and the eye with it, then brings the eye
 * straight in toward the origin until it too is within 4, keeping its
 * direction. Words when either happens, else empty. An avatar that places
 * parts is left out: their reach is not fetched here.
 */
function nearerWords(shard: ShardModel, eye: Eye): string {
  if (shard.parts?.length) return ''
  const g = 2 ** shard.unit / TICKS_PER_UNIT
  let reach = 0
  for (const v of shard.vertices) for (const t of ticksOf(v)) reach = Math.max(reach, Math.abs(t))
  const shape = reach * g
  const f = shape > MAX_AVATAR_REACH ? MAX_AVATAR_REACH / shape : 1
  let at = eye.map((t) => t * g * f)
  const m = Math.max(...at.map(Math.abs))
  const pulled = m > MAX_AVATAR_REACH
  if (pulled) at = at.map((x) => (x * MAX_AVATAR_REACH) / m)
  if (f === 1 && !pulled) return ''
  const parts = [
    f < 1 ? `the shape reaches ${gib(shape)} gibsons, so it is drawn at ${gib(f)} of true scale and the eye with it` : '',
    pulled ? `the eye ${f < 1 ? 'is then' : 'reaches past 4 gibsons, so it is'} brought straight in toward your origin` : '',
  ].filter(Boolean)
  return ` ONOSENDAI will draw it nearer: it draws an avatar within ${MAX_AVATAR_REACH} gibsons of its origin on each axis, so ${parts.join(', and ')}, to ${at.map(gib).join(', ')} gibsons from your origin.`
}

/** One line for a `face` shaped like a mode's name that this version does not know (DECK-0003 1.18): carried, and read as "path"; empty when there is none. */
function unknownFaceNote(unknownFace: string | undefined): string {
  return unknownFace === undefined ? '' : ` "face" ${JSON.stringify(unknownFace)} is a facing this version does not know: it is carried as found, since a later revision may define it, and read as "path" (DECK-0003 1.18).`
}

/** The facing names DECK-0003 1.18 gives, in words: "path" or "upright". */
function faceNames(): string {
  return FACE_MODES.map((m) => JSON.stringify(m)).join(' or ')
}

/** What each facing (DECK-0003 1.18) does to a worn avatar as it moves, in words. */
const FACE_WORDS: Record<FaceMode, string> = {
  path: 'path (the default: your front, the payload\'s -Z, points along your last move and tilts with it)',
  upright: 'upright (you turn only about the viewer\'s up and never tilt; a move straight up or down keeps your heading)',
}

/** An avatar's eye (DECK-0003 1.17) in words: "AUTO 0, 159, 0 ticks (0, 1.325, 0 units)", or CHOSEN for one its author wrote. */
function eyeWords(eye: Eye, chosen: boolean): string {
  const units = eye.map((t) => String(Math.round((t / TICKS_PER_UNIT) * 1000) / 1000))
  return `${chosen ? 'CHOSEN' : 'AUTO'} ${eye.join(', ')} ticks (${units.join(', ')} units)`
}

/**
 * The WALK setting an object is written with (DECK-0003 1.12), in words:
 * an authoring tool with no screen reports the setting it writes. The
 * payload's own word, or "opaque" when it gave none (ONOSENDAI #476).
 */
function walkNote(shard: ShardModel): string {
  const chosen = chosenConstrainOf(shard)
  const written = walkWords(withAuthoredConstrain(shard))
  return chosen
    ? ` WALK: ${written}, as the payload says.`
    : ` WALK: ${written}, the default, since the payload chose none; give "constrain": "off" (or "all") in the payload to choose otherwise.`
}

function followOffWords(reason: string): string {
  return `Follow watch switched off: ${reason}. If your STRATEGY asks you to follow or meet your operator, call follow_operator with on: true; otherwise leave it off, and do not message your operator about it.`
}

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
  | { door: DoorInput }

/** A look for a door (DECK-0004 §3.6): a kit piece or an SNO payload, turned and scaled as asked. */
export interface LookInput { kit?: string; object?: unknown; turn?: number; scale?: number }

/** A locked door (DECK-0004 §3.7): what seal_door takes. */
export interface DoorInput { name: string; lock: string; requires?: string; room_height: number; look?: LookInput; open_look?: LookInput }

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

/** The one DM when a STOP begins a halt: short, in the BRIEF style (follow-up to #45). */
export const STOPPED_WORDS = 'Stopped. I\'ll wait for your next message.'

export class Agent {
  readonly pubkey: string
  /** The kits on this machine (kit, kit_piece, check_layout, place and render with kit); read from disk, never published. */
  readonly kits: KitLibrary
  /** The doors this server sealed, with their secrets (keys/doors.json in the state directory, never shown). */
  private readonly doors: DoorStore
  readonly npub: string
  readonly relays: Relays
  readonly keeper: ChainKeeper
  readonly outbox: Outbox
  readonly keys: KeyStore
  readonly chat: Chat
  readonly presence: Presence
  /** Whose words reach the model (listenTo.ts). */
  readonly listener: Listener
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
  /** The release key's update notice: what is out, and the features switched off below its min_safe (updates.ts). */
  readonly updates: UpdateWatch
  /** What the agent placed: listing it, taking it down, moving it (placed.ts). */
  readonly placements: Placements
  /** Which build each placed thing belongs to, in local state only (builds.ts). */
  readonly builds: Builds
  /** The backups every delete writes first (trash.ts). */
  readonly trash: Trash
  /** The operator's approvals of large deletes (approvals.ts). */
  readonly deleteApprovals: DeleteApprovals
  /** The agent's own notes: what it built where, and why (notes.ts). */
  readonly notes: Notes
  /** Restores in flight, by trash entry: one at a time each (review of 485a2df). */
  private readonly restoring = new Map<string, Promise<void>>()
  calibration: Calibration
  private readonly dir: StateDir
  private readonly sk: Uint8Array
  private readonly held: HeldLock
  private readonly release: () => void
  private readonly log: (line: string) => void
  private name: string | null
  private stopped = false
  /** Proofs computing on their threads (chain/proofWorker.ts), each stopped by stop(). */
  private readonly proofs = new Set<AbortController>()
  /**
   * The objects opened this session (found, placed, or inside an opened
   * chest), the newest 64, by the handle find lists (render.ts objectHandle),
   * so render can draw them. In memory
   * only: an object is the region's secret, and bags.json keeps labels, never
   * contents (arkinox, 2026-10-11).
   */
  private readonly objectsSeen = new Map<string, ShardModel>()
  /** Who carries out the operator's STOP on the jobs (the waker, under serve); the ride is paused here whatever it says. */
  onStop: ((targets: string[]) => string[]) | null = null
  /** Unsent chain events dropped because a version 1 hop ahead of them was (dropVersion1Hop): event id to that hop's id, so the outbox can say why. */
  private readonly droppedBehindV1 = new Map<string, string>()
  /** Who marks the unread orders a STOP dropped (the waker, for their ⏹️). */
  onStoppedUnread: ((ids: string[]) => void) | null = null

  private constructor(readonly config: AgentConfig, dir: StateDir, sk: Uint8Array, held: HeldLock, calibration: Calibration) {
    this.dir = dir
    this.sk = sk
    this.held = held
    this.release = () => held.release()
    this.log = config.log ?? (() => {})
    this.pubkey = getPublicKey(sk)
    this.npub = nip19.npubEncode(this.pubkey)
    this.calibration = calibration
    this.kits = new KitLibrary(kitsDirCandidates(config.stateDir, config.kitsDir))
    this.doors = new DoorStore(dir)
    this.name = config.name ?? null
    const urls = config.relays.map((u) => normalizeRelay(u)).filter((u): u is string => !!u)
    if (urls.length === 0) throw new Error('no usable relay URL was given')
    this.relays = new Relays({ urls, signAuth: async (t) => finalizeEvent(t, this.sk), websocketImplementation: config.websocketImplementation, maxWaitMs: config.relayMaxWaitMs, log: this.log, beforePublish: () => held.assert('publish an event') })
    this.holders = new Holders(dir, this.relays.canonical)
    this.keeper = new ChainKeeper(dir, this.relays, this.holders, this.pubkey, this.log)
    this.outbox = new Outbox(dir, this.relays, {
      log: this.log,
      onAccepted: (event, accepted) => {
        if (this.keeper.events.some((e) => e.id === event.id)) {
          this.keeper.markPublished(event.id, 'ok')
          this.holders.note(accepted)
        }
        // A deletion of one of the agent's bags that the canonical relay took on a retry counts as done from then on (placed.ts).
        if (event.kind === 5 && accepted.includes(normalizeURL(this.relays.canonical))) {
          for (const t of event.tags) {
            const m = t[0] === 'a' ? /^33330:([0-9a-f]{64}):(.+)$/.exec(t[1] ?? '') : null
            if (m && m[1] === this.pubkey) this.keys.noteOwnDeletion(m[2], event.created_at, true)
          }
        }
      },
      guard: (event) => this.guardChainEvent(event),
    })
    this.keys = new KeyStore(dir)
    this.budget = new Budget(config.capCallSeconds, config.capSessionSeconds, {
      capDailySeconds: config.capDailySeconds ?? DEFAULT_CAP_DAILY_SECONDS,
      store: { read: () => dir.readJson<unknown>(DAILY_BUDGET_FILE, null), write: (r) => dir.writeJson(DAILY_BUDGET_FILE, r) },
      now: config.budgetClock,
    })
    // The release key's update notice; the operator channel it tells is built below, and is called only after boot.
    this.updates = new UpdateWatch({
      dir, releasePubkey: config.releasePubkey, running: config.runningVersion, now: nowSeconds, log: this.log,
      hasOperator: () => this.operatorOfProfile() !== null && this.operatorProblem() === null,
      tell: (text) => this.operatorChannel.message(text),
    })
    // The wallet talks to its own relays with the connection's own key; nothing of it reaches the agent's relays (wallet.ts, nwc.ts).
    this.wallet = new Wallet(dir, {
      // Below the update notice's min_safe the wallet pays nothing (updates.ts GATED_FEATURES).
      refuse: () => this.updates.off('payments'),
      nwc: config.nwc ?? null, source: config.nwcSource ?? 'the configuration', maxPaymentSats: config.maxPaymentSats ?? DEFAULT_MAX_PAYMENT_SATS, maxDailySats: config.maxDailySats ?? DEFAULT_MAX_DAILY_SATS,
      paymentApproval: config.paymentApproval ?? 'none', approvalTtlMs: config.approvalTtlMs,
      websocketImplementation: config.websocketImplementation, maxWaitMs: config.relayMaxWaitMs, log: this.log, now: config.walletClock, payTimeoutMs: config.walletPayTimeoutMs,
      beforePublish: () => held.assert('send a request to the wallet'),
    })
    this.transit = new Transit(dir, {
      proofInThread: (job, signal) => this.proofInThread(job, signal),
      pubkey: this.pubkey, keeper: this.keeper, budget: this.budget, outbox: this.outbox, canonical: this.relays.canonical,
      calibration: () => this.calibration, sign: (t) => this.sign(t), settle: () => this.settle(), refreshChain: () => this.refreshChain(), log: this.log,
      // The operator channel is built below; these are called only from tool calls and the background, long after.
      undeliverable: () => this.operatorChannel.undeliverable(), messageOperator: (text) => this.operatorChannel.message(text), wallet: this.wallet,
    }, { manifestUrl: config.manifestUrl, fetch: config.lineFetch, threads: config.rideThreads ?? config.threads, now: config.rideClock, hosakaUrl: config.hosakaUrl, hosakaFetch: config.hosakaFetch, hosakaPollMs: config.hosakaPollMs, hosakaQuoteWaitMs: config.hosakaQuoteWaitMs })
    // The operator the human configured, when there is one, else the one the profile names (identity refuses to name another).
    this.listener = new Listener(config.listenTo ?? 'everyone', this.pubkey, () => {
      const configured = this.config.operator ? parsePubkey(this.config.operator) : null
      return [configured ?? this.operatorOfProfile()]
    })
    // Words strangers wrote that the state kept from before are withheld too (listenTo.ts scrubSaved).
    scrubSaved(this.keys, this.listener)
    this.chat = new Chat(dir, this.relays, this.keys, {
      hears: (pubkey) => this.listener.hears(pubkey), operatorOnly: this.listener.operatorOnly,
      pubkey: this.pubkey, name: () => this.name, sign: (t) => this.sign(t), log: this.log,
      // The same operator DMs answer to: the one the profile names, unless the human configured another.
      operator: () => (this.operatorProblem() ? null : this.operatorOfProfile()),
      wakeMinutes: config.chatWakeMinutes,
    })
    this.presence = new Presence(this.relays, this.pubkey, this.log, (pubkey) => this.listener.hears(pubkey))
    this.presence.on('arrival', (p: Person) => this.chat.arrival(p.pubkey))
    this.avatars = new AvatarSizes(this.relays, this.log, Date.now, (pubkey) => this.listener.hears(pubkey))
    // Someone arrives: their avatar is read now, so its size is known before the agent plans a landing near them.
    this.presence.on('arrival', (p: Person) => this.avatars.want([p.pubkey]))
    // Builds, notes, the trash and delete approvals (arkinox, 2026-11-26): local state only, nothing of it published.
    this.builds = new Builds(dir)
    this.trash = new Trash(dir)
    this.notes = new Notes(dir)
    this.deleteApprovals = new DeleteApprovals(dir, config.deleteApproval ?? (config.operator ? 'operator' : 'none'), Date.now, config.deleteApprovalTtlMs)
    this.operatorChannel = new OperatorChannel({
      // The operator's answers to approval requests, checked by the operator channel's seal rules before they get here.
      // A payment's answer is consumed. A delete's is recorded and stays an ordinary message (its code blanked), so the
      // agent hears the answer and, approved, calls delete_build again: nothing else would wake it to.
      answerApproval: (text, createdAt, id) => {
        if (this.wallet.approvals.answer(text, createdAt, id) !== null) return true
        this.deleteApprovals.answer(text, createdAt, id)
        return false
      },
      operatorOnly: this.listener.operatorOnly,
      pubkey: this.pubkey, relays: this.relays, dir, operator: () => this.operatorOfProfile(), operatorProblem: () => this.operatorProblem(), lookupRelays: config.lookupRelays ?? GENERAL_RELAYS,
      sign: (t) => this.sign(t),
      wrap: (recipient, text) => this.assertLock('seal a DM') ?? wrapMessage({ senderSk: this.sk, recipient, text, now: nowSeconds() }),
      unwrap: (wrap) => unwrapMessage(wrap, this.sk),
      // The 👀 on each order, the first time the server sees it (arkinox, 2026-10-12).
      wrapReaction: (recipient, eventId, content, extraTags) => this.assertLock('seal a DM reaction') ?? wrapReaction({ senderSk: this.sk, recipient, eventId, content, extraTags, now: nowSeconds() }),
      // The operator's STOP, carried out by the server, never by a model (arkinox, 2026-10-25).
      onStop: (targets, _id, haltBegan) => { void this.carryOutStop(targets, haltBegan) },
      onStoppedUnread: (ids) => { try { this.onStoppedUnread?.(ids) } catch { /* the jobs' bookkeeping never fails a read */ } },
      reactionRetryMs: config.reactionRetryMs,
      now: nowSeconds, log: this.log, maxWaitMs: config.relayMaxWaitMs,
      // The operator's CONTINUE (KEEP GOING), and only it, renews the session budget (arkinox, 2026-10-11).
      renew: () => {
        const spent = this.budget.spentSeconds
        this.budget.renew()
        this.log(`session budget renewed by the operator's CONTINUE (renewal ${this.budget.renewals})`)
        const ride = this.transit.rideState()
        // A KEEP GOING never renews the daily cap (D3): when today's allowance is what binds, say so instead of promising a fresh session.
        const b = this.budget.state()
        const dailyBinds = b.remainingTodaySeconds !== null && b.remainingTodaySeconds < b.capSessionSeconds
        const daily = dailyBinds ? ` But today's daily cap still binds: ${b.remainingTodaySeconds!.toFixed(1)} s of work left of ${b.capDailySeconds} s until it starts over at ${b.dailyResetsAt}. A KEEP GOING never renews it; only your human raises it (--cap-daily-seconds).` : ''
        const rideWords = ride.state !== 'paused_cap' ? ''
          : this.budget.remainingSeconds() > 0 ? ` Your ride to block ${ride.to} is paused at the cap: call ride with to: ${ride.to} to resume it from the cache.`
            : ` Your ride to block ${ride.to} stays paused at the daily cap until ${b.dailyResetsAt}; then ride with to: ${ride.to} resumes it from the cache.`
        return `Your operator's CONTINUE (KEEP GOING) renewed your session budget: a fresh ${this.budget.capSessionSeconds} s of work (the session before it spent ${spent.toFixed(1)} s). The cap itself is unchanged.${daily}${rideWords}`
      },
    })
    this.follow = new OperatorWatch({
      relays: this.relays, dir,
      operator: () => (this.operatorProblem() ? null : this.operatorOfProfile()),
      follows: () => this.operatorChannel.operatorFollows(),
      // Following belongs to the STRATEGY current when it was turned on (arkinox, 2026-10-22).
      strategy: () => this.operatorChannel.strategy()?.id ?? null,
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
      quiet: (h) => this.quietHidden(h),
      here: () => this.keeper.place(),
      maxHeight: MAX_KEY_HEIGHT, minHeight: SCAN_MIN_HEIGHT, log: this.log,
      // Locked rooms (DECK-0004 §3.7): a move into a room goes into its room bag; the last door of a room that holds things stays.
      roomKeyFor: (at, plane, height, key) => this.roomHeld(at, plane, height, key)?.key ?? key,
      isRoomBag: (lookupId) => this.doors.isRoomBag(lookupId),
      beforeRemove: (ids) => {
        const going = new Set(ids)
        for (const id of ids) {
          const door = this.doors.byId(id)
          // Another door of the room that stays keeps the room reachable.
          if (!door || this.doors.siblings(door).some((d) => !going.has(d.doorId))) continue
          const bag = door.roomLookupId ? this.keys.mine.get(door.roomLookupId) : undefined
          if (bag && !bag.deletedAt) throw new Refusal(`"${door.name}" is the last door of its room, and the room still holds things. Removing it would leave a room bag no door names (DECK-0004 §3.7.8). First take the room's things out (remove_placed each, or remove_placed with whole_bag on one of them), then remove the door. Nothing was changed.`)
        }
      },
      afterRemove: (ids) => { for (const id of ids) this.doors.remove(id) },
      builds: this.builds,
      trash: this.trash,
      deleteGate: {
        threshold: config.deleteApprovalThreshold ?? DEFAULT_DELETE_APPROVAL_THRESHOLD,
        required: () => this.deleteApprovals.required,
        check: (input) => this.deleteGate(input),
        recent: () => this.deleteApprovals.recentDeleted(),
        note: (pieces, approved) => this.deleteApprovals.noteDeleted(pieces, approved),
      },
    })
  }

  /**
   * Whether a delete that needs approval may run (deleteApproval "operator";
   * approvals.ts DeleteApprovals). `spend`: go ahead; the caller calls it
   * inside the bag lock right before signing, and it spends the approval on
   * exactly these pieces then (review of 485a2df), refusing when it no longer
   * holds. `held`: the answer to give, with the request sent to the operator
   * by the server, never with its code. The operator's pending DMs are read
   * first, as inbox reads them, so an answer that came in is counted.
   */
  private async deleteGate(input: { pieces: string[]; needs: string[]; summary: string; again: string }): Promise<{ held: ToolResult } | { spend: () => void }> {
    if (input.needs.length === 0 || !this.deleteApprovals.required) return { spend: () => {} }
    const why = input.needs.join('; ')
    const operator = this.operatorProblem() ? null : this.operatorOfProfile()
    if (!operator) throw new Refusal(`This delete needs your operator's approval (${why}), and deleteApproval is "operator", but there is no operator to ask${this.operatorProblem() ? ` (${this.operatorProblem()})` : ' (identity publishes the operator your human configured)'}. Nothing was deleted.`)
    await this.operatorChannel.readNow()
    const v = this.deleteApprovals.verdict(input.pieces)
    if (v.state === 'approved') {
      const code = v.request.code
      return { spend: () => { if (!this.deleteApprovals.use(code, input.pieces)) throw new Refusal('The approval lapsed or changed before the delete ran. Nothing was deleted.') } }
    }
    if (v.state === 'refused' || v.state === 'expired') {
      this.deleteApprovals.reported(v.request.code)
      throw new Refusal(`Not deleted: ${v.reason}. Ask again (${input.again}, which sends them a new request) only if your operator tells you to.`)
    }
    const request = v.state === 'pending' ? v.request : this.deleteApprovals.request({ pieces: input.pieces, summary: input.summary })
    const minutes = this.deleteApprovals.ttlMinutes
    if (!this.deleteApprovals.notified(request.code)) {
      try {
        await this.operatorChannel.message(deleteRequestWords(request))
        this.deleteApprovals.markNotified(request.code)
      } catch (err) {
        return { held: { text: `Held: this delete needs your operator's approval (${why}), and the request could NOT be sent to them just now (${err instanceof Error ? err.message : String(err)}). Nothing was deleted. ${input.again[0].toUpperCase()}${input.again.slice(1)} to send it again.`, data: { held: true, approvalNeeded: true, needs: input.needs, notified: false } } }
      }
    }
    return {
      held: {
        text: `Held for your operator's approval (${why}): the server ${v.state === 'pending' ? 'already sent' : 'sent'} them what would go and what would stay, by DM, with a code. Nothing was deleted. Their answer comes as a DM: when they approve, ${input.again}; it runs then. If they refuse, or do not answer within ${minutes} minutes, nothing is deleted. The request covers exactly these pieces: if what would go changes, it no longer applies.`,
        data: { held: true, approvalNeeded: true, needs: input.needs, notified: true, expiresAt: request.expiresAt },
      },
    }
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

  /**
   * Whether a relay that accepted the last published profile is one this
   * server still publishes to. False once the configured relays have all
   * changed (the defaults moved off cyberspace.nostr1.com and
   * onosendai.feeds.relay.tools in #95): then nobody reading the current
   * relays finds the profile, its bot flag or its operator.
   */
  private profileOnCurrentRelays(last: ProfileFile): boolean {
    const now = new Set(this.relays.urls)
    return this.profileAccepted(last).some((url) => {
      try { return now.has(normalizeURL(url)) } catch { return false }
    })
  }

  /**
   * Every relay known to hold the last published profile: those profile.json
   * names, and those the outbox has since seen take the same event (its
   * replay at start sends an event the canonical relay has not taken to the
   * current relays, byte for byte, while the outbox still holds it).
   */
  private profileAccepted(last: ProfileFile): string[] {
    // The same profile, whichever signature: the one profile.json names, or a republish the outbox sent on later.
    const tags = JSON.stringify(last.tags)
    const same = this.outbox.entries.filter((e) => e.event.id === last.eventId || (e.event.kind === 0 && e.event.pubkey === this.pubkey && e.event.content === last.content && JSON.stringify(e.event.tags) === tags))
    return [...new Set([...last.accepted, ...same.flatMap((e) => e.accepted)])]
  }

  /** The startup republish while it runs (republishProfileIfMoved): identity waits for it, so the two never write profile.json over each other. */
  private republishing: Promise<unknown> | null = null

  /**
   * At serve start: the last published profile, published again unchanged
   * (its content and tags as they were, signed now) when no relay that
   * accepted it is configured any more, so an agent set up on older relays
   * moves its profile to its current ones without a call to identity. Not
   * when no relay ever accepted it (a refusal is not retried), nor while the
   * profile names another operator than the configured one.
   */
  republishProfileIfMoved(): Promise<{ status: 'unneeded' } | { status: 'published'; eventId: string; accepted: string[]; refused: Record<string, string> } | { status: 'refused'; eventId: string; refused: Record<string, string>; reason: string }> {
    const running = this.republishMoved()
    const settled = running.then(() => undefined, () => undefined)
    this.republishing = settled
    void settled.then(() => { if (this.republishing === settled) this.republishing = null })
    return running
  }

  private async republishMoved(): Promise<{ status: 'unneeded' } | { status: 'published'; eventId: string; accepted: string[]; refused: Record<string, string> } | { status: 'refused'; eventId: string; refused: Record<string, string>; reason: string }> {
    const last = this.dir.readJson<ProfileFile | null>('profile.json', null)
    if (!last || this.profileAccepted(last).length === 0 || this.operatorProblem()) return { status: 'unneeded' }
    // Every current relay refused it already: a refusal is not retried at each start (identity still asks, when called).
    const current = this.relays.urls
    if (current.every((url) => Object.keys(last.refused ?? {}).some((r) => { try { return normalizeURL(r) === url } catch { return false } }))) return { status: 'unneeded' }
    if (this.profileOnCurrentRelays(last)) {
      // The outbox's replay carried the same event to a current relay: profile.json says so too, so doctor names it.
      const accepted = this.profileAccepted(last)
      if (accepted.length > last.accepted.length) this.dir.writeJson('profile.json', { ...last, accepted } satisfies ProfileFile)
      return { status: 'unneeded' }
    }
    const event = this.sign({ kind: 0, created_at: nowSeconds(), content: last.content, tags: last.tags })
    const entry = this.outbox.add(event)
    const result = await this.outbox.send(entry)
    const refused = entry.refused ?? {}
    // profile.json changed meanwhile (identity published another): that one stands.
    const now = this.dir.readJson<ProfileFile | null>('profile.json', null)
    if (now?.eventId === last.eventId) {
      // Taken: profile.json names the new event. Not taken: the old relays' acceptance stays (doctor, visit), and the refusals are noted.
      this.dir.writeJson('profile.json', entry.accepted.length > 0
        ? { content: last.content, tags: last.tags, eventId: event.id, accepted: entry.accepted, refused } satisfies ProfileFile
        : { ...last, refused: { ...(last.refused ?? {}), ...refused } } satisfies ProfileFile)
    }
    return result.ok && entry.accepted.length > 0
      ? { status: 'published', eventId: event.id, accepted: entry.accepted, refused }
      : { status: 'refused', eventId: event.id, refused, reason: result.ok ? 'no relay accepted it' : result.reason }
  }

  /** Whether strangers' chat lines are switched off: this copy is below the update notice's min_safe (updates.ts GATED_FEATURES). */
  private strangersOff(): boolean {
    return this.updates.off('strangerWords') !== null
  }

  /** Copy the operator's DM inbox relays (kind 10050), in the background; a failure is logged and retried by the next DM tool. */
  private syncOperator(): void {
    void this.operatorChannel.sync().catch((err) => this.log(`operator inbox sync: ${err instanceof Error ? err.message : String(err)}`))
  }

  /** Whether the chain's truth is being read from a relay other than the default canonical one. */
  get nonDefaultCanonical(): boolean {
    return !isDefaultRelay(this.relays.canonical)
  }

  /**
   * Open the state directory, take its lock, load or create the key, measure
   * the machine once, replay the outbox, and start listening where the agent
   * stands. Throws LockHeldError when another server holds the directory.
   */
  static async start(config: AgentConfig): Promise<Agent> {
    const dir = StateDir.open(config.stateDir)
    const log = config.log ?? (() => {})
    const held = await dir.lock({ machineId: config.machineId, log })
    try {
      const sk = dir.loadOrCreateKey()
      let calibration = config.calibration
      if (!calibration) {
        const { calibration: c, measured } = loadOrMeasure(dir)
        calibration = c
        log(measured ? `calibrated: hop ceiling h${hopCeiling(c.cantorMsByHeight)}, ${Math.round(c.sha256PerSec / 1000)}k SHA-256/s${c.residue ? `, hop residues ${c.residue.primeUs.toFixed(1)} us per prime and ${c.residue.attemptUs.toFixed(1)} us per re-roll attempt` : ''}` : 'calibration loaded from the state directory')
      }
      const agent = new Agent(config, dir, sk, held, calibration)
      if (agent.nonDefaultCanonical) {
        log(`WARNING: the canonical relay is ${agent.relays.canonical}, not the default ${DEFAULT_RELAY}. The chain's truth (which spawn is newest, where the head is) is read from there. A spawn signed because that relay shows no chain would end a chain this identity has on the default relay. Use this only for a relay that really holds this identity's chain.`)
      }
      await agent.boot()
      // From here on the server notices the operator's orders by itself, mid-turn included (arkinox, 2026-10-12).
      agent.operatorChannel.startPolling(config.ordersPollMs ?? ORDERS_POLL_MS)
      return agent
    } catch (err) {
      held.release()
      throw err
    }
  }

  /**
   * Called once if this server loses its lock (lock.ts: the lock names
   * another owner, or its heartbeat could not be confirmed within the
   * fence). From then on nothing is signed, published or written; the
   * caller stops the server and exits non-zero so its supervisor restarts it.
   */
  onLockLost(cb: (reason: string) => void): void {
    this.held.onLost(cb)
  }

  /** Throws unless this server may write into its state directory (its lock holds): for the waker, which writes beside it. */
  guardWrite(what: string): void {
    this.dir.guard(what)
  }

  /** Throws unless this server still holds its lock; returns undefined, so `this.assertLock(...) ?? next` reads in one expression. */
  private assertLock(what: string): undefined {
    this.held.assert(what)
    return undefined
  }

  private async boot(): Promise<void> {
    // What a crash left signed and unsent goes out first, when the relays show the chain is clear of it.
    const { sent, dropped, waiting } = await this.outbox.replay()
    if (sent.length || dropped.length || waiting.length) this.log(`outbox replay: ${sent.length} sent, ${dropped.length} dropped, ${waiting.length} waiting for the relays`)
    for (const d of dropped) this.log(`dropped ${d.event.id.slice(0, 8)}: ${d.dropped}`)
    // The chain as kept, its hops checked at Level 1 in the background: a sanity check that is logged, never a stop (chain/hopProofs.ts).
    void this.keeper.checkHopProofs().catch((err) => this.log(`hop proof check: ${err instanceof Error ? err.message : String(err)}`))
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
    // The release key's update notices, on the configured relays and the notice relay (updates.ts).
    const noticeRelays = [...new Set([...(this.config.noticeRelays ?? [...this.relays.urls, NOTICE_RELAY])].map((u) => normalizeRelay(u)).filter((u): u is string => !!u).map((u) => normalizeURL(u)))]
    this.updates.start((filter, onEvent) => this.relays.subscribe(filter, onEvent, undefined, noticeRelays))
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
    const behind = this.droppedBehindV1.get(event.id)
    if (behind) {
      this.droppedBehindV1.delete(event.id)
      return { verdict: 'fork', reason: `dropped because the version 1 hop ${behind.slice(0, 8)}... ahead of it on the chain was dropped: this event extends that hop, so it cannot be sent without it (spec 5.13); hop again from where the relays last saw you` }
    }
    if (!this.keeper.events.some((e) => e.id === event.id)) return { verdict: 'fork', reason: 'this event is no longer on the chain this server keeps' }
    if (tagValue(event, 'A') === 'hop' && isVersion1Hop(event)) return this.dropVersion1Hop(event)
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

  /**
   * A version 1 hop (no mn, no mp) left in the outbox by a server that was
   * stopped before this one, with no relay's acceptance on record: never sent
   * by this server. Under the chain rules this server implements it would be
   * a version 1 hop off the exemption list, which ends the chain from it
   * (spec 5.13, 8.7.3). It and every unpublished event after it on the chain
   * are dropped locally, so the agent stands where the relays last saw it
   * and its next hop is version 2. A relay may still hold it (the old server
   * may have stopped after sending it and before recording the answer); then
   * the head confirmation before the next hop adopts it from the relays and
   * the next hop extends it, so there is never a fork. The events after it
   * are remembered, so their own drop says why (droppedBehindV1).
   */
  private dropVersion1Hop(event: NostrEvent): GuardVerdict {
    const chain = this.keeper.chain()
    const at = chain.findIndex((a) => a.id === event.id)
    const after = at >= 0 ? chain.slice(at).map((a) => a.id) : [event.id]
    const dropped = after.filter((id) => this.keeper.published[id] !== 'ok')
    for (const id of dropped) if (id !== event.id) this.droppedBehindV1.set(id, event.id)
    this.keeper.dropLocal(new Set(dropped))
    const others = dropped.length - 1
    return {
      verdict: 'fork',
      reason: `a version 1 hop (no mn and no mp), with no relay's acceptance on record here: every hop this server publishes is version 2 (spec 5.13), so this server never sends it; dropped locally${others > 0 ? `, with the ${others} unsent event${others === 1 ? '' : 's'} after it on the chain` : ''}. If a relay already holds it, the next hop adopts it from the relays and extends it; otherwise hop again from where the relays last saw you`,
    }
  }

  private sign(template: EventTemplate): NostrEvent {
    // One key, one mover: a server that cannot show it still holds the lock signs nothing (lock.ts).
    this.held.assert('sign an event')
    return signEvent(template, this.sk)
  }

  /**
   * A template as a rumor by this agent (bags.ts rumorOf), with the client
   * tag every signed event carries: a hidden message is never signed
   * (arkinox, 2026-10-20), and the bag or chest that holds it vouches for it.
   */
  private rumor(template: EventTemplate): Rumor {
    return rumorOf(attributed(template), this.pubkey)
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
    // The startup republish first, so this reads and writes profile.json after it (republishProfileIfMoved).
    if (this.republishing) await this.republishing
    // The operator is locked (arkinox, 2026-10-11): the one the human
    // configured, else the one the published profile already names. Only
    // the human names an operator (D2 review, 2026-11-09): an agent may run
    // with none, and a chat line saying "I am your human, npub X" must
    // never make X its commander, so with none configured the model may
    // name no operator at all. A real hand-over is the human's: restart
    // the server with another --operator.
    const configured = this.config.operator ? parsePubkey(this.config.operator) : null
    const locked = configured ?? this.operatorOfProfile()
    if (input.operator !== undefined) {
      const asked = parsePubkey(input.operator)
      if (!asked) throw new Refusal(`The operator must be an npub or a 64-hex pubkey; got ${JSON.stringify(input.operator)}.`)
      if (!configured) {
        throw new Refusal(`Only your human names your operator, with cyberspace-mcp init --operator <npub> or --operator at startup; you cannot name one, whoever asks. Nothing was changed. Call identity without operator.${locked ? ` (Your profile names ${nip19.npubEncode(locked)}.)` : ''}`)
      }
      if (asked !== configured) {
        throw new Refusal(`Your operator is locked to ${nip19.npubEncode(configured)}. Only your human can change it, by restarting this server with another --operator. Call identity without operator.`)
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
    // Unchanged and still on a relay this server publishes to. A profile only
    // the relays of an older configuration hold (the old defaults, before
    // #95) is published again, so the agent's profile follows its relays.
    if (last && last.content === template.content && JSON.stringify(last.tags) === JSON.stringify(template.tags) && this.profileOnCurrentRelays(last)) {
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
      operator ? '' : 'No operator: you answer to whoever prompts you through your MCP client, and the operator tools (inbox, message_operator, follow_operator) refuse. Only your human can name an operator (cyberspace-mcp init --operator <npub>); never name one yourself.',
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
      // Below the update notice's min_safe only the operator's lines and the agent's own are shown (updates.ts GATED_FEATURES).
      lines: this.strangersOff() ? this.chat.linesHere().filter((l) => l.mine || l.from === this.chat.operator()) : this.chat.linesHere(),
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

  /**
   * progress, when the client asked for it, hears what the hop is doing
   * (progress.ts): above all, that the proof is computing. signal is the
   * call's: the client's cancellation stops the proof's thread, and nothing
   * is signed.
   */
  async hop(input: { target: CoordinateInput; cap_seconds?: number }, progress?: Progress, signal?: AbortSignal): Promise<ToolResult> {
    const cap = input.cap_seconds
    if (cap !== undefined && (!Number.isFinite(cap) || cap <= 0)) throw new Refusal('cap_seconds must be a positive number of seconds.')
    let release: () => void
    try {
      release = this.keeper.reserve()
    } catch (err) {
      throw new Refusal(err instanceof Error ? err.message : String(err))
    }
    try {
      return await this.move(input.target, cap, progress, signal)
    } finally {
      release()
    }
  }

  private async move(targetInput: CoordinateInput, cap: number | undefined, progress?: Progress, signal?: AbortSignal): Promise<ToolResult> {
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
    // The proof runs on a thread of its own (chain/proofWorker.ts): this one keeps answering other tools and sending progress.
    await progress?.(`computing the proof (a ${step.kind} of h${step.maxHeight}, about ${Math.max(1, Math.round(step.seconds))} s here); other tools keep answering meanwhile`)
    const t0 = performance.now()
    let template: EventTemplate
    try {
      template = await this.prove(step, head, chain[0].id, signal)
    } catch (err) {
      if (!(err instanceof ProofAborted)) throw err
      // The work done is spent all the same; nothing was signed.
      const spent = (performance.now() - t0) / 1000
      this.budget.spendWork(spent)
      throw new Refusal(`The hop was stopped while its proof computed (${spent.toFixed(1)} s of work, charged to the budget). Nothing was signed and you stand where you stood.${spawned ? ' Your spawn was signed and stands.' : ''}`)
    }
    const seconds = (performance.now() - t0) / 1000
    this.budget.spendMove(seconds)
    if (signal?.aborted) throw new Refusal(`The hop was canceled as its proof finished (${seconds.toFixed(1)} s of work); the proof was discarded unsigned.${spawned ? ' Your spawn was signed and stands.' : ''}`)
    await progress?.(`proof done in ${seconds.toFixed(1)} s; confirming the head, then signing and publishing`)

    // Confirm again, immediately before the signature: the machine was busy, and another device may have moved.
    const again = await this.keeper.confirmHead()
    if (again) throw new Refusal(`${again} The proof (${seconds.toFixed(1)} s of work) was discarded unsigned.`)
    if (this.keeper.head()?.id !== head.id) throw new Refusal(`The head moved while the proof was computed: the relays hold a newer move (${this.keeper.head()?.id.slice(0, 8)}...), adopted now. The proof was discarded unsigned; plan again from where you stand.`)
    // Someone may have stepped onto the landing gibson while the proof was computed: asked again from memory.
    const arrived = await this.landingRefusal(step, target, from, false)
    if (arrived) throw new Refusal(`${arrived} They arrived while the proof was computed, so it (${seconds.toFixed(1)} s of work) was discarded unsigned.`)

    const problem = chainTemplateProblem(template, this.pubkey)
    if (problem) throw new Error(`refusing to sign a malformed chain event: ${problem}`)
    // A cancel that came while the head was confirmed is honored here, the last moment before the signature (review of #72).
    if (signal?.aborted) throw new Refusal(`The hop was canceled before it was signed (${seconds.toFixed(1)} s of work); the proof was discarded unsigned and you stand where you stood.${spawned ? ' Your spawn was signed and stands.' : ''}`)
    const event = this.sign(template)
    // Level 1 of the hop as signed, with its own id (spec 5.11): milliseconds, and a hop that fails it is never recorded or sent.
    if (step.kind === 'hop') {
      const failed = hopEventProblems(event)
      if (failed.length) throw new Error(`refusing to publish a hop whose proof fails Level 1 (${failed.join(', ')}); it was signed and discarded, never sent`)
    }
    this.keeper.record(event, 'queued')
    const entry = this.outbox.add(event)
    const result = await this.outbox.send(entry)
    this.settle()
    return this.moveResult(event, seconds, step.work, notes, target, result, step)
  }

  /**
   * The proof of one step, as the template it goes out as: the hop proof or
   * the sidestep proof from cyberspace-core, bound to the head's id,
   * computed on a worker thread (chain/proofWorker.ts) that the signal, or
   * the server stopping, terminates. The caller confirms the head before and
   * after, because this is the work; the template is built here, on this
   * thread, once the values are back.
   *
   * A hop is version 2 (spec 5.9, 5.10, 5.13): computeHopProofV2 builds the
   * trees as version 1 did and seals the residues of hop_n without building
   * hop_n, on Node's BigInt and the core's WASM word kernel (its default in
   * Node, where a synchronous compile is allowed); GMP is not needed here.
   * Only the three tags it returns go into the hop; no version 1 proof_hash
   * is computed or signed.
   */
  private async prove(step: PricedStep, head: ActionEvent, genesisId: string, signal?: AbortSignal): Promise<EventTemplate> {
    const to = step.to
    const from = [head.position.x, head.position.y, head.position.z].map(String) as [string, string, string]
    const target = [to.position.x, to.position.y, to.position.z].map(String) as [string, string, string]
    const proof = await this.proofInThread(step.kind === 'hop'
      ? { kind: 'hop', from, to: target, plane: to.plane, previousId: head.id, maxComputeHeight: this.ceilings().hop }
      : { kind: 'sidestep', from, to: target, plane: to.plane, previousId: head.id }, signal)
    if (proof.kind === 'hop') {
      return hopTemplate({
        createdAt: nowSeconds(), genesisId, previousId: head.id, prevCoordHex: head.coordHex, to: to.position, plane: to.plane,
        seal: proof.seal, mnHex: proof.mnHex, mpHex: proof.mpHex,
      })
    }
    if (proof.kind !== 'sidestep') throw new Error(`the proof thread answered a ${proof.kind} proof for a ${step.kind}`)
    return sidestepTemplate({
      createdAt: nowSeconds(), genesisId, previousId: head.id, prevCoordHex: head.coordHex, to: to.position, plane: to.plane, proofHash: proof.proofHash,
      merkleRoots: proof.merkleRoots, openings: proof.openings, mnHex: proof.mnHex, lcaHeights: proof.lcaHeights,
    })
  }

  /** A proof on its own thread, stopped by the call's signal or by the server stopping (stop() aborts every one in flight). */
  async proofInThread(job: ProofJob, signal?: AbortSignal): Promise<ProofResult> {
    const controller = new AbortController()
    const forward = (): void => controller.abort()
    // A server stopping between the price and the proof starts no thread.
    if (signal?.aborted || this.stopped) controller.abort()
    signal?.addEventListener('abort', forward, { once: true })
    this.proofs.add(controller)
    try {
      return await proveInThread(job, controller.signal)
    } finally {
      this.proofs.delete(controller)
      signal?.removeEventListener('abort', forward)
    }
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
  board(input: { as_of?: number } = {}, signal?: AbortSignal): Promise<ToolResult> {
    return this.transit.board(input, signal)
  }

  /** Ride the line to a block: the work runs in the background, and the ride call after the proof is ready signs the hyperjump (DECK-0001 5). */
  async ride(input: { to?: number; budget_seconds?: number; wait_seconds?: number; as_of?: number; pause?: boolean; cancel?: boolean; forget?: boolean; prover?: 'local' | 'hosaka' } = {}, signal?: AbortSignal): Promise<ToolResult> {
    // After the operator's STOP a ride is held, its proof unsigned and its work kept, until their next message (2026-10-25).
    if (this.operatorChannel.halted() && !input.pause && !input.cancel && !input.forget) {
      throw new Refusal('Held: your operator sent STOP. The ride waits, nothing computed is lost, and nothing is signed until their next message.')
    }
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
    // Quiet: still out of reach, and the one note about it was already invited under this STRATEGY (arkinox, 2026-10-22), so the waker lets it be.
    const quiet = moved !== null && this.follow.unreachableNoted() !== null && this.reachOf(moved) !== null
    const operatorMoved = moved ? { ...this.moveData(moved), quiet } : null
    const movedWords = operatorMoved
      ? quiet
        ? ` Your operator moved: ${operatorMoved.action} to ${operatorMoved.to} (${operatorMoved.distance} from you), still out of your reach; they were already told.`
        : ` Your operator moved: ${operatorMoved.action} to ${operatorMoved.to} (${operatorMoved.distance} from you). Call follow_operator to see the way there.`
      : ''
    const off = this.follow.pendingOff()
    const followSwitchedOff = off ? { at: off.at, reason: off.reason } : null
    // Whether a roam step is due (arkinox, 2026-10-11): from memory, and
    // never while a ride or a move holds the head, so the waker wakes the
    // agent only for a step it can take. Kept, like a move, when the DM
    // question fails.
    const roamDue = this.roaming.due() && this.roamBusy() === null
    const roamWords = roamDue ? ' A roam step is due: call roam for a suggested destination.' : ''
    // Chat heard in the room and not yet listened to (arkinox, 2026-10-11),
    // from memory. Only lines that address the agent (a mention) carry wake,
    // and a stranger's are rate limited in chat.ts; the rest are context.
    const heard = this.chat.unreadSummary()
    // Below the update notice's min_safe, a stranger's line wakes nothing and is not counted (updates.ts GATED_FEATURES).
    const chatHeard = this.strangersOff()
      ? { ...heard, wake: heard.wake === 'stranger' ? null : heard.wake, count: heard.fromOperator, addressed: heard.addressedFromOperator, unaddressed: heard.fromOperator - heard.addressedFromOperator, latestAt: heard.fromOperator ? heard.latestAt : null, strangersOff: true }
      : heard
    const chatWords = chatHeard.addressed > 0
      ? ` Chat: ${chatHeard.addressed} unread line(s) address you${chatHeard.addressedFromOperator ? `, ${chatHeard.addressedFromOperator} from your operator` : ''}: call listen, and answer with say (reply_to the line).`
      : ''
    let result: ToolResult
    try {
      result = await this.operatorChannel.ordersWaiting()
    } catch (err) {
      if ((!operatorMoved && !roamDue && chatHeard.wake === null && !followSwitchedOff) || !(err instanceof Refusal)) throw err
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
    const offWords = followSwitchedOff ? ` ${followOffWords(followSwitchedOff.reason)}` : ''
    // A STOP's halt, so whoever asks sees why nothing starts (follow-up to #45).
    const since = this.operatorChannel.haltedSince()
    const halted = since === null ? null : { since: new Date(since * 1000).toISOString() }
    const haltWords = since === null ? '' : ` ${this.operatorChannel.haltLine()}`
    return { text: `${result.text}${words}${movedWords}${roamWords}${chatWords}${offWords}${haltWords}`, data: { ...result.data, ride, operatorMoved, roamDue, chatHeard, followSwitchedOff, halted } }
  }

  /**
   * Whether the operator's position is out of reach from where the agent
   * stands, from memory and cheap: 'ride' across a wall no hop crosses,
   * 'caps' when the next step toward them is refused by the caps, null
   * otherwise. follow_operator's own answer aims beside them and weighs the
   * landing too; this is only for keeping quiet about a move, and quiet
   * needs follow_operator to have found them out of reach first, so a
   * difference between the two at the edge of reach only delays a wake to
   * the operator's next move.
   */
  private reachOf(m: OperatorMove): 'ride' | 'caps' | null {
    const me = this.keeper.place()
    const there = placeFromHex(m.coordHex)
    if (this.routeRefusal(me, there) !== null) return 'ride'
    const step = priceNextStep(me, there, this.ceilings(), this.calibration)
    return step && this.stepRefusal(step, there) ? 'caps' : null
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
    if (!op) throw new Refusal(noOperatorWords('follow'))
    // Any answer says why the server switched the watch off, so it is told once.
    this.follow.refresh()
    const off = this.follow.pendingOff()
    if (off) this.follow.markOffShown()
    if (input.on === true) this.follow.setOn(true)
    const on = this.follow.on
    if (!on) {
      const why = off ? `Follow watch off: ${off.reason}.` : 'Follow watch off.'
      return { text: `${why} Call follow_operator with on: true to watch your operator's moves and see where they are, when your STRATEGY asks you to follow or meet them.`, data: { on: false, switchedOff: off ? { at: off.at, reason: off.reason } : null } }
    }
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
    // Out of reach: the one note to the operator, once per STRATEGY while it lasts (arkinox, 2026-10-22).
    const reachKind = besideAlready ? null : needsRide ? 'ride' : plan!.data.refused ? 'caps' : null
    const reach = this.follow.noteReach(reachKind)
    const why = needsRide
      ? 'Too far to hop: a coordinate that distant is reached by riding the line to the stop nearest it (station, board, ride).'
      : `Not within your caps: ${plan?.data.refused as string}`
    const advice = besideAlready
      ? 'You already stand just outside your operator\'s avatar: no move is needed.'
      : reach === 'first'
        ? `${why} Only if your STRATEGY asks you to follow or meet your operator, tell them once, in one line with message_operator, what it would take. This is the only note about it: while they stay out of your reach, your waker does not wake you for their moves, and you send no other message about following.`
        : reach === 'already'
          ? `${why} Your operator was already told under this STRATEGY that you cannot reach them: do not message them about it again. While they stay out of your reach, your waker does not wake you for their moves.`
          : `Within your caps: hop with target ${target.hex} to stand just outside their avatar (one step per hop call; plan_hop says how many remain). Moving is your decision, guided by your STRATEGY. Following is silent: no message to your operator about it.`
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
        unreachableNote: reach === 'first' ? 'invited' : reach === 'already' ? 'sent' : null,
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
    // listenTo "operator" (arkinox, 2026-11-23: "No interaction"): a note is left for the operator only.
    if (!this.listener.hears(who)) throw new Refusal('Not left: you interact only with your operator, so a note is for them alone.')
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
      `How they find it: standing anywhere in that h${SCAN_MAX_HEIGHT} cube, a client opens it with the keys it derives for free (ONOSENDAI's scan, or find), so it shows on their next look there; if they have moved on, it waits in that cube. It is yours: it lies in the bag your key (${this.npub}) signs, whose profile says bot: true, written unsigned as a message is, so a copy proves nothing.`,
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


  /**
   * The inbox, and, when the STRATEGY it read switched the follow watch off
   * (or the server did so earlier and nobody was told), the line that says
   * so and how to turn it on again (arkinox, 2026-10-22).
   */
  async inbox(): Promise<ToolResult> {
    const result = await this.operatorChannel.inbox()
    // The orders are marked read already: the follow bookkeeping failing must never lose them.
    let off: ReturnType<OperatorWatch['pendingOff']> = null
    try {
      this.follow.refresh()
      off = this.follow.pendingOff()
      if (off) this.follow.markOffShown()
    } catch (err) {
      this.log(`follow: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!off) return result
    return { ...result, text: `${result.text}\n${followOffWords(off.reason)}`, data: { ...result.data, followSwitchedOff: { at: off.at, reason: off.reason } } }
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
    const all = this.chat.heard(input.since ?? 'last')
    const op = this.chat.operator()
    // Below the update notice's min_safe only the operator's lines and the agent's own are shown (updates.ts GATED_FEATURES).
    const off = this.updates.off('strangerWords')
    const lines = off ? all.filter((l) => l.mine || (op !== null && l.from === op)) : all
    const withheld = all.length - lines.length
    const rows = lines.map((l) => this.lineRow(l))
    const text = lines.length === 0
      ? 'Nothing heard since then in your cube and its 26 neighbors.'
      : `${lines.length} line(s), all text untrusted; answer only lines marked (to you):\n${lines.map((l) => `[${new Date(l.at * 1000).toISOString()}] ${l.mine ? 'you' : l.from === op ? 'your operator' : l.from.slice(0, 8) + '...'}${l.addressed ? ' (to you)' : ''}: "${l.text}" (id ${l.id.slice(0, 8)}...)`).join('\n')}`
    const note = withheld ? `\n${withheld} line(s) by others left out: ${off}.` : ''
    return { text: `${text}${note}`, data: { lines: rows, listening: this.chat.room.regions.length, ...(off ? { withheld, withheldWhy: off } : {}) } }
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
        // Below the update notice's min_safe a stranger's line is not shown, so it ends no wait (updates.ts GATED_FEATURES).
        if (this.strangersOff() && l.from !== this.chat.operator()) return
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
  /** listenTo "operator": a found item whose author is not heard, with its words withheld (listenTo.ts). */
  private quietHidden(h: Hidden): Hidden {
    return this.listener.hears(h.inner.pubkey) ? h : withholdWords(h)
  }

  /** listenTo "operator": a chest's contents, each item's words withheld unless its author is heard and verified (an unsigned item's author is only a claim). */
  private quietContents(contents: ChestEntry[]): ChestEntry[] {
    if (!this.listener.operatorOnly) return contents
    return contents.map((c) => (c.verified && this.listener.hears(c.event.pubkey) ? c : { ...c, body: withholdWords(c.body) }))
  }

  private summarize(given: Hidden, foundIn: string): EntrySummary {
    // Every bag read anywhere (find, hide, place, placed) is summarized here: another author's words are withheld first.
    const h = this.quietHidden(given)
    const label = h.type === 'message' ? messagePreview(h.text ?? '', 80) : h.type === 'shard' ? (h.shard?.name ?? 'shard') : h.type === 'key' ? (h.key?.name ?? 'key') : h.type === 'audio' ? (h.audio ? audioLabel(h.audio) : 'audio') : (h.chest?.name ?? 'chest')
    const summary: EntrySummary = {
      type: h.type, eventId: h.eventId, author: h.inner.pubkey, at: { x: h.at.x.toString(), y: h.at.y.toString(), z: h.at.z.toString() }, plane: h.plane, createdAt: h.createdAt, label,
      ...(namesNoPlane(h) ? { anyPlane: true as const } : {}),
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
        source: h.inner.pubkey === this.pubkey ? 'forged' : 'found', hider: h.inner.pubkey, eventId: h.eventId, place, ...lookOf(h.key), carried: this.listener.hears(h.inner.pubkey) ? carriedTags(h.inner.tags) : [],
      })
      summary.key = { itemPubkey: h.key.itemPubkey, about: h.key.about }
    }
    if (h.chest) {
      const seen: SeenChest = { id: h.eventId, name: h.chest.name, lockPubkey: h.chest.lockPubkey, senderPubkey: h.chest.senderPubkey, requires: h.chest.requires, payload: h.chest.payload, author: h.inner.pubkey, vouches: true, bagAuthor: h.author, place, seenAt: nowSeconds() }
      this.keys.noteChest(seen)
      const opener = openerFor(h.chest, this.keys.heldItems(), this.pubkey)
      if (!opener) {
        summary.chest = { lock: h.chest.lockPubkey, requires: requiresLabel(h.chest), opened: false }
      } else {
        try {
          const secret = opener.by === 'key' ? opener.key.secretHex : bytesToHex(this.sk)
          // Found in a bag, the chest was checked against the bag's signer: it vouches for its rumors.
          const contents = this.quietContents(readContents(openWithSecret(h.chest, secret), h.inner.pubkey))
          summary.chest = {
            lock: h.chest.lockPubkey, requires: requiresLabel(h.chest), opened: true, openedWith: opener.by === 'key' ? 'held item' : 'own key',
            contents: contents.map((c) => ({
              type: c.body.type,
              label: c.body.type === 'message' ? messagePreview(c.body.text ?? '', 80) : c.body.type === 'shard' ? (c.body.shard?.name ?? 'shard') : c.body.type === 'key' ? (c.body.key?.name ?? 'key') : c.body.type === 'audio' ? (c.body.audio ? audioLabel(c.body.audio) : 'audio') : (c.body.chest?.name ?? 'chest'),
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
          source: 'found', hider: c.event.pubkey, eventId: c.id, place: chest.place, from, ...lookOf(c.body.key), carried: !this.listener.operatorOnly || (c.verified && this.listener.hears(c.event.pubkey)) ? carriedTags(c.event.tags) : [],
        })
      }
      if (c.body.chest) {
        this.keys.noteChest({ id: c.id, name: c.body.chest.name, lockPubkey: c.body.chest.lockPubkey, senderPubkey: c.body.chest.senderPubkey, requires: c.body.chest.requires, payload: c.body.chest.payload, author: c.event.pubkey, ...(c.verified ? { vouches: true as const } : {}), bagAuthor: chest.bagAuthor ?? chest.author, place: chest.place, inChest: chest.id, seenAt: nowSeconds() })
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
        if (items.length === 0 && refs === 0) {
          unreadable.push(`bag ${ev.id.slice(0, 8)}... by ${ev.pubkey.slice(0, 8)}... in the h${key.height} cube did not open with the key for that cube, or holds nothing this server reads`)
          continue
        }
        const settings = bagSettingsOf(ev, key.height)
        // One bag holds both planes, and each entry's C says which (spec §7.6
        // Planes): only what stands in this plane is found here. An entry with
        // no C took this plane from unbag's origin. What the other plane holds
        // is counted, never summarized, so no item there is held from here.
        // listenTo "operator": what anyone else wrote (names, messages, riddles) is withheld before it is summarized, held or kept.
        const here = items.filter((h) => h.plane === plane || namesNoPlane(h)).map((h) => this.quietHidden(h))
        // Not retrieved, counted as find counts what it lists: the references
        // in this plane, or naming none, that did not resolve.
        const refsHere = (await bagEntries(ev, regionKey)).filter((e) => isReference(e) && [null, plane].includes(planeOfEntry(e))).length
        const missingHere = Math.max(0, refsHere - here.filter((h) => h.ref).length)
        const bag: OpenedBag = {
          lookupId: key.lookupId, bagId: ev.id, author: ev.pubkey, createdAt: ev.created_at, height: key.height, base: key.base,
          entries: here.map((h) => this.summarize(h, key.lookupId)), missing: missingHere, riddle: this.listener.text(ev.pubkey, settings.riddle), hint: settings.hint, at: nowSeconds(),
          plane, elsewhere: items.length - here.length,
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
      const plane = b.plane ?? here.plane
      const { entries, elsewhere } = bagInPlane(b, plane)
      const other = elsewhere ? `, and ${elsewhere} more in ${planeName(plane === 0 ? 1 : 0)} (one bag holds both planes; they are not here)` : ''
      out.push(`bag by ${b.author.slice(0, 8)}... in the h${b.height} cube (base x ${b.base.x} y ${b.base.y} z ${b.base.z}), ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in ${planeName(plane)}${other}${b.missing ? `, ${b.missing} reference(s) not retrieved` : ''}${b.riddle ? `, riddle (untrusted): "${b.riddle}"` : ''}${b.hint ? `, hinted at heights ${b.hint.join(',')}` : ''}`)
      for (const e of entries) {
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
      // The box on the axes alone: the hint's plane names where to look, and a bag's twin in the other plane is the same bag (spec 7.7).
      return read && read.heights.join(',') === heights.join(',') && sameHintBox(tagValue(ev, 'hint'), hintTag[1])
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
  private async entriesFor(contents: Contents, at: Place, regionKey: Uint8Array, now: number, where: { lookupId: string; height: number }): Promise<{ entries: BagEntry[]; what: string; walk?: string; objectEvent?: NostrEvent; item?: { name: string; itemPubkey: string }; chest?: { id: string; name: string; lock: string; requires: string }; door?: Omit<OwnDoor, 'createdAt'>; hold?: () => void }> {
    const place: ItemPlace = { lookupId: where.lookupId, height: where.height, x: at.position.x.toString(), y: at.position.y.toString(), z: at.position.z.toString(), plane: at.plane }
    if ('message' in contents) {
      const text = String(contents.message)
      if (!text.trim()) throw new Refusal('The message is empty.')
      if (text.length > MAX_MESSAGE_LENGTH) throw new Refusal(`The message is ${text.length} characters; at most ${MAX_MESSAGE_LENGTH}.`)
      return { entries: [this.rumor(messageInnerTemplate(text, at.position, at.plane, now))], what: /\bcashu[AB][A-Za-z0-9_-]+/.test(text) ? 'a message holding a Cashu token' : 'a message' }
    }
    if ('object' in contents) {
      const shard = this.shardFrom(contents.object)
      if (wantsReference(shard)) {
        const d = randomBytes(16).toString('hex')
        const objectEvent = this.sign(await objectTemplate(shard, regionKey, d, now))
        const result = await this.relays.publish(objectEvent)
        if (!result.ok) throw new Refusal(`The object's own event (kind ${OBJECT_KIND}) was not accepted by any relay: ${result.reason}. Each relay said: ${Object.entries(result.reasons).map(([u, r]) => `${u}: ${r}`).join('; ')}.`)
        return { entries: [referenceTo(objectEvent, at.position, at.plane, result.accepted[0] ?? '')], what: `an object by reference (${shard.vertices.length} vertices)`, objectEvent, walk: walkNote(shard) + opacityNote(shard) }
      }
      return { entries: [this.sign(shardInnerTemplate(shard, at.position, at.plane, now))], what: `an object (${shard.vertices.length} vertices, inline)`, walk: walkNote(shard) + opacityNote(shard) }
    }
    if ('key' in contents) {
      const name = String(contents.key.name ?? '').trim().slice(0, MAX_ITEM_NAME)
      if (!name) throw new Refusal('An item needs a name: what the finder sees, and what you seal chests to it by.')
      const key = forgeKey(name, String(contents.key.about ?? '').trim().slice(0, MAX_ABOUT))
      const event = this.sign(keyInnerTemplate(key, at.position, at.plane, now))
      // Forged is held once the bag that hides it is signed (B1 3.1), so chests can be sealed to it before anyone finds it; hide calls `hold` after the bag fits.
      const hold = (): void => { this.keys.holdItem({ itemPubkey: key.itemPubkey, secretHex: key.secretHex, name: key.name, about: key.about, foundIn: where.lookupId, at: now, source: 'forged', hider: this.pubkey, eventId: event.id, place, ...lookOf(key), carried: carriedTags(event.tags) }) }
      return { entries: [event], what: `an item "${key.name}" (public key ${key.itemPubkey})`, item: { name: key.name, itemPubkey: key.itemPubkey }, hold }
    }
    if ('chest' in contents) {
      const name = String(contents.chest.name ?? '').trim().slice(0, MAX_ITEM_NAME)
      if (!name) throw new Refusal('A chest needs a name: what a finder sees before it opens.')
      const lock = this.resolveLock(String(contents.chest.lock ?? ''))
      const inner: Rumor[] = []
      const forged: Array<{ key: KeyItem; event: NostrEvent }> = []
      // Each object sealed in it carries its WALK setting; said back, as for a placed one (DECK-0003 1.12; review of #44, L1).
      const objectWalks: string[] = []
      for (const e of contents.chest.entries ?? []) {
        if ('message' in e) {
          const text = String(e.message)
          if (!text.trim()) throw new Refusal('A message in the chest is empty.')
          if (text.length > MAX_MESSAGE_LENGTH) throw new Refusal(`A message in the chest is ${text.length} characters; at most ${MAX_MESSAGE_LENGTH}.`)
          // A rumor in a chest as in a bag: the chest's signature vouches for it.
          inner.push(this.rumor(messageInnerTemplate(text, at.position, at.plane, now)))
        } else if ('object' in e) {
          const shard = this.shardFrom(e.object)
          inner.push(this.sign(shardInnerTemplate(shard, at.position, at.plane, now)))
          objectWalks.push(`"${shard.name}" ${walkWords(withAuthoredConstrain(shard))}${chosenConstrainOf(shard) ? '' : ' (the default)'}`)
        } else if ('key' in e) {
          const keyName = String(e.key?.name ?? '').trim().slice(0, MAX_ITEM_NAME)
          if (!keyName) throw new Refusal('An item forged into a chest needs a name.')
          const key = forgeKey(keyName, String(e.key.about ?? '').trim().slice(0, MAX_ABOUT))
          const event = this.sign(keyInnerTemplate(key, at.position, at.plane, now))
          inner.push(event)
          forged.push({ key, event })
        } else if ('item' in e) {
          // A copy of an item the agent holds, signed by the agent: the same keypair, so the same chests open for the finder, and the item's own tags (picture, model, motions) as it carried them.
          const held = this.heldItemBy(String(e.item))
          inner.push(this.sign(keyInnerTemplate(keyItemOfHeld(held), at.position, at.plane, now)))
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
      const hold = (): void => { for (const f of forged) {
        this.keys.holdItem({ itemPubkey: f.key.itemPubkey, secretHex: f.key.secretHex, name: f.key.name, about: f.key.about, foundIn: where.lookupId, at: now, source: 'forged', hider: this.pubkey, eventId: f.event.id, place, from: { chestId: event.id, chestName: name }, ...lookOf(f.key), carried: carriedTags(f.event.tags) })
      } }
      const counts = (['message', 'object', 'item'] as const).map((k) => [k, (contents.chest.entries ?? []).filter((e) => k in e || (k === 'item' && 'key' in e)).length] as const).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`)
      return {
        entries: [event],
        what: `a chest "${name}" (id ${handle(event.id)}) sealed to ${lock.words}, holding ${counts.join(', ')}${forged.length ? `; you hold the new item(s) ${forged.map((f) => `"${f.key.name}" (public key ${f.key.itemPubkey})`).join(', ')}` : ''}`,
        chest: { id: event.id, name, lock: lock.pubkey, requires },
        hold,
        ...(objectWalks.length ? { walk: ` WALK for the object(s) sealed in it: ${objectWalks.join('; ')}.` } : {}),
      }
    }
    if ('door' in contents) {
      const d = contents.door
      const name = String(d.name ?? '').trim().slice(0, MAX_ITEM_NAME)
      if (!name) throw new Refusal('A door needs a name: what a finder sees before it opens.')
      const h = Number(d.room_height)
      if (!Number.isInteger(h) || h < 1 || h > where.height) throw new Refusal(`room_height must be a whole number from 1 to the height of the bag that holds the door (${where.height}): a door may not lock a room larger than its own bag's region (DECK-0004 §3.7.1).`)
      const lock = this.resolveLock(String(d.lock ?? ''))
      const secret = this.doors.secretFor(at.position, at.plane, h)
      let sealed
      try { sealed = sealEntries(roomEntries(secret) as BagEntry[], lock.pubkey) } catch (err) { throw new Refusal(err instanceof Error ? err.message : String(err)) }
      const look: string[][] = []
      for (const [which, li] of [['closed', d.look], ['open', d.open_look]] as const) {
        if (!li) continue
        const shard = this.lookShard(li, which)
        const payload = JSON.stringify(toPayload(shard))
        const bytes = new TextEncoder().encode(payload).length
        if (bytes > MAX_LOOK_BYTES) throw new Refusal(`The ${which} look is ${bytes} bytes; a look is at most ${MAX_LOOK_BYTES} (DECK-0004 §3.6 Size).`)
        look.push(which === 'open' ? ['look', payload, 'open'] : ['look', payload])
      }
      const requires = (d.requires ?? (lock.item ? `the ${lock.item.name}` : lock.person ? 'being the one it was sealed for' : '')).trim().slice(0, MAX_ITEM_NAME)
      const event = this.sign(chestInnerTemplate({ name, lockPubkey: lock.pubkey, senderPubkey: sealed.senderPubkey, requires, payload: sealed.payload, look, door: h }, at.position, at.plane, now))
      return {
        entries: [event],
        what: `a locked door "${name}" (id ${handle(event.id)}) sealed to ${lock.words}, locking the h${h} room around it${look.length ? `, with ${look.length === 2 ? 'a closed and an open look' : `a ${d.look ? 'closed' : 'open'} look`}` : ''}. From now on what you place or seal inside that room at height ${h} goes into its room bag, which only someone who opens this door can read; its secret stays in your state directory`,
        door: { doorId: event.id, name, lock: lock.pubkey, at: { x: at.position.x.toString(), y: at.position.y.toString(), z: at.position.z.toString() }, plane: at.plane, height: h, bagHeight: where.height, secret },
      }
    }
    throw new Refusal('contents must be one of: { message }, { object }, { key: { name } }, { chest: { name, lock, entries } }, { door: { name, lock, room_height } }.')
  }

  /** The key for the cube of `height` at `at`, priced against the caps and spent. */
  private regionAt(at: Place, height: number): { key: HeldKey; keyMs: number; regionKey: Uint8Array } {
    if (!Number.isInteger(height) || height < SCAN_MIN_HEIGHT || height > MAX_KEY_HEIGHT) throw new Refusal(`height must be an integer from ${SCAN_MIN_HEIGHT} to ${MAX_KEY_HEIGHT} (h0 is the one gibson, as ONOSENDAI hides and scans; above h${MAX_KEY_HEIGHT} a key costs more than a second).`)
    const priced = this.keysRefusal([height])
    if (priced) throw new Refusal(priced)
    const { result: key, ms: keyMs } = this.deriveKeys([height], () => this.keys.keyAt(at.position, height, 'hide'))
    return { key, keyMs, regionKey: hexToBytes(key.keyHex) }
  }

  async hide(input: { contents: Contents; coordinate: CoordinateInput; height: number; hint_heights?: [number, number, number]; riddle?: string; build?: string }): Promise<ToolResult> {
    const here = this.keeper.place()
    const at = this.target(input.coordinate, here)
    const placeKey = this.regionAt(at, input.height)
    const { keyMs } = placeKey
    let { key, regionKey } = placeKey
    // Inside the room of one of this server's doors, at exactly its height, a placement goes into the room bag (DECK-0004 §3.7.4).
    // A second door of that same room is not inside it: it stands in the ordinary bag like the first (§3.7.5).
    const sameRoomDoor = 'door' in input.contents && Number(input.contents.door.room_height) === input.height
    const inRoomBag = sameRoomDoor ? null : this.roomHeld(at.position, at.plane, input.height, placeKey.key)
    const room = inRoomBag?.door ?? null
    if (inRoomBag && room) {
      if (input.hint_heights || input.riddle) throw new Refusal(`This place is inside the room of your door "${room.name}" at height ${room.height}, so it goes into the room bag, which carries no hint or riddle (DECK-0004 §3.7.2). Leave them out, or hide it at another height.`)
      if ('door' in input.contents && !(Number(input.contents.door.room_height) < room.height)) throw new Refusal(`A door inside the room of "${room.name}" must have a lower height than that room (${room.height}), DECK-0004 §3.7.6.`)
      key = inRoomBag.key
      regionKey = inRoomBag.regionKey
    }
    // One bag per author per region: read before write, never replace; one change to a bag at a time (placed.ts).
    return this.placements.withBags([key.lookupId], async () => {
    const { current, entries: carried } = await this.placements.ownBag(key.lookupId, regionKey)
    const height = input.height
    const now = nowSeconds()
    // The hint is checked before anything is signed or forged, so a refusal leaves no item held that was never hidden.
    const currentSettings = current ? bagSettingsOf(current, height) : null
    const hint = input.hint_heights ?? currentSettings?.hint ?? null
    if (hint && !hintFits(hint, height)) throw new Refusal(`hint_heights ${hint.join(',')} cannot contain a height ${height} region: each must be from ${height} to 85.`)
    const { entries, what, walk, objectEvent, item, chest, door, hold } = await this.entriesFor(input.contents, at, regionKey, now, { lookupId: key.lookupId, height })
    const have = new Set(carried.map(entryKey))
    const merged = [...carried, ...entries.filter((e) => !have.has(entryKey(e)))]
    const riddle = (input.riddle ?? currentSettings?.riddle ?? '').slice(0, MAX_RIDDLE_LENGTH)
    const createdAt = Math.max(now, (current?.created_at ?? 0) + 1, this.placements.floor(key.lookupId))
    // A hint the agent gives now names its plane; one carried forward keeps its own while the bag holds an entry there (spec 7.6 Planes, The hint).
    const hintPlane = input.hint_heights ? at.plane : hintPlaneFor(current, merged, at.plane)
    const template = await bagTemplate(merged, regionKey, key.lookupId, height, createdAt, HIDDEN_KIND, room ? ROOM_BAG_SETTINGS : { heightTag: currentSettings?.heightTag ?? true, hint, riddle, contents: currentSettings?.contents, money: currentSettings?.money }, { at: at.position, plane: hintPlane })
    const bag = this.sign(template)
    // A bag past BAG_SAFE_BYTES is refused before anything is kept or sent, when this write makes it larger (ONOSENDAI lib/bagSize.ts, bagFit.ts growthRefusal):
    // the canonical relay refuses an event past 262,200 bytes, and a chest of up to 131,072 bytes (DECK-0004 §3.2) can bring a bag there. A write that shrinks a bag already past it still goes.
    const tooBig = bagGrowthRefusal(bag, current)
    if (tooBig) throw new Refusal(`${tooBig} The bag at this place already holds ${carried.length} entr${carried.length === 1 ? 'y' : 'ies'}; hide this at another height or place, or make it smaller.`)
    // Items forged now (an item, or items forged into a chest) are held once their bag fits (B1 3.1).
    hold?.()
    // A door's secret is kept the moment its bag is signed, before it is sent: this device sealed it, and nothing else knows it.
    if (door) this.doors.add({ ...door, createdAt })
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
    const recorded = entries[0] ? this.recordPiece(input.build, entries[0], opened, { lookupId: key.lookupId, height, at, createdAt, objectId: objectEvent?.id }) : null
    const text = [
      `Hid ${what} in the h${height} cube at base x ${key.base.x} y ${key.base.y} z ${key.base.z}${room ? `, inside the room of your door "${room.name}": it went into the room bag, which only someone who opens that door can read` : ''} (lookup id ${key.lookupId.slice(0, 12)}...). The bag ${bag.id.slice(0, 8)}... now holds ${merged.length} entr${merged.length === 1 ? 'y' : 'ies'}${current ? ` (${carried.length} carried forward from ${current.id.slice(0, 8)}...)` : ''}. Key cost ${keyMs.toFixed(0)} ms.`,
      accepted.length ? `Accepted by ${accepted.join(', ')}.` : `No relay accepted the bag${result.ok ? '' : `: ${result.reason}`}. It waits in the outbox.`,
      Object.keys(refused).length ? `Refused by ${Object.entries(refused).map(([u, r]) => `${u}: ${r}`).join('; ')} (verbatim; a refusal is not retried).` : '',
      hint ? `Hinted at heights ${hint.join(',')}${riddle ? `, riddle "${riddle}"` : ''}.` : 'No hint: only someone who derives this cube\'s key will find it.',
      walk ? `${walk.trim()}${'object' in input.contents ? ' constrain_placed changes it where it stands.' : ''}` : '',
      `Its id is ${handle(objectEvent ? objectEvent.id : !isReference(entries[0]) ? (entries[0] as NostrEvent).id : objectHandle(`${key.lookupId}/${entryKey(entries[0])}`))}: placed lists it, remove_placed takes it down, move_placed moves it.`,
      recorded ? `Recorded in your build "${recorded.label}" (kept only on this machine).` : '',
    ].filter(Boolean).join('\n')
    return { text, data: { ...(recorded ? { build: recorded.label, id: recorded.id } : {}), bagId: bag.id, lookupId: key.lookupId, cube: { height, base: key.base, plane: at.plane }, ...(room ? { room: { door: room.doorId, name: room.name, height: room.height } } : {}), ...(door ? { door: { id: door.doorId, name: door.name, roomHeight: door.height } } : {}), entries: merged.length, carried: carried.length, keyMs: Math.round(keyMs), accepted, refused, hint, riddle, objectEventId: objectEvent?.id ?? null, ...(item ? { item } : {}), ...(chest ? { chest } : {}) } }
    })
  }

  async place(input: { object?: unknown; address?: string; id?: string; kit?: string; turn?: number; scale?: number; coordinate: CoordinateInput; height: number; build?: string }): Promise<ToolResult> {
    // A kit piece, turned and scaled as asked, goes through the same hide as any payload: building with it, under the build's own name.
    if (input.kit !== undefined) {
      if (input.object !== undefined || input.address !== undefined || input.id !== undefined) throw new Refusal('Give kit alone, or object, address or id: not both.')
      const k = kitCall(() => kitObject(this.kits, String(input.kit), { turn: input.turn, scale: input.scale }))
      const at = this.target(input.coordinate, this.keeper.place())
      const clipped = kitCall(() => clipWords(k.entry, input.turn, input.scale, at.position, input.height))
      if (clipped) throw new Refusal(`Not placed: ${clipped}`)
      const r = await this.hide({ contents: { object: k.payload }, coordinate: input.coordinate, height: input.height, build: input.build })
      return { ...r, text: `Kit piece ${k.entry.id}${k.turn ? ` turned ${k.turn}` : ''}${k.scale ? ` at scale ${k.scale}` : ''}, as "${k.shard.name}": ${r.text}`, data: { ...r.data, kit: { piece: k.entry.id, turn: k.turn, scale: k.scale } } }
    }
    if (input.turn !== undefined || input.scale !== undefined) throw new Refusal('turn and scale go with kit (a kit piece); a payload you give is placed as it is.')
    // An object find or open_chest listed, or one taken from a chest, by its id: its payload is placed as given.
    if (input.id !== undefined && input.object === undefined && input.address === undefined) {
      return this.hide({ contents: { object: publishable(toPayload(this.objectById(input.id).shard) as { name?: unknown }) }, coordinate: input.coordinate, height: input.height, build: input.build })
    }
    if (input.object !== undefined) {
      const v = validateSnoPayload(input.object)
      if (!v.ok) throw new Refusal(`Not placed: the payload is not valid SNO. ${v.errors.join(' ')}`)
      return this.hide({ contents: { object: input.object }, coordinate: input.coordinate, height: input.height, build: input.build })
    }
    if (input.address) {
      const { address, object } = await this.publicObject(input.address)
      if (object.tags.some((t) => t[0] === 'encrypted')) throw new Refusal('That object is sealed to a place of its own; it cannot be placed elsewhere by reference. Place its payload instead.')
      let raw: unknown
      // Not JSON: refused in words of our own, never the parser's, which quote the content (review of #106).
      try { raw = JSON.parse(object.content || 'null') } catch { raw = null }
      const check = validateSnoPayload(raw)
      if (!check.ok) throw new Refusal(`The object at ${address} is not valid SNO: ${this.snoErrors(object.pubkey, check.errors)}`)
      const here = this.keeper.place()
      const at = this.target(input.coordinate, here)
      // Placing another author's public object is a placement (DECK-0003 3.2): a reference entry, carried in the bag.
      return this.hideReference(referenceTo(object, at.position, at.plane, this.relays.canonical), at, input.height, `object "${check.shard.name}" by ${object.pubkey.slice(0, 8)}... (public, by reference)`, input.build)
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
    if (this.listener.hears(object.pubkey)) return { address, object }
    // listenTo "operator": another author's object is drawn, placed or worn, but its name never reaches the model.
    let content = object.content
    try {
      const raw = JSON.parse(object.content || 'null') as unknown
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'name' in raw) content = JSON.stringify({ ...(raw as Record<string, unknown>), name: WITHHELD })
    } catch { /* not JSON: validation says so, in words of its own */ }
    return { address, object: { ...object, content } }
  }

  /** Why a payload is not valid SNO, in words: the validator quotes the payload, so another author's (listenTo "operator") gets one plain sentence. */
  private snoErrors(author: string, errors: string[]): string {
    return this.listener.hears(author) ? errors.join(' ') : 'it does not follow DECK-0003 section 1.9 (details withheld: it was written by someone other than your operator).'
  }

  /** Hide a reference entry in the agent's bag at a cube: the same read-before-write as hide. */
  private async hideReference(ref: Reference, at: Place, height: number, what: string, build?: string): Promise<ToolResult> {
    const cube = this.regionAt(at, height)
    // A reference placed inside one of this server's rooms, at its height, goes into the room bag as anything else does (DECK-0004 §3.7.4).
    const inRoom = this.roomHeld(at.position, at.plane, height, cube.key)
    const { keyMs } = cube
    const key = inRoom?.key ?? cube.key
    const regionKey = inRoom?.regionKey ?? cube.regionKey
    return this.placements.withBags([key.lookupId], async () => {
    const { current, entries: carried } = await this.placements.ownBag(key.lookupId, regionKey)
    const now = nowSeconds()
    const have = new Set(carried.map(entryKey))
    const merged = have.has(entryKey(ref)) ? carried : [...carried, ref]
    const settings = inRoom ? ROOM_BAG_SETTINGS : current ? bagSettingsOf(current, height) : { heightTag: true, hint: null, riddle: '' }
    const createdAt = Math.max(now, (current?.created_at ?? 0) + 1, this.placements.floor(key.lookupId))
    const bag = this.sign(await bagTemplate(merged, regionKey, key.lookupId, height, createdAt, HIDDEN_KIND, settings, { at: at.position, plane: hintPlaneFor(current, merged, at.plane) }))
    // Recorded whole before it is sent, so no later rewrite builds on an older copy, whichever relays take it.
    this.keys.noteOwnBag(key, createdAt, { bagId: bag.id, event: bag })
    const entry = this.outbox.add(bag)
    const result = await this.outbox.send(entry)
    this.keys.notePlaced(key.lookupId, entryKey(ref), createdAt)
    const opened = await unbag(bag, regionKey, (r) => this.resolveReference(r), { at: at.position, plane: at.plane }, height)
    this.keys.noteBag({ lookupId: key.lookupId, bagId: bag.id, author: this.pubkey, createdAt, height, base: key.base, entries: opened.map((h) => this.summarize(h, key.lookupId)), missing: merged.filter(isReference).length - opened.filter((h) => h.ref).length, riddle: settings.riddle, hint: settings.hint, at: now })
    const recorded = this.recordPiece(build, ref, opened, { lookupId: key.lookupId, height, at, createdAt })
    const text = `Placed ${what} in the h${height} cube at base x ${key.base.x} y ${key.base.y} z ${key.base.z}; bag ${bag.id.slice(0, 8)}... holds ${merged.length} entr${merged.length === 1 ? 'y' : 'ies'}. Key cost ${keyMs.toFixed(0)} ms. ${entry.accepted.length ? `Accepted by ${entry.accepted.join(', ')}.` : `No relay accepted it${result.ok ? '' : `: ${result.reason}`}.`}${entry.refused ? ` Refused by ${Object.entries(entry.refused).map(([u, r]) => `${u}: ${r}`).join('; ')}.` : ''} Recorded in your build "${recorded.label}" (kept only on this machine).`
    return { text, data: { build: recorded.label, id: recorded.id, bagId: bag.id, lookupId: key.lookupId, cube: { height, base: key.base, plane: at.plane }, entries: merged.length, keyMs: Math.round(keyMs), accepted: entry.accepted, refused: entry.refused ?? {} } }
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

  /** constrain_placed: set placed shards' WALK setting (and opacity) in place, keeping their lineage (placed.ts). */
  constrainPlaced(input: { target?: string | string[]; type?: string; match?: string; bag?: string; all?: boolean; constrain?: string; opacity?: number }): Promise<ToolResult> {
    return this.placements.constrain(input)
  }

  /**
   * Record what was just placed in the build ledger (builds.ts): under the
   * build named, else the current build, else "unlabelled". Its id and
   * label are what placed lists for it. Returns the build's label. Local
   * state only; nothing of it is published.
   */
  private recordPiece(build: string | undefined, entry: BagEntry, opened: Hidden[], where: { lookupId: string; height: number; at: Place; createdAt: number; objectId?: string }): { label: string; id: string } {
    const ref = isReference(entry) ? entry : null
    const key = entryKey(entry)
    const h = opened.find((x) => (ref ? !!x.ref && entryKey(x.ref) === key : !x.ref && x.inner.id === (entry as NostrEvent).id)) ?? null
    const id = where.objectId ?? (ref ? (h && h.inner.kind === OBJECT_KIND && h.inner.tags.some((t) => t[0] === 'encrypted') ? h.inner.id : objectHandle(`${where.lookupId}/${key}`)) : (entry as NostrEvent).id)
    const piece: BuildPiece = {
      lookupId: where.lookupId, height: where.height, id, lineage: ref ? (ref[0] === 'a' ? ref[1] : null) : itemLineage(entry as NostrEvent),
      type: h ? h.type : 'unreadable', label: h ? labelOf(h) : 'placed', at: { x: where.at.position.x.toString(), y: where.at.position.y.toString(), z: where.at.position.z.toString() }, plane: where.at.plane,
      ...(ref && ref[0] === 'a' ? { objectAddress: ref[1] } : {}), placedAt: where.createdAt,
    }
    try {
      return { label: this.builds.record(build, piece).label, id }
    } catch (err) {
      // The placement went out already: a ledger that cannot be written never fails it; the log says so.
      this.log(`builds: could not record a piece: ${err instanceof Error ? err.message : String(err)}`)
      return { label: this.builds.target(build), id }
    }
  }

  // ---- builds, notes, the trash ------------------------------------------------
  //
  // arkinox, 2026-11-26, after "delete the aerocarnival course" took a
  // 31-piece castle that shared an h9 bag with it: build labels, memory
  // notes, backup-before-delete, scoped deletes, a delete preview with
  // operator approval, and restore. All of it local state; nothing of a
  // build's label or notes is ever published.

  /** builds: every build, with its pieces counted and where they are; from the ledger alone (no relay is asked). */
  buildsList(): ToolResult {
    const all = this.builds.all()
    const current = this.builds.current()
    const rows = all.map((b) => {
      const active = b.pieces.filter((p) => !p.removedAt)
      const cubes = [...new Map(active.map((p) => [p.lookupId, p])).values()]
      return { b, active, removed: b.pieces.length - active.length, cubes }
    })
    const out: string[] = [all.length ? `Your builds: ${all.length}.${current ? ` Current build (where placements go when you name none): "${current.label}".` : ' No current build: placements with no build go to "unlabelled".'}` : 'You have no builds yet. place, hide, forge_item, seal_chest and seal_door take build: a label for what you are building ("aerocarnival course"); build_use sets one for every placement after.']
    for (const r of rows) {
      const where = r.cubes.slice(0, 6).map((p) => `h${p.height} near x ${p.at.x} y ${p.at.y} z ${p.at.z} (bag ${p.lookupId.slice(0, 8)}...)`).join('; ')
      out.push(`  "${r.b.label}" (id ${r.b.id}${current?.id === r.b.id ? ', current' : ''}): ${r.active.length} piece(s) in ${r.cubes.length} bag(s)${r.removed ? `, ${r.removed} removed` : ''}${where ? `: ${where}${r.cubes.length > 6 ? '; ...' : ''}` : ''}${r.b.notes ? `. Notes: ${r.b.notes.split('\n')[0].slice(0, 120)}` : ''}`)
    }
    out.push('Things placed before builds were kept are in no build: build with "unlabelled" lists them. build shows one build\'s pieces checked against what is placed; delete_build takes one build out of your bags and keeps everything else.')
    return {
      text: out.join('\n'),
      data: { current: current ? { id: current.id, label: current.label } : null, builds: rows.map((r) => ({ id: r.b.id, label: r.b.label, notes: r.b.notes, pieces: r.active.length, removed: r.removed, bags: r.cubes.map((p) => ({ lookupId: p.lookupId, height: p.height, near: p.at })), createdAt: r.b.createdAt, updatedAt: r.b.updatedAt })) },
    }
  }

  /** build: one build's pieces, checked against the bags as the relays hold them now (placed.ts buildReport). */
  build(input: { build: string }): Promise<ToolResult> {
    return this.placements.buildReport(String(input.build ?? ''))
  }

  /** build_add: things already placed, recorded under a build (placed.ts buildAdd). */
  buildAdd(input: { build: string; pieces?: string[]; match?: string; bag?: string; move?: boolean }): Promise<ToolResult> {
    return this.placements.buildAdd(input)
  }

  /** build_rename: a build's new label. */
  buildRename(input: { build: string; label: string }): ToolResult {
    const before = this.builds.get(input.build).label
    const b = this.builds.rename(input.build, input.label)
    return { text: `Renamed the build "${before}" to "${b.label}" (id ${b.id}). Its pieces are as they were; only this machine knows the label.`, data: { id: b.id, label: b.label, previous: before } }
  }

  /** build_use: the build later placements go to when they name none; empty clears it. */
  buildUse(input: { build?: string }): ToolResult {
    const existed = cleanLabel(input.build) ? this.builds.find(input.build) !== null : true
    const b = this.builds.use(input.build ?? '')
    if (!b) return { text: 'No current build now: a placement that names no build goes to "unlabelled".', data: { current: null } }
    return { text: `Current build: "${b.label}" (id ${b.id})${existed ? '' : ', a new build'}. Every place, hide, forge_item, seal_chest and seal_door that names no build is recorded in it until you change it (build_use with no build clears it).`, data: { current: { id: b.id, label: b.label }, created: !existed } }
  }

  /** build_notes: set or append to a build's notes. */
  buildNotes(input: { build: string; set?: string; append?: string }): ToolResult {
    if ((input.set === undefined) === (input.append === undefined)) throw new Refusal('Give exactly one of: set (replaces the build\'s notes) or append (adds a line). Nothing was changed.')
    const b = this.builds.setNotes(input.build, input)
    return { text: `Notes of the build "${b.label}" now (${b.notes.length} characters):\n${b.notes || '(empty)'}`, data: { id: b.id, label: b.label, notes: b.notes } }
  }

  /** notes: the agent's general notes file, read, appended to or replaced (notes.ts). */
  notesTool(input: { append?: string; replace?: string }): ToolResult {
    return this.notes.tool(input)
  }

  /** delete_build: take one build (or pieces by id) out of the bags, preview first, approval when needed, backup always (placed.ts). */
  deleteBuild(input: { build?: string; pieces?: string[]; confirm?: boolean }): Promise<ToolResult> {
    return this.placements.deleteBuild(input)
  }

  /** trash: the backups deletes wrote, newest first. */
  trashList(): ToolResult {
    const all = this.trash.list()
    const out = [all.length ? `Trash: ${all.length} backup(s), newest first. Nothing here is ever deleted on its own; restore_build with an id puts its pieces back.` : 'The trash is empty: nothing you placed was deleted since backups were kept.']
    for (const m of all.slice(0, 50)) {
      out.push(`  ${m.id}: ${m.tool}${m.build ? ` of the build "${m.build}"` : ''}, ${m.removed.length} thing(s) from ${m.bags.length} bag(s)${m.bags.some((b) => b.kept.length) ? ` (${m.bags.reduce((n, b) => n + b.kept.length, 0)} stayed)` : ''}: ${m.removed.slice(0, 6).map((r) => `${r.type} "${r.label}"`).join(', ')}${m.removed.length > 6 ? ', ...' : ''}${m.restoredAt ? `. Restored ${m.restoredAt}` : (m.restored ?? []).some((r) => r.ok) ? `. Partly restored (${new Set((m.restored ?? []).filter((r) => r.ok).map((r) => r.from)).size} of ${m.removed.length}); restore_build again tries the rest` : ''}`)
    }
    if (all.length > 50) out.push(`  ... and ${all.length - 50} older.`)
    return { text: out.join('\n'), data: { entries: all.map((m) => ({ id: m.id, createdAt: m.createdAt, tool: m.tool, build: m.build ?? null, removed: m.removed, bags: m.bags.map((b) => ({ lookupId: b.lookupId, height: b.height, wholeBag: b.wholeBag, removed: b.removed.length, kept: b.kept.length })), restoredAt: m.restoredAt ?? null })) } }
  }

  /**
   * restore_build: put back what a delete removed, from the bag the trash
   * keeps (placed.ts restoreFromTrash, review of 485a2df): the original
   * entries verbatim, same ids, merged into the bag as it stands now; a
   * sealed shard whose object was taken down sealed again under a new d; a
   * piece from a locked room only into that room. Each piece is marked in
   * the entry as it lands, so a restore cut short is tried again for the
   * rest only, and a piece already back is never put back twice. One restore
   * of an entry runs at a time. The entry is kept.
   */
  async restoreBuild(input: { trash: string }): Promise<ToolResult> {
    const id = this.trash.read(input.trash).meta.id
    // One restore of an entry at a time: a second waits for the first, then sees what it put back.
    const before = this.restoring.get(id) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((r) => { release = r })
    const tail = before.then(() => mine)
    this.restoring.set(id, tail)
    await before
    try {
      const entry = this.trash.read(id)
      if (entry.pieces.length === 0) throw new Refusal(`The trash entry ${id} holds no piece this server could read (the bag could not be opened when it was deleted), so nothing can be restored from it. Nothing was changed.`)
      const back = new Set((entry.meta.restored ?? []).filter((r) => r.ok).map((r) => r.from))
      if (entry.pieces.every((p) => back.has(p.id))) throw new Refusal(`Everything in the trash entry ${id} is already back (${entry.meta.restoredAt ?? 'restored'}); restoring it again would put back nothing. Nothing was changed.`)
      const done = await this.placements.restoreFromTrash(entry, back, (rs) => { this.trash.markRestored(id, rs) })
      const ok = done.filter((d) => d.ok)
      const failed = done.filter((d) => !d.ok)
      const meta = this.trash.read(id).meta
      if (ok.length === 0) throw new Refusal(`Nothing of ${id} was restored: ${failed.map((d) => `${d.type} "${d.label}": ${d.why}`).join('; ')}. The entry stays in the trash; restore_build tries again for these.`)
      return {
        text: [
          `Restored ${ok.length} thing(s) from ${id} into their bags, as they were (the same entries, merged with what is there now), recorded in their builds: ${ok.map((d) => `${d.type} "${d.label}"${d.id ? ` (id ${d.id.slice(0, 12)})` : ''}${d.why ? `; ${d.why}` : ''}`).join(', ')}.`,
          ...(back.size ? [`Already back before this call: ${back.size}.`] : []),
          ...failed.map((d) => `Not restored: ${d.type} "${d.label}": ${d.why}`),
          meta.restoredAt ? `Every piece is back; the trash entry is kept, marked restored (${meta.restoredAt}).` : 'Not every piece is back: the trash entry is kept, and restore_build with it again tries only the rest.',
        ].join('\n'),
        data: { trashId: id, restored: ok, failed, restoredAt: meta.restoredAt ?? null },
      }
    } finally {
      release()
      if (this.restoring.get(id) === tail) this.restoring.delete(id)
    }
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
      contents = this.quietContents(readContents(openWithSecret(c, opener.by === 'key' ? opener.key.secretHex : bytesToHex(this.sk)), sealerOfSeen(c)))
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
      const looks = r.model ? ` It wears the SNO object ${r.model.address}${r.animation?.length ? ` (${r.animation.join(', ')})` : ''}.` : ''
      lines.push(`- "${r.name}"${r.about ? `: "${r.about}"` : ''}. Public key ${r.itemPubkey}. ${how}, ${placeWords(r.place ?? undefined)}. It ${opens}.${looks}`)
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
      if (b.key) fresh = this.keys.holdItem({ itemPubkey: b.key.itemPubkey, secretHex: b.key.secretHex, name: b.key.name, about: b.key.about, foundIn: c.place.lookupId, at: now, source: 'taken', hider: e.event.pubkey, eventId: e.id, place: c.place, from, ...lookOf(b.key), carried: !this.listener.operatorOnly || (e.verified && this.listener.hears(e.event.pubkey)) ? carriedTags(e.event.tags) : [] }) || fresh
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
  forgeItem(input: { name: string; about?: string; coordinate?: CoordinateInput; height: number; hint_heights?: [number, number, number]; riddle?: string; build?: string }): Promise<ToolResult> {
    return this.hide({ contents: { key: { name: input.name, about: input.about } }, coordinate: input.coordinate ?? { dx: 0, dy: 0, dz: 0 }, height: input.height, hint_heights: input.hint_heights, riddle: input.riddle, build: input.build })
  }

  /** The seal_chest tool: seal things to a public key and hide the chest (B1 3.1). */
  sealChest(input: { name: string; lock: string; requires?: string; contents: ChestContentInput[]; coordinate?: CoordinateInput; height: number; hint_heights?: [number, number, number]; riddle?: string; build?: string }): Promise<ToolResult> {
    return this.hide({ contents: { chest: { name: input.name, lock: input.lock, requires: input.requires, entries: input.contents } }, coordinate: input.coordinate ?? { dx: 0, dy: 0, dz: 0 }, height: input.height, hint_heights: input.hint_heights, riddle: input.riddle, build: input.build })
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
  /** kit: the kits installed here, or the pieces that fit a search (kits/library.ts). Local; nothing is sent. */
  kit(input: KitQuery): ToolResult {
    return kitTool(this.kits, input)
  }

  /** kit_piece: one kit piece in full, and its payload when asked. Local; nothing is sent. */
  kitPiece(input: { piece: string; sno?: boolean; turn?: number; scale?: number }): ToolResult {
    return kitPieceTool(this.kits, input)
  }

  /** check_layout: the kits' rules over a planned build (kits/layout.ts). origin, when given, is read like any coordinate (from where you stand for { dx, dy, dz }). */
  checkLayout(input: { placements: PlacementInput[]; origin?: CoordinateInput; height?: number }): ToolResult {
    const origin = input.origin !== undefined ? this.target(input.origin, this.keeper.place()).position : undefined
    return checkLayoutTool(this.kits, { placements: input.placements, origin, height: input.height })
  }

  /** A door look as a model: a kit piece (turned and scaled by the kit path) or a payload, turned as asked. */
  private lookShard(li: LookInput, which: string): ShardModel {
    if ((li.kit === undefined) === (li.object === undefined)) throw new Refusal(`The ${which} look: give kit (a kit piece) or object (an SNO payload), one of them.`)
    if (li.kit !== undefined) return kitCall(() => kitObject(this.kits, String(li.kit), { turn: li.turn, scale: li.scale })).shard
    const v = validateSnoPayload(typeof li.object === 'string' ? (() => { try { return JSON.parse(li.object as string) } catch { return null } })() : li.object)
    if (!v.ok) throw new Refusal(`The ${which} look is not valid SNO: ${v.errors.join(' ')}`)
    const q = (((Number(li.turn ?? 0) / 90) % 4) + 4) % 4
    if (!Number.isInteger(q)) throw new Refusal(`The ${which} look's turn must be a multiple of 90.`)
    const unit = v.shard.unit + Math.max(0, Math.floor(Number(li.scale ?? 0)))
    if (unit > 84) throw new Refusal(`The ${which} look's scale would put its unit past 84.`)
    return { ...turnModel(v.shard, q), unit }
  }

  /** The room bag's key, when a place at this height is inside the room of one of this server's doors (DECK-0004 §3.7.4); null otherwise. */
  private roomHeld(at: Position, plane: Plane, height: number, key: HeldKey): { key: HeldKey; regionKey: Uint8Array; door: OwnDoor } | null {
    const door = this.doors.roomAt(at, plane, height)
    if (!door) return null
    const rk = roomKey(hexToBytes(key.keyHex), hexToBytes(door.secret))
    const lookupId = roomLookupId(rk)
    this.doors.noteRoom(door, lookupId)
    return { key: { ...key, lookupId, keyHex: bytesToHex(rk) }, regionKey: rk, door }
  }

  /** seal_door: a locked door (DECK-0004 §3.7) hidden like a chest; its room bag takes what is hidden in its room at its height from then on. */
  async sealDoor(input: DoorInput & { coordinate?: CoordinateInput; height: number; hint_heights?: [number, number, number]; riddle?: string; build?: string }): Promise<ToolResult> {
    const { coordinate, height, hint_heights, riddle, build, ...door } = input
    return this.hide({ contents: { door }, coordinate: coordinate ?? { dx: 0, dy: 0, dz: 0 }, height, hint_heights, riddle, build })
  }

  async render(input: { object?: unknown; id?: string; address?: string; kit?: string; turn?: number; scale?: number; layout?: PlacementInput[]; cut?: number; view?: NamedView; yaw?: number; pitch?: number; size?: number; eye?: boolean }): Promise<ToolResult> {
    const given = [input.object, input.id, input.address, input.kit, input.layout].filter((x) => x !== undefined).length
    if (given !== 1) throw new Refusal('Give exactly one of: object (an SNO payload), id (an object find or look listed), address (a public kind 33331), kit (a kit piece) or layout (a planned build of kit pieces).')
    if (input.eye !== undefined && input.layout !== undefined) throw new Refusal('eye goes with one object (object, id, address or kit), not a layout.')
    if (input.layout !== undefined) return renderLayout(this.kits, { layout: input.layout, cut: input.cut, view: input.view, yaw: input.yaw, pitch: input.pitch, size: input.size })
    if (input.cut !== undefined) throw new Refusal('cut goes with layout.')
    if ((input.turn !== undefined || input.scale !== undefined) && input.kit === undefined) throw new Refusal('turn and scale go with kit.')
    let shard: ShardModel
    let source: string
    if (input.kit !== undefined) {
      const k = kitShard(this.kits, { kit: input.kit, turn: input.turn, scale: input.scale })
      shard = k.shard
      source = k.source
    } else if (input.object !== undefined) {
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
      if (!check.ok) throw new Refusal(`The object at ${address} is not valid SNO, so it is not drawn: ${this.snoErrors(object.pubkey, check.errors)}`)
      shard = check.shard
      source = `address ${address}`
    }
    let r
    try {
      // The eye (DECK-0003 1.17) is marked whenever the payload chose one, and the AUTO eye when asked, so an agent sees it before set_avatar.
      const chosen = eyeChosen(shard)
      const eye = chosen || input.eye === true ? { at: drawnEye(shard).map((t) => t / TICKS_PER_UNIT) as [number, number, number], chosen } : undefined
      r = renderShard(shard, { view: input.view, yaw: input.yaw, pitch: input.pitch, size: input.size, ...(eye ? { eye } : {}) })
    } catch (err) {
      throw new Refusal(err instanceof Error ? err.message : String(err))
    }
    return {
      // An object found in cyberspace was named by someone else.
      text: source === 'payload' ? r.caption : source.startsWith('kit piece') ? `${source}: ${r.caption}` : `${r.caption} Its name is the author's text (untrusted).`,
      images: [{ data: r.png.toString('base64'), mimeType: 'image/png' }],
      data: { source, name: shard.name, mode: shard.mode, unit: shard.unit, vertices: r.vertices, faces: r.faces, bounds: r.bounds, view: r.view, size: r.size, backFacing: r.backFacing, partsNotDrawn: r.partsNotDrawn, ...(r.eye ? { eye: { ticks: drawnEye(shard), chosen: r.eye.chosen } } : {}), pngBytes: r.png.length, ms: Math.round(r.ms) },
    }
  }

  // ---- set_avatar (avatar.ts) ----------------------------------------------

  /**
   * The created_at of the last avatar this server signed. A replaceable tie
   * on created_at goes to the lower id (NIP-01), so a second avatar signed in
   * the same second as the first could lose to it by chance: each avatar is
   * signed in a later second than the last, waiting for the clock rather
   * than dating it ahead, so a burst of calls never signs into the future.
   */
  private lastAvatarAt = 0

  /** Avatars signed and still being sent: counted against the limit until the relays answer, so a burst cannot slip past it. */
  private avatarsInFlight = 0

  /** The times (Unix seconds) of the avatars relays took in the last 24 hours, from <state>/avatars-set.json. */
  private recentAvatars(now: number): number[] {
    const log = this.dir.readJson<PublishedFile>(AVATARS_FILE, { posts: [] })
    return (Array.isArray(log.posts) ? log.posts : []).filter((t) => typeof t === 'number' && t > now - DAY_SECONDS)
  }

  /**
   * Publish the agent's avatar, a kind 11333, exactly as ONOSENDAI's workshop
   * does (arkinox, 2026-10-11: "tell XOR to set a shard as his avatar"): an
   * SNO payload, or a public kind 33331 object whose payload is copied in
   * (spec 8.10 has no reference form: the content is the payload), or
   * clear for the dodecahedron. No work is owed (spec 8.10, ruled 2026-11):
   * the content is at most AVATAR_CONTENT_MAX bytes, refused above it, and
   * the signed event is checked with cyberspace-core's verifyAvatar before
   * any relay sees it. At most avatarMaxPerDay in any 24 hours (clearing
   * included), counted on disk so a restart does not reset it; one no relay
   * takes does not count.
   *
   * The payload's `eye` (DECK-0003 1.17, ruled 2026-11-16), where the
   * avatar's own first-person viewer looks from, is published in the
   * version 2 frame (a version 1 payload's Z is flipped with its vertices).
   * `eye: null` is no choice (AUTO, nothing written); any other malformed
   * eye in `object` is refused, since a publisher never writes one, and one
   * in an object copied by address is left out (AUTO, as every reader reads
   * it). The answer says which eye goes out and what ONOSENDAI does to one
   * past its 4-gibson reach, and the picture marks it.
   *
   * The avatar's facing, `face` (DECK-0003 1.18, ruled 2026-11-16), how it
   * turns as it moves: "path" (the default) or "upright". Given as the
   * `face` input it replaces the payload's, from object or from address.
   * "path" writes nothing, as a publisher leaves the default out; "upright"
   * is written into the payload. Any other face, as the input or in
   * `object` when no input is given, is refused, a name this version does
   * not know included, since an agent should write a mode it can name
   * (`face: null` in `object` is no choice, "path", as `eye: null` is). In an
   * object copied by address, a malformed face is left out, so it faces
   * along its path, and a name of the right shape this version does not
   * know is carried as found and read as "path", as an editor carries it.
   * The answer says which facing goes out.
   */
  async setAvatar(input: { object?: unknown; address?: string; clear?: boolean; face?: unknown }): Promise<ToolResult> {
    const given = [input.object, input.address, input.clear ? true : undefined].filter((x) => x !== undefined).length
    if (given !== 1) throw new Refusal('Give exactly one of: object (an SNO payload), address (a public kind 33331 object), or clear: true (the default dodecahedron).')
    const faceWanted = input.face === undefined ? undefined : readFace(input.face)
    if (input.face !== undefined && faceWanted === undefined) throw new Refusal(`Not set: face must be ${faceNames()}, in lower case (DECK-0003 1.18); got ${String(JSON.stringify(input.face)).slice(0, 80)}. Leave it out for "path". Nothing was signed or published.`)
    if (faceWanted !== undefined && input.clear) throw new Refusal('face goes with an avatar (object or address), not with clear: the dodecahedron has no facing. Nothing was signed or published.')
    /** The payload with the input face in place of its own: "path" removes the field, so nothing is written. A copy, so the caller's object is not changed. */
    const withWanted = (raw: unknown): unknown => {
      if (faceWanted === undefined || !raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
      const { [FACE_FIELD]: _old, ...bare } = raw as Record<string, unknown>
      return faceWanted === 'path' ? bare : { ...bare, [FACE_FIELD]: faceWanted }
    }
    let shard: ShardModel | null = null
    let source = 'clear'
    if (input.object !== undefined) {
      let raw = input.object
      if (typeof raw === 'string') {
        try { raw = JSON.parse(raw) } catch { throw new Refusal('object is a string that is not JSON; give the SNO payload as an object.') }
      }
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.hasOwn(raw, EYE_FIELD)) {
        const eyeGiven = (raw as Record<string, unknown>)[EYE_FIELD]
        // Null is no eye chosen: AUTO, and nothing written. A copy, so the caller's object is not changed.
        if (eyeGiven === null) {
          const { [EYE_FIELD]: _none, ...bare } = raw as Record<string, unknown>
          raw = bare
        } else if (readEye(eyeGiven) === undefined) throw new Refusal(`Not set: "eye" must be three whole numbers of ticks (120 a unit), each from ${-EYE_REACH} to ${EYE_REACH} (DECK-0003 1.17); got ${String(JSON.stringify(eyeGiven)).slice(0, 80)}. Leave eye out (or null) for the automatic eye. Nothing was signed or published.`)
      }
      // The face input replaces the payload's, so the payload's is checked only when there is none.
      if (faceWanted === undefined && raw && typeof raw === 'object' && !Array.isArray(raw) && Object.hasOwn(raw, FACE_FIELD)) {
        const faceGiven = (raw as Record<string, unknown>)[FACE_FIELD]
        // Null is no facing chosen: "path", and nothing written, as for the eye. A copy, so the caller's object is not changed.
        if (faceGiven === null) {
          const { [FACE_FIELD]: _none, ...bare } = raw as Record<string, unknown>
          raw = bare
        } else if (readFace(faceGiven) === undefined) throw new Refusal(`Not set: "face" in the payload must be ${faceNames()}, in lower case (DECK-0003 1.18); got ${String(JSON.stringify(faceGiven)).slice(0, 80)}. Leave face out (or null) for "path". Nothing was signed or published.`)
      }
      const v = validateSnoPayload(withWanted(raw))
      if (!v.ok) throw new Refusal(`Not set: the payload is not valid SNO. ${v.errors.join(' ')}`)
      // v.bytes is the content as it is signed: sno-core's toPayload, as avatarTemplate writes it.
      if (avatarTooLarge(v.bytes)) throw new Refusal(`Not set: ${avatarTooLargeWords(v.bytes)}. Use fewer vertices and faces.`)
      const kitHit = kitPieceIn(this.kits, v.shard)
      if (kitHit) throw new Refusal(`Not set: ${kitHit} ${KIT_PUBLISH_REFUSAL}`)
      shard = v.shard
      source = 'payload'
    } else if (input.address !== undefined) {
      const { address, object } = await this.publicObject(String(input.address))
      if (object.tags.some((t) => t[0] === 'encrypted')) throw new Refusal('That object is sealed to a place; an avatar is public. Find it, then give its payload.')
      let raw: unknown
      try { raw = JSON.parse(object.content || 'null') } catch { raw = null }
      const v = validateSnoPayload(withWanted(raw))
      if (!v.ok) throw new Refusal(`The object at ${address} is not valid SNO: ${this.snoErrors(object.pubkey, v.errors)}`)
      if (avatarTooLarge(v.bytes)) throw new Refusal(`Not set: the object at ${address} is too large for an avatar: ${avatarTooLargeWords(v.bytes)}.`)
      shard = publishable(v.shard)
      source = `address ${address} (payload copied: an avatar carries its shape, not a reference${v.repaired.includes(EYE_FIELD) ? '; its malformed eye is left out, so the eye is AUTO' : ''}${v.repaired.includes(FACE_FIELD) ? '; its malformed face is left out, so it faces along its path' : ''}${v.unknownFace !== undefined ? `; its face ${this.listener.hears(object.pubkey) ? JSON.stringify(v.unknownFace) : '(withheld)'} is a facing this version does not know, carried as found and read as path` : ''})`
    }
    // A later second than the last avatar signed here, by waiting (at most a second), never by dating it ahead.
    while (nowSeconds() <= this.lastAvatarAt) await new Promise((r) => setTimeout(r, 100))
    // The limit, checked with nothing awaited between it and the signing, so calls in a burst each see the ones before.
    const limit = this.config.avatarMaxPerDay ?? DEFAULT_AVATAR_PER_DAY
    const recent = this.recentAvatars(nowSeconds())
    if (recent.length + this.avatarsInFlight >= limit) {
      const next = recent.length ? Math.min(...recent) + DAY_SECONDS : nowSeconds() + 1
      const hours = Math.max(0, (next - nowSeconds()) / 3600)
      throw new Refusal(`You have set your avatar ${recent.length + this.avatarsInFlight} times in the last 24 hours, the most your human allows (${limit} a day, avatarMaxPerDay). The next one can go after ${new Date(next * 1000).toISOString()}, in about ${hours.toFixed(1)} h. Nothing was published.`)
    }
    const template: EventTemplate = avatarTemplate(shard, nowSeconds())
    const contentBytes = avatarContentBytes(template.content)
    const event = this.sign(template)
    // The reader's check before any relay sees it: what ONOSENDAI would not draw is never published.
    if (shard) {
      const verdict = verifyAvatar(event)
      if (!verdict.ok || !paidShard(event)) throw new Refusal(`The signed avatar did not verify (${verdict.reason}); nothing was published. This is a bug in the server.`)
    }
    if (event.kind !== AVATAR_KIND) throw new Refusal('internal: not an avatar event')
    this.lastAvatarAt = event.created_at
    const entry = this.outbox.add(event)
    this.avatarsInFlight++
    let result
    try {
      result = await this.outbox.send(entry)
    } finally {
      this.avatarsInFlight--
    }
    // Counted once a relay takes it, as publish_object counts; one kept in the outbox for a retry does not.
    let left: number | null = null
    if (entry.accepted.length) {
      const now = nowSeconds()
      const log = [...this.recentAvatars(now), now]
      this.dir.writeJson(AVATARS_FILE, { posts: log } satisfies PublishedFile)
      left = Math.max(0, limit - log.length - this.avatarsInFlight)
    }
    const leftWords = left === null ? '' : ` ${left} more avatar change${left === 1 ? '' : 's'} in the next 24 hours.`
    // The size the personal-space rule gives the agent's own avatar from now on (space/personalSpace.ts),
    // unless a newer avatar was signed while this one was sent: the newest one is the one relays keep.
    if (entry.accepted.length && event.created_at === this.lastAvatarAt) this.avatars.set(this.pubkey, shard)
    const relayWords = entry.accepted.length ? `Accepted by ${entry.accepted.join(', ')}.` : `No relay accepted it${result.ok ? '' : `: ${result.reason}`}.`
    // Spec 8.10, non-normative: some remote signers (NIP-46) refuse an event this large. This server signs with its own key.
    const warnWords = contentBytes > AVATAR_CONTENT_WARN ? ` Over ${AVATAR_CONTENT_WARN} bytes: a client that signs through a remote signer (NIP-46) may be refused one this large; this server signs with its own key.` : ''
    const refusedWords = entry.refused ? ` Refused by ${Object.entries(entry.refused).map(([u, r]) => `${u}: ${r}`).join('; ')}.` : ''
    if (!shard) {
      return { text: `Avatar cleared: you are drawn as the dodecahedron again (kind 11333 ${event.id.slice(0, 8)}..., empty content). ${relayWords}${refusedWords}${leftWords}`, data: { eventId: event.id, cleared: true, accepted: entry.accepted, refused: entry.refused ?? {}, leftToday: left, maxPerDay: limit } }
    }
    const eye = drawnEye(shard)
    const chosen = eyeChosen(shard)
    const face = drawnFace(shard)
    let r
    try {
      r = renderShard(shard, { eye: { at: eye.map((t) => t / TICKS_PER_UNIT) as [number, number, number], chosen } })
    } catch (err) {
      throw new Refusal(`Published as ${event.id}, but the picture failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return {
      text: `Avatar set: "${shard.name}" (${source}), kind 11333 ${event.id.slice(0, 8)}..., ${contentBytes} bytes of payload, eye ${eyeWords(eye, chosen)}, facing ${FACE_WORDS[face]}.${nearerWords(shard, eye)} ONOSENDAI draws it in place of your dodecahedron wherever you are seen. ${relayWords}${refusedWords}${warnWords}${leftWords} ${r.caption}`,
      images: [{ data: r.png.toString('base64'), mimeType: 'image/png' }],
      data: { eventId: event.id, name: shard.name, source, bytes: contentBytes, eye: { ticks: eye, chosen }, face, accepted: entry.accepted, refused: entry.refused ?? {}, vertices: r.vertices, faces: r.faces, pngBytes: r.png.length, leftToday: left, maxPerDay: limit },
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
    const kitHit = kitPieceIn(this.kits, v.shard)
    if (kitHit) throw new Refusal(`Not published: ${kitHit} ${KIT_PUBLISH_REFUSAL}`)
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
      text: `Published "${v.shard.name}" to the feed${replacing ? ` under d "${d}" (it replaces any earlier version there)` : ''}: kind 33331 ${event.id.slice(0, 8)}..., ${v.vertices} vertices, ${v.faces} faces, ${payloadBytes(v.shard)} bytes.${walkNote(v.shard)}${opacityNote(v.shard)} Accepted by ${entry.accepted.join(', ')}.${refusedWords} Address ${address} (naddr ${naddr}). This publishes the object; it does not place it in the world. To hide it at a place, call place with this address. To change it later, publish again with d "${d}". ${left} more today.${ignoredNote(v.ignored, v.repaired, v.unknownFace)}`,
      data: { eventId: event.id, address, naddr, d, name: v.shard.name, replaced: replacing, accepted: entry.accepted, refused: entry.refused ?? {}, publishedToday: recent.length + 1, maxPerDay: limit, ignored: v.ignored, repaired: v.repaired, constrain: chosenConstrainOf(withAuthoredConstrain(v.shard)) },
    }
  }

  /** The created_at last signed per d this run, so two edits in one second still order. */
  private readonly lastPublishedAt = new Map<string, number>()

  // ---- validate_object, budget, outbox -------------------------------------

  validateObject(input: { payload: unknown }): ToolResult {
    const v = validateSnoPayload(input.payload)
    if (!v.ok) return { text: `Not valid: ${v.errors.join(' ')}`, data: { valid: false, errors: v.errors } }
    // The bytes as place and publish_object write it, with its WALK setting (walkConstrain.ts).
    const bytes = payloadBytes(v.shard)
    const byReference = wantsReference(v.shard)
    return {
      text: `Valid SNO: "${v.shard.name}", ${v.vertices} vertices, ${v.faces} faces, mode ${v.shard.mode}, unit 2^${v.shard.unit} gibsons, ${bytes} bytes on the wire${byReference ? ' (large: it would be hidden by reference)' : ' (small: it would be carried inline)'}.${walkNote(v.shard)}${opacityNote(v.shard)}${eyeChosen(v.shard) ? ` Eye, read only when worn as an avatar (DECK-0003 1.17): ${eyeWords(drawnEye(v.shard), true)}.` : ''}${drawnFace(v.shard) !== 'path' ? ` Facing, read only when worn as an avatar (DECK-0003 1.18): ${FACE_WORDS[drawnFace(v.shard)]}.` : ''}${ignoredNote(v.ignored, v.repaired, v.unknownFace)}`,
      data: { valid: true, name: v.shard.name, vertices: v.vertices, faces: v.faces, mode: v.shard.mode, unit: v.shard.unit, bytes, byReference, ignored: v.ignored, repaired: v.repaired, constrain: chosenConstrainOf(withAuthoredConstrain(v.shard)), ...(eyeChosen(v.shard) ? { eye: drawnEye(v.shard) } : {}), face: drawnFace(v.shard), ...(v.unknownFace !== undefined ? { unknownFace: v.unknownFace } : {}) },
    }
  }

  budgetState(): ToolResult {
    const b = this.budget.state()
    return {
      text: `Work: ${b.remainingSessionSeconds.toFixed(1)} s left of ${b.capSessionSeconds} s this session, at most ${b.capCallSeconds} s per call; ${b.spentSeconds.toFixed(1)} s spent over ${b.moves} move(s) and the keys derived above h${SCAN_MAX_HEIGHT}.${b.capDailySeconds !== null ? ` Today (UTC, across restarts): ${b.spentTodaySeconds.toFixed(1)} s spent, ${b.remainingTodaySeconds!.toFixed(1)} s left of the ${b.capDailySeconds} s daily cap, which starts over at ${b.dailyResetsAt}.` : ''} Chat: ${b.chatLinesSaid} line(s) said, ${this.chat.unpromptedAllowance} unprompted line(s) allowed before the next arrival, one line per 5 s, 500 characters. Sidestep cap h${this.config.maxSidestepHeight}; hop ceiling h${this.ceilings().hop} on this machine.`,
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
   * The operator's STOP (arkinox, 2026-10-25: HOLD becomes a real control):
   * the jobs are stopped first (the waker kills the turn under way and
   * closes them, with ⏹️), then a ride computing in the background is
   * paused, every finished leaf kept. When the STOP begins a halt, the
   * operator gets one short DM (follow-up to #45), so a STOP pressed days
   * ago still says why the agent is idle. Never throws; logs ids, never words.
   */
  async carryOutStop(targets: string[], haltBegan = false): Promise<void> {
    try {
      const stopped = this.onStop?.(targets) ?? []
      this.log(`STOP: ${stopped.length} job(s) stopped`)
    } catch (err) {
      this.log(`STOP: the jobs could not be stopped: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (this.transit.rideState().state === 'computing') {
      try {
        await this.transit.ride({ pause: true })
        this.log('STOP: the ride is paused')
      } catch (err) {
        this.log(`STOP: the ride could not be paused: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (!haltBegan) return
    try {
      await this.operatorChannel.message(STOPPED_WORDS)
    } catch (err) {
      this.log(`STOP: could not tell the operator: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Text sealed with NIP-44 v2 from the agent's key to itself (the
   * conversation key of its own secret and public key, as the self copy of
   * a NIP-17 seal is), for what the server keeps on disk about its jobs
   * (arkinox, 2026-10-25). Only this key opens it.
   */
  sealToSelf(text: string): string {
    return nip44.encrypt(text, nip44.utils.getConversationKey(this.sk, this.pubkey))
  }

  /** Open what sealToSelf sealed. Throws when it is not this key's. */
  openFromSelf(payload: string): string {
    return nip44.decrypt(payload, nip44.utils.getConversationKey(this.sk, this.pubkey))
  }

  /**
   * The operator's unread lines in local chat that address the agent: its
   * orders from the room (arkinox, 2026-10-25), by the signature's word
   * (fromOperator), never the text's. Words are untrusted chat text, read
   * as orders only because the operator's key said them.
   */
  operatorChatOrders(): Array<{ id: string; at: number; text: string }> {
    const op = this.chat.operator()
    // The rule a DM order needs holds here too: the operator follows the agent (kind 3), by the newest check.
    if (!op || !this.operatorChannel.followedNow()) return []
    return this.chat.lines.filter((l) => l.unread && !l.mine && l.addressed && l.from === op).map((l) => ({ id: l.id, at: l.at, text: l.text }))
  }

  /**
   * A job's status on the order it came from (arkinox, 2026-10-25), always
   * private: the NIP-17 kind 7 the 👀 is, to the operator, content the
   * emoji, e the order's id (a DM's rumor id, or a chat line's id with
   * ["k", "23333"] marking the channel). Never a public event: what the
   * agent was told in the room stays in the room.
   */
  jobStatus(order: { id: string; channel: 'dm' | 'chat' }, emoji: string): Promise<void> {
    return this.operatorChannel.status(order.id, emoji, order.channel === 'chat' ? [['k', String(CHAT_KIND)]] : [])
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
    // The release key's update notice, rate limited (updates.ts): never its note, only the version and what is off.
    const update = this.updates.line()
    if (update) lines.push(update)
    return lines.length ? { lines, newOrders, operatorTaggedInChat } : null
  }

  /** Stop listening, close the sockets, release the lock. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    // A proof computing on its thread is stopped; the move it was for is refused, nothing signed.
    for (const p of this.proofs) p.abort()
    // A ride computing in the background ends first, its finished leaves flushed to disk (arkinox, 2026-10-11).
    await this.transit.stop()
    // A 👀 already on its way gets a moment to land (arkinox, 2026-10-12). Only when one is: from here to the close nothing yields, so no subscription opens on a closing socket.
    this.operatorChannel.stop()
    if (this.operatorChannel.reacting()) await Promise.race([this.operatorChannel.reactionsSettled(), new Promise((r) => setTimeout(r, 3000).unref())])
    this.wallet.stop()
    this.updates.stop()
    this.outbox.stop()
    this.follow.stop()
    this.operatorChannel.stop()
    this.chat.stop()
    this.presence.stop()
    this.relays.close()
    this.release()
  }
}
