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

import { randomUUID } from 'node:crypto'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import type { DsaClient, DescribeResult } from './cli.ts'
import { converge, settle, summarize } from './core.ts'
import { requestIdForContent, scopedRequestId } from './ids.ts'

/** The diagnostic limit the seam sets for provider-authored failure text. */
const DIAGNOSTIC_LIMIT = 4096

/** How the provider mints a request id. */
export type IdempotencyMode =
  /** One id per start: never a surprise conflict, never replay-stable. */
  | 'unique'
  /** One id per identical delegation: replay-stable, but two identical delegations collide. */
  | 'content'

/** Construction options for {@link createDurableProvider}. */
export interface DurableProviderOptions {
  /** Registry name on `ctx.subagents`. */
  readonly providerName: string
  /** The CLI client. */
  readonly client: DsaClient
  /** The pi agent definition each delegation runs as. */
  readonly agent: string
  /** Request-id policy. Default `unique`. */
  readonly idempotency?: IdempotencyMode
  /** Submission attempts before `start` rejects. Default 3. */
  readonly attempts?: number
  /** How long the run handle waits for the durable verdict. Default 600000. */
  readonly settleTimeoutMs?: number
  /** Poll interval while waiting. Default 1000. */
  readonly pollIntervalMs?: number
}

/** The capabilities this provider can honour. */
const CAPABILITIES: SubagentCapabilities = {
  // pi-durable-subagents validates a `report` against the schema it was given
  // before sealing, so a sealed `data` payload is already schema-valid.
  outputSchema: true,
  // pi-durable-subagents refuses nested subagents.
  depthLimit: false,
  // Tool scoping would have to be translated into the run spec's `tools` list.
  toolFilter: false,
  // A persona is an agent definition here, not a per-child prompt section.
  persona: false,
}

const textBlock = (text: string): SubagentResult['output'][number] =>
  ({ type: 'text', text }) as SubagentResult['output'][number]

const clip = (text: string): string =>
  text.length > DIAGNOSTIC_LIMIT ? text.slice(0, DIAGNOSTIC_LIMIT) : text

/**
 * The text of the prompt blocks a model wrote.
 * @param prompt - the child's user message content.
 * @returns the concatenated text blocks.
 */
export function promptText(prompt: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of prompt) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { type?: unknown; text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n\n')
}

/**
 * Map one durable snapshot onto the seam's terminal result.
 *
 * Success is read per call, not from the workflow's `status`: a workflow whose
 * calls all failed still reports `done`.
 *
 * @param snapshot - the sealed, rejected, or unreadable snapshot.
 * @returns the result the run handle resolves with.
 */
export function toResult(snapshot: DescribeResult | undefined): SubagentResult {
  if (snapshot === undefined) {
    return { output: [], stopReason: 'error', diagnostic: 'no durable state was read for this request' }
  }
  if (snapshot.state === 'rejected' || snapshot.state === 'pruned') {
    const detail = snapshot.reason ?? snapshot.readError ?? `the request was ${snapshot.state}`
    return { output: [], stopReason: 'error', diagnostic: clip(detail) }
  }
  const summary = summarize(snapshot)
  const output: SubagentResult['output'] = summary.output.length > 0 ? [textBlock(summary.output)] : []
  const stopped = snapshot.status === 'stopped' || snapshot.calls.some(call => call.status === 'stopped')
  const stopReason = !summary.ok ? 'error' : stopped ? 'aborted' : 'completed'
  return {
    output,
    ...snapshot.structured !== undefined ? { structured: snapshot.structured } : {},
    ...summary.diagnostic !== undefined ? { diagnostic: clip(summary.diagnostic) } : {},
    stopReason,
  }
}

/** The run spec pi-durable-subagents accepts for one delegation. */
function buildSpec(request: ResolvedSubagentStartRequest, agent: string): Record<string, unknown> {
  const task = promptText(request.prompt)
  return {
    agent,
    task,
    ...request.label !== undefined ? { name: request.label } : {},
    ...request.outputSchema !== undefined ? { schema: request.outputSchema } : {},
  }
}

/**
 * Build the provider that registers on `ctx.subagents`.
 * @param options - provider configuration.
 * @returns the provider.
 */
export function createDurableProvider(options: DurableProviderOptions): SubagentProvider {
  return {
    name: options.providerName,
    capabilities: CAPABILITIES,
    inheritsParentContext: false,
    async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
      const sessionId = request.parent.session.id
      const spec = buildSpec(request, options.agent)
      const requestId = options.idempotency === 'content'
        ? requestIdForContent({ sessionId, parts: [spec] })
        : scopedRequestId(sessionId, `run-${randomUUID()}`)
      if (request.signal.aborted) throw new Error('the delegation was cancelled before it started')

      const outcome = await converge(options.client, { requestId, spec }, {
        ...options.attempts !== undefined ? { attempts: options.attempts } : {},
      })
      if (outcome.kind === 'failed') throw new Error(`durable delegation failed to start: ${outcome.message}`)
      if (outcome.kind === 'rejected') throw new Error(`durable delegation was rejected: ${outcome.reason}`)
      if (request.signal.aborted) {
        await options.client.stop(scopedRequestId(sessionId, `cancel-${randomUUID()}`), requestId)
        throw new Error('the delegation was cancelled during submission')
      }

      const wid = outcome.wid ?? requestId
      let settled = false
      let disposed = false
      const result: Promise<SubagentResult> = (async () => {
        try {
          if (outcome.kind === 'sealed') return toResult(outcome.snapshot)
          const final = await settle(options.client, requestId, {
            ...options.settleTimeoutMs !== undefined ? { timeoutMs: options.settleTimeoutMs } : {},
            ...options.pollIntervalMs !== undefined ? { intervalMs: options.pollIntervalMs } : {},
          })
          if ('last' in final) {
            return {
              output: [],
              stopReason: 'error',
              diagnostic: `the durable call did not settle within the wait; its last state was ${final.last.state}`,
            } satisfies SubagentResult
          }
          return toResult(final)
        } finally {
          settled = true
        }
      })()

      return {
        id: wid as unknown as SubagentRun['id'],
        localAgent: undefined,
        result,
        dispose: async (): Promise<void> => {
          if (disposed) return
          disposed = true
          if (settled) return
          await options.client.stop(scopedRequestId(sessionId, `stop-${randomUUID()}`), requestId)
        },
      }
    },
  }
}
