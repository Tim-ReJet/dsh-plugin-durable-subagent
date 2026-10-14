/**
 * The pi-durable-subagents command-line contract, as one small client.
 *
 * The CLI is the integration boundary: it is documented as a program-facing
 * API, its `run --request <id>` is decided once per id, and `describe --key` is
 * read-only and never starts the orchestrator. This module owns argv
 * construction, process execution, and the exit-code vocabulary
 * (`0` decided, `1` rejected, `3` request-conflict, `75` not decided yet), so
 * the provider, the tool, and the tests share one implementation.
 *
 * @module dsh-plugin-durable-subagent/cli
 */
/** Exit codes the CLI documents. */
export declare const DSA_EXIT: {
    /** Decided and applied; a retry gets the same answer. */
    readonly applied: 0;
    /** Decided and rejected, or refused before submission. */
    readonly rejected: 1;
    /** The id already names other content; nothing was sent. */
    readonly conflict: 3;
    /** Not decided yet, or a lock was busy: retry with the same id and bytes. */
    readonly pending: 75;
};
/** One finished command invocation. */
export interface DsaRunResult {
    /** Process exit code, or null when a signal ended it. */
    readonly code: number | null;
    /** Terminating signal, or null on an ordinary exit. */
    readonly signal: string | null;
    readonly stdout: string;
    readonly stderr: string;
}
/** Where and how one command runs. */
export interface RunnerOptions {
    readonly cwd: string;
    readonly env: Record<string, string | undefined>;
    readonly timeoutMs: number;
}
/**
 * Runs one argv to completion. Injectable so tests drive a fixture binary
 * without a process or an installed CLI.
 */
export type Runner = (argv: readonly string[], input: string | undefined, options: RunnerOptions) => Promise<DsaRunResult>;
/** The default runner: a real child process with a bounded output tail and a kill deadline. */
export declare const defaultRunner: Runner;
/** How a submission ended. */
export type SubmitOutcome = {
    readonly kind: 'applied';
    readonly wid?: string;
    readonly created?: boolean;
    readonly digest?: string;
    readonly raw: unknown;
} | {
    readonly kind: 'rejected';
    readonly reason?: string;
    readonly raw: unknown;
} | {
    readonly kind: 'conflict';
    readonly reason?: string;
    readonly state?: unknown;
    readonly raw: unknown;
} | {
    readonly kind: 'pending';
    readonly reason?: string;
    readonly raw: unknown;
} | {
    readonly kind: 'failed';
    readonly retryable: boolean;
    readonly message: string;
};
/** The lifecycle states `describe` reports. */
export type DescribeState = 'absent' | 'pending' | 'rejected' | 'running' | 'asking' | 'sealed' | 'pruned' | 'unknown';
/** One open question on a live call. */
export interface DescribeQuestion {
    readonly call?: string;
    readonly qid?: string;
    readonly rev?: number;
    readonly text?: string;
}
/**
 * One call inside a workflow, as `describe` reports it.
 *
 * A workflow's own `status` is `done` even when its calls failed, so success has
 * to be read here, per call.
 */
export interface DescribeCall {
    readonly key?: string;
    readonly gen?: number;
    readonly phase?: string;
    readonly agent?: string;
    readonly model?: string;
    readonly status?: string;
    /** Present once the call settles; `false` is a failed call. */
    readonly ok?: boolean;
    readonly error?: string;
    readonly output?: string;
    /** The schema-validated structured result, when the run asked for one. */
    readonly data?: unknown;
}
/** One read-only snapshot of a durable request. */
export interface DescribeResult {
    readonly state: DescribeState;
    readonly wid?: string;
    readonly status?: string;
    readonly reason?: string;
    readonly output?: string;
    readonly error?: string;
    readonly structured?: unknown;
    readonly questions: readonly DescribeQuestion[];
    readonly calls: readonly DescribeCall[];
    readonly raw: unknown;
    /** Present when the read itself failed (command missing, unparseable reply). */
    readonly readError?: string;
}
/** Construction options for {@link DsaClient}. */
export interface DsaClientOptions {
    /** The executable, argv[0] only. */
    readonly command: string;
    /**
     * Arguments that always precede the subcommand, for a launcher rather than a
     * bare executable (`['--no-install', 'pi-durable-subagents']` under npx, or a
     * script path under `node`).
     */
    readonly commandArgs?: readonly string[];
    /** Working directory for every invocation; part of a run's content digest. */
    readonly cwd: string;
    /** `DSA_HOME` for the invocations, when the caller needs one. */
    readonly home?: string;
    /** Extra environment for the invocations. */
    readonly env?: Record<string, string | undefined>;
    /** Per-invocation deadline. */
    readonly timeoutMs?: number;
    /** Injection point for the process runner. */
    readonly run?: Runner;
}
/**
 * Parse the single JSON object the CLI prints on `--json`.
 *
 * The reply is one object; a tolerant scan keeps a leading banner or a trailing
 * log line from turning a usable reply into a parse failure.
 *
 * @param text - the captured stdout.
 * @returns the parsed object, or undefined when none parses.
 */
export declare function parseJsonReply(text: string): unknown;
/**
 * Classify one `describe --json` reply.
 *
 * The CLI documents the state vocabulary (`absent`, `pending`, `rejected`,
 * `running`, `asking`, `sealed`, `pruned`); this reads a `state` field when one
 * is present and otherwise infers the state from the fields the documented
 * vocabulary pairs with it.
 *
 * @param raw - the parsed reply.
 * @returns the snapshot, with `unknown` when nothing identifies the state.
 */
export declare function classifyDescribe(raw: unknown): DescribeResult;
/** Builds argv and invokes the CLI. */
export declare class DsaClient {
    #private;
    constructor(options: DsaClientOptions);
    /**
     * Submit one run, or return the first outcome the id already has.
     * @param requestId - the durable request identity.
     * @param spec - the `subagents` tool run form, as plain JSON.
     * @returns the submission outcome.
     */
    submit(requestId: string, spec: unknown): Promise<SubmitOutcome>;
    /**
     * Read one request's durable state. Never starts the orchestrator.
     * @param requestId - the durable request identity.
     * @returns the snapshot.
     */
    describe(requestId: string): Promise<DescribeResult>;
    /**
     * Send one durable message to a call or workflow.
     * @param requestId - a fresh id identifying this send, so a retry is a no-op.
     * @param input - the target, kind, and message.
     * @returns the submission outcome for the send.
     */
    send(requestId: string, input: {
        readonly to: string;
        readonly kind: 'steer' | 'answer' | 'follow-up' | 'notify';
        readonly message: string;
        readonly qid?: string;
        readonly rev?: number;
    }): Promise<SubmitOutcome>;
    /**
     * Stop one call or workflow.
     * @param requestId - a fresh id identifying this stop, so a retry is a no-op.
     * @param target - the workflow, call, or run id to stop.
     * @returns the submission outcome for the stop.
     */
    stop(requestId: string, target: string): Promise<SubmitOutcome>;
}
/**
 * The first non-empty line of some text, clipped.
 * @param text - the captured stream.
 * @returns one short line.
 */
export declare function firstLine(text: string): string;
/**
 * A message for an unknown thrown value.
 * @param error - the thrown value.
 * @returns its message.
 */
export declare function messageOf(error: unknown): string;
