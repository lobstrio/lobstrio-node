// Compiled by `npm run lint` (tsc --noEmit), never run: the typed surface, and what it must refuse.
import { Lobstr } from '../src/index.js';
const client = new Lobstr('k');
async function f() {
  const a = await client.run('google_maps/places/search', { query: 'x' });
  const name: string | null = a.results[0]!.name;
  // @ts-expect-error unknown option on a known operation
  await client.run('google_maps/places/search', { query: 'x', nope: 1 });
  const b = await client.run('some/new/op', { anything: 1 });
  b.results[0]!.object;
  const c = await client.googleMaps.places.search({ query: 'x', near: { lat: 1, lng: 2 } }, { limit: 2 });
  c.results[0]!.rating;
  // @ts-expect-error limit refused on a single-record operation
  await client.googleMaps.places.get({ place: 'x' }, { limit: 1 });
  for await (const r of client.googleMaps.places.search.iterate({ query: 'x' }, { maxRecords: 3 })) r.name;
  for await (const r of client.iterate('google_news/articles/search', { query: 'x' })) r.title;
  await client.x.bookmarks.list();
  const page = await client.runs.list({ limit: 5 });
  page.data[0]!.http_status;
  for await (const r of client.runs.list()) r.id;
  const next = await c.nextPage();
  next?.results[0]?.name;
  const res = await client.runMany([['google_news/articles/search', { query: 'a' }], { operation: 'google_news/articles/search', options: { query: 'b' }, limit: 1 }, c.next!]);
  return [name, res];
}
f;

// The README's examples.
async function readme() {
  const run = await client.run('google_maps/places/search', { query: 'bakeries in Lyon' }, { limit: 5 });
  void [run.results, run.cost.credits, run.balance?.credits, run.next];
  let page: Awaited<ReturnType<typeof client.googleMaps.reviews.list>> | null = await client.run('google_maps/reviews/list', {
    place: 'ChIJc_459AHr9EcRd0ALc7vrjcI',
  });
  while (page) {
    for (const review of page.results) console.log(review.rating);
    page = await page.nextPage();
  }
  for await (const review of client.iterate('google_maps/reviews/list', { place: 'x' }, { maxRecords: 100 })) {
    console.log(review.text);
  }
  const typed = await client.googleMaps.places.search({ query: 'bakery', near: { lat: 45.76, lng: 4.84 } });
  const phone: string | null = typed.results[0].phone;
  for await (const tweet of client.x.tweets.search.iterate({ query: 'nasa' }, { maxPages: 2 })) console.log(tweet.text);
  await client.runMany(
    [
      ['google_maps/places/search', { query: 'bakeries in Lyon' }],
      ['google_maps/places/search', { query: 'bakeries in Lille' }, { limit: 5 }],
    ],
    { concurrency: 4 },
  );
  await client.catalog.list();
  await client.catalog.get('google_maps/places/search');
  await client.catalog.status('google_maps/places/search');
  await client.balance();
  await client.accounts.connect({ site: 'x', cookies: { auth_token: '...', ct0: '...' }, country: 'FR' });
  await client.accounts.list({ site: 'x' });
  await client.accounts.get('acc_...');
  await client.accounts.delete('acc_...');
  await client.runs.list({ limit: 20 });
  for await (const call of client.runs.list({ status: 'failed' })) console.log(call.id);
  await client.runs.get('run_...');
  await client.runs.response('run_...');
  await client.feedback('A field is missing', { kind: 'missing_data', operation: 'google_maps/places/get' });
  return phone;
}
readme;
