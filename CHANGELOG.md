# Changelog

All notable changes to `lobstrio`, the Node.js SDK for lobstr.io's API v2, are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

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
