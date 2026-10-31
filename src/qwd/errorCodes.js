export const ErrorCode = Object.freeze({
  OK: 0,
  BAD_REQUEST: 4000,
  NOT_FOUND: 4004,
  CONFLICT: 4009,
  NO_CAPACITY: 4029,
  STALE_PLAN: 4090,
  INTERNAL: 5000
});

export const fail = (code, message, extra) => ({
  code,
  data: extra === undefined ? { message } : { message, ...extra }
});

export const ok = (data) => (data === undefined ? { code: ErrorCode.OK, data: { accepted: true } } : { code: ErrorCode.OK, data });
