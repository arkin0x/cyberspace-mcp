// budget.ts: what the server may spend this session. Every tool that spends
// work returns its price before spending and refuses above the per-call and
// per-session caps the server was started with (agents note 5.3, rule 7).
// Work is the seconds of proof for a move, and the seconds of key
// derivation above the passive scan height for hide, find and look.
//
// The daily cap (D3, 2026-11-09) bounds what no session cap can: a stdio
// client that starts a fresh process per chat gets a fresh session budget
// each time, so the work of each UTC day is also counted in a file in the
// state directory that survives restarts, and refused above its cap.

import { availableParallelism } from 'node:os'

/** The stranger-safe defaults (D3, 2026-11-09): what a machine whose human never chose gives. */
export const DEFAULT_CAP_CALL_SECONDS = 15
export const DEFAULT_CAP_SESSION_SECONDS = 180
export const DEFAULT_CAP_DAILY_SECONDS = 1800
/** The file in the state directory that counts today's work. */
export const DAILY_BUDGET_FILE = 'budget-daily.json'

/** Worker threads for rides and avatars when the human chose none: two at most, and one core always left free. */
export function defaultThreads(cores: number = availableParallelism()): number {
  return Math.max(1, Math.min(2, cores - 1))
}

/** What the daily file holds: the UTC day (YYYY-MM-DD) and the work spent in it. */
export interface DailyRecord {
  day: string
  spentSeconds: number
}

/** Where the daily record is kept (the state directory, in the server). */
export interface DailyStore {
  read(): unknown
  write(record: DailyRecord): void
}

export interface BudgetOptions {
  /** The most work of one UTC day, across restarts. Default: no daily cap. */
  capDailySeconds?: number
  store?: DailyStore
  /** Unix ms; tests pass a fixed clock. */
  now?: () => number
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

export interface BudgetState {
  capCallSeconds: number
  capSessionSeconds: number
  spentSeconds: number
  remainingSessionSeconds: number
  chatLinesSaid: number
  moves: number
  /** Times the operator's CONTINUE renewed the session budget since the server started. */
  renewals: number
  /** Work spent in sessions that a renewal closed. */
  spentBeforeRenewalsSeconds: number
  /** The daily cap (null: none), today's work (this UTC day, across restarts), what is left, and when it resets (ISO, UTC midnight). */
  capDailySeconds: number | null
  spentTodaySeconds: number
  remainingTodaySeconds: number | null
  dailyResetsAt: string
}

export class Budget {
  spentSeconds = 0
  chatLinesSaid = 0
  moves = 0
  renewals = 0
  spentBeforeRenewalsSeconds = 0

  readonly capDailySeconds: number | null
  private readonly store: DailyStore | null
  private readonly now: () => number
  private today: DailyRecord

  constructor(readonly capCallSeconds: number, readonly capSessionSeconds: number, options: BudgetOptions = {}) {
    this.capDailySeconds = options.capDailySeconds ?? null
    this.store = options.store ?? null
    this.now = options.now ?? Date.now
    const raw = this.store?.read() as Partial<DailyRecord> | null | undefined
    this.today = raw && typeof raw.day === 'string' && typeof raw.spentSeconds === 'number' && Number.isFinite(raw.spentSeconds) && raw.spentSeconds >= 0
      ? { day: raw.day, spentSeconds: raw.spentSeconds }
      : { day: utcDay(this.now()), spentSeconds: 0 }
  }

  /**
   * Today's record, started over when a later UTC day begins. A record of a
   * day after today (the clock went back) is kept as it is: setting the
   * clock back must never hand out a fresh allowance.
   */
  private day(): DailyRecord {
    const d = utcDay(this.now())
    if (d > this.today.day) this.today = { day: d, spentSeconds: 0 }
    return this.today
  }

  /** Seconds of work left today under the daily cap, or Infinity with none. */
  remainingTodaySeconds(): number {
    return this.capDailySeconds === null ? Infinity : Math.max(0, this.capDailySeconds - this.day().spentSeconds)
  }

  /** Seconds of work left before any cap but the per-call one: the session's or today's, whichever is less. */
  remainingSeconds(): number {
    return Math.min(Math.max(0, this.capSessionSeconds - this.spentSeconds), this.remainingTodaySeconds())
  }

  /** When today's allowance starts over: the next UTC midnight, as ISO. */
  dailyResetsAt(): string {
    // The day counted: today, or a later day a clock set back left in the record.
    const d = new Date(`${this.day().day}T00:00:00Z`)
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString()
  }

  /** Why this much work would break the daily cap, or null. Names the cap and how the human raises it. */
  dailyRefusal(seconds: number): string | null {
    if (this.capDailySeconds === null || this.day().spentSeconds + seconds <= this.capDailySeconds) return null
    const left = this.remainingTodaySeconds()
    const hours = Math.max(0, (Date.parse(this.dailyResetsAt()) - this.now()) / 3_600_000)
    return `This would take about ${seconds.toFixed(1)} s, and today's work has ${left.toFixed(1)} s left of the daily cap of ${this.capDailySeconds} s (it counts across restarts and starts over at 00:00 UTC, in about ${hours.toFixed(1)} h). Only your human can raise it: --cap-daily-seconds <n> when starting the server, or capDailySeconds in config.json. Never raise a cap yourself.`
  }

  /** Why spending this many seconds would break a cap, or null when it fits. `callCap` is the caller's own cap for this call, if lower. */
  refusal(seconds: number, callCap?: number): string | null {
    const perCall = callCap === undefined ? this.capCallSeconds : Math.min(callCap, this.capCallSeconds)
    if (seconds > perCall) {
      return `This would take about ${seconds.toFixed(1)} s on this machine, above the ${perCall} s cap for one call${callCap !== undefined && callCap < this.capCallSeconds ? ' you gave' : ' the server was started with'}. Pick a nearer target or a lower height, or ask your human to raise the cap.`
    }
    if (this.spentSeconds + seconds > this.capSessionSeconds) {
      return `This would take about ${seconds.toFixed(1)} s, and the session has ${(this.capSessionSeconds - this.spentSeconds).toFixed(1)} s of its ${this.capSessionSeconds} s left. Ask your human to raise the session cap or start a new session.`
    }
    return this.dailyRefusal(seconds)
  }

  /** A move's proof was computed: count it. */
  spendMove(seconds: number): void {
    this.spendWork(seconds)
    this.moves++
  }

  /** Key derivation above the passive scan height, a hinted sweep, a ride's leaves: work, not a move. Counted for today too, on disk. */
  spendWork(seconds: number): void {
    this.spentSeconds += seconds
    const today = this.day()
    today.spentSeconds += seconds
    this.store?.write({ ...today })
  }

  /**
   * The operator's CONTINUE (KEEP GOING) was read: a fresh session budget of
   * the configured cap begins (arkinox, 2026-10-11). The daily cap is not
   * renewed: only the human raises it, at startup. The cap is never
   * raised, only renewed, and only operator.ts calls this, for a DM sealed by
   * the operator and carrying the CONTINUE tag; nothing the model passes to
   * a tool can.
   */
  renew(): void {
    this.spentBeforeRenewalsSeconds += this.spentSeconds
    this.spentSeconds = 0
    this.renewals++
  }

  state(): BudgetState {
    return {
      capCallSeconds: this.capCallSeconds,
      capSessionSeconds: this.capSessionSeconds,
      spentSeconds: this.spentSeconds,
      remainingSessionSeconds: Math.max(0, this.capSessionSeconds - this.spentSeconds),
      chatLinesSaid: this.chatLinesSaid,
      moves: this.moves,
      renewals: this.renewals,
      spentBeforeRenewalsSeconds: this.spentBeforeRenewalsSeconds,
      capDailySeconds: this.capDailySeconds,
      spentTodaySeconds: this.day().spentSeconds,
      remainingTodaySeconds: this.capDailySeconds === null ? null : this.remainingTodaySeconds(),
      dailyResetsAt: this.dailyResetsAt(),
    }
  }
}
