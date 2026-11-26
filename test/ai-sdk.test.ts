// The tools for the Vercel AI SDK (`lobstrio/ai-sdk`), on a mocked fetch: the three tools, the per-operation ones,
// their answers and errors as text, and a whole generateText loop with the AI SDK's mock model.
import { readdirSync, readFileSync } from 'node:fs';

import { generateText, isStepCount } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { lobstrTools } from '../src/ai-sdk.js';
import { answer, apiError, client, json } from './helpers.js';
import type { Call } from './helpers.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const CATALOG = fixture('catalog.json');
const CONTRACTS: Record<string, unknown> = {
  'google_news/articles/search': fixture('google_news.articles.search.json'),
  'google_maps/places/get': fixture('google_maps.places.get.json'),
};

/** The API, mocked: the catalog, two contracts, and `run` answered by `onRun`. */
function api(onRun: (call: Call, index: number) => Response | Promise<Response> = () => json(200, answer(1))) {
  return client((call, index) => {
    const path = call.url.pathname;
    if (call.method === 'GET' && path === '/v2/catalog') return json(200, CATALOG);
    if (call.method === 'GET' && path.startsWith('/v2/catalog/')) {
      const contract = CONTRACTS[path.slice('/v2/catalog/'.length)];
      return contract ? json(200, contract) : apiError(404, 'invalid_request_error', 'unknown_operation');
    }
    if (call.method === 'POST' && path === '/v2/run') return onRun(call, index);
    return apiError(404, 'invalid_request_error', 'not_found');
  });
}

/** Runs a tool's `execute` as the AI SDK does. */
async function call(tool: any, input: unknown, abortSignal?: AbortSignal): Promise<string> {
  return tool.execute(input, { toolCallId: 'call_1', messages: [], abortSignal, context: {} });
}

const parsed = async (tool: any, input: unknown) => JSON.parse(await call(tool, input));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('lobstrTools', () => {
  it('gives the three tools, each with a description and a JSON schema whose arguments are described', async () => {
    const { client: c, calls } = api();
    const tools = await lobstrTools({ client: c });
    expect(Object.keys(tools)).toEqual(['lobstr_find_operations', 'lobstr_get_operation', 'lobstr_run_operation']);
    for (const tool of Object.values(tools)) {
      expect(tool.description).toBeTruthy();
      const schema = (tool.inputSchema as any).jsonSchema;
      expect(schema.type).toBe('object');
      for (const property of Object.values(schema.properties) as any[]) expect(property.description).toBeTruthy();
    }
    const run = (tools.lobstr_run_operation.inputSchema as any).jsonSchema;
    expect(Object.keys(run.properties)).toEqual(['operation', 'options', 'fields', 'limit']);
    expect(run.required).toEqual(['operation', 'options']);
    expect(tools.lobstr_run_operation.description).toContain('Ask only for what you need');
    expect(tools.lobstr_run_operation.description).toContain('Each call costs its credits');
    expect(calls).toHaveLength(0); // nothing read before a tool is called
  });

  it('makes its own client by default, and works without a key until a call needs one', async () => {
    vi.stubEnv('LOBSTR_API_KEY', '');
    vi.stubGlobal('fetch', catalogOnlyFetch());
    // `new Lobstr()` on the global fetch: the catalog needs no key, a run says the key is missing, as text.
    const tools = await lobstrTools();
    const found = await parsed(tools.lobstr_find_operations, { query: 'news' });
    expect(found.operations[0].id).toBe('google_news/articles/search');
    const error = await parsed(tools.lobstr_run_operation, { operation: 'google_news/articles/search', options: { query: 'Tesla' } });
    expect(error.error.code).toBe('missing_api_key');
    expect(error.error.doc_url).toBe('https://docs.lobstr.io/errors#missing_api_key');
  });
});

/** A fetch that answers the catalog only. */
function catalogOnlyFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/v2/catalog') return json(200, CATALOG);
    return apiError(404, 'invalid_request_error', 'not_found');
  }) as typeof fetch;
}

describe('lobstr_find_operations', () => {
  it('ranks the operations by the words of the query, from the catalog read once', async () => {
    const { client: c, calls } = api();
    const tools = await lobstrTools({ client: c });
    const news = await call(tools.lobstr_find_operations, { query: 'news about a brand today' });
    expect(news).not.toContain('\n'); // compact JSON
    expect(JSON.parse(news)).toEqual({
      operations: [
        {
          id: 'google_news/articles/search',
          title: CATALOG.data.find((op: any) => op.id === 'google_news/articles/search').title,
          summary: CATALOG.data.find((op: any) => op.id === 'google_news/articles/search').summary,
          credits_per_call: 1,
        },
      ],
    });
    const reviews = await parsed(tools.lobstr_find_operations, { query: 'reviews of a restaurant on google maps' });
    expect(reviews.operations[0].id).toBe('google_maps/reviews/list');
    expect(Object.keys(reviews.operations[0])).toEqual(['id', 'title', 'summary', 'credits_per_call']);
    const tweets = await parsed(tools.lobstr_find_operations, { query: 'tweets about a brand' });
    expect(tweets.operations.map((op: any) => op.id)).toEqual(['x/tweets/search']);
    expect(calls.filter((c) => c.url.pathname === '/v2/catalog')).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBeUndefined(); // the catalog needs no key
  });

  it('lists every operation in one line for an empty query', async () => {
    const { client: c } = api();
    const tools = await lobstrTools({ client: c });
    const all = await parsed(tools.lobstr_find_operations, {});
    expect(all.operations).toHaveLength(CATALOG.data.length);
    expect(all.operations).toContain('google_news/articles/search: Search articles on news.google.com, 1 credit a call');
    expect(all.operations).toContain('google_maps/places/search: Search places on google.com/maps, 20 credits a call');
    expect(all.note).toBe('Ask with words for the details of those that fit.');
    expect(await parsed(tools.lobstr_find_operations, { query: 'the of in' })).toEqual(all);
  });

  it('lists every operation when nothing matches', async () => {
    const { client: c } = api();
    const tools = await lobstrTools({ client: c });
    const none = await parsed(tools.lobstr_find_operations, { query: 'zzzz qqqq' });
    expect(none.operations).toHaveLength(CATALOG.data.length);
    expect(none.note).toBe('Nothing matched these words: here is every operation; ask with its words.');
  });

  it('says a failed catalog read as text, and reads it again at the next call', async () => {
    let fail = true;
    const { client: c } = client((call) => {
      if (fail) {
        fail = false;
        return apiError(400, 'invalid_request_error', 'bad_request');
      }
      return json(200, CATALOG);
    });
    const tools = await lobstrTools({ client: c });
    expect((await parsed(tools.lobstr_find_operations, { query: 'news' })).error.code).toBe('bad_request');
    expect((await parsed(tools.lobstr_find_operations, { query: 'news' })).operations[0].id).toBe(
      'google_news/articles/search',
    );
  });
});

describe('lobstr_get_operation', () => {
  it("answers the operation's contract: input schema, record fields, price, pagination", async () => {
    const { client: c, calls } = api();
    const tools = await lobstrTools({ client: c });
    const text = await call(tools.lobstr_get_operation, { operation: ' google_news/articles/search ' });
    expect(text).not.toContain('\n');
    const contract = JSON.parse(text);
    const source = CONTRACTS['google_news/articles/search'] as any;
    expect(Object.keys(contract)).toEqual([
      'id', 'title', 'summary', 'use_when', 'input', 'record_fields', 'price', 'pagination',
    ]);
    expect(contract.id).toBe('google_news/articles/search');
    expect(contract.input).toEqual(source.input);
    expect(contract.price.credits_per_call).toBe(1);
    expect(contract.pagination).toEqual({ style: 'none', page_size: 100 });
    expect(contract.record_fields).toContain('publisher (name, site, icon, id, google_news_url)');
    expect(contract.record_fields).toContain('title');
    expect(calls[0]!.url.pathname).toBe('/v2/catalog/google_news/articles/search');
    expect(calls[0]!.headers.authorization).toBeUndefined(); // the catalog needs no key
  });

  it("answers an unknown operation's error as text, with its doc_url", async () => {
    const { client: c } = api();
    const tools = await lobstrTools({ client: c });
    const error = await parsed(tools.lobstr_get_operation, { operation: 'google_maps/places/nowhere' });
    expect(error.error).toMatchObject({
      type: 'invalid_request_error',
      code: 'unknown_operation',
      message: 'The message of unknown_operation.',
      doc_url: 'https://docs.lobstr.io/errors#unknown_operation',
    });
    const malformed = await parsed(tools.lobstr_get_operation, { operation: 'places' });
    expect(malformed.error.message).toContain('source/resource/verb');
  });
});

describe('lobstr_run_operation', () => {
  it('runs the operation and answers count, cost, has_more, next in its own shape, and results', async () => {
    const page = answer(2, {
      source: 'google_news',
      operation: 'articles/search',
      has_more: true,
      next: {
        source: 'google_news',
        operation: 'articles/search',
        options: { query: 'Tesla', cursor: 'c1' },
        fields: ['title', 'url'],
        limit: 2,
      },
      cost: { credits: 1 },
    });
    const { client: c, calls } = api(() => json(200, page));
    const tools = await lobstrTools({ client: c });
    const text = await call(tools.lobstr_run_operation, {
      operation: 'google_news/articles/search',
      options: { query: 'Tesla' },
      fields: ['title', 'url'],
      limit: 2,
    });
    expect(text).not.toContain('\n');
    expect(calls[0]!.body).toEqual({
      source: 'google_news',
      operation: 'articles/search',
      options: { query: 'Tesla' },
      fields: ['title', 'url'],
      limit: 2,
    });
    expect(calls[0]!.headers['idempotency-key']).toBeTruthy();
    const result = JSON.parse(text);
    expect(Object.keys(result)).toEqual(['count', 'cost', 'has_more', 'next', 'results']);
    expect(result).toEqual({
      count: 2,
      cost: { credits: 1 },
      has_more: true,
      next: {
        operation: 'google_news/articles/search',
        options: { query: 'Tesla', cursor: 'c1' },
        fields: ['title', 'url'],
        limit: 2,
      },
      results: page.results,
    });
  });

  it('answers next null on the last page, and leaves out empty fields and limit', async () => {
    const { client: c, calls } = api(() => json(200, answer(1)));
    const tools = await lobstrTools({ client: c });
    const result = await parsed(tools.lobstr_run_operation, {
      operation: 'google_maps/reviews/list',
      options: { place: 'ChIJ' },
      fields: [],
      limit: null,
    });
    expect(calls[0]!.body).toEqual({ source: 'google_maps', operation: 'reviews/list', options: { place: 'ChIJ' } });
    expect(result.next).toBeNull();
    expect(result.has_more).toBe(false);
  });

  it("answers the API's error as text, never a throw", async () => {
    const { client: c } = api(() => apiError(402, 'billing_error', 'insufficient_credits'));
    const tools = await lobstrTools({ client: c });
    const text = await call(tools.lobstr_run_operation, { operation: 'google_news/articles/search', options: { query: 'Tesla' } });
    expect(JSON.parse(text)).toEqual({
      error: {
        type: 'billing_error',
        code: 'insufficient_credits',
        message: 'The message of insufficient_credits.',
        param: null,
        doc_url: 'https://docs.lobstr.io/errors#insufficient_credits',
        request_id: 'req_error',
        retryable: false,
      },
    });
  });

  it("keeps the SDK's retries underneath, with one idempotency key", async () => {
    const { client: c, calls } = api((_call, index) =>
      index === 0 ? apiError(503, 'site_error', 'site_unavailable', { retryable: true, retry_after: 0 }) : json(200, answer(1)),
    );
    const tools = await lobstrTools({ client: c });
    const result = await parsed(tools.lobstr_run_operation, { operation: 'google_maps/reviews/list', options: { place: 'ChIJ' } });
    expect(result.count).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers['idempotency-key']).toBe(calls[0]!.headers['idempotency-key']);
  });

  it('throws when the agent loop is aborted', async () => {
    const controller = new AbortController();
    const { client: c } = api(() => {
      controller.abort();
      return apiError(503, 'site_error', 'site_unavailable', { retryable: true, retry_after: 1 });
    });
    const tools = await lobstrTools({ client: c });
    await expect(
      call(tools.lobstr_run_operation, { operation: 'google_maps/reviews/list', options: { place: 'ChIJ' } }, controller.signal),
    ).rejects.toThrow();
  });
});

describe('per-operation tools', () => {
  it("adds one tool per operation: its name, its summary and use_when, its input with fields (and limit for a list)", async () => {
    const { client: c, calls } = api();
    const tools = await lobstrTools({ client: c, operations: ['google_news/articles/search', 'google_maps/places/get'] });
    expect(Object.keys(tools)).toEqual([
      'lobstr_find_operations',
      'lobstr_get_operation',
      'lobstr_run_operation',
      'google_news_articles_search',
      'google_maps_places_get',
    ]);
    expect(calls.map((call) => call.url.pathname).sort()).toEqual([
      '/v2/catalog/google_maps/places/get',
      '/v2/catalog/google_news/articles/search',
    ]);
    const news = CONTRACTS['google_news/articles/search'] as any;
    expect(tools.google_news_articles_search!.description).toBe(`${news.summary}\n\n${news.use_when}`);
    const schema = (tools.google_news_articles_search!.inputSchema as any).jsonSchema;
    expect(schema.required).toEqual(['query']);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual([...Object.keys(news.input.properties), 'fields', 'limit']);
    expect(schema.properties.query).toEqual(news.input.properties.query);
    const place = (tools.google_maps_places_get!.inputSchema as any).jsonSchema;
    expect(place.properties.fields).toBeTruthy();
    expect(place.properties.limit).toBeUndefined(); // one record: no limit
    expect(news.input.properties.fields).toBeUndefined(); // the contract itself is left as it is
  });

  it('runs its operation with the options, fields and limit set apart, and answers next in its own shape', async () => {
    const page = answer(1, {
      source: 'google_news',
      operation: 'articles/search',
      has_more: true,
      next: { source: 'google_news', operation: 'articles/search', options: { query: 'Tesla', cursor: 'c1' }, fields: ['title'], limit: 1 },
    });
    const { client: c, calls } = api(() => json(200, page));
    const tools = await lobstrTools({ client: c, operations: ['google_news/articles/search'] });
    const result = await parsed(tools.google_news_articles_search, { query: 'Tesla', edition: 'US:en', fields: ['title'], limit: 1 });
    const run = calls.find((call) => call.method === 'POST')!;
    expect(run.body).toEqual({
      source: 'google_news',
      operation: 'articles/search',
      options: { query: 'Tesla', edition: 'US:en' },
      fields: ['title'],
      limit: 1,
    });
    expect(result.next).toEqual({ query: 'Tesla', cursor: 'c1', fields: ['title'], limit: 1 });
  });

  it('never sends a limit for an operation that answers one record', async () => {
    const { client: c, calls } = api(() => json(200, answer(1)));
    const tools = await lobstrTools({ client: c, operations: ['google_maps/places/get'] });
    await call(tools.google_maps_places_get, { place: 'ChIJCar0f49ZwokR6ozLV-dHNTE', limit: 5 });
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      source: 'google_maps',
      operation: 'places/get',
      options: { place: 'ChIJCar0f49ZwokR6ozLV-dHNTE' },
    });
  });

  it('answers its errors as text', async () => {
    const { client: c } = api(() => apiError(400, 'invalid_request_error', 'invalid_options', { param: 'options.query' }));
    const tools = await lobstrTools({ client: c, operations: ['google_news/articles/search'] });
    const error = await parsed(tools.google_news_articles_search, { query: '' });
    expect(error.error).toMatchObject({ code: 'invalid_options', param: 'options.query', doc_url: expect.any(String) });
  });

  it('fails to build for an operation the catalog does not have', async () => {
    const { client: c } = api();
    await expect(lobstrTools({ client: c, operations: ['google_maps/places/nowhere'] })).rejects.toMatchObject({
      code: 'unknown_operation',
    });
  });
});

describe('with generateText', () => {
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  };
  const toolCall = (toolName: string, input: unknown) => ({
    content: [{ type: 'tool-call' as const, toolCallId: `call_${toolName}`, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls' as const, raw: undefined },
    usage,
    warnings: [],
  });

  it('runs the tools the model calls and gives their answers back to it', async () => {
    const page = answer(1, { source: 'google_news', operation: 'articles/search', results: [{ object: 'article', id: 'a1', position: 1, title: 'Tesla today' }] });
    const { client: c, calls } = api((call) =>
      call.body.options.query === 'nowhere' ? apiError(400, 'invalid_request_error', 'invalid_options') : json(200, page),
    );
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCall('lobstr_find_operations', { query: 'news about a brand' }),
        toolCall('lobstr_run_operation', { operation: 'google_news/articles/search', options: { query: 'nowhere' } }),
        toolCall('google_news_articles_search', { query: 'Tesla', fields: ['title'], limit: 1 }),
        {
          content: [{ type: 'text' as const, text: 'The news says: Tesla today.' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage,
          warnings: [],
        },
      ],
    });
    const result = await generateText({
      model,
      tools: await lobstrTools({ client: c, operations: ['google_news/articles/search'] }),
      stopWhen: isStepCount(6),
      prompt: 'What does the news say about Tesla today?',
    });
    expect(result.text).toBe('The news says: Tesla today.');
    expect(result.steps).toHaveLength(4);
    const outputs = result.steps.flatMap((step) => step.toolResults.map((r) => [r.toolName, JSON.parse(r.output as string)]));
    expect(outputs[0]![1].operations[0].id).toBe('google_news/articles/search');
    expect(outputs[1]![1].error.code).toBe('invalid_options'); // the loop went on
    expect(outputs[2]![1].results[0].title).toBe('Tesla today');
    // The model was given the tools with their JSON schemas, and read each answer.
    const offered = model.doGenerateCalls[0]!.tools!.map((tool: any) => [tool.name, tool.inputSchema.type]);
    expect(offered).toEqual([
      ['lobstr_find_operations', 'object'],
      ['lobstr_get_operation', 'object'],
      ['lobstr_run_operation', 'object'],
      ['google_news_articles_search', 'object'],
    ]);
    expect(JSON.stringify(model.doGenerateCalls[3]!.prompt)).toContain('Tesla today');
    expect(calls.filter((call) => call.method === 'POST').map((call) => call.body.options.query)).toEqual(['nowhere', 'Tesla']);
  });
});

describe('the main entry', () => {
  it('never imports ai', () => {
    const dir = new URL('../src/', import.meta.url);
    const loaders = readdirSync(dir).filter((file) => file.endsWith('.ts') && file !== 'ai-sdk.ts');
    for (const file of loaders) {
      expect(readFileSync(new URL(file, dir), 'utf8'), file).not.toMatch(/from ['"]ai(\/[^'"]*)?['"]/);
    }
    expect(readFileSync(new URL('index.ts', dir), 'utf8')).not.toMatch(/agent-tools|ai-sdk/);
  });
});
