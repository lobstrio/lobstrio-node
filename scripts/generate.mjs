#!/usr/bin/env node
// Generates src/generated.ts from the API's OpenAPI: one interface for each operation's options and records, the
// typed namespaces (`client.googleMaps.places.search(...)`), and the types of the other routes' bodies.
//
//   node scripts/generate.mjs                     # from https://api.lobstr.io/v2/openapi.json
//   node scripts/generate.mjs path/to/openapi.json
//
// The output is deterministic (operations sorted by id, properties in the OpenAPI's order) and committed.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SOURCE = 'https://api.lobstr.io/v2/openapi.json';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'generated.ts');

// The client's own members: a source named like one of them gets a `Source` suffix.
const RESERVED = new Set([
  'run', 'send', 'iterate', 'runMany', 'catalog', 'accounts', 'runs', 'balance', 'feedback',
  'baseUrl', 'timeout', 'maxRetries', 'toJSON', 'constructor', '_request', '_raw',
]);
// The core schemas, renamed where a hand-written name takes theirs (`Run` is the class of a run's answer).
const CORE_NAMES = { Run: 'RunLog', RunList: 'RunLogList', ConnectAccount: 'ConnectAccountParams' };
const SKIPPED_CORE = new Set(['Error']);

// JSON Schema keywords; any other key with a null value is a piece of a description cut at a comma upstream.
const KEYWORDS = new Set([
  '$ref', '$schema', '$id', 'title', 'description', 'type', 'enum', 'const', 'default', 'examples', 'example',
  'format', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength',
  'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'items', 'properties', 'required', 'additionalProperties',
  'patternProperties', 'oneOf', 'anyOf', 'allOf', 'not', 'nullable', 'readOnly', 'writeOnly', 'deprecated',
]);

async function load(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source, { headers: { Accept: 'application/json', 'User-Agent': 'lobstrio-node-generator' } });
    if (!res.ok) throw new Error(`GET ${source}: HTTP ${res.status}`);
    return res.json();
  }
  return JSON.parse(await readFile(source, 'utf8'));
}

const pascal = (s) => s.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
const camel = (s) => {
  const p = pascal(s);
  const c = p ? p[0].toLowerCase() + p.slice(1) : '_';
  return /^[0-9]/.test(c) ? `_${c}` : c;
};
const str = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
const propKey = (k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : str(k));
const literal = (v) => (typeof v === 'string' ? str(v) : v === null ? 'null' : JSON.stringify(v));

function description(node) {
  if (!node || typeof node !== 'object') return '';
  let text = typeof node.description === 'string' ? node.description : '';
  for (const [key, value] of Object.entries(node)) {
    if (value === null && !KEYWORDS.has(key)) text = text ? `${text}, ${key}` : key;
  }
  return text.trim();
}

function jsdoc(lines, indent) {
  const clean = lines
    .flatMap((l) => String(l).split('\n'))
    .map((l) => l.replace(/\*\//g, '*\\/').trimEnd());
  while (clean.length && !clean[clean.length - 1]) clean.pop();
  if (!clean.length) return '';
  if (clean.length === 1) return `${indent}/** ${clean[0]} */\n`;
  return `${indent}/**\n${clean.map((l) => (l ? `${indent} * ${l}` : `${indent} *`)).join('\n')}\n${indent} */\n`;
}

function propertyDoc(node, indent, ctx) {
  const lines = [];
  const text = description(node);
  if (text) lines.push(text);
  if (node && node.default !== undefined) lines.push(`@default ${JSON.stringify(node.default)}`);
  if (ctx.examples && node && Array.isArray(node.examples)) {
    for (const example of node.examples) lines.push(`@example ${JSON.stringify(example)}`);
  }
  return jsdoc(lines, indent);
}

function union(parts) {
  const unique = [...new Set(parts)];
  return unique.length ? unique.join(' | ') : 'never';
}

function arrayOf(type) {
  return /^[A-Za-z0-9_.]+$/.test(type) ? `${type}[]` : `Array<${type}>`;
}

function tsType(schema, indent, ctx) {
  if (!schema || typeof schema !== 'object') return 'unknown';
  if (schema.$ref) return ctx.ref(schema.$ref);
  if ('const' in schema) return literal(schema.const);
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    return union((schema.oneOf ?? schema.anyOf).map((s) => tsType(s, indent, ctx)));
  }
  if (Array.isArray(schema.allOf)) return schema.allOf.map((s) => `(${tsType(s, indent, ctx)})`).join(' & ');
  const types = schema.type === undefined ? [] : [].concat(schema.type);
  if (Array.isArray(schema.enum)) {
    const parts = schema.enum.map(literal);
    if (types.includes('null') && !schema.enum.includes(null)) parts.push('null');
    return union(parts);
  }
  if (!types.length) {
    if (schema.properties || schema.required) types.push('object');
    else if (schema.items) types.push('array');
    else return 'unknown';
  }
  return union(
    types.map((type) => {
      switch (type) {
        case 'string':
          return 'string';
        case 'integer':
        case 'number':
          return 'number';
        case 'boolean':
          return 'boolean';
        case 'null':
          return 'null';
        case 'array':
          return arrayOf(schema.items ? tsType(schema.items, indent, ctx) : 'unknown');
        case 'object':
          return objectType(schema, indent, ctx);
        default:
          return 'unknown';
      }
    }),
  );
}

function objectType(schema, indent, ctx) {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const keys = [...Object.keys(props), ...[...required].filter((k) => !(k in props))];
  const extra = schema.additionalProperties;
  if (!keys.length) {
    if (extra && typeof extra === 'object') return `Record<string, ${tsType(extra, indent, ctx)}>`;
    return 'Record<string, unknown>';
  }
  const inner = `${indent}  `;
  let out = '{\n';
  for (const key of keys) {
    const prop = props[key];
    out += propertyDoc(prop, inner, ctx);
    out += `${inner}${propKey(key)}${required.has(key) ? '' : '?'}: ${prop ? tsType(prop, inner, ctx) : 'unknown'};\n`;
  }
  if (extra !== false && (extra !== undefined || !schema.properties)) out += `${inner}[key: string]: unknown;\n`;
  return `${out}${indent}}`;
}

function named(name, schema, docLines, ctx) {
  const head = jsdoc(docLines, '');
  const isInterface =
    schema && typeof schema === 'object' && !schema.$ref && !schema.oneOf && !schema.anyOf && !schema.enum &&
    (schema.properties || schema.required) && [].concat(schema.type ?? 'object').every((t) => t === 'object');
  if (isInterface) return `${head}export interface ${name} ${objectType(schema, '', ctx)}\n`;
  return `${head}export type ${name} = ${tsType(schema, '', ctx)};\n`;
}

function generate(spec) {
  const schemas = spec.components?.schemas ?? {};
  const coreName = (name) => CORE_NAMES[name] ?? pascal(name);
  const ctx = {
    examples: false,
    ref(ref) {
      const name = ref.split('/').pop();
      return !name.includes('.') && schemas[name] && !SKIPPED_CORE.has(name) ? coreName(name) : 'unknown';
    },
  };

  // The operations, from their Request schemas: `source` and `operation` are consts there.
  const ops = [];
  for (const [key, request] of Object.entries(schemas)) {
    if (!key.endsWith('.Request')) continue;
    const base = key.slice(0, -'.Request'.length);
    const source = request.properties?.source?.const;
    const operation = request.properties?.operation?.const;
    if (typeof source !== 'string' || typeof operation !== 'string') continue;
    const [resource, verb] = operation.split('/');
    if (!resource || !verb) continue;
    const typeBase = pascal(source) + pascal(resource) + pascal(verb);
    const optionsSchema = schemas[`${base}.Options`] ?? { type: 'object' };
    ops.push({
      id: `${source}/${operation}`,
      source,
      resource,
      verb,
      typeBase,
      summary: typeof request.description === 'string' ? request.description : '',
      paged: Boolean(request.properties?.limit),
      optionsRequired: (optionsSchema.required ?? []).length > 0,
      options: optionsSchema,
      record: schemas[`${base}.Record`] ?? { type: 'object' },
    });
  }
  ops.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let out = '';
  out += '// Generated by scripts/generate.mjs from the API\'s OpenAPI. Do not edit by hand: run `npm run generate`.\n';
  out += `// From ${DEFAULT_SOURCE} (OpenAPI ${spec.openapi ?? '?'}, API version ${spec.info?.version ?? '?'}): ${ops.length} operations.\n\n`;
  out += "import { bindOperation } from './bind.js';\n";
  out += "import type { Run } from './run.js';\n";
  out += "import type { IterateParams, OperationRunner, RunParams, SingleRunParams } from './types.js';\n\n";

  // The other routes' bodies.
  out += '// ---- The other routes\' bodies ----\n\n';
  for (const [name, schema] of Object.entries(schemas)) {
    if (name.includes('.') || SKIPPED_CORE.has(name)) continue;
    out += named(coreName(name), schema, [description(schema)], ctx) + '\n';
  }
  const feedback = spec.paths?.['/v2/feedback']?.post?.responses?.['201']?.content?.['application/json']?.schema;
  out += named('Feedback', feedback ?? { type: 'object' }, ['A message received by `POST /v2/feedback`.'], ctx) + '\n';

  // Each operation's options and record.
  out += '// ---- Each operation\'s options and record ----\n\n';
  for (const op of ops) {
    const optionsCtx = { ...ctx, examples: true };
    const summary = op.summary ? ['', op.summary] : [];
    out += named(`${op.typeBase}Options`, op.options, [`The options of \`${op.id}\`.`, ...summary], optionsCtx) + '\n';
    out += named(`${op.typeBase}Record`, op.record, [`A record of \`${op.id}\`.`], ctx) + '\n';
  }

  // The map from an operation's id to its types, for `client.run('google_maps/places/search', ...)`.
  out += '/** Every operation, by id: its options and record types. */\n';
  out += 'export interface Operations {\n';
  for (const op of ops) {
    out += `  ${str(op.id)}: { options: ${op.typeBase}Options; record: ${op.typeBase}Record; paged: ${op.paged} };\n`;
  }
  out += '}\n\n';
  out += '/** An operation\'s id, `source/resource/verb`. */\n';
  out += 'export type OperationId = keyof Operations;\n\n';
  out += '/** Every operation\'s id, sorted. */\n';
  out += 'export const OPERATIONS: readonly OperationId[] = [\n';
  for (const op of ops) out += `  ${str(op.id)},\n`;
  out += '];\n\n';

  // The namespaces: a source, its resources, their verbs.
  const sources = new Map();
  for (const op of ops) {
    if (!sources.has(op.source)) sources.set(op.source, new Map());
    const resources = sources.get(op.source);
    if (!resources.has(op.resource)) resources.set(op.resource, []);
    resources.get(op.resource).push(op);
  }
  const sourceProp = (source) => {
    const name = camel(source);
    return RESERVED.has(name) ? `${name}Source` : name;
  };

  out += '// ---- The typed methods: client.<source>.<resource>.<verb>(options, params) ----\n\n';
  for (const [source, resources] of sources) {
    for (const [resource, list] of resources) {
      out += `/** \`${source}/${resource}/...\` */\n`;
      out += `export interface ${pascal(source)}${pascal(resource)}Resource {\n`;
      for (const op of list) {
        const opt = op.optionsRequired ? 'options' : 'options?';
        const params = op.paged ? 'RunParams' : 'SingleRunParams';
        const lines = [];
        if (op.summary) lines.push(op.summary, '');
        lines.push(`Runs \`${op.id}\`: one call, at the operation's price; ${op.paged ? '`nextPage()` on the answer for the next page, or `.iterate()` for every record.' : 'it answers one record.'}`);
        lines.push(`The contract: https://api.lobstr.io/v2/catalog/${op.id}`);
        out += jsdoc(lines, '  ');
        out += `  ${propKey(camel(op.verb))}: {\n`;
        out += `    (${opt}: ${op.typeBase}Options, params?: ${params}): Promise<Run<${op.typeBase}Record>>;\n`;
        if (op.paged) {
          out += '    /** Every record, page after page, until the last page or a cap (`maxRecords`, `maxPages`): each page is a call. */\n';
          out += `    iterate(${opt}: ${op.typeBase}Options, params?: IterateParams): AsyncGenerator<${op.typeBase}Record, void, undefined>;\n`;
        }
        out += '  };\n';
      }
      out += '}\n\n';
    }
    out += `/** \`${source}/...\` */\n`;
    out += `export interface ${pascal(source)}Source {\n`;
    for (const resource of resources.keys()) {
      out += `  ${propKey(camel(resource))}: ${pascal(source)}${pascal(resource)}Resource;\n`;
    }
    out += '}\n\n';
  }

  out += '/** The typed methods, by source. */\n';
  out += 'export interface Namespaces {\n';
  for (const source of sources.keys()) out += `  ${propKey(sourceProp(source))}: ${pascal(source)}Source;\n`;
  out += '}\n\n';

  out += '/** Binds every typed method to a client. */\n';
  out += 'export function createNamespaces(client: OperationRunner): Namespaces {\n';
  out += '  return {\n';
  for (const [source, resources] of sources) {
    out += `    ${propKey(sourceProp(source))}: {\n`;
    for (const [resource, list] of resources) {
      out += `      ${propKey(camel(resource))}: {\n`;
      for (const op of list) {
        out += `        ${propKey(camel(op.verb))}: bindOperation(client, ${str(op.id)}, ${op.paged}),\n`;
      }
      out += '      },\n';
    }
    out += '    },\n';
  }
  out += '  } as Namespaces;\n';
  out += '}\n';
  return { code: out, count: ops.length };
}

async function main() {
  const args = process.argv.slice(2);
  const source = args.find((a) => !a.startsWith('-')) ?? DEFAULT_SOURCE;
  const spec = await load(source);
  const { code, count } = generate(spec);
  await writeFile(OUT, code);
  process.stderr.write(`Wrote ${path.relative(ROOT, OUT)}: ${count} operations.\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err}\n`);
  process.exit(1);
});
