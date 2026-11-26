import type { AnyRecord, RunAnswer, RunRequest, SendParams } from './types.js';

/** What a `Run` needs to fetch its next page. */
export interface RunSender {
  send(request: RunRequest, params?: SendParams): Promise<Run<any>>;
}

/**
 * The answer of one call to `POST /v2/run`: the envelope's fields as the API names them (`has_more`, `next`,
 * `cost.credits`, `request_id`...) and the records in `results`.
 */
export class Run<R = AnyRecord> implements RunAnswer<R> {
  declare readonly object: 'run';
  declare readonly id: string;
  declare readonly created_at?: string;
  declare readonly livemode?: boolean;
  declare readonly source: string;
  declare readonly operation: string;
  declare readonly version: string;
  declare readonly schema_url?: string;
  declare readonly options: Record<string, unknown>;
  declare readonly fields?: string[] | null;
  declare readonly limit?: number | null;
  declare readonly status: string;
  declare readonly count: number;
  declare readonly has_more: boolean;
  declare readonly next: RunRequest | null;
  declare readonly cost: { credits: number };
  declare readonly balance?: { credits: number };
  declare readonly duration_ms?: number;
  declare readonly request_id: string;
  declare readonly results: R[];
  [key: string]: unknown;

  readonly #sender: RunSender;

  constructor(sender: RunSender, answer: RunAnswer<R>) {
    this.#sender = sender;
    Object.assign(this, answer);
    if (!Array.isArray(this.results)) (this as { results: R[] }).results = [];
    if (this.next === undefined) (this as { next: RunRequest | null }).next = null;
  }

  /** The next page: sends `next` as it is, with a new idempotency key. `null` after the last page. */
  async nextPage(params: SendParams = {}): Promise<Run<R> | null> {
    if (!this.next) return null;
    return (await this.#sender.send(this.next, params)) as Run<R>;
  }

  /** The answer as the API sent it. */
  toJSON(): RunAnswer<R> {
    return { ...this } as unknown as RunAnswer<R>;
  }
}
