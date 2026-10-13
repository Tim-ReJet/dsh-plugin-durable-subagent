import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyDescribe } from '../src/cli.ts'
import { summarize } from '../src/core.ts'
import { toResult } from '../src/provider.ts'

/**
 * Payloads captured from `pi-durable-subagents` 1.0.39 on 2026-10-13, during the
 * Phase 0 spike: one absent read, one running read, one sealed run whose only
 * call failed, and one `request-conflict` reply.
 */
const replies = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real-replies.json'),
  'utf8',
)) as Record<string, unknown>

test('a real absent read classifies as absent', () => {
  const snapshot = classifyDescribe(replies.absent)
  assert.equal(snapshot.state, 'absent')
  assert.deepEqual(snapshot.calls, [])
})

test('a real running read carries its live call', () => {
  const snapshot = classifyDescribe(replies.running)
  assert.equal(snapshot.state, 'running')
  assert.equal(snapshot.status, 'running')
  assert.equal(snapshot.wid, '01M4THR3CMT54R65BASRA9QX3V')
  assert.equal(snapshot.calls.length, 1)
  assert.equal(snapshot.calls[0]?.phase, 'running')
  assert.equal(snapshot.calls[0]?.agent, 'worker')
  assert.equal(snapshot.calls[0]?.model, 'minimax/MiniMax-M2.7-highspeed')
  assert.equal(snapshot.calls[0]?.ok, undefined, 'a live call has no verdict yet')
})

test('a real sealed run keeps the failure on its call, not on the workflow status', () => {
  const snapshot = classifyDescribe(replies.sealedWithFailedCall)
  assert.equal(snapshot.state, 'sealed')
  assert.equal(snapshot.status, 'done', 'the workflow status is done even though the call failed')
  assert.equal(snapshot.calls[0]?.ok, false)
  assert.equal(snapshot.calls[0]?.status, 'failed')
  assert.equal(snapshot.calls[0]?.error, 'lost ×5')
})

test('summarize reads a failed call as a failure', () => {
  const summary = summarize(classifyDescribe(replies.sealedWithFailedCall))
  assert.equal(summary.ok, false)
  assert.equal(summary.diagnostic, 'lost ×5')
  assert.equal(summary.output, '')
})

test('toResult reports a failed call as an error result, not a completed one', () => {
  const result = toResult(classifyDescribe(replies.sealedWithFailedCall))
  assert.equal(result.stopReason, 'error')
  assert.deepEqual(result.output, [])
  assert.equal(result.diagnostic, 'lost ×5')
})

test('toResult returns a succeeded call output verbatim', () => {
  const snapshot = classifyDescribe(replies.sealedWithOutput)
  assert.equal(summarize(snapshot).ok, true)
  const result = toResult(snapshot)
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(result.output, [{ type: 'text', text: 'the receipt\n' }])
  assert.equal(result.diagnostic, undefined)
})

test('the real conflict reply is recognised by the submit classifier', async () => {
  // The conflict arrives with exit 3; the field the message lives in is `error`,
  // not `reason`.
  const snapshot = classifyDescribe(replies.conflict)
  assert.equal(snapshot.state, 'running')
  assert.equal(snapshot.wid, '01M4THSMCFSE12NVGTJT0MGBSX')
  assert.equal((replies.conflict as { error?: string }).error, 'request-conflict')
})
