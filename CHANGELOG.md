# Changelog

All notable changes to `lobstrio`, the Node.js SDK for lobstr.io's API v2, are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## 1.1.0 (2026-11-26)

### Added

- `lobstrio/ai-sdk`, the tools for the Vercel AI SDK (`ai` 7, an optional peer dependency that the main entry never
  loads): `await lobstrTools({ client, operations })` gives `lobstr_find_operations`, `lobstr_get_operation` and
  `lobstr_run_operation`, the MCP server's three tools with the same names, arguments and answers as the Python
  SDK's, plus one tool per operation in `operations` (`google_maps_places_search`), its input the operation's JSON
  schema with `fields` and `limit`. Answers are compact JSON; a failed call comes back to the model as text, the
  API's message and `doc_url`. ESM and CommonJS, with types.

### Changed

- The examples of the README, the JSDoc and the CLI's help are in the US: bakeries in Austin, TX, the reviews of
  Katz's Delicatessen in New York.

## 1.0.0 (2026-11-26)

The first version, for the API v2.

### Added

- `Lobstr`, the client, on the global `fetch` (Node 18 or later), without runtime dependencies, as ESM and CommonJS
  with its types. The key from `apiKey` or `LOBSTR_API_KEY`; a missing key fails at the first call that needs one.
- `client.run(operation, options, params)` and `client.send(request)`, answering a `Run`: the envelope's fields,
  `results`, and `nextPage()`.
- `client.iterate()`, every record across pages, with `maxRecords` and `maxPages`.
- `client.runMany(calls, { concurrency })`, calls in parallel, one `Run` or error per call in their order, waiting
  on `429 concurrency_limit`.
- A typed method per operation, `client.googleMaps.places.search(options, params)` and its `.iterate()`, generated
  from the OpenAPI by `scripts/generate.mjs`: 40 operations.
- `client.catalog`, `client.balance()`, `client.accounts`, `client.runs` (pages to `await`, or `for await` across
  pages), `client.feedback()`.
- Retries of what can work later, waiting `retry_after`, with one `Idempotency-Key` per call across its retries.
- Errors by type: `InvalidRequestError`, `AuthenticationError`, `BillingError`, `RateLimitError`, `SiteError`,
  `APIError`, and `APIConnectionError`, `APITimeoutError`, all `LobstrError`s.
- The `lobstr` command: `run`, `catalog`, `operation`, `balance`, `runs`, `feedback`.
