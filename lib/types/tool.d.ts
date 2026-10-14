/**
 * The model-facing `durable_subagent` tool.
 *
 * This is where the harness's idempotency key enters the design. A tool
 * execution carries `exec.callId`, and the session checkpoint policy already
 * durably records that call before the tool body runs; forwarding it as the
 * CLI's `--request` id is the convention that policy names. The derived id is
 * stable across a crash and replay, so a delegation that was decided before the
 * crash is read back instead of executed again.
 *
 * @module dsh-plugin-durable-subagent/tool
 */
import type { DsaClient } from './cli.ts';
/** The tool's verbs. */
export type DurableAction = 'run' | 'status' | 'answer' | 'steer' | 'notify' | 'stop';
/** Construction options for {@link defineDurableTool}. */
export interface DurableToolOptions {
    /** Model-facing tool name. */
    readonly name: string;
    /** The CLI client. */
    readonly client: DsaClient;
    /** The pi agent definition a `run` delegates to unless the call names another. */
    readonly agent: string;
    /** Submission attempts before a `run` gives up. Default 3. */
    readonly attempts?: number;
}
/**
 * Define the tool that submits, inspects, steers, and stops durable delegations.
 * @param options - tool configuration.
 * @returns a registry-ready tool definition.
 */
export declare function defineDurableTool(options: DurableToolOptions): import("@deepseek-ai/dsh-tools").ToolDefinition;
