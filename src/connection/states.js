/**
 * Connection lifecycle states. These live in their own module so that feature
 * code (join/move) can reason about session state without importing the
 * session class itself — the old layout made `services/*` depend on
 * `session/ConnectionSession.js`, i.e. a lower layer reaching into a higher one.
 */
export const ConnectionState = Object.freeze({
  CONNECTED: 'CONNECTED',
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  MOVING: 'MOVING',
  CLOSED: 'CLOSED'
});

/** Allowed transitions between states; anything else is a programming error. */
export const TRANSITIONS = Object.freeze({
  [ConnectionState.CONNECTED]: new Set([ConnectionState.PENDING, ConnectionState.CLOSED]),
  [ConnectionState.PENDING]: new Set([ConnectionState.ACTIVE, ConnectionState.CLOSED]),
  [ConnectionState.ACTIVE]: new Set([ConnectionState.MOVING, ConnectionState.CLOSED]),
  [ConnectionState.MOVING]: new Set([ConnectionState.ACTIVE, ConnectionState.CLOSED]),
  [ConnectionState.CLOSED]: new Set()
});
