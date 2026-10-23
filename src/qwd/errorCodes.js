/**
 * Ack codes this node returns to the manager. Values must match the manager's
 * ErrorCode enum; they were previously inlined as literals throughout
 * RoomServer, which let a `409` slip in where the manager expected `4009`.
 */
export const ErrorCode = Object.freeze({
  OK: 0,
  BAD_REQUEST: 4000,
  NOT_FOUND: 4004,
  CONFLICT: 4009,
  NO_CAPACITY: 4029,
  /** The plan was built from a room snapshot that has since advanced. */
  STALE_PLAN: 4090,
  /** A command handler threw. */
  INTERNAL: 5000
});

/** Build an ack reply body. */
export const fail = (code, message, extra) => ({
  code,
  data: extra === undefined ? { message } : { message, ...extra }
});

export const ok = (data) => (data === undefined ? { code: ErrorCode.OK, data: { accepted: true } } : { code: ErrorCode.OK, data });
