/**
 * The `lobstr` command: lobstr.io's API v2 from a terminal.
 *
 *   lobstr run google_maps/places/search query="bakeries in Lyon" near.lat=45.76 --limit 5 --fields name,phone
 *
 * The same grammar as the Python SDK's `lobstr`. Output: pretty JSON on a terminal, compact JSON when piped,
 * JSON Lines with `--jsonl`. Errors: the API's message and its doc_url on stderr, exit code 1.
 */
import { Lobstr } from './client.js';
import { LobstrError } from './errors.js';
import type { Run } from './run.js';
import type { CatalogOperation } from './types.js';
import { VERSION } from './version.js';

export const USAGE = `lobstr ${VERSION}: lobstr.io's API v2 from the command line.

Usage:
  lobstr run <source/resource/verb> [key=value ...] [--limit N] [--fields a,b] [--all] [--max-records N] [--jsonl]
  lobstr catalog [words ...] [--jsonl]
  lobstr operation <source/resource/verb>
  lobstr balance
  lobstr runs [--limit N] [--jsonl]
  lobstr feedback "<message>" [--operation op] [--run id]

Options are key=value: the value is read as JSON when it is valid JSON, else as a string; dotted keys nest
(near.lat=45.76). --all follows every page (each page is a call, at the operation's price), up to --max-records.
The API key comes from LOBSTR_API_KEY (https://app.lobstr.io/dashboard/api); the catalog needs none.

Examples:
  lobstr catalog google maps
  lobstr run google_maps/places/search query="bakeries in Lyon" --limit 5 --fields name,phone
  lobstr run google_maps/reviews/list place=ChIJc_459AHr9EcRd0ALc7vrjcI --all --max-records 100 --jsonl

Docs: https://docs.lobstr.io · Catalog: https://api.lobstr.io/v2/catalog.md
`;

/** A mistake in the command line itself: exit code 2. */
export class UsageError extends Error {}

const VALUE_FLAGS = new Set(['limit', 'fields', 'max-records', 'operation', 'run']);
const BOOLEAN_FLAGS = new Set(['all', 'jsonl', 'help', 'version']);
const SHORT_FLAGS: Record<string, string> = { '-h': 'help', '-V': 'version' };
const COMMAND_FLAGS: Record<string, string[]> = {
  run: ['limit', 'fields', 'all', 'max-records', 'jsonl'],
  catalog: ['jsonl'],
  operation: [],
  balance: [],
  runs: ['limit', 'jsonl'],
  feedback: ['operation', 'run'],
};

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Splits the command line into its command, positionals (`key=value`, words) and `--flags`. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (SHORT_FLAGS[arg]) {
      flags[SHORT_FLAGS[arg]!] = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1) throw new UsageError(`--${name} takes no value.`);
      flags[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      if (eq !== -1) flags[name] = arg.slice(eq + 1);
      else if (i + 1 < argv.length) flags[name] = argv[++i]!;
      else throw new UsageError(`--${name} needs a value.`);
    } else {
      throw new UsageError(`Unknown option --${name}.`);
    }
  }
  const command = positionals.shift() ?? null;
  return { command, positionals, flags };
}

/** A `key=value`'s value: JSON when it is valid JSON (`5`, `true`, `["a"]`), else the string as it is. */
export function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** `key=value` pairs to the options object; dotted keys nest (`near.lat=45.76` gives `{near: {lat: 45.76}}`). */
export function parseOptions(pairs: string[]): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new UsageError(`Options are key=value: got "${pair}".`);
    const path = pair.slice(0, eq).split('.');
    if (path.some((p) => !p)) throw new UsageError(`An empty key in "${pair}".`);
    let target = options;
    for (const key of path.slice(0, -1)) {
      const current = target[key];
      if (current === undefined) target[key] = {};
      else if (current === null || typeof current !== 'object' || Array.isArray(current)) {
        throw new UsageError(`"${pair}": ${key} is already a value, not an object.`);
      }
      target = target[key] as Record<string, unknown>;
    }
    target[path[path.length - 1]!] = parseValue(pair.slice(eq + 1));
  }
  return options;
}

function positiveInt(value: string | boolean | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${flag} takes a whole number, 1 or more.`);
  return n;
}

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /** Whether stdout is a terminal: pretty JSON. */
  stdoutIsTTY: boolean;
  /** Whether stderr is a terminal: a one-line summary of what a run cost. */
  stderrIsTTY: boolean;
}

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

function summary(records: number, credits: number, left: number | undefined, more: boolean): string {
  const parts = [plural(records, 'record'), plural(credits, 'credit')];
  if (left !== undefined) parts.push(`${plural(left, 'credit')} left`);
  return `${parts.join(' · ')}${more ? ' · more pages: --all' : ''}\n`;
}

/** Runs the command line; returns the exit code. */
export async function main(
  argv: string[],
  io: CliIO,
  makeClient: () => Lobstr = () => new Lobstr(),
): Promise<number> {
  const print = (value: unknown, jsonl: boolean) => {
    if (jsonl && Array.isArray(value)) for (const item of value) io.out(`${JSON.stringify(item)}\n`);
    else if (jsonl) io.out(`${JSON.stringify(value)}\n`);
    else io.out(`${io.stdoutIsTTY ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`);
  };

  try {
    const { command, positionals, flags } = parseArgs(argv);
    if (flags.version) {
      io.out(`${VERSION}\n`);
      return 0;
    }
    if (flags.help || command === 'help') {
      io.out(USAGE);
      return 0;
    }
    if (command === null) {
      io.err(USAGE);
      return 2;
    }
    const allowed = COMMAND_FLAGS[command];
    if (!allowed) throw new UsageError(`Unknown command "${command}".`);
    for (const flag of Object.keys(flags)) {
      if (!allowed.includes(flag)) throw new UsageError(`lobstr ${command} takes no --${flag}.`);
    }
    const jsonl = flags.jsonl === true;
    const client = makeClient();

    switch (command) {
      case 'run': {
        const [operation, ...pairs] = positionals;
        if (!operation) throw new UsageError('lobstr run <source/resource/verb> [key=value ...]');
        const options = parseOptions(pairs);
        const limit = positiveInt(flags.limit, 'limit');
        const maxRecords = positiveInt(flags['max-records'], 'max-records');
        const fields =
          typeof flags.fields === 'string' ? flags.fields.split(',').map((f) => f.trim()).filter(Boolean) : undefined;
        const all = flags.all === true || maxRecords !== undefined;
        let run: Run | null = await client.run(operation, options, { limit, fields });
        if (!all) {
          if (jsonl) print(run.results, true);
          else print(run, false);
          if (io.stderrIsTTY) io.err(summary(run.count, run.cost?.credits ?? 0, run.balance?.credits, Boolean(run.next)));
          return 0;
        }
        // Every page, up to --max-records: records as they come with --jsonl, else one array at the end.
        const records: unknown[] = [];
        let count = 0;
        let credits = 0;
        let left: number | undefined;
        while (run) {
          credits += run.cost?.credits ?? 0;
          left = run.balance?.credits ?? left;
          for (const record of run.results) {
            if (maxRecords !== undefined && count >= maxRecords) break;
            if (jsonl) print(record, true);
            else records.push(record);
            count += 1;
          }
          if (maxRecords !== undefined && count >= maxRecords) break;
          run = await run.nextPage();
        }
        if (!jsonl) print(records, false);
        if (io.stderrIsTTY) io.err(summary(count, credits, left, false));
        return 0;
      }
      case 'catalog': {
        const words = positionals.map((w) => w.toLowerCase());
        const { data } = await client.catalog.list();
        const matches = data.filter((op: CatalogOperation) => {
          const text = [op.id, op.title, op.summary, op.use_when, op.site?.title, ...(op.categories ?? [])]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return words.every((w) => text.includes(w));
        });
        print(
          matches.map((op) => ({
            id: op.id,
            title: op.title,
            credits_per_call: op.price?.credits_per_call ?? null,
            summary: op.summary,
          })),
          jsonl,
        );
        return 0;
      }
      case 'operation': {
        const [operation] = positionals;
        if (!operation || positionals.length > 1) throw new UsageError('lobstr operation <source/resource/verb>');
        print(await client.catalog.get(operation), jsonl);
        return 0;
      }
      case 'balance': {
        if (positionals.length) throw new UsageError('lobstr balance takes no arguments.');
        print(await client.balance(), jsonl);
        return 0;
      }
      case 'runs': {
        if (positionals.length) throw new UsageError('lobstr runs [--limit N]');
        const page = await client.runs.list({ limit: positiveInt(flags.limit, 'limit') });
        print(page.data, jsonl);
        return 0;
      }
      case 'feedback': {
        const [message] = positionals;
        if (!message || positionals.length > 1) {
          throw new UsageError('lobstr feedback "<message>" [--operation op] [--run id] (quote the message).');
        }
        const answer = await client.feedback(message, {
          operation: typeof flags.operation === 'string' ? flags.operation : undefined,
          run: typeof flags.run === 'string' ? flags.run : undefined,
        });
        print(answer, jsonl);
        return 0;
      }
    }
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`error: ${err.message}\nRun "lobstr --help" for the commands.\n`);
      return 2;
    }
    if (err instanceof LobstrError) {
      io.err(`error: ${err.message}\n`);
      if (err.param) io.err(`param: ${err.param}\n`);
      if (err.docUrl) io.err(`${err.docUrl}\n`);
      return 1;
    }
    io.err(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
