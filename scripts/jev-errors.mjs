import { APIError, APITimeoutError, APIUserAbortError } from '@typesafe-ai/sdk';
import { ZodError } from 'zod';

export class JevError extends Error {
  constructor(code, message = code, exitCode = 1) {
    super(message);
    this.name = 'JevError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function stableError(error) {
  if (error instanceof JevError) return error;
  if (error instanceof ZodError) return new JevError('input_schema_invalid', 'The request schema is invalid.', 2);
  if (error instanceof APITimeoutError) return new JevError('evaluation_timeout', 'The TypeSafe request timed out.');
  if (error instanceof APIUserAbortError) return new JevError('evaluation_aborted', 'The TypeSafe request was aborted.');
  if (error instanceof APIError) {
    const status = Number.isInteger(error.status) ? error.status : 'unknown';
    return new JevError(`typesafe_http_${status}`, 'The TypeSafe API rejected the request.');
  }
  return new JevError('evaluation_failed', 'The TypeSafe evaluation failed.');
}

export function errorPayload(error) {
  const stable = stableError(error);
  return { status: 'error', error: { code: stable.code } };
}
