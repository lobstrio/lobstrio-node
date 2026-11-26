import { describe, expect, it } from 'vitest';

import { USAGE, UsageError, main, parseArgs, parseOptions, parseValue } from '../src/cli.js';
import { Lobstr } from '../src/index.js';
import { answer, apiError, json, mockFetch, pages } from './helpers.js';
import type { Call } from './helpers.js';

describe('key=value options', () => {
  it('reads a value as JSON when it is valid JSON, else as a string', () => {
    expect(parseValue('5')).toBe(5);
    expect(parseValue('45.76')).toBe(45.76);
    expect(parseValue('true')).toBe(true);
    expect(parseValue('null')).toBeNull();
    expect(parseValue('["a","b"]')).toEqual(['a', 'b']);
    expect(parseValue('{"lat":1}')).toEqual({ lat: 1 });
    expect(parseValue('"5"')).toBe('5');
    expect(parseValue('lobstr.io')).toBe('lobstr.io');
    expect(parseValue('bakeries in Lyon')).toBe('bakeries in Lyon');
    expect(parseValue('')).toBe('');
  });

  it('nests dotted keys', () => {
    expect(parseOptions(['query=bakeries in Lyon', 'near.lat=45.76', 'near.lng=4.84', 'zoom=15'])).toEqual({
      query: 'bakeries in Lyon',
      near: { lat: 45.76, lng: 4.84 },
      zoom: 15,
    });
    expect(parseOptions(['a.b.c=1'])).toEqual({ a: { b: { c: 1 } } });
    expect(parseOptions(['url=https://www.leboncoin.fr/recherche?text=a=b'])).toEqual({
      url: 'https://www.leboncoin.fr/recherche?text=a=b',
    });
  });

  it('refuses what is not key=value', () => {
    expect(() => parseOptions(['query'])).toThrow(UsageError);
    expect(() => parseOptions(['=x'])).toThrow(UsageError);
    expect(() => parseOptions(['a..b=1'])).toThrow(UsageError);
    expect(() => parseOptions(['near=1', 'near.lat=2'])).toThrow(UsageError);
  });
});

describe('arguments', () => {
  it('splits the command, its positionals and its flags', () => {
    expect(
      parseArgs(['run', 'google_maps/places/search', 'query=x', '--limit', '5', '--fields=name,phone', '--all', '--jsonl']),
    ).toEqual({
      command: 'run',
      positionals: ['google_maps/places/search', 'query=x'],
      flags: { limit: '5', fields: 'name,phone', all: true, jsonl: true },
    });
    expect(parseArgs(['-h']).flags.help).toBe(true);
    expect(parseArgs(['feedback', '--', '--not-a-flag']).positionals).toEqual(['--not-a-flag']);
  });

  it('refuses an unknown flag, or a flag without its value', () => {
    expect(() => parseArgs(['run', '--nope'])).toThrow(UsageError);
    expect(() => parseArgs(['run', 'op', '--limit'])).toThrow(UsageError);
    expect(() => parseArgs(['run', '--all=1'])).toThrow(UsageError);
  });
});

function harness(handler: (call: Call, index: number) => Response | Promise<Response>, tty = false) {
  const mock = mockFetch(handler);
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t), stdoutIsTTY: tty, stderrIsTTY: tty };
  const run = (argv: string[]) => main(argv, io, () => new Lobstr({ apiKey: 'test_key', fetch: mock.fetch, maxRetries: 0 }));
  return { run, calls: mock.calls, out, err, stdout: () => out.join(''), stderr: () => err.join('') };
}

describe('lobstr run', () => {
  it('sends the operation with its options, limit and fields, and prints the answer', async () => {
    const body = answer(2);
    const h = harness(() => json(200, body));
    const code = await h.run([
      'run',
      'google_maps/places/search',
      'query=bakeries in Lyon',
      'near.lat=45.76',
      'near.lng=4.84',
      '--limit',
      '5',
      '--fields',
      'name,phone',
    ]);
    expect(code).toBe(0);
    expect(h.calls[0]!.body).toEqual({
      source: 'google_maps',
      operation: 'places/search',
      options: { query: 'bakeries in Lyon', near: { lat: 45.76, lng: 4.84 } },
      limit: 5,
      fields: ['name', 'phone'],
    });
    expect(JSON.parse(h.stdout())).toEqual(body);
    expect(h.stdout().trim().split('\n')).toHaveLength(1); // compact when piped
    expect(h.stderr()).toBe('');
  });

  it('prints pretty JSON and a summary on a terminal', async () => {
    const h = harness(() => json(200, answer(1)), true);
    await h.run(['run', 'google_news/articles/search', 'query=lobstr.io']);
    expect(h.stdout()).toContain('\n  "object": "run"');
    expect(h.stderr()).toBe('1 record · 4 credits · 996 credits left\n');
  });

  it('prints records as JSON Lines with --jsonl', async () => {
    const h = harness(() => json(200, answer(3)));
    await h.run(['run', 'google_maps/reviews/list', 'place=ChIJ', '--jsonl']);
    const lines = h.stdout().trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).object).toBe('review');
  });

  it('follows every page with --all, up to --max-records', async () => {
    const answers = pages([3, 3, 3]);
    const h = harness((_, i) => json(200, answers[i]));
    await h.run(['run', 'google_maps/reviews/list', 'place=ChIJ', '--max-records', '5', '--jsonl']);
    expect(h.stdout().trim().split('\n')).toHaveLength(5);
    expect(h.calls).toHaveLength(2);

    const all = pages([2, 1]);
    const h2 = harness((_, i) => json(200, all[i]));
    await h2.run(['run', 'google_maps/reviews/list', 'place=ChIJ', '--all']);
    expect(JSON.parse(h2.stdout())).toHaveLength(3);
    expect(h2.calls[1]!.body.options.cursor).toBe('c1');
  });

  it('prints the API message and doc_url on stderr, exit code 1', async () => {
    const h = harness(() => apiError(422, 'invalid_request_error', 'invalid_options', { param: 'options.query' }));
    const code = await h.run(['run', 'google_news/articles/search', 'query=']);
    expect(code).toBe(1);
    expect(h.stdout()).toBe('');
    expect(h.stderr()).toContain('The message of invalid_options.');
    expect(h.stderr()).toContain('options.query');
    expect(h.stderr()).toContain('https://docs.lobstr.io/errors#invalid_options');
    expect(h.stderr()).not.toContain('test_key');
  });

  it('exits 2 on a usage error', async () => {
    const h = harness(() => json(200, answer(0)));
    expect(await h.run(['run'])).toBe(2);
    expect(await h.run(['run', 'google_news/articles/search', 'query'])).toBe(2);
    expect(await h.run(['run', 'google_news/articles/search', '--limit', '0'])).toBe(2);
    expect(await h.run(['balance', '--all'])).toBe(2);
    expect(await h.run(['nope'])).toBe(2);
    expect(await h.run([])).toBe(2);
    expect(h.calls).toHaveLength(0);
  });
});

describe('the other commands', () => {
  const catalog = {
    object: 'list',
    has_more: false,
    data: [
      { object: 'operation', id: 'google_maps/places/search', title: 'Search places', summary: 'Places of a Google Maps search.', price: { credits_per_call: 20 } },
      { object: 'operation', id: 'google_news/articles/search', title: 'Search articles', summary: 'Articles of a Google News search.', price: { credits_per_call: 1 } },
      { object: 'operation', id: 'x/tweets/search', title: 'Search tweets', summary: 'Tweets of a search on X.', price: { credits_per_call: 20 } },
    ],
  };

  it('filters the catalog on every word', async () => {
    const h = harness(() => json(200, catalog));
    await h.run(['catalog', 'google', 'SEARCH', 'news']);
    expect(JSON.parse(h.stdout())).toEqual([
      { id: 'google_news/articles/search', title: 'Search articles', credits_per_call: 1, summary: 'Articles of a Google News search.' },
    ]);
    expect(h.calls[0]!.headers.authorization).toBeUndefined();
  });

  it('prints an operation, the balance, the runs, and sends feedback', async () => {
    const h = harness((call) => {
      if (call.url.pathname.startsWith('/v2/catalog/')) return json(200, { object: 'operation', id: 'x/tweets/search' });
      if (call.url.pathname === '/v2/balance') return json(200, { object: 'balance', credits: 7 });
      if (call.url.pathname === '/v2/runs') return json(200, { object: 'list', data: [{ id: 'run_1' }], has_more: false, next: null });
      return json(201, { object: 'feedback', id: 'fbk_1', kind: 'other', created_at: '2026-11-26T00:00:00Z' });
    });
    await h.run(['operation', 'x/tweets/search']);
    await h.run(['balance']);
    await h.run(['runs', '--limit', '3']);
    await h.run(['feedback', 'A field is missing', '--operation', 'x/tweets/search', '--run', 'run_1']);
    const lines = h.stdout().trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0].id).toBe('x/tweets/search');
    expect(lines[1].credits).toBe(7);
    expect(lines[2]).toEqual([{ id: 'run_1' }]);
    expect(lines[3].id).toBe('fbk_1');
    expect(h.calls[2]!.url.searchParams.get('limit')).toBe('3');
    expect(h.calls[3]!.body).toEqual({ message: 'A field is missing', operation: 'x/tweets/search', run: 'run_1' });
  });

  it('prints the usage and the version', async () => {
    const h = harness(() => json(200, {}));
    expect(await h.run(['--help'])).toBe(0);
    expect(h.stdout()).toBe(USAGE);
    expect(await h.run(['--version'])).toBe(0);
    expect(h.stdout().endsWith('1.0.0\n')).toBe(true);
  });
});
