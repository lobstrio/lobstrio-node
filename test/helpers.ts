import { Lobstr } from '../src/index.js';
import type { ClientOptions } from '../src/index.js';

export interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: any;
}

type Reply = Response | Promise<Response>;

/** A `fetch` that records every call and answers with `handler`. */
export function mockFetch(handler: (call: Call, index: number) => Reply) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** A client on a mocked fetch, with a fake key. */
export function client(handler: (call: Call, index: number) => Reply, options: ClientOptions = {}) {
  const mock = mockFetch(handler);
  return { client: new Lobstr({ apiKey: 'test_key', fetch: mock.fetch, ...options }), calls: mock.calls };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_header', ...headers },
  });
}

export function apiError(
  status: number,
  type: string,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return json(
    status,
    {
      error: {
        type,
        code,
        message: `The message of ${code}.`,
        param: null,
        doc_url: `https://docs.lobstr.io/errors#${code}`,
        request_id: 'req_error',
        retryable: false,
        ...extra,
      },
    },
    headers,
  );
}

let counter = 0;

/** An answer of `POST /v2/run` with `n` records. */
export function answer(n: number, overrides: Record<string, unknown> = {}) {
  counter += 1;
  return {
    object: 'run',
    id: `run_${counter}`,
    created_at: '2026-11-26T10:00:00Z',
    livemode: true,
    source: 'google_maps',
    operation: 'reviews/list',
    version: '1.1.0',
    schema_url: 'https://api.lobstr.io/v2/catalog/google_maps/reviews/list',
    options: { place: 'ChIJ', sort: 'newest' },
    fields: null,
    limit: null,
    status: 'succeeded',
    count: n,
    has_more: false,
    next: null,
    cost: { credits: 4 },
    balance: { credits: 996 },
    duration_ms: 1000,
    request_id: `req_${counter}`,
    results: Array.from({ length: n }, (_, i) => ({ object: 'review', id: `r${counter}_${i}`, position: i + 1 })),
    ...overrides,
  };
}

/** A request for the next page, as an answer's `next` holds it. */
export function nextRequest(cursor: string) {
  return { source: 'google_maps', operation: 'reviews/list', options: { place: 'ChIJ', cursor } };
}

/** Pages of an answer, each pointing to the next by its cursor. */
export function pages(sizes: number[]) {
  return sizes.map((n, i) =>
    answer(n, {
      has_more: i < sizes.length - 1,
      next: i < sizes.length - 1 ? nextRequest(`c${i + 1}`) : null,
    }),
  );
}
