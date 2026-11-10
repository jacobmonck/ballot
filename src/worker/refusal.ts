import type { ErrorCode } from "../shared/protocol";

// An expected rejection of a client request. Its code and message go straight back to that client.
export class Refusal extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
