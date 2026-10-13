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

import { spawn } from 'node:child_process'

/** Exit codes the CLI documents. */
export const DSA_EXIT = {
  /** Decided and applied; a retry gets the same answer. */
  applied: 0,
  /** Decided and rejected, or refused before submission. */
  rejected: 1,
  /** The id already names other content; nothing was sent. */
  conflict: 3,
  /** Not decided yet, or a lock was busy: retry with the same id and bytes. */
  pending: 75,
} as const

/** One finished command invocation. */
export interface DsaRunResult {
  /** Process exit code, or null when a signal ended it. */
  readonly code: number | null
  /** Terminating signal, or null on an ordinary exit. */
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
}

/** Where and how one command runs. */
export interface RunnerOptions {
  readonly cwd: string
  readonly env: Record<string, string | undefined>
  readonly timeoutMs: number
}

/**
 * Runs one argv to completion. Injectable so tests drive a fixture binary
 * without a process or an installed CLI.
 */
export type Runner = (
  argv: readonly string[],
  input: string | undefined,
  options: RunnerOptions,
) => Promise<DsaRunResult>

/** Output retained per stream; the CLI's replies are far smaller. */
const OUTPUT_CAP = 1 << 20

/** The default runner: a real child process with a bounded output tail and a kill deadline. */
export const defaultRunner: Runner = async (argv, input, options) => {
  const [command, ...args] = argv
  if (command === undefined) throw new Error('empty command')
  return await new Promise<DsaRunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => { child.kill('SIGKILL') }, options.timeoutMs)
    timer.unref()
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { if (stdout.length < OUTPUT_CAP) stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { if (stderr.length < OUTPUT_CAP) stderr += chunk })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
    child.stdin?.end(input)
  })
}

/** How a submission ended. */
export type SubmitOutcome =
  | { readonly kind: 'applied'; readonly wid?: string; readonly created?: boolean; readonly digest?: string; readonly raw: unknown }
  | { readonly kind: 'rejected'; readonly reason?: string; readonly raw: unknown }
  | { readonly kind: 'conflict'; readonly reason?: string; readonly state?: unknown; readonly raw: unknown }
  | { readonly kind: 'pending'; readonly reason?: string; readonly raw: unknown }
  | { readonly kind: 'failed'; readonly retryable: boolean; readonly message: string }

/** The lifecycle states `describe` reports. */
export type DescribeState =
  | 'absent'
  | 'pending'
  | 'rejected'
  | 'running'
  | 'asking'
  | 'sealed'
  | 'pruned'
  | 'unknown'

/** One open question on a live call. */
export interface DescribeQuestion {
  readonly call?: string
  readonly qid?: string
  readonly rev?: number
  readonly text?: string
}

/**
 * One call inside a workflow, as `describe` reports it.
 *
 * A workflow's own `status` is `done` even when its calls failed, so success has
 * to be read here, per call.
 */
export interface DescribeCall {
  readonly key?: string
  readonly gen?: number
  readonly phase?: string
  readonly agent?: string
  readonly model?: string
  readonly status?: string
  /** Present once the call settles; `false` is a failed call. */
  readonly ok?: boolean
  readonly error?: string
  readonly output?: string
  /** The schema-validated structured result, when the run asked for one. */
  readonly data?: unknown
}

/** One read-only snapshot of a durable request. */
export interface DescribeResult {
  readonly state: DescribeState
  readonly wid?: string
  readonly status?: string
  readonly reason?: string
  readonly output?: string
  readonly error?: string
  readonly structured?: unknown
  readonly questions: readonly DescribeQuestion[]
  readonly calls: readonly DescribeCall[]
  readonly raw: unknown
  /** Present when the read itself failed (command missing, unparseable reply). */
  readonly readError?: string
}

/** Construction options for {@link DsaClient}. */
export interface DsaClientOptions {
  /** The executable, argv[0] only. */
  readonly command: string
  /**
   * Arguments that always precede the subcommand, for a launcher rather than a
   * bare executable (`['--no-install', 'pi-durable-subagents']` under npx, or a
   * script path under `node`).
   */
  readonly commandArgs?: readonly string[]
  /** Working directory for every invocation; part of a run's content digest. */
  readonly cwd: string
  /** `DSA_HOME` for the invocations, when the caller needs one. */
  readonly home?: string
  /** Extra environment for the invocations. */
  readonly env?: Record<string, string | undefined>
  /** Per-invocation deadline. */
  readonly timeoutMs?: number
  /** Injection point for the process runner. */
  readonly run?: Runner
}

const KNOWN_STATES = new Set<string>(['absent', 'pending', 'rejected', 'running', 'asking', 'sealed', 'pruned'])

/**
 * Parse the single JSON object the CLI prints on `--json`.
 *
 * The reply is one object; a tolerant scan keeps a leading banner or a trailing
 * log line from turning a usable reply into a parse failure.
 *
 * @param text - the captured stdout.
 * @returns the parsed object, or undefined when none parses.
 */
export function parseJsonReply(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    for (const line of trimmed.split('\n')) {
      const candidate = line.trim()
      if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue
      try {
        return JSON.parse(candidate)
      } catch {
        continue
      }
    }
    return undefined
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const asString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

const asNumber = (value: unknown): number | undefined => typeof value === 'number' ? value : undefined

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
export function classifyDescribe(raw: unknown): DescribeResult {
  const record = asRecord(raw)
  if (record === undefined) return { state: 'unknown', questions: [], calls: [], raw }

  const questions: DescribeQuestion[] = []
  const asking = record.asking ?? record.questions
  if (Array.isArray(asking)) {
    for (const entry of asking) {
      const question = asRecord(entry)
      if (question === undefined) continue
      const item: { call?: string; qid?: string; rev?: number; text?: string } = {}
      const call = asString(question.call)
      const qid = asString(question.qid)
      const rev = asNumber(question.rev)
      const text = asString(question.text)
      if (call !== undefined) item.call = call
      if (qid !== undefined) item.qid = qid
      if (rev !== undefined) item.rev = rev
      if (text !== undefined) item.text = text
      questions.push(item)
    }
  }

  const calls: DescribeCall[] = []
  if (Array.isArray(record.calls)) {
    for (const entry of record.calls) {
      const call = asRecord(entry)
      if (call === undefined) continue
      const item: {
        key?: string
        gen?: number
        phase?: string
        agent?: string
        model?: string
        status?: string
        ok?: boolean
        error?: string
        output?: string
        data?: unknown
      } = {}
      const key = asString(call.key)
      const gen = asNumber(call.gen)
      const phase = asString(call.phase)
      const agent = asString(call.agent)
      const model = asString(call.model)
      const status = asString(call.status)
      const error = asString(call.error)
      const output = asString(call.output)
      if (key !== undefined) item.key = key
      if (gen !== undefined) item.gen = gen
      if (phase !== undefined) item.phase = phase
      if (agent !== undefined) item.agent = agent
      if (model !== undefined) item.model = model
      if (status !== undefined) item.status = status
      if (typeof call.ok === 'boolean') item.ok = call.ok
      if (error !== undefined) item.error = error
      if (output !== undefined) item.output = output
      if (call.data !== undefined) item.data = call.data
      calls.push(item)
    }
  }

  const declared = asString(record.state)
  let state: DescribeState = declared !== undefined && KNOWN_STATES.has(declared) ? declared as DescribeState : 'unknown'
  if (state === 'unknown') {
    if (record.absent === true) state = 'absent'
    else if (record.pruned !== undefined) state = 'pruned'
    else if (record.sealed === true || (record.wid !== undefined && record.status !== undefined && record.calls !== undefined)) state = 'sealed'
    else if (questions.length > 0) state = 'asking'
    else if (record.reason !== undefined && record.wid === undefined) state = 'rejected'
    else if (record.wid !== undefined) state = 'running'
  }

  const snapshot: {
    state: DescribeState
    wid?: string
    status?: string
    reason?: string
    output?: string
    error?: string
    structured?: unknown
    questions: readonly DescribeQuestion[]
    calls: readonly DescribeCall[]
    raw: unknown
  } = { state, questions, calls, raw }
  const wid = asString(record.wid)
  const status = asString(record.status)
  const reason = asString(record.reason)
  const output = asString(record.output)
  const error = asString(record.error)
  if (wid !== undefined) snapshot.wid = wid
  if (status !== undefined) snapshot.status = status
  if (reason !== undefined) snapshot.reason = reason
  if (output !== undefined) snapshot.output = output
  if (error !== undefined) snapshot.error = error
  if (record.data !== undefined) snapshot.structured = record.data
  return snapshot
}

/** Builds argv and invokes the CLI. */
export class DsaClient {
  readonly #command: string
  readonly #commandArgs: readonly string[]
  readonly #cwd: string
  readonly #env: Record<string, string | undefined>
  readonly #timeoutMs: number
  readonly #run: Runner

  constructor(options: DsaClientOptions) {
    this.#command = options.command
    this.#commandArgs = options.commandArgs ?? []
    this.#cwd = options.cwd
    this.#env = { ...process.env, ...options.env, ...options.home !== undefined ? { DSA_HOME: options.home } : {} }
    this.#timeoutMs = options.timeoutMs ?? 120_000
    this.#run = options.run ?? defaultRunner
  }

  /** The full argv for one subcommand. */
  #argv(...parts: string[]): string[] {
    return [this.#command, ...this.#commandArgs, ...parts]
  }

  /**
   * Submit one run, or return the first outcome the id already has.
   * @param requestId - the durable request identity.
   * @param spec - the `subagents` tool run form, as plain JSON.
   * @returns the submission outcome.
   */
  async submit(requestId: string, spec: unknown): Promise<SubmitOutcome> {
    const argv = this.#argv('run', '--request', requestId, '--spec', '-', '--cwd', this.#cwd, '--json')
    return await this.#classifySubmit(argv, JSON.stringify(spec))
  }

  /**
   * Read one request's durable state. Never starts the orchestrator.
   * @param requestId - the durable request identity.
   * @returns the snapshot.
   */
  async describe(requestId: string): Promise<DescribeResult> {
    const argv = this.#argv('describe', '--key', requestId, '--json')
    let result: DsaRunResult
    try {
      result = await this.#run(argv, undefined, this.#options())
    } catch (error) {
      return { state: 'unknown', questions: [], calls: [], raw: undefined, readError: messageOf(error) }
    }
    const parsed = parseJsonReply(result.stdout)
    if (parsed === undefined) {
      return {
        state: 'unknown',
        questions: [],
        calls: [],
        raw: { code: result.code, signal: result.signal, stdout: result.stdout, stderr: result.stderr },
        readError: result.code === DSA_EXIT.applied
          ? 'describe printed no JSON object'
          : `describe exited ${result.code ?? `on ${result.signal ?? 'a signal'}`}: ${firstLine(result.stderr)}`,
      }
    }
    return classifyDescribe(parsed)
  }

  /**
   * Send one durable message to a call or workflow.
   * @param requestId - a fresh id identifying this send, so a retry is a no-op.
   * @param input - the target, kind, and message.
   * @returns the submission outcome for the send.
   */
  async send(requestId: string, input: {
    readonly to: string
    readonly kind: 'steer' | 'answer' | 'follow-up' | 'notify'
    readonly message: string
    readonly qid?: string
    readonly rev?: number
  }): Promise<SubmitOutcome> {
    const argv = this.#argv('send', '--request', requestId, '--to', input.to, '--kind', input.kind, '--message', input.message)
    if (input.qid !== undefined) argv.push('--qid', input.qid)
    if (input.rev !== undefined) argv.push('--rev', String(input.rev))
    argv.push('--json')
    return await this.#classifySubmit(argv, undefined)
  }

  /**
   * Stop one call or workflow.
   * @param requestId - a fresh id identifying this stop, so a retry is a no-op.
   * @param target - the workflow, call, or run id to stop.
   * @returns the submission outcome for the stop.
   */
  async stop(requestId: string, target: string): Promise<SubmitOutcome> {
    const argv = this.#argv('stop', '--request', requestId, target, '--json')
    return await this.#classifySubmit(argv, undefined)
  }

  #options(): RunnerOptions {
    return { cwd: this.#cwd, env: this.#env, timeoutMs: this.#timeoutMs }
  }

  async #classifySubmit(argv: string[], input: string | undefined): Promise<SubmitOutcome> {
    let result: DsaRunResult
    try {
      result = await this.#run(argv, input, this.#options())
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'EACCES'
      return {
        kind: 'failed',
        retryable: !missing,
        message: missing
          ? `${this.#command} is not executable: install pi-durable-subagents or set the plugin's \`command\` config`
          : `could not run ${this.#command}: ${messageOf(error)}`,
      }
    }
    const parsed = parseJsonReply(result.stdout)
    const record = asRecord(parsed)
    const reason = asString(record?.reason) ?? asString(record?.error)
    switch (result.code) {
      case DSA_EXIT.applied: {
        const wid = asString(record?.wid)
        const digest = asString(record?.spec_digest)
        const created = record?.created
        return {
          kind: 'applied',
          ...wid !== undefined ? { wid } : {},
          ...typeof created === 'boolean' ? { created } : {},
          ...digest !== undefined ? { digest } : {},
          raw: parsed,
        }
      }
      case DSA_EXIT.rejected:
        return { kind: 'rejected', ...reason !== undefined ? { reason } : {}, raw: parsed }
      case DSA_EXIT.conflict:
        return { kind: 'conflict', ...reason !== undefined ? { reason } : {}, state: record?.state, raw: parsed }
      case DSA_EXIT.pending:
        return { kind: 'pending', ...reason !== undefined ? { reason } : {}, raw: parsed }
      default:
        return {
          kind: 'failed',
          // A signal or a missing code means the process died before it could
          // answer; the submission is still idempotent, so the caller may retry.
          retryable: result.code === null,
          message: `the CLI exited ${result.code ?? `on ${result.signal ?? 'a signal'}`}: ${firstLine(result.stderr) || firstLine(result.stdout)}`,
        }
    }
  }
}

/**
 * The first non-empty line of some text, clipped.
 * @param text - the captured stream.
 * @returns one short line.
 */
export function firstLine(text: string): string {
  const line = text.split('\n').map(part => part.trim()).find(part => part.length > 0) ?? ''
  return line.length > 200 ? `${line.slice(0, 200)}...` : line
}

/**
 * A message for an unknown thrown value.
 * @param error - the thrown value.
 * @returns its message.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
