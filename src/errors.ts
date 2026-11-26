/**
 * Errors raised by the SDK.
 *
 * Every failure of the API answers one error object
 * (`{"error": {type, code, message, param, doc_url, request_id, retryable, retry_after}}`):
 * it becomes a `LobstrError`, of the subclass its `type` names. A failed call costs nothing.
 */

/** The error object of the API, as it answers it. */
export interface ErrorBody {
  type: string;
  code: string;
  message: string;
  param?: string | null;
  doc_url?: string | null;
  request_id?: string;
  retryable?: boolean;
  retry_after?: number;
  [key: string]: unknown;
}

export interface LobstrErrorInit {
  message: string;
  status?: number | null;
  type?: string;
  code?: string;
  param?: string | null;
  docUrl?: string | null;
  requestId?: string | null;
  retryable?: boolean;
  retryAfter?: number | null;
  headers?: Headers | null;
  body?: unknown;
  cause?: unknown;
}

/** Any error of the SDK: an error the API answered, or a client-side one (connection, timeout). */
export class LobstrError extends Error {
  /** The HTTP status, or `null` for an error raised before any answer. */
  readonly status: number | null;
  /** `invalid_request_error`, `authentication_error`, `billing_error`, `rate_limit_error`, `site_error`, `api_error`... */
  readonly type: string;
  /** What happened, exactly: `invalid_options`, `concurrency_limit`... (https://docs.lobstr.io/errors). */
  readonly code: string;
  /** The option at fault, as `options.place`, or `null`. */
  readonly param: string | null;
  /** The page that explains the code. */
  readonly docUrl: string | null;
  /** The call's request id (also in the `Request-Id` header): quote it when you write to lobstr.io. */
  readonly requestId: string | null;
  /** Whether the same call can work later. */
  readonly retryable: boolean;
  /** In how many seconds to retry, when the API says it. */
  readonly retryAfter: number | null;
  /** The answer's headers, when there was an answer. */
  readonly headers: Headers | null;
  /** The answer's body, parsed, when there was one. */
  readonly body: unknown;

  constructor(init: LobstrErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = new.target.name;
    this.status = init.status ?? null;
    this.type = init.type ?? 'api_error';
    this.code = init.code ?? 'unknown_error';
    this.param = init.param ?? null;
    this.docUrl = init.docUrl ?? null;
    this.requestId = init.requestId ?? null;
    this.retryable = init.retryable ?? false;
    this.retryAfter = init.retryAfter ?? null;
    this.headers = init.headers ?? null;
    this.body = init.body;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      status: this.status,
      type: this.type,
      code: this.code,
      message: this.message,
      param: this.param,
      doc_url: this.docUrl,
      request_id: this.requestId,
      retryable: this.retryable,
      retry_after: this.retryAfter,
    };
  }
}

/** 400, 404, 409, 410, 422: the call is not what the API takes (`param` says where). */
export class InvalidRequestError extends LobstrError {}
/** 401: the API key is missing or wrong. */
export class AuthenticationError extends LobstrError {}
/** 402: not enough credits for the call. */
export class BillingError extends LobstrError {}
/** 429: too many calls at a time, an account's pace, a day's quota. */
export class RateLimitError extends LobstrError {}
/** 408, 424, 503: the site did not answer in time, or not as expected. */
export class SiteError extends LobstrError {}
/** 500 and any other failure on lobstr.io's side. */
export class APIError extends LobstrError {}
/** The request did not reach the API, or its answer did not come back (network). */
export class APIConnectionError extends LobstrError {}
/** No answer within the client's timeout. */
export class APITimeoutError extends APIConnectionError {}

const BY_TYPE: Record<string, typeof LobstrError> = {
  invalid_request_error: InvalidRequestError,
  authentication_error: AuthenticationError,
  billing_error: BillingError,
  rate_limit_error: RateLimitError,
  site_error: SiteError,
  api_error: APIError,
};

function typeForStatus(status: number): string {
  if (status === 401) return 'authentication_error';
  if (status === 402) return 'billing_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 408 || status === 424 || status === 503) return 'site_error';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
}

/** Parses a `Retry-After` header: seconds, or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, (date - Date.now()) / 1000);
}

/** Builds the error of an HTTP answer that failed, from its body (the API's error object) and headers. */
export function errorFromResponse(status: number, body: unknown, headers: Headers | null): LobstrError {
  const raw =
    body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object'
      ? (body.error as Partial<ErrorBody>)
      : null;
  const type = typeof raw?.type === 'string' ? raw.type : typeForStatus(status);
  const Cls = BY_TYPE[type] ?? BY_TYPE[typeForStatus(status)] ?? APIError;
  const headerWait = parseRetryAfter(headers?.get('retry-after'));
  const retryAfter = typeof raw?.retry_after === 'number' ? raw.retry_after : headerWait;
  const requestId = (typeof raw?.request_id === 'string' ? raw.request_id : null) ?? headers?.get('request-id') ?? null;
  let message: string;
  if (typeof raw?.message === 'string' && raw.message) message = raw.message;
  else if (typeof body === 'string' && body.trim()) message = `HTTP ${status}: ${body.trim().slice(0, 500)}`;
  else message = `HTTP ${status}`;
  return new Cls({
    message,
    status,
    type,
    code: typeof raw?.code === 'string' ? raw.code : `http_${status}`,
    param: typeof raw?.param === 'string' ? raw.param : null,
    docUrl: typeof raw?.doc_url === 'string' ? raw.doc_url : null,
    requestId,
    retryable: typeof raw?.retryable === 'boolean' ? raw.retryable : status >= 500,
    retryAfter,
    headers,
    body,
  });
}

/** The error of a call that needs a key, made without one: raised before anything is sent. */
export function missingKeyError(): AuthenticationError {
  return new AuthenticationError({
    message:
      'No API key: pass `apiKey` to `new Lobstr()` or set the LOBSTR_API_KEY environment variable. ' +
      'It is on https://app.lobstr.io/dashboard/api',
    type: 'authentication_error',
    code: 'missing_api_key',
    docUrl: 'https://docs.lobstr.io/errors#missing_api_key',
  });
}
