/**
 * Durable subagent execution for DeepSeek Harness.
 *
 * Registers a `durable` provider on `ctx.subagents` and, by default, a
 * model-facing tool that submits delegations to pi-durable-subagents under a
 * request id derived from the harness call identity, so a delegation accepted
 * before a crash is read back instead of executed twice.
 *
 * @module dsh-plugin-durable-subagent
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type IdempotencyMode } from './provider.ts';
export declare const name = "durable-subagent";
/** The provider registry is required; the tools service is read only when the tool is enabled. */
export declare const inject: string[];
/** Config: the executable, the delegation defaults, and the tool surface. */
export interface Config {
    /** The `ctx.subagents` registry name this plugin registers. */
    provider: string;
    /** The pi-durable-subagents executable, argv[0] only. */
    command: string;
    /** Arguments that always precede the subcommand, for a launcher rather than a bare executable. */
    commandArgs: string[];
    /** `DSA_HOME` for every invocation, when the orchestrator state lives away from the default. */
    home?: string;
    /** The pi agent definition a delegation runs as unless the call names another. */
    agent: string;
    /**
     * Working directory of every invocation. A run's cwd is part of the content
     * the CLI hashes, so a retry from a different directory is a
     * `request-conflict` rather than the first outcome. Defaults to the harness
     * process's working directory, which is stable for the life of that process.
     */
    cwd?: string;
    /** How the provider mints request ids. The model-facing tool always uses the call identity. */
    idempotency: IdempotencyMode;
    /** Submission attempts before a start fails. */
    attempts: number;
    /** How long a run handle waits for the durable verdict. */
    settleTimeoutMs: number;
    /** Poll interval while waiting. */
    pollIntervalMs: number;
    /** Per-invocation deadline for the CLI. */
    timeoutMs: number;
    /** Register the model-facing tool. */
    enableTool: boolean;
    /** Model-facing tool name. */
    tool: string;
}
export declare const Config: z<Config>;
/**
 * Mount the provider and, when enabled, the tool.
 * @param ctx - the plugin context.
 * @param config - the validated configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
