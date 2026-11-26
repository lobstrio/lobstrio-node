/**
 * lobstr.io's tools for agents, whatever the framework: find an operation, read it, run it. The same three tools as
 * the hosted MCP server (https://api.lobstr.io/v2/mcp), with its descriptions, and the same names, arguments and
 * answers as the Python SDK's (LangChain, CrewAI). Each framework's module only wraps them (`lobstrio/ai-sdk`).
 *
 * Every tool answers text, compact JSON, and never throws for a failed call: the API's error comes back to the agent
 * as text (its message and `doc_url`), the SDK's retries underneath.
 */
import type { Lobstr } from 'lobstrio';
import type { CatalogOperation, OperationContract, RunRequest } from 'lobstrio';

export const FIND_OPERATIONS = 'lobstr_find_operations';
export const GET_OPERATION = 'lobstr_get_operation';
export const RUN_OPERATION = 'lobstr_run_operation';

// What the agent reads to choose a tool and fill it in: the MCP server's own words (lobstrio/platform agents.py).
const OPERATION_ID = `The operation's id, source/resource/verb, as ${FIND_OPERATIONS} gives it: "google_maps/reviews/list".`;
const FIELDS =
  'Only these record fields, by path ("name", "address.full"); object, id and position always come. ' +
  'Left out: every field, which can be large.';
const LIMIT = 'Only the first N records of the page (1 to 1000), for a search or a list; the call costs the same.';

export const DESCRIPTIONS = {
  [FIND_OPERATIONS]:
    'Find the operations that return the data you need, from what you would ask in words ("reviews of a ' +
    'restaurant on google maps", "places near a point"): the few that fit best, each with its id ' +
    `(source/resource/verb), its title, what it returns and its price per call; ${GET_OPERATION} has its options ` +
    'and the fields of its records. An empty query lists every operation in one line.',
  [GET_OPERATION]:
    `Everything about one operation, by its id from ${FIND_OPERATIONS} ("google_maps/reviews/list"): when to use ` +
    'it, its options (`input`, a JSON schema: their types, their defaults, those `required`), every field of its ' +
    'records (`record_fields`, the paths `fields` takes: "seller (name, phones)" is seller.name and seller.phones), ' +
    'its price per call and its pagination (`page_size`, the records a call returns).',
  [RUN_OPERATION]:
    'Run one operation (POST /v2/run) and get one page of records in `results`, with `count`, `cost`, ' +
    `\`has_more\` and \`next\`. \`options\` is the operation's input (see ${FIND_OPERATIONS} or ${GET_OPERATION}).\n\n` +
    '`fields`: the record fields you need, by path ("name", "rating", "phone", "address.full"); `object`, `id` ' +
    'and `position` always come. Ask only for what you need: every field of a full page is large (20 places with ' +
    'all their fields are about 70,000 characters, more than you may be able to read in one answer), the same ' +
    'page with four fields is a few thousand.\n\n' +
    '`limit`: only the first N records of the page, for a search or a list; the call costs the same. With ' +
    '`fields`, it keeps a large page readable: 100 Google News articles with four fields are about 50,000 ' +
    'characters, with `limit` 20 a fifth of it.\n\n' +
    `One call is one page (\`pagination.page_size\` in ${GET_OPERATION}: 20 places, 20 reviews). For more, call ` +
    `${RUN_OPERATION} again with the answer's \`next\` as it is (its operation, options, fields and limit) until ` +
    'you have enough or `next` is null: 50 places are 3 calls. Each call costs its credits.',
} as const;

/** A JSON schema, as the frameworks take them. */
export type JsonSchemaObject = Record<string, unknown>;

export const INPUT_SCHEMAS: Record<typeof FIND_OPERATIONS | typeof GET_OPERATION | typeof RUN_OPERATION, JsonSchemaObject> = {
  [FIND_OPERATIONS]: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'What you need, in words, as you would ask it: "reviews of a restaurant on google maps". ' +
          'Empty: every operation, one line each.',
        default: '',
      },
    },
    additionalProperties: false,
  },
  [GET_OPERATION]: {
    type: 'object',
    properties: { operation: { type: 'string', description: OPERATION_ID } },
    required: ['operation'],
    additionalProperties: false,
  },
  [RUN_OPERATION]: {
    type: 'object',
    properties: {
      operation: { type: 'string', description: OPERATION_ID },
      options: {
        type: 'object',
        description:
          `The operation's input, its options as ${GET_OPERATION} lists them in \`input\`: ` +
          '{"query": "bakeries in Austin, TX"}. For the next page, the answer\'s `next` options, as they are.',
        additionalProperties: true,
      },
      fields: { type: 'array', items: { type: 'string' }, description: FIELDS },
      limit: { type: 'integer', minimum: 1, maximum: 1000, description: LIMIT },
    },
    required: ['operation', 'options'],
    additionalProperties: false,
  },
};

export interface FindOperationsInput {
  /** What you need, in words; empty: every operation. */
  query?: string;
}

export interface GetOperationInput {
  /** `source/resource/verb`. */
  operation: string;
}

export interface RunOperationInput {
  /** `source/resource/verb`. */
  operation: string;
  /** The operation's options. */
  options: Record<string, unknown>;
  /** Only these record fields, by path. */
  fields?: string[];
  /** Only the first N records of the page. */
  limit?: number;
}

/** A per-operation tool's input: the operation's options, and `fields` (and `limit` for a list). */
export type OperationToolInput = Record<string, unknown> & { fields?: string[]; limit?: number };

/** What a tool answers: JSON without spaces, a third of the size an indented answer takes in an agent's context. */
export function compact(value: unknown): string {
  return JSON.stringify(value);
}

// Ranking, as the MCP server's find_operations does it.
const WORD = /[a-z0-9]+/g;
const COMMON = new Set([
  'the', 'of', 'on', 'in', 'for', 'and', 'an', 'to', 'with', 'from', 'by', 'at', 'or', 'its', 'it', 'what', 'get',
  'all', 'my', 'me', 'find', 'want', 'need', 'data', 'list', 'one', 'page', 'you', 'your', 'about', 'they', 'their',
  'them', 'http', 'https', 'www', 'com', 'fr', 'sale',
]);
/** At most, the operations a search details. */
const FOUND = 5;
/** And only those scoring at least this share of the best one. */
const CLOSE = 0.4;

/** Lower-case words that say something, a plural read as its singular: "reviews" finds "review". */
export function words(text: unknown): Set<string> {
  const found = new Set<string>();
  for (const word of String(text ?? '').toLowerCase().match(WORD) ?? []) {
    const singular = word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
    if (singular.length > 1 && !COMMON.has(singular)) found.add(singular);
  }
  return found;
}

type Said = Array<[weight: number, found: Set<string>]>;

/** Where a word weighs most: the id, the title and the site, then the summary and the categories, then use_when. */
function said(op: CatalogOperation): Said {
  const site = op.site ?? ({} as { title?: string; domain?: string });
  const name = `${op.id.replace(/[_/]/g, ' ')} ${op.title ?? ''} ${site.title ?? ''} ${site.domain ?? ''}`;
  return [
    [3, words(name)],
    [2, words(`${op.summary ?? ''} ${(op.categories ?? []).join(' ')}`)],
    [1, words(op.use_when)],
  ];
}

/**
 * The few operations that fit the query best. A word weighs by where it is and by how rare it is in the catalog
 * ("airbnb" says more than "search", which nearly every operation carries); kept: those scoring at least CLOSE of
 * the best, FOUND at most. A query without a telling word: the whole catalog.
 */
export function ranked(every: CatalogOperation[], query: string): CatalogOperation[] {
  const asked = words(query);
  if (!asked.size) return every;
  const texts = new Map(every.map((op) => [op.id, said(op)] as const));
  const rare = new Map<string, number>();
  for (const word of asked) {
    const carried = every.filter((op) => texts.get(op.id)!.some(([, found]) => found.has(word))).length;
    if (carried) rare.set(word, Math.log(1 + every.length / carried));
  }
  const score = (op: CatalogOperation) => {
    let total = 0;
    for (const [word, weight] of rare) {
      let best = 0;
      for (const [where, found] of texts.get(op.id)!) if (found.has(word) && where > best) best = where;
      total += best * weight;
    }
    return total;
  };
  const scored = every.map((op) => [score(op), op] as const).sort((a, b) => b[0] - a[0]);
  const best = scored.length ? scored[0]![0] : 0;
  return scored
    .filter(([s]) => s > 0 && s >= CLOSE * best)
    .slice(0, FOUND)
    .map(([, op]) => op);
}

function credits(op: CatalogOperation): number | undefined {
  return op.price?.credits_per_call;
}

/** An operation in one line: `airbnb/homes/search: Search homes on airbnb.com, 1 credit a call`. */
export function line(op: CatalogOperation): string {
  const n = credits(op);
  return `${op.id}: ${op.title} on ${op.site?.domain}, ${n} ${n === 1 ? 'credit' : 'credits'} a call`;
}

/**
 * The record's fields, every object with its own: "seller (name, type, phones, address (city, postal_code))", the
 * very paths `fields` takes (seller.phones). A list's items come whole and are named alone.
 */
export function recordFields(record: unknown): string[] {
  const properties = (schema: unknown): Record<string, unknown> => {
    const props = schema && typeof schema === 'object' ? (schema as { properties?: unknown }).properties : undefined;
    return props && typeof props === 'object' ? (props as Record<string, unknown>) : {};
  };
  const named = (name: string, schema: unknown): string => {
    const children = Object.entries(properties(schema));
    if (!children.length) return name;
    return `${name} (${children.map(([k, v]) => named(k, v)).join(', ')})`;
  };
  return Object.entries(properties(record)).map(([k, v]) => named(k, v));
}

/** Whether an operation answers a page of several records (a search, a list), which `limit` cuts. */
export function isList(contract: OperationContract): boolean {
  const pagination = contract.pagination as { style?: string; page_size?: number } | null | undefined;
  return Boolean(pagination) && (pagination!.style !== 'none' || (pagination!.page_size ?? 1) > 1);
}

/** A per-operation tool's name: `google_maps/places/search` is `google_maps_places_search`. */
export function toolName(operation: string): string {
  return operation.replace(/\//g, '_');
}

/** A per-operation tool's description: the operation's summary and when to use it. */
export function operationDescription(contract: OperationContract): string {
  return [contract.summary, contract.use_when].filter(Boolean).join('\n\n');
}

/** A per-operation tool's input schema: the operation's input as it is, plus `fields`, and `limit` for a list. */
export function operationInputSchema(contract: OperationContract): JsonSchemaObject {
  const input = (contract.input ?? { type: 'object', properties: {} }) as JsonSchemaObject;
  const properties = { ...((input.properties as Record<string, unknown>) ?? {}) };
  if (!('fields' in properties)) properties.fields = { type: 'array', items: { type: 'string' }, description: FIELDS };
  if (isList(contract) && !('limit' in properties)) {
    properties.limit = { type: 'integer', minimum: 1, maximum: 1000, description: LIMIT };
  }
  return { ...input, type: 'object', properties };
}

/** An error as the agent reads it: the API's error object (its message and `doc_url`), never a throw. */
export function errorText(err: unknown): string {
  const e = (err ?? {}) as { body?: unknown; type?: unknown; code?: unknown; docUrl?: unknown; message?: unknown };
  const body = e.body as { error?: unknown } | undefined;
  if (body && typeof body === 'object' && body.error && typeof body.error === 'object') return compact(body);
  const error: Record<string, unknown> = {};
  if (typeof e.type === 'string') error.type = e.type;
  if (typeof e.code === 'string') error.code = e.code;
  error.message = typeof e.message === 'string' && e.message ? e.message : String(err);
  if (typeof e.docUrl === 'string') error.doc_url = e.docUrl;
  return compact({ error });
}

interface RunLike {
  count: number;
  cost: { credits: number };
  has_more: boolean;
  next: RunRequest | null;
  results: unknown[];
}

function answer(run: RunLike, next: Record<string, unknown> | null): string {
  return compact({ count: run.count, cost: run.cost, has_more: run.has_more, next, results: run.results });
}

/** `next` as lobstr_run_operation takes it: `{operation, options, fields?, limit?}`. */
function nextForRun(next: RunRequest | null): Record<string, unknown> | null {
  if (!next) return null;
  return {
    operation: `${next.source}/${next.operation}`,
    options: next.options ?? {},
    ...(next.fields ? { fields: next.fields } : {}),
    ...(next.limit ? { limit: next.limit } : {}),
  };
}

/** `next` as a per-operation tool takes it: its options, with `fields` and `limit`. */
function nextForOperation(next: RunRequest | null): Record<string, unknown> | null {
  if (!next) return null;
  return {
    ...(next.options ?? {}),
    ...(next.fields ? { fields: next.fields } : {}),
    ...(next.limit ? { limit: next.limit } : {}),
  };
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length ? value.map(String) : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && value > 0 ? value : undefined;
}

function rethrowAbort(err: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) throw err;
}

/**
 * The tools' work on one client: the catalog read once and kept for the tools' lifetime, each contract read once.
 */
export class AgentTools {
  #catalog?: Promise<CatalogOperation[]>;
  readonly #contracts = new Map<string, Promise<OperationContract>>();

  constructor(readonly client: Lobstr) {}

  /** Every operation (`GET /v2/catalog`), read once. */
  catalog(): Promise<CatalogOperation[]> {
    if (!this.#catalog) {
      const catalog = this.client.catalog.list().then((list) => list.data);
      // A failed read is tried again at the next call.
      catalog.catch(() => {
        if (this.#catalog === catalog) this.#catalog = undefined;
      });
      this.#catalog = catalog;
    }
    return this.#catalog;
  }

  /** One operation's contract (`GET /v2/catalog/{source}/{resource}/{verb}`), read once. */
  contract(operation: string): Promise<OperationContract> {
    let contract = this.#contracts.get(operation);
    if (!contract) {
      const read = this.client.catalog.get(operation);
      read.catch(() => {
        if (this.#contracts.get(operation) === read) this.#contracts.delete(operation);
      });
      this.#contracts.set(operation, read);
      contract = read;
    }
    return contract;
  }

  /** lobstr_find_operations. */
  async findOperations(input: FindOperationsInput = {}): Promise<string> {
    try {
      const every = await this.catalog();
      const query = typeof input.query === 'string' ? input.query : '';
      if (!words(query).size) {
        return compact({ operations: every.map(line), note: 'Ask with words for the details of those that fit.' });
      }
      const found = ranked(every, query);
      if (found.length) {
        return compact({
          operations: found.map((op) => ({
            id: op.id,
            title: op.title,
            summary: op.summary,
            credits_per_call: credits(op) ?? null,
          })),
        });
      }
      return compact({
        operations: every.map(line),
        note: 'Nothing matched these words: here is every operation; ask with its words.',
      });
    } catch (err) {
      return errorText(err);
    }
  }

  /** lobstr_get_operation. */
  async getOperation(input: GetOperationInput): Promise<string> {
    try {
      const contract = await this.contract(String(input?.operation ?? '').trim());
      return compact({
        id: contract.id,
        title: contract.title,
        summary: contract.summary,
        use_when: contract.use_when ?? null,
        input: contract.input ?? null,
        record_fields: recordFields(contract.record),
        price: contract.price ?? null,
        pagination: contract.pagination ?? null,
      });
    } catch (err) {
      return errorText(err);
    }
  }

  /** lobstr_run_operation. */
  async runOperation(input: RunOperationInput, signal?: AbortSignal): Promise<string> {
    try {
      const options = input?.options && typeof input.options === 'object' ? input.options : {};
      const run = await this.client.run(String(input?.operation ?? '').trim(), options, {
        fields: strings(input?.fields),
        limit: count(input?.limit),
        signal,
      });
      return answer(run, nextForRun(run.next));
    } catch (err) {
      rethrowAbort(err, signal);
      return errorText(err);
    }
  }

  /** A per-operation tool's call: its options, `fields` and `limit` set apart. */
  async runTool(operation: string, contract: OperationContract, input: OperationToolInput, signal?: AbortSignal): Promise<string> {
    try {
      const own = (contract.input as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
      const options: Record<string, unknown> = { ...(input ?? {}) };
      let fields: string[] | undefined;
      let limit: number | undefined;
      if (!('fields' in own)) {
        fields = strings(options.fields);
        delete options.fields;
      }
      if (!('limit' in own)) {
        limit = isList(contract) ? count(options.limit) : undefined;
        delete options.limit;
      }
      const run = await this.client.run(operation, options, { fields, limit, signal });
      return answer(run, nextForOperation(run.next));
    } catch (err) {
      rethrowAbort(err, signal);
      return errorText(err);
    }
  }
}
