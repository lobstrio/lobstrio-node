import { randomUUID } from 'node:crypto';

import { LobstrError, RateLimitError, missingKeyError } from './errors.js';
import { createNamespaces } from './generated.js';
import type {
  Account,
  AccountList,
  Balance,
  ConnectAccountParams,
  DeletedAccount,
  Feedback,
  Namespaces,
  OperationId,
  Operations,
  RunLog,
  RunLogList,
} from './generated.js';
import { sendWithRetries, sleep } from './http.js';
import { Run } from './run.js';
import type {
  AnyRecord,
  CatalogList,
  FeedbackParams,
  IterateParams,
  OperationContract,
  OperationStatus,
  RunAnswer,
  RunListParams,
  RunManyCall,
  RunManyParams,
  RunParams,
  RunRequest,
  SendParams,
} from './types.js';
import { VERSION } from './version.js';

export const DEFAULT_BASE_URL = 'https://api.lobstr.io';
/** The client's timeout per request, in milliseconds: above the longest deadline of an operation (120 s). */
export const DEFAULT_TIMEOUT = 180_000;
export const DEFAULT_MAX_RETRIES = 2;
/** How many times `runMany()` waits on `429 concurrency_limit` for one call before giving its error back. */
const MAX_CONCURRENCY_WAITS = 100;

export interface ClientOptions {
  /** The API key; falls back to the `LOBSTR_API_KEY` environment variable. */
  apiKey?: string | null;
  /** Default `https://api.lobstr.io`. */
  baseUrl?: string;
  /** The client's timeout per request, in milliseconds (default 180,000). A run waits at least its `timeoutS` plus 30 s. */
  timeout?: number;
  /** How many times a retryable failure is retried (default 2). */
  maxRetries?: number;
  /** A `fetch` to use instead of the global one. */
  fetch?: typeof fetch;
  /** Headers sent with every request. */
  defaultHeaders?: Record<string, string>;
}

type OptionsFor<K> = K extends OperationId ? Operations[K]['options'] : Record<string, unknown>;
type RecordFor<K> = K extends OperationId ? Operations[K]['record'] : AnyRecord;
type OperationName = OperationId | (string & {});

interface RequestSpec {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  query?: Record<string, string | number | undefined | null>;
  body?: unknown;
  /** Whether the call needs the key (the catalog does not). */
  auth?: boolean;
  idempotencyKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Splits `source/resource/verb` into the API's `source` and `operation`. */
export function splitOperation(operation: string): { source: string; operation: string } {
  const parts = typeof operation === 'string' ? operation.split('/') : [];
  if (parts.length !== 3 || parts.some((p) => !p)) {
    throw new TypeError(
      `An operation is "source/resource/verb", as "google_maps/places/search"; got ${JSON.stringify(operation)}.`,
    );
  }
  return { source: parts[0]!, operation: `${parts[1]}/${parts[2]}` };
}

function operationPath(operation: string): string {
  splitOperation(operation);
  return operation.split('/').map(encodeURIComponent).join('/');
}

function utcDate(value: string | Date | undefined): string | undefined {
  if (value instanceof Date) return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return value;
}

/** The API's catalog: every operation, its contract and how its calls went. No key needed. */
export class Catalog {
  constructor(private readonly client: Lobstr) {}

  /** Every operation (`GET /v2/catalog`), or one site's with `source`. */
  list(params: { source?: string } = {}): Promise<CatalogList> {
    return this.client._request({ method: 'GET', path: '/v2/catalog', query: { source: params.source }, auth: false });
  }

  /** One operation's public contract: its options, record, price, deadline, errors, examples. */
  async get(operation: OperationName): Promise<OperationContract> {
    return this.client._request({ method: 'GET', path: `/v2/catalog/${operationPath(operation)}`, auth: false });
  }

  /** How the operation's calls went, the last 90 days, a UTC day at a time. */
  async status(operation: OperationName): Promise<OperationStatus> {
    return this.client._request({
      method: 'GET',
      path: `/v2/catalog/${operationPath(operation)}/status`,
      auth: false,
    });
  }
}

/** Your accounts on the sites whose operations need one (https://docs.lobstr.io/accounts). */
export class Accounts {
  constructor(private readonly client: Lobstr) {}

  /** Your connected accounts, or one site's. */
  list(params: { site?: string } = {}): Promise<AccountList> {
    return this.client._request({ method: 'GET', path: '/v2/accounts', query: { site: params.site } });
  }

  /** One of your connected accounts. */
  get(id: string): Promise<Account> {
    return this.client._request({ method: 'GET', path: `/v2/accounts/${encodeURIComponent(id)}` });
  }

  /** Removes one of your accounts, its session with it. */
  delete(id: string): Promise<DeletedAccount> {
    return this.client._request({ method: 'DELETE', path: `/v2/accounts/${encodeURIComponent(id)}` });
  }

  /**
   * Connects one of your accounts on a site, from the cookies of a browser logged in to it. The site checks them at
   * once; the account is kept only once it accepted them. The same login sent again keeps its id.
   */
  connect(params: ConnectAccountParams): Promise<Account> {
    return this.client._request({ method: 'POST', path: '/v2/accounts', body: params });
  }
}

/**
 * A page of your calls, to `await`, or to go through with `for await`, page after page.
 */
export class RunLogPage implements PromiseLike<RunLogList>, AsyncIterable<RunLog> {
  #first?: Promise<RunLogList>;

  constructor(
    private readonly client: Lobstr,
    private readonly path: string,
    private readonly query: Record<string, string | number | undefined>,
  ) {}

  #firstPage(): Promise<RunLogList> {
    this.#first ??= this.client._request<RunLogList>({ method: 'GET', path: this.path, query: this.query });
    return this.#first;
  }

  then<A = RunLogList, B = never>(
    onfulfilled?: ((value: RunLogList) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.#firstPage().then(onfulfilled, onrejected);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<RunLog, void, undefined> {
    let page = await this.#firstPage();
    for (;;) {
      yield* page.data;
      if (!page.has_more || !page.next) return;
      page = await this.client._request<RunLogList>({ method: 'GET', path: page.next });
    }
  }
}

/** Your calls to `POST /v2/run`, kept 90 days: what was sent and what was answered. */
export class Runs {
  constructor(private readonly client: Lobstr) {}

  /**
   * Your calls, newest first. `await` it for one page (`data`, `has_more`, `next`), or `for await` it for every call
   * across pages.
   */
  list(params: RunListParams = {}): RunLogPage {
    return new RunLogPage(this.client, '/v2/runs', {
      limit: params.limit,
      starting_after: params.startingAfter,
      operation: params.operation,
      status: params.status,
      via: params.via,
      created_after: utcDate(params.createdAfter),
      created_before: utcDate(params.createdBefore),
    });
  }

  /** One of your calls: what was sent (`request`) and what was answered, records aside. */
  get(id: string): Promise<RunLog> {
    return this.client._request({ method: 'GET', path: `/v2/runs/${encodeURIComponent(id)}` });
  }

  /** A call's whole answer, records included, while your plan keeps answers (7, 45 or 90 days). */
  async response<R = AnyRecord>(id: string): Promise<Run<R>> {
    const answer = await this.client._request<RunAnswer<R>>({
      method: 'GET',
      path: `/v2/runs/${encodeURIComponent(id)}/response`,
    });
    return new Run<R>(this.client, answer);
  }
}

/**
 * The lobstr.io API v2 client.
 *
 * ```ts
 * const client = new Lobstr(); // the key from LOBSTR_API_KEY
 * const run = await client.run('google_maps/places/search', { query: 'bakeries in Lyon' });
 * ```
 */
export class Lobstr {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly catalog: Catalog;
  readonly accounts: Accounts;
  readonly runs: Runs;
  readonly #apiKey: string | null;
  readonly #fetch: typeof fetch;
  readonly #defaultHeaders: Record<string, string>;

  constructor(apiKeyOrOptions?: string | ClientOptions | null, options: ClientOptions = {}) {
    const opts: ClientOptions =
      typeof apiKeyOrOptions === 'object' && apiKeyOrOptions !== null
        ? apiKeyOrOptions
        : { ...options, apiKey: apiKeyOrOptions ?? options.apiKey };
    const envKey = typeof process !== 'undefined' ? process.env?.LOBSTR_API_KEY : undefined;
    this.#apiKey = opts.apiKey || envKey || null;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeout = opts.timeout ?? DEFAULT_TIMEOUT;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('No global fetch: lobstrio needs Node 18 or later, or a `fetch` option.');
    }
    this.#fetch = fetchImpl;
    this.#defaultHeaders = { ...opts.defaultHeaders };
    this.catalog = new Catalog(this);
    this.accounts = new Accounts(this);
    this.runs = new Runs(this);
    Object.assign(this, createNamespaces(this));
  }

  /**
   * Runs one operation, `source/resource/verb`, with its options: one page of a list, or one item.
   *
   * ```ts
   * const run = await client.run('google_maps/places/search', { query: 'bakeries in Lyon' }, { limit: 5 });
   * run.results; run.cost.credits; await run.nextPage();
   * ```
   */
  async run<K extends OperationName>(
    operation: K,
    options?: OptionsFor<K>,
    params: RunParams = {},
  ): Promise<Run<RecordFor<K>>> {
    return this.send(buildRequest(operation, options as Record<string, unknown> | undefined, params), {
      idempotencyKey: params.idempotencyKey,
      signal: params.signal,
    }) as Promise<Run<RecordFor<K>>>;
  }

  /** Sends a whole request to `POST /v2/run` as it is, such as an answer's `next`. */
  async send<R = AnyRecord>(request: RunRequest, params: SendParams = {}): Promise<Run<R>> {
    if (!request || typeof request !== 'object' || !request.source || !request.operation) {
      throw new TypeError('A request needs `source` and `operation` (`resource/verb`), as an answer\'s `next` has them.');
    }
    const timeoutS = typeof request.timeout_s === 'number' ? request.timeout_s : 0;
    const { data } = await this._raw<RunAnswer<R>>({
      method: 'POST',
      path: '/v2/run',
      body: request,
      idempotencyKey: params.idempotencyKey ?? randomUUID(),
      timeoutMs: Math.max(this.timeout, (timeoutS + 30) * 1000),
      signal: params.signal,
    });
    return new Run<R>(this, data);
  }

  /**
   * Every record of an operation, page after page, following `next` until it is `null` or a cap is hit.
   * Each page is a call, at the operation's price: set `maxRecords` or `maxPages`, or stop when you have enough.
   *
   * ```ts
   * for await (const review of client.iterate('google_maps/reviews/list', { place }, { maxRecords: 100 })) {}
   * ```
   */
  async *iterate<K extends OperationName>(
    operation: K,
    options?: OptionsFor<K>,
    params: IterateParams = {},
  ): AsyncGenerator<RecordFor<K>, void, undefined> {
    const { maxRecords, maxPages, ...runParams } = params;
    if (maxRecords != null && maxRecords <= 0) return;
    if (maxPages != null && maxPages <= 0) return;
    let page: Run<RecordFor<K>> | null = await this.run(operation, options, runParams);
    let pages = 1;
    let records = 0;
    while (page) {
      for (const record of page.results) {
        yield record;
        records += 1;
        if (maxRecords != null && records >= maxRecords) return;
      }
      if (maxPages != null && pages >= maxPages) return;
      page = await page.nextPage({ signal: params.signal });
      pages += 1;
    }
  }

  /**
   * Runs many calls in parallel, at most `concurrency` at a time (default 4), and gives back one item per call, in
   * their order: its `Run`, or the error it raised. It never throws for one failed call, and waits on
   * `429 concurrency_limit` (your plan's calls at a time) as long as the API says.
   *
   * ```ts
   * const [a, b] = await client.runMany([
   *   ['google_maps/places/search', { query: 'bakeries in Lyon' }],
   *   ['google_maps/places/search', { query: 'bakeries in Lille' }],
   * ]);
   * ```
   */
  async runMany<R = AnyRecord>(calls: RunManyCall[], params: RunManyParams = {}): Promise<Array<Run<R> | Error>> {
    const concurrency = params.concurrency ?? 4;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new TypeError('`concurrency` is an integer, 1 or more.');
    }
    const results: Array<Run<R> | Error> = new Array(calls.length);
    let next = 0;
    const worker = async () => {
      while (next < calls.length) {
        const index = next++;
        try {
          results[index] = await this.#runOne<R>(calls[index]!, params.signal);
        } catch (err) {
          results[index] = err instanceof Error ? err : new Error(String(err));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, calls.length) }, worker));
    return results;
  }

  async #runOne<R>(call: RunManyCall, signal?: AbortSignal): Promise<Run<R>> {
    let request: RunRequest;
    let idempotencyKey: string | undefined;
    if (Array.isArray(call)) {
      const [operation, options, runParams = {}] = call;
      request = buildRequest(operation, options, runParams);
      idempotencyKey = runParams.idempotencyKey;
    } else if (call && typeof call === 'object' && typeof call.source === 'string') {
      const { idempotencyKey: key, ...rest } = call as RunRequest & { idempotencyKey?: string };
      request = rest;
      idempotencyKey = key;
    } else {
      const { operation, options, ...runParams } = call as { operation: string; options?: Record<string, unknown> } & RunParams;
      request = buildRequest(operation, options, runParams);
      idempotencyKey = runParams.idempotencyKey;
    }
    // One key for the call, kept across every wait and retry: it is never charged twice.
    idempotencyKey ??= randomUUID();
    for (let waits = 0; ; waits++) {
      try {
        return await this.send<R>(request, { idempotencyKey, signal });
      } catch (err) {
        const busy = err instanceof RateLimitError && err.code === 'concurrency_limit';
        if (!busy || waits >= MAX_CONCURRENCY_WAITS) throw err;
        const waitS = (err as LobstrError).retryAfter ?? 1;
        await sleep(waitS * 1000 + Math.random() * 250, signal);
      }
    }
  }

  /** The credits the key's account can spend, and its plan with the price of one credit on it. */
  balance(): Promise<Balance> {
    return this._request({ method: 'GET', path: '/v2/balance' });
  }

  /**
   * Tells lobstr.io's team what went wrong or what you need: an operation that failed in a way its error does not
   * explain, a missing field or operation, a misleading error. Free; 20 messages a day per account.
   */
  feedback(message: string, params: FeedbackParams = {}): Promise<Feedback> {
    const body: Record<string, unknown> = { message };
    if (params.kind) body.kind = params.kind;
    if (params.operation) body.operation = params.operation;
    if (params.run) body.run = params.run;
    return this._request({ method: 'POST', path: '/v2/feedback', body });
  }

  /** @internal Sends a request to the API and returns its parsed JSON answer. */
  async _request<T>(spec: RequestSpec): Promise<T> {
    return (await this._raw<T>(spec)).data;
  }

  /** @internal */
  async _raw<T>(spec: RequestSpec): Promise<{ data: T; status: number; headers: Headers }> {
    const auth = spec.auth ?? true;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': userAgent(),
      ...this.#defaultHeaders,
    };
    if (auth) {
      if (!this.#apiKey) throw missingKeyError();
      headers.Authorization = `Bearer ${this.#apiKey}`;
    }
    if (spec.body !== undefined) headers['Content-Type'] = 'application/json';
    if (spec.idempotencyKey) headers['Idempotency-Key'] = spec.idempotencyKey;
    return sendWithRetries<T>(this.#fetch, {
      method: spec.method,
      url: this.#url(spec.path, spec.query),
      headers,
      body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
      timeoutMs: spec.timeoutMs ?? this.timeout,
      maxRetries: this.maxRetries,
      safeToRepeat: spec.method !== 'POST' || Boolean(spec.idempotencyKey),
      signal: spec.signal,
    });
  }

  #url(path: string, query?: RequestSpec['query']): string {
    // A path from the API (a list's `next`) may come whole, query included.
    const url = /^https?:\/\//.test(path)
      ? new URL(path)
      : new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** Never shows the key. */
  toJSON(): Record<string, unknown> {
    return { baseUrl: this.baseUrl, timeout: this.timeout, maxRetries: this.maxRetries, apiKey: this.#apiKey ? '***' : null };
  }
}

// The typed methods, one per operation (`client.googleMaps.places.search(...)`), generated from the OpenAPI.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface Lobstr extends Namespaces {}

function buildRequest(operation: string, options: Record<string, unknown> | undefined, params: RunParams): RunRequest {
  const { source, operation: op } = splitOperation(operation);
  const request: RunRequest = { source, operation: op, options: options ?? {} };
  if (params.fields != null) request.fields = params.fields;
  if (params.limit != null) request.limit = params.limit;
  if (params.timeoutS != null) request.timeout_s = params.timeoutS;
  return request;
}

let cachedUserAgent: string | undefined;
function userAgent(): string {
  if (!cachedUserAgent) {
    const runtime = typeof process !== 'undefined' && process.versions?.node ? `node/${process.versions.node}` : 'unknown';
    const platform = typeof process !== 'undefined' ? `${process.platform}-${process.arch}` : 'unknown';
    cachedUserAgent = `lobstrio-node/${VERSION} (${runtime}; ${platform})`;
  }
  return cachedUserAgent;
}
