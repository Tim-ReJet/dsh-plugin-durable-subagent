import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DsaClient, type DsaRunResult, type Runner } from '../src/cli.ts'
import { converge, settle } from '../src/core.ts'

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-dsa.mjs')

/** The fixture's persisted state. */
interface FakeState {
  executions?: number
  runs?: Record<string, { digest: string; wid?: string; executions?: number; state?: string; status?: string; output?: string }>
  invocations?: { command: string }[]
}

interface Harness {
  readonly dir: string
  readonly client: DsaClient
  readonly state: () => FakeState
  readonly runs: () => number
}

/**
 * A client whose command is the fixture CLI, in a fresh state directory.
 * @param mode - the fixture's `FAKE_DSA_MODE`.
 * @returns the harness.
 */
function harness(mode: string): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-'))
  const state = (): FakeState => {
    try {
      return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as FakeState
    } catch {
      return {}
    }
  }
  const client = new DsaClient({
    command: process.execPath,
    commandArgs: [fixture],
    cwd: dir,
    env: { FAKE_DSA_STATE: dir, FAKE_DSA_MODE: mode },
    timeoutMs: 10_000,
  })
  return {
    dir,
    client,
    state,
    runs: () => (state().invocations ?? []).filter(entry => entry.command === 'run').length,
  }
}

const spec = { agent: 'worker', task: 'fix the flaky lease test' }
const request = (requestId: string) => ({ requestId, spec })

test('a submission is decided once and seals', async () => {
  const h = harness('ok')
  const outcome = await converge(h.client, request('d1'))
  assert.equal(outcome.kind, 'sealed')
  assert.equal(h.runs(), 1)
  assert.equal(h.state().executions, 1)
})

test('a retry of the same id never executes a second time', async () => {
  const h = harness('ok')
  const first = await converge(h.client, request('d2'))
  const second = await converge(h.client, request('d2'))
  assert.equal(first.kind, 'sealed')
  assert.equal(second.kind, 'sealed')
  assert.equal(h.state().executions, 1)
  assert.equal(h.runs(), 1, 'the decided id is answered from the read, so run is not invoked again')
})

test('a submit that died after deciding converges on the first outcome', async () => {
  // The process recorded the decision, then exited 75 as one that died before
  // reporting. The next attempt must read the durable decision, not run again.
  const h = harness('kill-after-decide')
  const outcome = await converge(h.client, request('d3'), { attempts: 3, delayMs: 1 })
  assert.equal(outcome.kind, 'sealed')
  assert.equal(h.state().executions, 1, 'exactly one execution')
  assert.equal(h.state().runs?.d3?.executions, 1)
})

test('an already-decided id is never submitted', async () => {
  const h = harness('ok')
  writeFileSync(join(h.dir, 'state.json'), JSON.stringify({
    executions: 1,
    runs: { d4: { digest: 'seeded', wid: 'w-seeded', executions: 1, state: 'sealed', status: 'done', output: 'done earlier' } },
    invocations: [],
  }))
  const outcome = await converge(h.client, request('d4'))
  assert.equal(outcome.kind, 'sealed')
  assert.equal(h.runs(), 0)
})

test('an undecided submission is retried a bounded number of times', async () => {
  const h = harness('hang')
  const outcome = await converge(h.client, request('d5'), { attempts: 2, delayMs: 1 })
  assert.equal(outcome.kind, 'failed')
  assert.equal(h.runs(), 2)
  assert.equal(h.state().executions, undefined, 'nothing was decided')
})

test('the same id carrying other content is a conflict, not a second execution', async () => {
  const h = harness('ok')
  const applied = await h.client.submit('d6', spec)
  assert.equal(applied.kind, 'applied')
  const conflicting = await h.client.submit('d6', { agent: 'worker', task: 'a different task' })
  assert.equal(conflicting.kind, 'conflict')
  assert.equal(h.state().executions, 1)
  assert.equal(h.runs(), 2, 'both submissions reached the CLI; only the first executed')
})

test('a missing executable is terminal and names the fix', async () => {
  const client = new DsaClient({ command: '/nonexistent/pi-durable-subagents', cwd: tmpdir(), timeoutMs: 5000 })
  const outcome = await converge(client, request('d7'), { attempts: 3, delayMs: 1 })
  assert.equal(outcome.kind, 'failed')
  assert.match(outcome.kind === 'failed' ? outcome.message : '', /not executable/)
})

test('a live call is reported, never resubmitted', async () => {
  const calls: string[][] = []
  const runner: Runner = async (argv): Promise<DsaRunResult> => {
    calls.push([...argv])
    return {
      code: 0,
      signal: null,
      stdout: JSON.stringify({ state: 'asking', wid: 'wq', asking: [{ call: 'wq/main', qid: 'q1', rev: 2, text: 'which branch?' }] }),
      stderr: '',
    }
  }
  const client = new DsaClient({ command: 'dsa', cwd: tmpdir(), run: runner })
  const outcome = await converge(client, request('d8'))
  assert.equal(outcome.kind, 'asking')
  assert.equal(outcome.kind === 'asking' ? outcome.questions[0]?.qid : undefined, 'q1')
  assert.equal(calls.filter(argv => argv.includes('run')).length, 0)
})

test('settle waits for the durable state to seal', async () => {
  const h = harness('ok')
  await converge(h.client, request('d9'))
  const settled = await settle(h.client, 'd9', { timeoutMs: 2000, intervalMs: 1 })
  assert.equal('state' in settled ? settled.state : 'sealed', 'sealed')
})

test('the fixture digest covers both spec bytes and cwd', async () => {
  // Guards the fixture itself: the real CLI hashes the content, so a changed
  // cwd must be a conflict rather than one execution.
  const h = harness('ok')
  await h.client.submit('d10', spec)
  const recorded = h.state().runs?.d10?.digest
  const expected = createHash('sha256').update(`${JSON.stringify(spec)}|${h.dir}`).digest('hex').slice(0, 16)
  assert.equal(recorded, expected)
})
