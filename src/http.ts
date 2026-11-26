import { APIConnectionError, APITimeoutError, LobstrError, errorFromResponse } from './errors.js';

/** Never wait longer than this on a server's `retry_after` (a day's quota says hours): raise instead. */
export const MAX_RETRY_WAIT_S = 60;
/** `409 idempotency_in_flight` asks to retry in 2 seconds. */
const IN_FLIGHT_WAIT_S = 2;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

/** Exponential backoff with jitter: about 0.5 s, 1 s, 2 s... up to 8 s. */
export function backoffMs(attempt: number): number {
  const base = Math.min(8_000, 500 * 2 ** attempt);
  return Math.round(base * (0.5 + Math.random() / 2));
}

/**
 * How long to wait before retrying after `error`, in milliseconds, or `null` not to retry.
 *
 * Retried: a connection error or a client timeout (only when the request is safe to repeat), the error's own
 * `retryable`, a `429` with `retry_after`, `409 idempotency_in_flight`, any 5xx.
 */
export function retryDelayMs(error: LobstrError, attempt: number, safeToRepeat: boolean): number | null {
  if (error instanceof APIConnectionError) return safeToRepeat ? backoffMs(attempt) : null;
  const status = error.status ?? 0;
  const inFlight = status === 409 && error.code === 'idempotency_in_flight';
  const retry =
    error.retryable || inFlight || (status === 429 && error.retryAfter != null) || status >= 500;
  if (!retry) return null;
  const wait = error.retryAfter ?? (inFlight ? IN_FLIGHT_WAIT_S : null);
  if (wait == null) return backoffMs(attempt);
  if (wait > MAX_RETRY_WAIT_S) return null;
  return Math.round(wait * 1000);
}

export interface HttpRequest {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxRetries: number;
  /** Whether a request that may have reached the server can be sent again (GET, DELETE, a run with its key). */
  safeToRepeat: boolean;
  signal?: AbortSignal;
}

export interface HttpResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

/** Sends one request, with the client's timeout and retries, and parses its JSON answer or raises its error. */
export async function sendWithRetries<T>(fetchImpl: typeof fetch, req: HttpRequest): Promise<HttpResponse<T>> {
  for (let attempt = 0; ; attempt++) {
    let error: LobstrError;
    try {
      const res = await fetchOnce(fetchImpl, req);
      if (res.status >= 200 && res.status < 300) return res as HttpResponse<T>;
      error = errorFromResponse(res.status, res.data, res.headers);
    } catch (err) {
      if (req.signal?.aborted) throw err;
      error = err instanceof LobstrError ? err : toConnectionError(err);
    }
    const wait = attempt < req.maxRetries ? retryDelayMs(error, attempt, req.safeToRepeat) : null;
    if (wait == null) throw error;
    await sleep(wait, req.signal);
  }
}

class ClientTimeout extends Error {}

async function fetchOnce(fetchImpl: typeof fetch, req: HttpRequest): Promise<HttpResponse<unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ClientTimeout()), req.timeoutMs);
  const onAbort = () => controller.abort(abortReason(req.signal!));
  if (req.signal?.aborted) onAbort();
  req.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchImpl(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { data, status: res.status, headers: res.headers };
  } catch (err) {
    if (controller.signal.reason instanceof ClientTimeout && !req.signal?.aborted) {
      throw new APITimeoutError({
        message: `No answer within ${Math.round(req.timeoutMs / 1000)} s (the client's timeout).`,
        type: 'api_error',
        code: 'client_timeout',
        retryable: true,
        cause: err,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onAbort);
  }
}

function toConnectionError(err: unknown): APIConnectionError {
  const reason = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
  return new APIConnectionError({
    message: `Could not reach the API: ${reason}`,
    type: 'api_error',
    code: 'connection_error',
    retryable: true,
    cause: err,
  });
}
