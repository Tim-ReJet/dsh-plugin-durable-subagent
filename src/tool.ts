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

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DsaClient, DescribeResult } from './cli.ts'
import { converge, summarize } from './core.ts'
import { requestIdForToolCall, scopedRequestId } from './ids.ts'

/** The tool's verbs. */
export type DurableAction = 'run' | 'status' | 'answer' | 'steer' | 'notify' | 'stop'

/** Construction options for {@link defineDurableTool}. */
export interface DurableToolOptions {
  /** Model-facing tool name. */
  readonly name: string
  /** The CLI client. */
  readonly client: DsaClient
  /** The pi agent definition a `run` delegates to unless the call names another. */
  readonly agent: string
  /** Submission attempts before a `run` gives up. Default 3. */
  readonly attempts?: number
}

/** The value every action returns. */
interface DurableToolValue {
  readonly request: string
  readonly state: string
  readonly wid?: string
  readonly output?: string
  readonly detail?: string
}

/**
 * Reduce any snapshot to the tool's flat, model-facing value.
 *
 * A sealed workflow reports the calls' output; a failure is named per call,
 * because the workflow's own status stays `done`.
 *
 * @param request - the durable request identity.
 * @param snapshot - the durable state.
 * @returns the tool value.
 */
function fromSnapshot(request: string, snapshot: DescribeResult): DurableToolValue {
  const summary = summarize(snapshot)
  const asking = snapshot.questions.length > 0
    ? snapshot.questions.map(question => `${question.call ?? 'call'} asks (qid ${question.qid ?? '?'} rev ${question.rev ?? '?'}): ${question.text ?? ''}`).join('; ')
    : undefined
  const detail = snapshot.readError
    ?? (!summary.ok ? `failed: ${summary.diagnostic ?? 'no detail'}` : undefined)
    ?? asking
    ?? snapshot.reason
    ?? snapshot.error
  return {
    request,
    state: snapshot.state,
    ...snapshot.wid !== undefined ? { wid: snapshot.wid } : {},
    ...summary.output.length > 0 ? { output: summary.output } : {},
    ...detail !== undefined && detail.length > 0 ? { detail } : {},
  }
}

/**
 * Define the tool that submits, inspects, steers, and stops durable delegations.
 * @param options - tool configuration.
 * @returns a registry-ready tool definition.
 */
export function defineDurableTool(options: DurableToolOptions) {
  return defineTool({
    name: options.name,
    description: [
      'Delegate work to a durable subagent that survives a crash of this process.',
      'Each call is decided once: if the harness dies after a delegation was accepted, the same call reports that delegation\'s outcome instead of running it again.',
      'Use `run` with a task; it returns as soon as the delegation is accepted, not when the work finishes.',
      'Use `status` to read a delegation\'s durable state, `answer` to reply to a question it asked, `steer` to redirect work in flight, and `stop` to end it.',
      'A delegation asks a question through its own result; a `status` of `asking` carries the question id and revision an `answer` needs.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ['run', 'status', 'answer', 'steer', 'notify', 'stop'],
        description: 'What to do. Defaults to `run`.',
      },
      task: {
        type: 'string',
        description: 'The work to delegate (required for `run`).',
      },
      agent: {
        type: 'string',
        description: `Which agent definition to run as (default ${options.agent}).`,
      },
      to: {
        type: 'string',
        description: 'The delegation an action addresses: the `request` value a `run` returned (required for every action except `run`).',
      },
      message: {
        type: 'string',
        description: 'The text for `answer`, `steer`, or `notify`.',
      },
      qid: {
        type: 'string',
        description: 'The question id an `answer` replies to, from `status`.',
      },
      rev: {
        type: 'integer',
        description: 'The question revision an `answer` replies to, from `status`.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          request: { type: 'string', required: true },
          state: { type: 'string', required: true },
          wid: { type: 'string' },
          output: { type: 'string' },
          detail: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.output !== undefined
          ? value.output
          : `${value.state}: ${value.detail ?? value.wid ?? ''}`.trim().replace(/:$/, ''),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<DurableToolValue> {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error(`${options.name} requires a calling agent (exec.agent was undefined)`)
      }
      const sessionId = agent.session.id
      const action = (typeof args.action === 'string' ? args.action : 'run') as DurableAction
      const name = typeof args.agent === 'string' && args.agent.length > 0 ? args.agent : options.agent

      if (action === 'run') {
        const task = typeof args.task === 'string' ? args.task.trim() : ''
        if (task.length === 0) throw new Error('`task` is required for action `run`')
        return await run(task)
      }

      const to = typeof args.to === 'string' ? args.to.trim() : ''
      if (to.length === 0) throw new Error(`\`to\` is required for action \`${action}\``)

      if (action === 'status') {
        return fromSnapshot(to, await options.client.describe(to))
      }

      const message = typeof args.message === 'string' ? args.message : ''
      if ((action === 'answer' || action === 'steer' || action === 'notify') && message.length === 0) {
        throw new Error(`\`message\` is required for action \`${action}\``)
      }

      if (action === 'stop') {
        const requestId = scopedRequestId(sessionId, `${exec.callId}-stop`)
        const outcome = await options.client.stop(requestId, to)
        return outcome.kind === 'applied'
          ? { request: requestId, state: 'stopped', detail: `stop accepted for ${to}` }
          : { request: requestId, state: outcome.kind, detail: detailOf(outcome) }
      }

      const requestId = scopedRequestId(sessionId, `${exec.callId}-${action}`)
      const outcome = await options.client.send(requestId, {
        to,
        kind: action === 'answer' ? 'answer' : action === 'steer' ? 'steer' : 'notify',
        message,
        ...typeof args.qid === 'string' ? { qid: args.qid } : {},
        ...typeof args.rev === 'number' ? { rev: args.rev } : {},
      })
      return outcome.kind === 'applied'
        ? { request: requestId, state: action === 'answer' ? 'answered' : 'sent', detail: `${action} accepted for ${to}` }
        : { request: requestId, state: outcome.kind, detail: detailOf(outcome) }

      async function run(task: string): Promise<DurableToolValue> {
        // The harness durably recorded this call before the body ran, so its id
        // is the replay-stable key the submission needs.
        const requestId = requestIdForToolCall({ sessionId, callId: exec.callId })
        const outcome = await converge(
          options.client,
          { requestId, spec: { agent: name, task } },
          {
            ...options.attempts !== undefined ? { attempts: options.attempts } : {},
          },
        )
        switch (outcome.kind) {
          case 'sealed':
            return { request: requestId, state: 'sealed', ...outcome.wid !== undefined ? { wid: outcome.wid } : {}, detail: 'already finished' }
          case 'running':
          case 'pending':
          case 'asking':
            return {
              request: requestId,
              state: outcome.kind,
              ...outcome.wid !== undefined ? { wid: outcome.wid } : {},
              ...outcome.kind === 'asking' && outcome.questions.length > 0 ? { detail: 'the delegation is waiting for your answer; read it with status' } : {},
            }
          case 'rejected':
            return { request: requestId, state: 'rejected', detail: outcome.reason }
          case 'failed':
            throw new Error(`could not submit the delegation: ${outcome.message}`)
        }
      }
    },
  })
}

/**
 * The message for a non-applied submission outcome.
 * @param outcome - the outcome.
 * @returns a short detail line.
 */
function detailOf(outcome: { readonly kind: string; readonly reason?: string; readonly message?: string }): string {
  return outcome.reason ?? outcome.message ?? outcome.kind
}
