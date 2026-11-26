import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  BillingError,
  InvalidRequestError,
  Lobstr,
  LobstrError,
  OPERATIONS,
  RateLimitError,
  Run,
  SiteError,
  VERSION,
} from '../src/index.js';
import { answer, apiError, client, json, mockFetch, nextRequest, pages } from './helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('run', () => {
  it('posts the operation, its options and params, and returns a Run', async () => {
    const body = answer(2);
    const { client: c, calls } = client(() => json(200, body));
    const run = await c.run(
      'google_maps/reviews/list',
      { place: 'ChIJ' },
      { fields: ['rating'], limit: 2, timeoutS: 20 },
    );
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url.toString()).toBe('https://api.lobstr.io/v2/run');
    expect(call.body).toEqual({
      source: 'google_maps',
      operation: 'reviews/list',
      options: { place: 'ChIJ' },
      fields: ['rating'],
      limit: 2,
      timeout_s: 20,
    });
    expect(call.headers.authorization).toBe('Bearer test_key');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers['idempotency-key']).toMatch(UUID);
    expect(call.headers['user-agent']).toMatch(/^lobstrio-node\/1\.1\.0 \(node\/\d+/);
    expect(run).toBeInstanceOf(Run);
    expect(run.id).toBe(body.id);
    expect(run.count).toBe(2);
    expect(run.cost.credits).toBe(4);
    expect(run.results).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(run))).toEqual(body);
  });

  it('sends the idempotency key it is given', async () => {
    const { client: c, calls } = client(() => json(200, answer(0)));
    await c.run('google_maps/reviews/list', { place: 'ChIJ' }, { idempotencyKey: 'my-key' });
    expect(calls[0]!.headers['idempotency-key']).toBe('my-key');
  });

  it('refuses an operation that is not source/resource/verb', async () => {
    const { client: c, calls } = client(() => json(200, answer(0)));
    await expect(c.run('places/search' as string, {})).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('runs a typed method as its operation', async () => {
    const { client: c, calls } = client(() => json(200, answer(1)));
    const run = await c.googleMaps.places.search({ query: 'bakeries in Lyon', near: { lat: 45.76, lng: 4.84 } }, { limit: 5 });
    expect(calls[0]!.body).toEqual({
      source: 'google_maps',
      operation: 'places/search',
      options: { query: 'bakeries in Lyon', near: { lat: 45.76, lng: 4.84 } },
      limit: 5,
    });
    expect(run.results).toHaveLength(1);
    await c.x.bookmarks.list();
    expect(calls[1]!.body).toMatchObject({ source: 'x', operation: 'bookmarks/list', options: {} });
  });

  it('has a typed method for every operation', () => {
    const c = new Lobstr('k');
    expect(OPERATIONS.length).toBeGreaterThanOrEqual(40);
    const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
    for (const id of OPERATIONS) {
      const [source, resource, verb] = id.split('/') as [string, string, string];
      const method = (c as any)[camel(source)][camel(resource)][camel(verb)];
      expect(typeof method, id).toBe('function');
    }
    expect(typeof c.googleMaps.places.search.iterate).toBe('function');
    expect((c.googleMaps.places.get as any).iterate).toBeUndefined();
  });
});

describe('the key', () => {
  it('falls back to LOBSTR_API_KEY', async () => {
    vi.stubEnv('LOBSTR_API_KEY', 'env_key');
    const mock = mockFetch(() => json(200, { object: 'balance', credits: 10 }));
    await new Lobstr({ fetch: mock.fetch }).balance();
    expect(mock.calls[0]!.headers.authorization).toBe('Bearer env_key');
  });

  it('fails at the first call that needs it, before sending anything', async () => {
    vi.stubEnv('LOBSTR_API_KEY', '');
    const mock = mockFetch(() => json(200, { object: 'list', data: [], has_more: false }));
    const c = new Lobstr({ fetch: mock.fetch });
    const err = await c.run('google_news/articles/search', { query: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.code).toBe('missing_api_key');
    expect(err.docUrl).toBe('https://docs.lobstr.io/errors#missing_api_key');
    expect(mock.calls).toHaveLength(0);
    // The catalog needs none.
    await c.catalog.list();
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.headers.authorization).toBeUndefined();
  });

  it('never shows the key', () => {
    const c = new Lobstr('secret_value');
    expect(JSON.stringify(c)).not.toContain('secret_value');
    expect(String(Object.keys(c))).not.toContain('secret_value');
  });
});

describe('send and nextPage', () => {
  it('sends a request as it is', async () => {
    const { client: c, calls } = client(() => json(200, answer(1)));
    const request = { ...nextRequest('abc'), fields: ['rating'], limit: 2 };
    await c.send(request);
    expect(calls[0]!.body).toEqual(request);
  });

  it('sends next as it is, with a key of its own, and null after the last page', async () => {
    const [first, second] = pages([2, 1]);
    const { client: c, calls } = client((_, i) => json(200, i === 0 ? first : second));
    const run = await c.run('google_maps/reviews/list', { place: 'ChIJ' });
    expect(run.has_more).toBe(true);
    const next = await run.nextPage();
    expect(calls[1]!.body).toEqual(first!.next);
    expect(calls[1]!.headers['idempotency-key']).toMatch(UUID);
    expect(calls[1]!.headers['idempotency-key']).not.toBe(calls[0]!.headers['idempotency-key']);
    expect(next!.results).toHaveLength(1);
    expect(await next!.nextPage()).toBeNull();
    expect(calls).toHaveLength(2);
  });
});

describe('iterate', () => {
  it('yields every record across pages', async () => {
    const answers = pages([3, 3, 2]);
    const { client: c, calls } = client((_, i) => json(200, answers[i]));
    const records = [];
    for await (const r of c.iterate('google_maps/reviews/list', { place: 'ChIJ' })) records.push(r);
    expect(records).toHaveLength(8);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.body.options.cursor).toBe('c2');
  });

  it('stops at maxRecords without calling for another page', async () => {
    const answers = pages([3, 3, 3]);
    const { client: c, calls } = client((_, i) => json(200, answers[i]));
    const records = [];
    for await (const r of c.iterate('google_maps/reviews/list', { place: 'ChIJ' }, { maxRecords: 4 })) records.push(r);
    expect(records).toHaveLength(4);
    expect(calls).toHaveLength(2);
  });

  it('stops at maxPages', async () => {
    const answers = pages([3, 3, 3]);
    const { client: c, calls } = client((_, i) => json(200, answers[i]));
    const records = [];
    for await (const r of c.iterate('google_maps/reviews/list', { place: 'ChIJ' }, { maxPages: 2 })) records.push(r);
    expect(records).toHaveLength(6);
    expect(calls).toHaveLength(2);
  });

  it('calls nothing with a cap of 0, and once for a typed iterate', async () => {
    const answers = pages([2]);
    const { client: c, calls } = client((_, i) => json(200, answers[i]));
    for await (const _ of c.iterate('google_maps/reviews/list', { place: 'x' }, { maxRecords: 0 })) void _;
    expect(calls).toHaveLength(0);
    const records = [];
    for await (const r of c.googleMaps.reviews.list.iterate({ place: 'ChIJ' })) records.push(r);
    expect(records).toHaveLength(2);
    expect(calls[0]!.body.operation).toBe('reviews/list');
  });
});

describe('runMany', () => {
  it('gives one item per call, in their order, whatever order they finish in', async () => {
    const { client: c, calls } = client(async (call) => {
      const delay = call.body.options.delay as number;
      await new Promise((r) => setTimeout(r, delay));
      return json(200, answer(1, { id: `run_${call.body.options.q}` }));
    });
    const results = await c.runMany(
      [
        ['google_news/articles/search', { q: 'a', delay: 30 }],
        { operation: 'google_news/articles/search', options: { q: 'b', delay: 1 }, limit: 1 },
        { source: 'google_news', operation: 'articles/search', options: { q: 'c', delay: 10 } },
      ],
      { concurrency: 3 },
    );
    expect(results.map((r) => (r as Run).id)).toEqual(['run_a', 'run_b', 'run_c']);
    expect(calls.find((x) => x.body.options.q === 'b')!.body.limit).toBe(1);
  });

  it('gives the error of a failed call instead of throwing', async () => {
    const { client: c } = client((call) =>
      call.body.options.q === 'bad'
        ? apiError(422, 'invalid_request_error', 'invalid_options', { param: 'options.q' })
        : json(200, answer(1)),
    );
    const results = await c.runMany([
      ['google_news/articles/search', { q: 'ok' }],
      ['google_news/articles/search', { q: 'bad' }],
      ['nope' as string, {}],
    ]);
    expect(results[0]).toBeInstanceOf(Run);
    expect(results[1]).toBeInstanceOf(InvalidRequestError);
    expect((results[1] as LobstrError).param).toBe('options.q');
    expect(results[2]).toBeInstanceOf(TypeError);
  });

  it('runs at most `concurrency` calls at a time', async () => {
    let inFlight = 0;
    let most = 0;
    const { client: c } = client(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return json(200, answer(0));
    });
    const calls = Array.from({ length: 9 }, (_, i) => ['google_news/articles/search', { q: i }] as [string, object]);
    const results = await c.runMany(calls as any, { concurrency: 2 });
    expect(results).toHaveLength(9);
    expect(most).toBe(2);
  });

  it('waits on 429 concurrency_limit for retry_after, with the same key', async () => {
    vi.useFakeTimers();
    let busy = 4; // more than the client's own retries
    const { client: c, calls } = client(() =>
      busy-- > 0
        ? apiError(429, 'rate_limit_error', 'concurrency_limit', { retryable: true, retry_after: 1 })
        : json(200, answer(1)),
    );
    const done = c.runMany([['google_news/articles/search', { q: 'a' }]]);
    await vi.advanceTimersByTimeAsync(10_000);
    const [result] = await done;
    expect(result).toBeInstanceOf(Run);
    expect(calls).toHaveLength(5);
    expect(new Set(calls.map((x) => x.headers['idempotency-key'])).size).toBe(1);
  });
});

describe('retries', () => {
  it('waits Retry-After and keeps the same idempotency key', async () => {
    vi.useFakeTimers();
    const { client: c, calls } = client((_, i) =>
      i === 0 ? apiError(503, 'site_error', 'site_unavailable', { retryable: true }, { 'retry-after': '3' }) : json(200, answer(1)),
    );
    const promise = c.run('google_maps/reviews/list', { place: 'ChIJ' });
    await vi.advanceTimersByTimeAsync(2_900);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    const run = await promise;
    expect(run.count).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers['idempotency-key']).toBe(calls[0]!.headers['idempotency-key']);
  });

  it('prefers the body retry_after, and retries 409 idempotency_in_flight', async () => {
    vi.useFakeTimers();
    const { client: c, calls } = client((_, i) =>
      i === 0
        ? apiError(429, 'rate_limit_error', 'account_rate_limited', { retry_after: 5 }, { 'retry-after': '1' })
        : i === 1
          ? apiError(409, 'invalid_request_error', 'idempotency_in_flight', { retryable: true })
          : json(200, answer(1)),
    );
    const promise = c.run('x/tweets/search', { query: 'nasa' });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000); // idempotency_in_flight: retry in 2 s
    await promise;
    expect(calls).toHaveLength(3);
  });

  it('gives up after maxRetries', async () => {
    vi.useFakeTimers();
    const { client: c, calls } = client(() => apiError(500, 'api_error', 'internal_error', { retryable: true, retry_after: 1 }));
    const promise = c.run('google_maps/reviews/list', { place: 'ChIJ' }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await promise;
    expect(err).toBeInstanceOf(APIError);
    expect(calls).toHaveLength(3); // the call and 2 retries
  });

  it('does not retry what cannot work later', async () => {
    const { client: c, calls } = client(() => apiError(422, 'invalid_request_error', 'invalid_options'));
    await expect(c.run('google_maps/reviews/list', { place: 'x' })).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls).toHaveLength(1);
  });

  it('does not wait hours on a quota: a retry_after over a minute is raised', async () => {
    const { client: c, calls } = client(() =>
      apiError(429, 'rate_limit_error', 'account_quota_exceeded', { retryable: true, retry_after: 30_000 }),
    );
    const err = await c.run('leboncoin/phones/get', { listing: '1' }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfter).toBe(30_000);
    expect(calls).toHaveLength(1);
  });

  it('retries a network error on a run, with exponential backoff', async () => {
    vi.useFakeTimers();
    const { client: c, calls } = client((_, i) => {
      if (i < 2) throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') });
      return json(200, answer(1));
    });
    const promise = c.run('google_maps/reviews/list', { place: 'ChIJ' });
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((x) => x.headers['idempotency-key'])).size).toBe(1);
  });

  it('does not repeat a POST without a key after a network error (feedback)', async () => {
    const { client: c, calls } = client(() => {
      throw new TypeError('fetch failed');
    });
    const err = await c.feedback('hello').catch((e) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err.message).toContain('fetch failed');
    expect(calls).toHaveLength(1);
  });

  it('raises APITimeoutError past the client timeout', async () => {
    const mock = mockFetch(() => new Promise<Response>(() => {})); // never answers
    const c = new Lobstr({ apiKey: 'k', fetch: abortable(mock.fetch), timeout: 20, maxRetries: 0 });
    const err = await c.balance().catch((e) => e);
    expect(err).toBeInstanceOf(APITimeoutError);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err.code).toBe('client_timeout');
  });

  it('stops when the caller aborts', async () => {
    const mock = mockFetch(() => new Promise<Response>(() => {}));
    const c = new Lobstr({ apiKey: 'k', fetch: abortable(mock.fetch) });
    const controller = new AbortController();
    const promise = c.run('google_news/articles/search', { query: 'x' }, { signal: controller.signal }).catch((e) => e);
    controller.abort();
    const err = await promise;
    expect(err).not.toBeInstanceOf(LobstrError);
    expect(mock.calls).toHaveLength(1);
  });
});

/** Wraps a fetch so it rejects when its signal aborts, as the real one does. */
function abortable(inner: typeof fetch): typeof fetch {
  return ((input: any, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      inner(input, init).then(resolve, reject);
    })) as typeof fetch;
}

describe('errors', () => {
  const cases: [number, string, typeof LobstrError][] = [
    [400, 'invalid_request_error', InvalidRequestError],
    [404, 'invalid_request_error', InvalidRequestError],
    [401, 'authentication_error', AuthenticationError],
    [402, 'billing_error', BillingError],
    [429, 'rate_limit_error', RateLimitError],
    [408, 'site_error', SiteError],
    [424, 'site_error', SiteError],
    [500, 'api_error', APIError],
  ];
  for (const [status, type, Cls] of cases) {
    it(`maps ${status} ${type} to ${Cls.name}`, async () => {
      const { client: c } = client(() => apiError(status, type, 'some_code', { param: 'options.place' }), { maxRetries: 0 });
      const err = await c.run('google_maps/places/get', { place: 'x' }).catch((e) => e);
      expect(err).toBeInstanceOf(Cls);
      expect(err).toBeInstanceOf(LobstrError);
      expect(err.name).toBe(Cls.name);
      expect(err.status).toBe(status);
      expect(err.type).toBe(type);
      expect(err.code).toBe('some_code');
      expect(err.message).toBe('The message of some_code.');
      expect(err.param).toBe('options.place');
      expect(err.docUrl).toBe('https://docs.lobstr.io/errors#some_code');
      expect(err.requestId).toBe('req_error');
      expect(err.retryable).toBe(false);
    });
  }

  it('keeps retry_after, and reads the type from the status when the body has none', async () => {
    const { client: c } = client(() => new Response('<html>Bad gateway</html>', { status: 502 }), { maxRetries: 0 });
    const err = await c.balance().catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err.status).toBe(502);
    expect(err.message).toContain('Bad gateway');
    const { client: c2 } = client(() => apiError(429, 'rate_limit_error', 'concurrency_limit', { retryable: true, retry_after: 2 }), {
      maxRetries: 0,
    });
    const err2 = await c2.balance().catch((e) => e);
    expect(err2.retryAfter).toBe(2);
    expect(err2.retryable).toBe(true);
    expect(err2.toJSON()).toMatchObject({ code: 'concurrency_limit', retry_after: 2, doc_url: expect.any(String) });
  });
});

describe('resources', () => {
  it('reads the catalog without a key', async () => {
    const { client: c, calls } = client(() => json(200, { object: 'list', data: [], has_more: false }));
    await c.catalog.list({ source: 'google_maps' });
    await c.catalog.get('google_maps/places/search');
    await c.catalog.status('google_maps/places/search');
    expect(calls.map((x) => x.url.pathname + x.url.search)).toEqual([
      '/v2/catalog?source=google_maps',
      '/v2/catalog/google_maps/places/search',
      '/v2/catalog/google_maps/places/search/status',
    ]);
    expect(calls.every((x) => x.headers.authorization === undefined)).toBe(true);
  });

  it('reads the balance and sends feedback', async () => {
    const { client: c, calls } = client((call) =>
      call.url.pathname === '/v2/balance'
        ? json(200, { object: 'balance', credits: 42, plan: null })
        : json(201, { object: 'feedback', id: 'fbk_1', created_at: '2026-11-26T10:00:00Z', kind: 'bug' }),
    );
    expect((await c.balance()).credits).toBe(42);
    const fb = await c.feedback('A field is missing', { kind: 'missing_data', operation: 'google_maps/places/get', run: 'run_1' });
    expect(fb.id).toBe('fbk_1');
    expect(calls[1]!.method).toBe('POST');
    expect(calls[1]!.body).toEqual({
      message: 'A field is missing',
      kind: 'missing_data',
      operation: 'google_maps/places/get',
      run: 'run_1',
    });
  });

  it('lists, reads, connects and deletes accounts', async () => {
    const account = { object: 'account', id: 'acc_1', site: 'x', name: 'acme', status: 'ok' };
    const { client: c, calls } = client((call) =>
      call.method === 'DELETE'
        ? json(200, { object: 'account', id: 'acc_1', deleted: true })
        : call.url.pathname === '/v2/accounts' && call.method === 'GET'
          ? json(200, { object: 'list', data: [account], has_more: false })
          : json(call.method === 'POST' ? 201 : 200, account),
    );
    expect((await c.accounts.list({ site: 'x' })).data[0]!.id).toBe('acc_1');
    expect((await c.accounts.get('acc_1')).name).toBe('acme');
    await c.accounts.connect({ site: 'x', cookies: { auth_token: 'a', ct0: 'b' }, country: 'FR' });
    expect((await c.accounts.delete('acc_1')).deleted).toBe(true);
    expect(calls.map((x) => `${x.method} ${x.url.pathname}${x.url.search}`)).toEqual([
      'GET /v2/accounts?site=x',
      'GET /v2/accounts/acc_1',
      'POST /v2/accounts',
      'DELETE /v2/accounts/acc_1',
    ]);
    expect(calls[2]!.body).toEqual({ site: 'x', cookies: { auth_token: 'a', ct0: 'b' }, country: 'FR' });
    expect(calls[2]!.headers['idempotency-key']).toBeUndefined();
  });

  it('lists runs a page at a time, or every one across pages', async () => {
    const log = (id: string) => ({ object: 'run', id, status: 'succeeded' });
    const { client: c, calls } = client((call) =>
      call.url.searchParams.get('starting_after')
        ? json(200, { object: 'list', data: [log('run_3')], has_more: false, next: null })
        : json(200, {
            object: 'list',
            data: [log('run_1'), log('run_2')],
            has_more: true,
            next: '/v2/runs?limit=2&starting_after=run_2',
          }),
    );
    const page = await c.runs.list({
      limit: 2,
      operation: 'google_maps/reviews/list',
      status: 'succeeded',
      via: 'api',
      createdAfter: new Date('2026-11-09T08:00:00.123Z'),
      createdBefore: '2026-11-10T08:00:00Z',
    });
    expect(page.data).toHaveLength(2);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      limit: '2',
      operation: 'google_maps/reviews/list',
      status: 'succeeded',
      via: 'api',
      created_after: '2026-11-09T08:00:00Z',
      created_before: '2026-11-10T08:00:00Z',
    });
    const ids = [];
    for await (const run of c.runs.list({ limit: 2 })) ids.push(run.id);
    expect(ids).toEqual(['run_1', 'run_2', 'run_3']);
    expect(calls[2]!.url.pathname + calls[2]!.url.search).toBe('/v2/runs?limit=2&starting_after=run_2');
  });

  it('reads one run, and its whole answer as a Run', async () => {
    const [first] = pages([1, 1]);
    const { client: c, calls } = client((call) =>
      call.url.pathname.endsWith('/response')
        ? json(200, first)
        : call.method === 'POST'
          ? json(200, answer(1))
          : json(200, { object: 'run', id: 'run_9', http_status: 200 }),
    );
    expect((await c.runs.get('run_9')).http_status).toBe(200);
    const run = await c.runs.response('run_9');
    expect(run).toBeInstanceOf(Run);
    await run.nextPage();
    expect(calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual([
      'GET /v2/runs/run_9',
      'GET /v2/runs/run_9/response',
      'POST /v2/run',
    ]);
  });

  it('uses another base URL', async () => {
    const { client: c, calls } = client(() => json(200, { object: 'balance', credits: 1 }), {
      baseUrl: 'http://localhost:8000/',
    });
    await c.balance();
    expect(calls[0]!.url.toString()).toBe('http://localhost:8000/v2/balance');
  });
});

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });
});
