// budget.ts: what the server may spend this session. Every tool that spends
// work returns its price before spending and refuses above the per-call and
// per-session caps the server was started with (agents note 5.3, rule 7).
// Work is the seconds of proof for a move, and the seconds of key
// derivation above the passive scan height for hide, find and look.

export interface BudgetState {
  capCallSeconds: number
  capSessionSeconds: number
  spentSeconds: number
  remainingSessionSeconds: number
  chatLinesSaid: number
  moves: number
}

export class Budget {
  spentSeconds = 0
  chatLinesSaid = 0
  moves = 0

  constructor(readonly capCallSeconds: number, readonly capSessionSeconds: number) {}

  /** Why spending this many seconds would break a cap, or null when it fits. `callCap` is the caller's own cap for this call, if lower. */
  refusal(seconds: number, callCap?: number): string | null {
    const perCall = callCap === undefined ? this.capCallSeconds : Math.min(callCap, this.capCallSeconds)
    if (seconds > perCall) {
      return `This would take about ${seconds.toFixed(1)} s on this machine, above the ${perCall} s cap for one call${callCap !== undefined && callCap < this.capCallSeconds ? ' you gave' : ' the server was started with'}. Pick a nearer target or a lower height, or ask your human to raise the cap.`
    }
    if (this.spentSeconds + seconds > this.capSessionSeconds) {
      return `This would take about ${seconds.toFixed(1)} s, and the session has ${(this.capSessionSeconds - this.spentSeconds).toFixed(1)} s of its ${this.capSessionSeconds} s left. Ask your human to raise the session cap or start a new session.`
    }
    return null
  }

  /** A move's proof was computed: count it. */
  spendMove(seconds: number): void {
    this.spentSeconds += seconds
    this.moves++
  }

  /** Key derivation above the passive scan height, or a hinted sweep: work, not a move. */
  spendWork(seconds: number): void {
    this.spentSeconds += seconds
  }

  state(): BudgetState {
    return {
      capCallSeconds: this.capCallSeconds,
      capSessionSeconds: this.capSessionSeconds,
      spentSeconds: this.spentSeconds,
      remainingSessionSeconds: Math.max(0, this.capSessionSeconds - this.spentSeconds),
      chatLinesSaid: this.chatLinesSaid,
      moves: this.moves,
    }
  }
}
