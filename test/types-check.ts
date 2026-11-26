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
