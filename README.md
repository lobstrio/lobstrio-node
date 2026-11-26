# lobstrio

The official Node.js SDK for [lobstr.io](https://www.lobstr.io)'s API v2: structured data from websites, one call per
page. The types of every operation's options and records, a `lobstr` command, no runtime dependencies.

```bash
npm install lobstrio
```

Node 18 or later, ESM or CommonJS.

## The key

Your API key is in the app, under [API](https://app.lobstr.io/dashboard/api). The client reads it from
`LOBSTR_API_KEY`, or takes it as `new Lobstr({ apiKey })`. The catalog needs none.

```bash
export LOBSTR_API_KEY="..."
```

## One call

```ts
import { Lobstr } from 'lobstrio';

const client = new Lobstr();
const run = await client.run('google_maps/places/search', { query: 'bakeries in Austin, TX' }, { limit: 5 });

run.results; // the records
run.cost.credits; // what the call cost
run.balance?.credits; // the credits left
run.next; // the whole call for the next page, or null
```

An operation is `source/resource/verb`, as the [catalog](https://api.lobstr.io/v2/catalog.md) names it, with its
options. The third argument takes `fields`, `limit`, `timeoutS` and `idempotencyKey`. The envelope's fields keep the
API's names (`has_more`, `request_id`...): [Run an operation](https://docs.lobstr.io/run).

Every call sends an `Idempotency-Key` (a UUID unless you give one), kept across the SDK's retries: a retry is never
charged twice.

## Every page

A call is one page. `nextPage()` sends `next` as it is, and answers `null` after the last page:

```ts
let page = await client.run('google_maps/reviews/list', { place: 'ChIJCar0f49ZwokR6ozLV-dHNTE' });
while (page) {
  for (const review of page.results) console.log(review.rating);
  page = await page.nextPage();
}
```

Or every record, page after page:

```ts
for await (const review of client.iterate('google_maps/reviews/list', { place: 'ChIJCar0f49ZwokR6ozLV-dHNTE' }, { maxRecords: 100 })) {
  console.log(review.text);
}
```

Each page is a call, at the operation's price: stop with `maxRecords`, `maxPages` or a `break`.

## A typed method

One per operation, with its options' and its record's types, and their descriptions in your editor:

```ts
const run = await client.googleMaps.places.search({ query: 'bakery', near: { lat: 30.27, lng: -97.74 } });
run.results[0].phone; // string | null

for await (const tweet of client.x.tweets.search.iterate({ query: 'nasa' }, { maxPages: 2 })) {
  console.log(tweet.text);
}
```

`client.run('google_maps/places/search', ...)` is typed the same way, and an operation newer than your SDK still runs,
untyped. The types are generated from the [OpenAPI](https://api.lobstr.io/v2/openapi.json).

## Many calls

```ts
const runs = await client.runMany(
  [
    ['google_maps/places/search', { query: 'bakeries in Austin, TX' }],
    ['google_maps/places/search', { query: 'bakeries in Dallas, TX' }, { limit: 5 }],
  ],
  { concurrency: 4 },
);
```

At most `concurrency` calls at a time, and one item per call, in their order: its `Run`, or the error it raised. Your
plan's calls at a time still count (1 on Free to 50 on Team): on `429 concurrency_limit` the SDK waits as long as the
API says. Each call is its own, at its operation's price.

## Errors

```ts
import { LobstrError } from 'lobstrio';

try {
  await client.run('google_maps/places/get', { place: 'nowhere' });
} catch (err) {
  if (err instanceof LobstrError) console.log(err.status, err.code, err.message, err.param, err.docUrl, err.requestId);
}
```

| Class | `type` | Status |
| --- | --- | --- |
| `InvalidRequestError` | `invalid_request_error` | 400, 404, 409, 410, 422 |
| `AuthenticationError` | `authentication_error` | 401 |
| `BillingError` | `billing_error` | 402 |
| `RateLimitError` | `rate_limit_error` | 429 |
| `SiteError` | `site_error` | 408, 424, 503 |
| `APIError` | `api_error` | 500 |
| `APIConnectionError`, `APITimeoutError` | | no answer |

All are `LobstrError`s, with `status`, `type`, `code`, `message`, `param`, `docUrl`, `requestId`, `retryable` and
`retryAfter`. The SDK retries up to `maxRetries` times (2) what can work later (the error's `retryable`, a `429` with
`retry_after`, `409 idempotency_in_flight`, a 5xx, a lost connection), waiting `retry_after` when the API gives it.
A failed call costs nothing: [Errors](https://docs.lobstr.io/errors).

## Everything else

```ts
await client.catalog.list(); // every operation, no key needed
await client.catalog.get('google_maps/places/search'); // its contract
await client.catalog.status('google_maps/places/search'); // how its calls went, 90 days
await client.balance(); // the credits left, and your plan

await client.accounts.connect({ site: 'x', cookies: { auth_token: '...', ct0: '...' }, country: 'US' });
await client.accounts.list({ site: 'x' });
await client.accounts.get('acc_...');
await client.accounts.delete('acc_...');

await client.runs.list({ limit: 20 }); // a page of your calls
for await (const call of client.runs.list({ status: 'failed' })) console.log(call.id); // every one
await client.runs.get('run_...');
await client.runs.response('run_...'); // a call's whole answer, as a Run

await client.feedback('A field is missing', { kind: 'missing_data', operation: 'google_maps/places/get' });
```

`new Lobstr({ apiKey, baseUrl, timeout, maxRetries, fetch, defaultHeaders })`: `timeout` is in milliseconds per
request (180,000 by default; a run waits at least its `timeoutS` plus 30 seconds).

## The CLI

```bash
npx lobstr run google_maps/places/search query="bakeries in Austin, TX" --limit 5 --fields name,phone
npx lobstr run google_maps/places/search query=bakery near.lat=30.27 near.lng=-97.74
npx lobstr run google_maps/reviews/list place=ChIJCar0f49ZwokR6ozLV-dHNTE --all --max-records 100 --jsonl
npx lobstr catalog google maps
npx lobstr operation google_maps/places/search
npx lobstr balance
npx lobstr runs --limit 5
npx lobstr feedback "A field is missing" --operation google_maps/places/get
```

Options are `key=value`: the value is read as JSON when it is valid JSON, else as a string; dotted keys nest. `--all`
follows every page, up to `--max-records`. The output is pretty JSON on a terminal, JSON Lines with `--jsonl`. An
error prints the API's message and its `doc_url` on stderr, with exit code 1.

## Agent frameworks

The tools of lobstr.io's [MCP server](https://github.com/lobstrio/lobstr-mcp) for the
[Vercel AI SDK](https://ai-sdk.dev), version 7, from `lobstrio/ai-sdk`:

```bash
npm install lobstrio ai @ai-sdk/anthropic
```

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, isStepCount } from 'ai';
import { lobstrTools } from 'lobstrio/ai-sdk';

const { text } = await generateText({
  model: anthropic('claude-sonnet-5-5'),
  tools: await lobstrTools(),
  stopWhen: isStepCount(10),
  prompt: 'What does the news say about Tesla today?',
});
```

Three tools: `lobstr_find_operations` finds the operations that fit what the agent needs (the catalog, read once),
`lobstr_get_operation` gives one's options and the fields of its records, `lobstr_run_operation` runs it, one page
at its price, and answers `count`, `cost`, `has_more`, `next` (its own arguments for the following page) and
`results`. `operations` adds a tool per operation, its input the operation's options:

```ts
import { Lobstr } from 'lobstrio';

const client = new Lobstr({ apiKey: process.env.LOBSTR_API_KEY });
const tools = await lobstrTools({ client, operations: ['google_maps/places/search'] });
tools.google_maps_places_search; // its input: query, near, zoom..., fields, limit
```

Every tool answers compact JSON, and a failed call comes back to the model as text (the API's message and
`doc_url`), never as a throw, the SDK's retries underneath. `ai` is an optional peer dependency: `lobstrio` itself
never loads it. The same tools, with the same names and answers, are in the
[Python SDK](https://github.com/lobstrio/lobstrio-python) for LangChain and CrewAI.

## Links

- Docs: https://docs.lobstr.io
- Catalog: https://api.lobstr.io/v2/catalog.md
- MCP server: https://github.com/lobstrio/lobstr-mcp

## License

[Apache 2.0](LICENSE), LOBSTR SAS.
