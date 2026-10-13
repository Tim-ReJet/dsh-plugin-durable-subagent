import test from 'node:test'
import assert from 'node:assert/strict'
import { isRequestId, requestIdForContent, requestIdForToolCall, REQUEST_ID_MAX_LENGTH, scopedRequestId } from '../src/ids.ts'

test('a tool call mints an id the CLI accepts', () => {
  const id = requestIdForToolCall({ sessionId: 'session-1', callId: 'call-3' })
  assert.equal(isRequestId(id), true)
  assert.match(id, /^d[0-9a-f]{10}-call-3-[0-9a-f]{16}$/)
})

test('the same call in the same session mints the same id', () => {
  const first = requestIdForToolCall({ sessionId: 'session-1', callId: 'call-3' })
  const second = requestIdForToolCall({ sessionId: 'session-1', callId: 'call-3' })
  assert.equal(first, second, 'a replay after a crash must re-derive the same request id')
})

test('the same call in another session mints a different id', () => {
  const here = requestIdForToolCall({ sessionId: 'session-1', callId: 'call-3' })
  const there = requestIdForToolCall({ sessionId: 'session-2', callId: 'call-3' })
  assert.notEqual(here, there, 'request ids are unique per DSA_HOME, and two sessions share one')
})

test('two call ids that sanitize alike still mint different ids', () => {
  const slash = requestIdForToolCall({ sessionId: 'session-1', callId: 'call/3' })
  const dash = requestIdForToolCall({ sessionId: 'session-1', callId: 'call-3' })
  assert.notEqual(slash, dash)
})

test('awkward call ids stay inside the grammar and the length bound', () => {
  const id = requestIdForToolCall({ sessionId: 's'.repeat(200), callId: '::'.concat('x'.repeat(300)) })
  assert.equal(isRequestId(id), true)
  assert.ok(id.length <= REQUEST_ID_MAX_LENGTH, `id was ${id.length} characters`)
})

test('content-derived ids are deterministic and content-sensitive', () => {
  const one = requestIdForContent({ sessionId: 's1', parts: [{ agent: 'worker', task: 'a' }] })
  const again = requestIdForContent({ sessionId: 's1', parts: [{ agent: 'worker', task: 'a' }] })
  const other = requestIdForContent({ sessionId: 's1', parts: [{ agent: 'worker', task: 'b' }] })
  assert.equal(one, again)
  assert.notEqual(one, other)
  assert.equal(isRequestId(one), true)
})

test('scopedRequestId rejects nothing the CLI would refuse', () => {
  for (const local of ['', 'a', '9', '-leading', 'with space', 'ünïcøde', 'a'.repeat(500)]) {
    const id = scopedRequestId('scope', local)
    assert.equal(isRequestId(id), true, `local ${JSON.stringify(local.slice(0, 12))} produced ${id}`)
  }
})
