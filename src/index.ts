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

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DsaClient } from './cli.ts'
import { createDurableProvider, type IdempotencyMode } from './provider.ts'
import { defineDurableTool } from './tool.ts'

export const name = 'durable-subagent'

/** The provider registry is required; the tools service is read only when the tool is enabled. */
export const inject = ['subagents']

/** Config: the executable, the delegation defaults, and the tool surface. */
export interface Config {
  /** The `ctx.subagents` registry name this plugin registers. */
  provider: string
  /** The pi-durable-subagents executable, argv[0] only. */
  command: string
  /** Arguments that always precede the subcommand, for a launcher rather than a bare executable. */
  commandArgs: string[]
  /** `DSA_HOME` for every invocation, when the orchestrator state lives away from the default. */
  home?: string
  /** The pi agent definition a delegation runs as unless the call names another. */
  agent: string
  /**
   * Working directory of every invocation. A run's cwd is part of the content
   * the CLI hashes, so a retry from a different directory is a
   * `request-conflict` rather than the first outcome. Defaults to the harness
   * process's working directory, which is stable for the life of that process.
   */
  cwd?: string
  /** How the provider mints request ids. The model-facing tool always uses the call identity. */
  idempotency: IdempotencyMode
  /** Submission attempts before a start fails. */
  attempts: number
  /** How long a run handle waits for the durable verdict. */
  settleTimeoutMs: number
  /** Poll interval while waiting. */
  pollIntervalMs: number
  /** Per-invocation deadline for the CLI. */
  timeoutMs: number
  /** Register the model-facing tool. */
  enableTool: boolean
  /** Model-facing tool name. */
  tool: string
}

export const Config: z<Config> = z.object({
  provider: z.string().default('durable'),
  command: z.string().default('pi-durable-subagents'),
  commandArgs: z.array(String).default([]),
  home: z.string(),
  agent: z.string().default('worker'),
  cwd: z.string(),
  idempotency: z.union(['unique', 'content'] as const).default('unique'),
  attempts: z.number().step(1).min(1).default(3),
  settleTimeoutMs: z.number().default(600_000),
  pollIntervalMs: z.number().default(1_000),
  timeoutMs: z.number().default(120_000),
  enableTool: z.boolean().default(true),
  tool: z.string().default('durable_subagent'),
})

/**
 * Mount the provider and, when enabled, the tool.
 * @param ctx - the plugin context.
 * @param config - the validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const client = new DsaClient({
    command: config.command,
    commandArgs: config.commandArgs,
    cwd: config.cwd ?? process.cwd(),
    ...config.home !== undefined ? { home: config.home } : {},
    timeoutMs: config.timeoutMs,
  })

  ctx.subagents.registerProvider(createDurableProvider({
    providerName: config.provider,
    client,
    agent: config.agent,
    idempotency: config.idempotency,
    attempts: config.attempts,
    settleTimeoutMs: config.settleTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
  }))

  if (!config.enableTool) return
  const tools = ctx.get('tools')
  if (tools === undefined) {
    throw new Error(`${name}: enableTool is true but the tools service is not mounted`)
  }
  tools.register(defineDurableTool({
    name: config.tool,
    client,
    agent: config.agent,
    attempts: config.attempts,
  }))
}
