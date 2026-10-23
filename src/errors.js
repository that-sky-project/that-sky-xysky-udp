export class ProtocolError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = 'ProtocolError';
    this.details = details;
  }
}

export class StateError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = 'StateError';
    this.details = details;
  }
}
