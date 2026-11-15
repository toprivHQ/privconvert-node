export class PrivConvertError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly retryAfter?: number;

  constructor(message: string, opts: { status?: number; code?: string; retryAfter?: number } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = opts.status;
    this.code = opts.code;
    this.retryAfter = opts.retryAfter;
  }
}

/** 401: missing, invalid or revoked API key. */
export class AuthenticationError extends PrivConvertError {}
/** 400: malformed request, unknown tool, bad parameter or unreadable input. */
export class BadRequestError extends PrivConvertError {}
/** 413: the file is above your plan's size limit. */
export class FileTooLargeError extends PrivConvertError {}
/** 415: the input file type is not valid for this tool. */
export class UnsupportedTypeError extends PrivConvertError {}
/** 422: the file was read but could not be converted. */
export class ConversionFailedError extends PrivConvertError {}
/** 429 rate_limited: per-minute rate or monthly quota exceeded. */
export class RateLimitError extends PrivConvertError {}
/** 429 concurrency_limited: too many conversions running at once. */
export class ConcurrencyLimitError extends RateLimitError {}
/** 5xx: a problem on the server side. Safe to retry. */
export class ServerError extends PrivConvertError {}
/** 404 for a job: deleted, never existed, or lost in a service restart. */
export class JobNotFoundError extends PrivConvertError {}
/** 410: the job result passed its retention window and was deleted. */
export class JobExpiredError extends PrivConvertError {}
/**
 * Reading from or writing to your cloud storage failed. `code` holds the
 * provider's error code when there is one, e.g. `NoSuchKey` or `AccessDenied`.
 */
export class StorageError extends PrivConvertError {}

export const STATUS_BY_CODE: Record<string, number> = {
  bad_request: 400,
  unauthorized: 401,
  file_too_large: 413,
  unsupported_type: 415,
  conversion_failed: 422,
  rate_limited: 429,
  concurrency_limited: 429,
  server_error: 500,
  server_busy: 503,
};

export function errorFor(
  status: number,
  message: string,
  code: string | undefined,
  retryAfter: number | undefined,
  job = false,
): PrivConvertError {
  const opts = { status, code, retryAfter };
  if (status === 429) {
    return code === "concurrency_limited" ? new ConcurrencyLimitError(message, opts) : new RateLimitError(message, opts);
  }
  if (status === 404 && job) return new JobNotFoundError(message, opts);
  if (status >= 500) return new ServerError(message, opts);
  switch (status) {
    case 400:
      return new BadRequestError(message, opts);
    case 401:
    case 403:
      return new AuthenticationError(message, opts);
    case 410:
      return new JobExpiredError(message, opts);
    case 413:
      return new FileTooLargeError(message, opts);
    case 415:
      return new UnsupportedTypeError(message, opts);
    case 422:
      return new ConversionFailedError(message, opts);
    default:
      return new PrivConvertError(message, opts);
  }
}
