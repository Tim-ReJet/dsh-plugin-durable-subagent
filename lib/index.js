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
import z from '@deepseek-ai/schemastery';
import { DsaClient } from "./cli.js";
import { createDurableProvider } from "./provider.js";
import { defineDurableTool } from "./tool.js";
export const name = 'durable-subagent';
/** The provider registry is required; the tools service is read only when the tool is enabled. */
export const inject = ['subagents'];
export const Config = z.object({
    provider: z.string().default('durable'),
    command: z.string().default('pi-durable-subagents'),
    commandArgs: z.array(String).default([]),
    home: z.string(),
    agent: z.string().default('worker'),
    cwd: z.string(),
    idempotency: z.union(['unique', 'content']).default('unique'),
    attempts: z.number().step(1).min(1).default(3),
    settleTimeoutMs: z.number().default(600_000),
    pollIntervalMs: z.number().default(1_000),
    timeoutMs: z.number().default(120_000),
    enableTool: z.boolean().default(true),
    tool: z.string().default('durable_subagent'),
});
/**
 * Mount the provider and, when enabled, the tool.
 * @param ctx - the plugin context.
 * @param config - the validated configuration.
 */
export function apply(ctx, config) {
    const client = new DsaClient({
        command: config.command,
        commandArgs: config.commandArgs,
        cwd: config.cwd ?? process.cwd(),
        ...config.home !== undefined ? { home: config.home } : {},
        timeoutMs: config.timeoutMs,
    });
    ctx.subagents.registerProvider(createDurableProvider({
        providerName: config.provider,
        client,
        agent: config.agent,
        idempotency: config.idempotency,
        attempts: config.attempts,
        settleTimeoutMs: config.settleTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
    }));
    if (!config.enableTool)
        return;
    const tools = ctx.get('tools');
    if (tools === undefined) {
        throw new Error(`${name}: enableTool is true but the tools service is not mounted`);
    }
    tools.register(defineDurableTool({
        name: config.tool,
        client,
        agent: config.agent,
        attempts: config.attempts,
    }));
}
//# sourceMappingURL=index.js.map