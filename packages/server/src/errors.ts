import { DocValidationError, type ErrorCode, TimelineOpError } from '@rideo/shared';
import { ZodError } from 'zod';

const STATUS: Record<ErrorCode, number> = {
  validation_error: 422,
  not_found: 404,
  conflict: 409,
  character_not_locked: 409,
  character_locked: 409,
  element_not_locked: 409,
  element_locked: 409,
  consistency_gate: 409,
  gate_unmet: 409,
  timeline_op_invalid: 422,
  gateway_error: 502,
  llm_invalid_output: 502,
  llm_error: 502,
  storage_error: 503,
  media_error: 500,
  unauthorized: 401,
  forbidden: 403,
  cancelled: 409,
  lease_lost: 409,
  consent_required: 422,
  voice_not_locked: 409,
  voice_locked: 409,
  tts_unavailable: 422,
  internal_error: 500,
};

/** Domain error with a stable code (REST problem details, MCP errors and job records share it). */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly errors: unknown[] = [],
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = STATUS[code];
  }
}

export const notFound = (what: string) => new AppError('not_found', `${what} not found`);
export const conflict = (message: string) => new AppError('conflict', message);
export const invalid = (message: string, errors: unknown[] = []) =>
  new AppError('validation_error', message, errors);

/** Normalizes any thrown value into an AppError. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof DocValidationError) return new AppError('validation_error', err.message, err.issues);
  if (err instanceof TimelineOpError)
    return new AppError('timeline_op_invalid', err.message, [{ opIndex: err.opIndex }]);
  if (err instanceof ZodError) {
    return new AppError(
      'validation_error',
      'Request validation failed',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  if (err && typeof err === 'object' && 'name' in err && (err as Error).name === 'AbortError') {
    return new AppError('cancelled', 'Operation cancelled');
  }
  const message = err instanceof Error ? err.message : String(err);
  const retryable =
    typeof err === 'object' && err !== null && 'retryable' in err
      ? Boolean((err as { retryable: unknown }).retryable)
      : false;
  const code =
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    (err as { code: string }).code in STATUS
      ? (err as { code: ErrorCode }).code
      : 'internal_error';
  return new AppError(code, message, [], retryable);
}

export function problemDetails(err: AppError, instance?: string) {
  return {
    type: `urn:rideo:problem:${err.code}`,
    title: err.code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    status: err.status,
    detail: err.message,
    code: err.code,
    ...(instance ? { instance } : {}),
    errors: err.errors,
  };
}
