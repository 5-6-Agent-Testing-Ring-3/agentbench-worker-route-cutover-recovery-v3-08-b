import { redactText } from "./redact.js";

/**
 * Exit codes are part of the CLI contract and are documented in
 * `docs/operations.md`. Automation distinguishes an unsafe refusal (2) from a
 * candidate that failed validation and was rolled back (3), and both from a
 * failed restore that needs a human (4).
 */
export const ExitCode = {
  success: 0,
  usage: 1,
  unsafe: 2,
  validationFailed: 3,
  recoveryFailed: 4,
  remote: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class RolloutError extends Error {
  readonly exitCode: ExitCodeValue;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    exitCode: ExitCodeValue,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(redactText(message));
    this.name = "RolloutError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

export class UsageError extends RolloutError {
  constructor(message: string) {
    super(message, ExitCode.usage);
    this.name = "UsageError";
  }
}

/** A safety precondition could not be established; nothing was mutated. */
export class UnsafeStateError extends RolloutError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, ExitCode.unsafe, details);
    this.name = "UnsafeStateError";
  }
}

/** The candidate failed health or public-contract validation. */
export class ValidationError extends RolloutError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, ExitCode.validationFailed, details);
    this.name = "ValidationError";
  }
}

/** Restoration of the captured production state could not be verified. */
export class RecoveryError extends RolloutError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, ExitCode.recoveryFailed, details);
    this.name = "RecoveryError";
  }
}

/** The Cloudflare API could not be used safely after bounded retries. */
export class RemoteError extends RolloutError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, ExitCode.remote, details);
    this.name = "RemoteError";
  }
}

export function exitCodeFor(error: unknown): ExitCodeValue {
  return error instanceof RolloutError ? error.exitCode : ExitCode.remote;
}
