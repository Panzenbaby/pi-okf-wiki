// Tiny per-extension session registry: the explicit, unit-testable interface
// for the two-phase command-handler → event-hook handoff. Holds at most one
// pending session of a given kind; `take()` clears the slot atomically.
//
// Two instances exist at runtime (created next to their session types so the
// session types do not have to be imported here, which would create a cycle):
//   - intakeSessionRegistry in update.ts (IntakeSession)
//   - querySessionRegistry in query.ts   (QuerySession)

/** A session entry stored in a {@link SessionRegistry}. */
export interface Session {
  readonly id: string;
}

/**
 * A single-slot registry for a pending session. Owns the handoff between the
 * command handler (producer) and the event hook (consumer). `take()` is
 * atomic: it returns and clears the slot in one step. `set()` returns the
 * displaced session so the caller can finalize/warn about it; callers
 * (`runUpdate`/`runQuery`) drain a pending session at the start of each command
 * so nothing is silently dropped.
 */
export class SessionRegistry<T extends Session> {
  private session: T | undefined;

  /**
   * Store a pending session, returning the previously-pending one (or
   * `undefined` if the slot was empty) so the caller can finalize/warn about
   * the displaced session instead of silently dropping it.
   */
  set(session: T): T | undefined {
    const displaced = this.session;
    this.session = session;
    return displaced;
  }

  /** Remove and return the pending session, or `undefined` if none. */
  take(): T | undefined {
    const session = this.session;
    this.session = undefined;
    return session;
  }

  /** Clear the slot without finalizing. Intended for tests. */
  reset(): void {
    this.session = undefined;
  }
}