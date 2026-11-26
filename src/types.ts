/** Hand-written types of the API v2 (the operations' own types are generated in `generated.ts`). */

/** A record, whatever its operation: `object` always, `id` and `position` for most. */
export interface AnyRecord {
  object: string;
  id?: string;
  position?: number;
  [field: string]: unknown;
}

/**
 * The body of `POST /v2/run`. A `next` from an answer is one of these, to send as it is.
 * `operation` here is `resource/verb`, the site in `source`.
 */
export interface RunRequest {
  source: string;
  operation: string;
  options?: Record<string, unknown>;
  fields?: string[] | null;
  limit?: number | null;
  timeout_s?: number | null;
  [key: string]: unknown;
}

/** The answer of `POST /v2/run`: the envelope, then the records in `results`. */
export interface RunAnswer<R = AnyRecord> {
  object: 'run';
  /** The call's id: `client.runs.get(id)` finds it again. */
  id: string;
  created_at?: string;
  livemode?: boolean;
  source: string;
  /** `resource/verb`. */
  operation: string;
  /** The operation's version that ran; `schema_url` is its contract. */
  version: string;
  schema_url?: string;
  /** What ran, the defaults included. */
  options: Record<string, unknown>;
  fields?: string[] | null;
  limit?: number | null;
  status: string;
  /** The records in this answer. */
  count: number;
  /** Whether there are more. */
  has_more: boolean;
  /** The whole call for the next page, to send as it is; `null` after the last page. */
  next: RunRequest | null;
  /** The credits this call cost. */
  cost: { credits: number };
  /** The credits left. */
  balance?: { credits: number };
  duration_ms?: number;
  /** Also in the `Request-Id` header: quote it when you write to lobstr.io. */
  request_id: string;
  /** The records. */
  results: R[];
  [key: string]: unknown;
}

/** What `run()` and the typed methods take beside the options. */
export interface RunParams {
  /** Only these fields of each record, by path (`name`, `address.city`); `object`, `id` and `position` always come. */
  fields?: string[];
  /**
   * Only the first 1 to 1,000 records of the answer, for an operation that answers several. The call costs the same,
   * and the next page starts after the whole page, not after the records shown.
   */
  limit?: number;
  /** The most seconds to wait, up to the operation's maximum; past it the call answers `408 timeout`, free. */
  timeoutS?: number;
  /** Makes a retry safe; a UUID is generated per call when left out, and kept across the SDK's own retries. */
  idempotencyKey?: string;
  /** Aborts the call. */
  signal?: AbortSignal;
}

/** The parameters of an operation that answers one record (no `limit`). */
export type SingleRunParams = Omit<RunParams, 'limit'>;

/** What `send()` and `nextPage()` take. */
export interface SendParams {
  /** Makes a retry safe; a UUID is generated per call when left out. */
  idempotencyKey?: string;
  /** Aborts the call. */
  signal?: AbortSignal;
}

/** What `iterate()` takes: the run's parameters, and when to stop. */
export interface IterateParams extends Omit<RunParams, 'idempotencyKey'> {
  /** Stop after this many records. */
  maxRecords?: number;
  /** Stop after this many pages (calls). */
  maxPages?: number;
}

/** One call of `runMany()`: `[operation, options, params]`, `{ operation, options, ...params }`, or a whole request (a `next`). */
export type RunManyCall =
  | [operation: string, options?: Record<string, unknown>, params?: Omit<RunParams, 'signal'>]
  | ({ operation: string; options?: Record<string, unknown>; source?: undefined } & Omit<RunParams, 'signal'>)
  | (RunRequest & { idempotencyKey?: string });

export interface RunManyParams {
  /** At most this many calls at a time (default 4). Your plan's own cap still applies: the SDK waits on `429 concurrency_limit`. */
  concurrency?: number;
  /** Aborts the calls not yet answered. */
  signal?: AbortSignal;
}

/** An operation in the catalog (`GET /v2/catalog`). */
export interface CatalogOperation {
  object: 'operation';
  /** `source/resource/verb`. */
  id: string;
  source: string;
  operation: string;
  site?: { title: string; domain: string; color?: string };
  title: string;
  summary: string;
  use_when?: string;
  categories?: string[];
  icon?: string;
  version: string;
  status?: string;
  price?: { credits_per_call: number; description?: string; free?: string[] };
  [key: string]: unknown;
}

/** `GET /v2/catalog`. */
export interface CatalogList {
  object: 'list';
  data: CatalogOperation[];
  has_more: boolean;
  next_cursor?: string | null;
  [key: string]: unknown;
}

/** An operation's public contract (`GET /v2/catalog/{source}/{resource}/{verb}`): its options, record, price, errors. */
export interface OperationContract extends CatalogOperation {
  input?: Record<string, unknown>;
  record?: Record<string, unknown>;
  pagination?: Record<string, unknown> | null;
  deadline?: { default_s: number; max_s: number };
  errors?: unknown[];
  examples?: unknown[];
  changelog?: { version: string; date: string; notes: string }[];
}

/** How an operation's calls went, the last 90 days, a UTC day at a time. */
export interface OperationStatus {
  object: 'operation_status';
  id: string;
  calls: number;
  ok: number;
  success_rate: number | null;
  days: { date: string; calls: number; ok: number; p50_ms: number }[];
  [key: string]: unknown;
}

/** The parameters of `client.runs.list()`. */
export interface RunListParams {
  /** 1 to 100 calls a page (default 20), newest first. */
  limit?: number;
  /** The last id of the previous page. */
  startingAfter?: string;
  /** Only this operation, as `google_maps/reviews/list`. */
  operation?: string;
  status?: 'succeeded' | 'failed';
  /** Only the calls made by the API, the MCP server or the app. */
  via?: 'api' | 'mcp' | 'app';
  /** UTC, as `2026-11-09T08:00:00Z`, or a `Date`. */
  createdAfter?: string | Date;
  /** UTC, as `2026-11-09T08:00:00Z`, or a `Date`. */
  createdBefore?: string | Date;
}

/** The parameters of `client.feedback()`. */
export interface FeedbackParams {
  kind?: 'bug' | 'missing_data' | 'idea' | 'other';
  /** The operation's id, as `google_maps/reviews/list`. */
  operation?: string;
  /** The id of the call concerned (`run_...`). */
  run?: string;
}

/** What the generated typed methods need from the client. */
export interface OperationRunner {
  run(operation: string, options?: Record<string, unknown>, params?: RunParams): Promise<unknown>;
  iterate(operation: string, options?: Record<string, unknown>, params?: IterateParams): AsyncGenerator<unknown, void, undefined>;
}
