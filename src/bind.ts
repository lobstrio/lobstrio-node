import type { OperationRunner } from './types.js';

/** Binds one operation to the client, for the generated namespaces: a function, and its `iterate` for a list. */
export function bindOperation(client: OperationRunner, operation: string, paged: boolean): unknown {
  const method = (options?: Record<string, unknown>, params?: Record<string, unknown>) =>
    client.run(operation, options, params);
  if (paged) {
    return Object.assign(method, {
      iterate: (options?: Record<string, unknown>, params?: Record<string, unknown>) =>
        client.iterate(operation, options, params),
    });
  }
  return method;
}
