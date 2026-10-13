#!/usr/bin/env node
/**
 * A stand-in for the `pi-durable-subagents` CLI, used by the keyless tests.
 *
 * It models the parts of the documented contract the plugin depends on:
 *
 * - `run --request <id> --spec - --cwd <dir> --json` decides an id once and
 *   returns the first outcome forever after; the spec digest covers the spec
 *   bytes and the cwd, exactly as the real CLI's content hash does.
 * - exit 0 (applied), 1 (rejected), 3 (request-conflict), 75 (not decided yet).
 * - `describe --key <id> --json` is read-only and reports the durable state.
 *
 * Environment:
 * - `FAKE_DSA_STATE`  directory holding `state.json` (required).
 * - `FAKE_DSA_MODE`   `ok` (default), `kill-after-decide` (record the execution,
 *                     then exit 75 as a process that died before reporting),
 *                     `hang` (exit 75 without deciding anything).
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const stateDir = process.env.FAKE_DSA_STATE
if (!stateDir) {
  process.stderr.write('FAKE_DSA_STATE is not set\n')
  process.exit(2)
}
mkdirSync(stateDir, { recursive: true })
const stateFile = join(stateDir, 'state.json')
const mode = process.env.FAKE_DSA_MODE ?? 'ok'

const readState = () => {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    return { runs: {}, invocations: [] }
  }
}
const writeState = (state) => { writeFileSync(stateFile, JSON.stringify(state, null, 2)) }

const argv = process.argv.slice(2)
const command = argv[0]
const flag = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}
const state = readState()
state.invocations.push({ command, argv })
const digestOf = (spec, cwd) => createHash('sha256').update(`${JSON.stringify(spec)}|${cwd}`).digest('hex').slice(0, 16)
const reply = (object, code) => {
  writeState(state)
  process.stdout.write(`${JSON.stringify(object)}\n`)
  process.exit(code)
}

if (command === 'run') {
  const requestId = flag('--request')
  const cwd = flag('--cwd') ?? process.cwd()
  let raw = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) raw += chunk
  let spec
  try {
    spec = JSON.parse(raw)
  } catch {
    reply({ request: requestId, applied: false, reason: 'invalid spec' }, 1)
  }
  const digest = digestOf(spec, cwd)
  const existing = state.runs[requestId]
  if (existing) {
    if (existing.digest !== digest) {
      reply({ request: requestId, error: 'request-conflict', spec_digest: existing.digest, state: existing.state }, 3)
    }
    reply({ request: requestId, wid: existing.wid, created: false, spec_digest: existing.digest }, 0)
  }
  if (mode === 'hang') {
    reply({ request: requestId, pending: true, reason: 'busy' }, 75)
  }
  state.executions = (state.executions ?? 0) + 1
  state.runs[requestId] = {
    digest,
    wid: `w-${requestId}`,
    executions: 1,
    state: 'sealed',
    status: 'done',
    output: `ran ${spec?.agent ?? 'agent'}: ${spec?.task ?? ''}`,
  }
  if (mode === 'kill-after-decide') {
    // The decision is durable; the process died before it could report it.
    reply({ request: requestId, pending: true, reason: 'killed' }, 75)
  }
  reply({ request: requestId, wid: state.runs[requestId].wid, created: true, spec_digest: digest }, 0)
}

if (command === 'describe') {
  const requestId = flag('--key')
  const run = state.runs[requestId]
  if (!run) reply({ state: 'absent' }, 0)
  reply({
    state: run.state,
    wid: run.wid,
    status: run.status,
    output: run.output,
    calls: [{ key: 'main', phase: run.state }],
  }, 0)
}

if (command === 'send' || command === 'stop') {
  const requestId = flag('--request')
  reply({ request: requestId, applied: true }, 0)
}

process.stderr.write(`unknown command: ${command}\n`)
process.exit(1)
