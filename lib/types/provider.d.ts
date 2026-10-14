/**
 * The `durable` subagent provider.
 *
 * One delegation becomes one pi-durable-subagents request, and the run handle's
 * result is the durable record's own verdict rather than a process exit code.
 *
 * Idempotency note: the provider boundary receives no tool call identity
 * (`ResolvedSubagentStartRequest` carries no `callId`), so it cannot mint the
 * replay-stable id that `converge` is designed around. The model-facing tool in
 * `./tool.ts` owns that identity and submits directly. This provider exists for
 * consumers that reach the run through `ctx.subagents` and choose its
 * idempotency mode through configuration.
 *
 * @module dsh-plugin-durable-subagent/provider
 */
import type { SubagentProvider, SubagentResult } from '@deepseek-ai/dsh-subagent';
import type { DsaClient, DescribeResult } from './cli.ts';
/** How the provider mints a request id. */
export type IdempotencyMode = 
/** One id per start: never a surprise conflict, never replay-stable. */
'unique'
/** One id per identical delegation: replay-stable, but two identical delegations collide. */
 | 'content';
/** Construction options for {@link createDurableProvider}. */
export interface DurableProviderOptions {
    /** Registry name on `ctx.subagents`. */
    readonly providerName: string;
    /** The CLI client. */
    readonly client: DsaClient;
    /** The pi agent definition each delegation runs as. */
    readonly agent: string;
    /** Request-id policy. Default `unique`. */
    readonly idempotency?: IdempotencyMode;
    /** Submission attempts before `start` rejects. Default 3. */
    readonly attempts?: number;
    /** How long the run handle waits for the durable verdict. Default 600000. */
    readonly settleTimeoutMs?: number;
    /** Poll interval while waiting. Default 1000. */
    readonly pollIntervalMs?: number;
}
/**
 * The text of the prompt blocks a model wrote.
 * @param prompt - the child's user message content.
 * @returns the concatenated text blocks.
 */
export declare function promptText(prompt: readonly unknown[]): string;
/**
 * Map one durable snapshot onto the seam's terminal result.
 *
 * Success is read per call, not from the workflow's `status`: a workflow whose
 * calls all failed still reports `done`.
 *
 * @param snapshot - the sealed, rejected, or unreadable snapshot.
 * @returns the result the run handle resolves with.
 */
export declare function toResult(snapshot: DescribeResult | undefined): SubagentResult;
/**
 * Build the provider that registers on `ctx.subagents`.
 * @param options - provider configuration.
 * @returns the provider.
 */
export declare function createDurableProvider(options: DurableProviderOptions): SubagentProvider;
