// Per-profile verification hold state machine.
//
// States: idle -> challenge_detected -> waiting_for_human -> cleared
// `challenge_detected` is set by detection (auto or manual); `waiting_for_human`
// is set by the handoff path and cleared only by an explicit resume (agent or
// user). All transitions are recorded with timestamps for auditability.

export const HOLD_STATUS = {
  IDLE: "idle",
  CHALLENGE_DETECTED: "challenge_detected",
  WAITING_FOR_HUMAN: "waiting_for_human",
  CLEARED: "cleared"
};

const TERMINAL_LIMIT = 50;

export class VerificationHold {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.states = new Map(); // profileName -> state object
    this.transitions = []; // newest first
  }

  _record(profileName, status, challenge, note) {
    const timestamp = new Date(this.now()).toISOString();
    const transition = { profileName, status, challenge, note, timestamp };
    this.transitions.unshift(transition);
    if (this.transitions.length > TERMINAL_LIMIT) this.transitions.length = TERMINAL_LIMIT;
  }

  report(profileName, challenge, { handoff = false } = {}) {
    const status = handoff ? HOLD_STATUS.WAITING_FOR_HUMAN : HOLD_STATUS.CHALLENGE_DETECTED;
    const state = {
      profileName,
      status,
      challenge: challenge ?? null,
      since: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString()
    };
    this.states.set(profileName, state);
    this._record(profileName, status, challenge, handoff ? "handoff requested" : "challenge reported");
    return state;
  }

  handoff(profileName, challenge = null) {
    return this.report(profileName, challenge ?? this.states.get(profileName)?.challenge ?? null, { handoff: true });
  }

  resume(profileName, { reason = "manual" } = {}) {
    const state = {
      profileName,
      status: HOLD_STATUS.CLEARED,
      challenge: null,
      since: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString()
    };
    this.states.set(profileName, state);
    this._record(profileName, HOLD_STATUS.CLEARED, null, reason);
    return state;
  }

  status(profileName) {
    const state = this.states.get(profileName);
    if (!state) {
      return {
        profileName,
        status: HOLD_STATUS.IDLE,
        challenge: null,
        since: null,
        updatedAt: null
      };
    }
    return state;
  }

  isHeld(profileName) {
    const status = this.status(profileName).status;
    return status === HOLD_STATUS.CHALLENGE_DETECTED || status === HOLD_STATUS.WAITING_FOR_HUMAN;
  }

  recentTransitions(limit = 10) {
    return this.transitions.slice(0, Math.min(50, Math.max(1, Number(limit) || 10)));
  }

  reset(profileName) {
    this.states.delete(profileName);
    this._record(profileName, HOLD_STATUS.IDLE, null, "state reset");
  }
}
