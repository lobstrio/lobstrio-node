/**
 * lobstr.io's tools for the Vercel AI SDK (`ai`, version 7): `import { lobstrTools } from 'lobstrio/ai-sdk'`.
 *
 * ```ts
 * import { generateText, isStepCount } from 'ai';
 * import { anthropic } from '@ai-sdk/anthropic';
 * import { lobstrTools } from 'lobstrio/ai-sdk';
 *
 * const { text } = await generateText({
 *   model: anthropic('claude-sonnet-5-5'),
 *   tools: await lobstrTools(),
 *   stopWhen: isStepCount(8),
 *   prompt: 'What does the news say about Tesla today?',
 * });
 * ```
 *
 * `ai` is an optional peer dependency of `lobstrio`: install it beside it. The main entry, `lobstrio`, never loads it.
 */
import { jsonSchema, tool } from 'ai';
import type { JSONSchema7, Tool } from 'ai';
import { Lobstr } from 'lobstrio';

import {
  AgentTools,
  DESCRIPTIONS,
  FIND_OPERATIONS,
  GET_OPERATION,
  INPUT_SCHEMAS,
  RUN_OPERATION,
  operationDescription,
  operationInputSchema,
  toolName,
} from './agent-tools.js';
import type { FindOperationsInput, GetOperationInput, OperationToolInput, RunOperationInput } from './agent-tools.js';

export type { FindOperationsInput, GetOperationInput, OperationToolInput, RunOperationInput } from './agent-tools.js';
export { FIND_OPERATIONS, GET_OPERATION, RUN_OPERATION } from './agent-tools.js';

export interface LobstrToolsOptions {
  /** The client the tools call; a `new Lobstr()` by default, its key from `LOBSTR_API_KEY`. */
  client?: Lobstr;
  /**
   * Operations to add as tools of their own, as `google_maps/places/search`: one tool each, named
   * `google_maps_places_search`, whose input is the operation's options (its JSON schema from the catalog) with
   * `fields`, and `limit` for a search or a list.
   */
  operations?: string[];
}

/** The three tools, and one per operation asked for. Every tool answers compact JSON text. */
export type LobstrToolSet = {
  /** Finds the operations that fit what the agent needs, from the catalog (read once). */
  lobstr_find_operations: Tool<FindOperationsInput, string>;
  /** One operation's contract: its options, its records' fields, its price, its pagination. */
  lobstr_get_operation: Tool<GetOperationInput, string>;
  /** Runs one operation: one page, at the operation's price. */
  lobstr_run_operation: Tool<RunOperationInput, string>;
} & { [operationTool: string]: Tool<any, string> };

/**
 * lobstr.io's tools for the AI SDK: `lobstr_find_operations`, `lobstr_get_operation` and `lobstr_run_operation`
 * (the hosted MCP server's three), plus one tool per operation in `operations`, whose contracts are read first.
 * A failed call comes back to the model as text, the API's message and `doc_url`, and never stops the loop.
 */
export async function lobstrTools(options: LobstrToolsOptions = {}): Promise<LobstrToolSet> {
  const tools = new AgentTools(options.client ?? new Lobstr());

  const set: LobstrToolSet = {
    [FIND_OPERATIONS]: tool({
      description: DESCRIPTIONS[FIND_OPERATIONS],
      inputSchema: jsonSchema<FindOperationsInput>(INPUT_SCHEMAS[FIND_OPERATIONS] as JSONSchema7),
      execute: (input) => tools.findOperations(input),
    }),
    [GET_OPERATION]: tool({
      description: DESCRIPTIONS[GET_OPERATION],
      inputSchema: jsonSchema<GetOperationInput>(INPUT_SCHEMAS[GET_OPERATION] as JSONSchema7),
      execute: (input) => tools.getOperation(input),
    }),
    [RUN_OPERATION]: tool({
      description: DESCRIPTIONS[RUN_OPERATION],
      inputSchema: jsonSchema<RunOperationInput>(INPUT_SCHEMAS[RUN_OPERATION] as JSONSchema7),
      execute: (input, { abortSignal }) => tools.runOperation(input, abortSignal),
    }),
  };

  const operations = [...new Set((options.operations ?? []).map((op) => op.trim()))];
  const contracts = await Promise.all(operations.map((op) => tools.contract(op)));
  operations.forEach((operation, i) => {
    const contract = contracts[i]!;
    set[toolName(operation)] = tool({
      description: operationDescription(contract),
      inputSchema: jsonSchema<OperationToolInput>(operationInputSchema(contract) as JSONSchema7),
      execute: (input, { abortSignal }) => tools.runTool(operation, contract, input, abortSignal),
    });
  });
  return set;
}
