export class ProtocolError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = 'ProtocolError';
    this.details = details;
  }
}

export class AdmissionError extends Error {
  constructor(message = 'room capacity reserved') {
    super(message);
    this.name = 'AdmissionError';
    this.code = 'NO_CAPACITY';
  }
}

export class StateError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = 'StateError';
    this.details = details;
  }
}
