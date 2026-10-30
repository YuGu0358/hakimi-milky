// Failure shape shared by the real and mock payments functions.
// kind tells the caller what it may do next:
//   rejected:  the request took no effect, so a reservation can be released
//   not-found: the thing does not exist
//   uncertain: the outcome is unknown, so look it up before doing anything else
export function kindFromStatus(status) {
  if (status === 404) return 'not-found';
  if (status >= 400 && status < 500) return 'rejected';
  return 'uncertain';
}

export class PaymentsError extends Error {
  constructor(message, {status = null, kind = kindFromStatus(status)} = {}) {
    super(message);
    this.name = 'PaymentsError';
    this.status = status;
    this.kind = kind;
  }
}
