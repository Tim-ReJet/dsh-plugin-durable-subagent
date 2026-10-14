/**
 * The convergence state machine.
 *
 * DSH's session checkpoint policy durably records execution intent and tells
 * side-effecting tools to forward `exec.callId` as an idempotency key; it does
 * not promise exactly-once effects. pi-durable-subagents decides one request id
 * once. {@link converge} joins the two: read the durable state first, submit
 * only when the id is undecided, and never re-submit an id the CLI has already
 * decided.
 *
 * The read-before-write order is what makes a crash converge. A process that
 * died between deciding a submission and reporting it leaves a durable decision
 * behind; the next attempt reads it instead of executing again.
 *
 * @module dsh-plugin-durable-subagent/core
 */
import type { DsaClient, DescribeQuestion, DescribeResult } from './cli.ts';
/** One delegation to submit under a durable identity. */
export interface DelegationRequest {
    /** The request id: the CLI's identity for this submission. */
    readonly requestId: string;
    /** The `subagents` tool run form, as plain JSON. */
    readonly spec: unknown;
}
/** How {@link converge} ended. */
export type ConvergenceOutcome = {
    readonly kind: 'sealed';
    readonly wid?: string;
    readonly snapshot?: DescribeResult;
} | {
    readonly kind: 'running';
    readonly wid?: string;
    readonly snapshot?: DescribeResult;
} | {
    readonly kind: 'pending';
    readonly wid?: string;
    readonly snapshot?: DescribeResult;
} | {
    readonly kind: 'asking';
    readonly wid?: string;
    readonly questions: readonly DescribeQuestion[];
    readonly snapshot?: DescribeResult;
} | {
    readonly kind: 'rejected';
    readonly reason: string;
} | {
    readonly kind: 'failed';
    readonly message: string;
};
/** Tuning for {@link converge}. */
export interface ConvergeOptions {
    /** Submission attempts before giving up. Default 3. */
    readonly attempts?: number;
    /** Wait between attempts, in milliseconds. Default 250. */
    readonly delayMs?: number;
    /** Injection point for waiting. */
    readonly sleep?: (ms: number) => Promise<void>;
    /** Observes each read, for diagnostics and tests. */
    readonly onAttempt?: (attempt: number, snapshot: DescribeResult) => void;
}
/** Tuning for {@link settle}. */
export interface SettleOptions {
    /** Poll deadline in milliseconds. Default 600000. */
    readonly timeoutMs?: number;
    /** Wait between polls in milliseconds. Default 1000. */
    readonly intervalMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly now?: () => number;
}
/**
 * Submit one delegation at most once, and report what the durable record says.
 *
 * Terminal states are returned from the read alone, so a retry after a crash
 * never reaches the CLI's `run`.
 *
 * @param client - the CLI client.
 * @param request - the delegation.
 * @param options - retry tuning.
 * @returns the outcome, never throwing for a rejected or undecided request.
 */
export declare function converge(client: DsaClient, request: DelegationRequest, options?: ConvergeOptions): Promise<ConvergenceOutcome>;
/** The settled truth of one workflow snapshot. */
export interface SnapshotSummary {
    /** True when no call failed. Meaningful once the workflow is sealed. */
    readonly ok: boolean;
    /** The calls' joined output, or the top-level output when the CLI carries one. */
    readonly output: string;
    /** Why the run failed, when it did. */
    readonly diagnostic?: string;
}
/**
 * Read a workflow's real outcome.
 *
 * A workflow's own `status` is `done` even when every call inside it failed, and
 * `output` and `error` live on the calls rather than at the top level. Verified
 * against `pi-durable-subagents` 1.0.39: a run whose only call was `lost ×5`
 * reports `{"state":"sealed","status":"done","calls":[{"status":"failed","ok":false,"error":"lost ×5"}]}`.
 *
 * @param snapshot - one durable state read.
 * @returns the outcome a consumer should present.
 */
export declare function summarize(snapshot: DescribeResult): SnapshotSummary;
/**
 * Poll one request until it settles.
 *
 * @param client - the CLI client.
 * @param requestId - the durable request identity.
 * @param options - poll tuning.
 * @returns the terminal snapshot, or the last read with state `timeout`.
 */
export declare function settle(client: DsaClient, requestId: string, options?: SettleOptions): Promise<DescribeResult | {
    readonly state: 'timeout';
    readonly last: DescribeResult;
}>;
