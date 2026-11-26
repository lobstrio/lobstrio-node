// The live smoke test: real calls to https://api.lobstr.io, skipped unless LOBSTR_API_KEY is set.
// It spends 1 credit (one google_news/articles/search call); the catalog and the balance are free.
import { describe, expect, it } from 'vitest';

import { Lobstr, Run } from '../src/index.js';

const live = Boolean(process.env.LOBSTR_API_KEY);

describe.skipIf(!live)('live', () => {
  const client = new Lobstr();

  it('lists the catalog', async () => {
    const catalog = await client.catalog.list();
    expect(catalog.object).toBe('list');
    expect(catalog.data.map((op) => op.id)).toContain('google_news/articles/search');
  });

  it('reads the balance', async () => {
    const balance = await client.balance();
    expect(balance.object).toBe('balance');
    expect(typeof balance.credits).toBe('number');
  });

  it('runs google_news/articles/search with limit 1', async () => {
    const run = await client.googleNews.articles.search({ query: 'lobstr.io' }, { limit: 1 });
    expect(run).toBeInstanceOf(Run);
    expect(run.object).toBe('run');
    expect(run.status).toBe('succeeded');
    expect(run.results.length).toBeLessThanOrEqual(1);
    expect(typeof run.cost.credits).toBe('number');
    console.info(
      `live run ${run.id}: ${run.status}, ${run.count} record(s), ${run.cost.credits} credit(s), version ${run.version}`,
    );
  }, 90_000);
});
