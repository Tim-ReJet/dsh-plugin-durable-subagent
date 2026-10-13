import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyDescribe, firstLine, parseJsonReply } from '../src/cli.ts'

test('a declared state is read verbatim', () => {
  assert.equal(classifyDescribe({ state: 'absent' }).state, 'absent')
  assert.equal(classifyDescribe({ state: 'pending' }).state, 'pending')
  assert.equal(classifyDescribe({ state: 'rejected', reason: 'unknown agent' }).state, 'rejected')
  assert.equal(classifyDescribe({ state: 'running', wid: 'w1' }).state, 'running')
  assert.equal(classifyDescribe({ state: 'pruned', pruned: { status: 'done' } }).state, 'pruned')
})

test('a sealed reply carries the output and status', () => {
  const snapshot = classifyDescribe({ state: 'sealed', wid: 'w1', status: 'done', output: 'the receipt', calls: [{ key: 'main' }] })
  assert.equal(snapshot.state, 'sealed')
  assert.equal(snapshot.wid, 'w1')
  assert.equal(snapshot.status, 'done')
  assert.equal(snapshot.output, 'the receipt')
})

test('an asking reply carries its questions', () => {
  const snapshot = classifyDescribe({
    state: 'asking',
    wid: 'w2',
    asking: [{ call: 'w2/main', qid: 'q1', rev: 2, text: 'which branch?' }],
  })
  assert.equal(snapshot.state, 'asking')
  assert.deepEqual(snapshot.questions, [{ call: 'w2/main', qid: 'q1', rev: 2, text: 'which branch?' }])
})

test('a reply without a state field is inferred from the fields it carries', () => {
  assert.equal(classifyDescribe({ wid: 'w1', status: 'done', calls: [{ key: 'main' }] }).state, 'sealed')
  assert.equal(classifyDescribe({ wid: 'w1' }).state, 'running')
  assert.equal(classifyDescribe({ reason: 'no such agent' }).state, 'rejected')
  assert.equal(classifyDescribe({ questions: [{ qid: 'q1' }] }).state, 'asking')
})

test('an unrecognised reply is unknown, not absent', () => {
  assert.equal(classifyDescribe({}).state, 'unknown')
  assert.equal(classifyDescribe({ state: 'nonsense' }).state, 'unknown')
  assert.equal(classifyDescribe(undefined).state, 'unknown')
  assert.equal(classifyDescribe('a string').state, 'unknown')
})

test('a schema data payload is surfaced as the structured result', () => {
  const snapshot = classifyDescribe({ state: 'sealed', wid: 'w3', status: 'done', data: { ok: true } })
  assert.deepEqual(snapshot.structured, { ok: true })
})

test('a JSON reply survives a banner line', () => {
  assert.deepEqual(parseJsonReply('note: starting\n{"state":"sealed"}\n'), { state: 'sealed' })
  assert.deepEqual(parseJsonReply('{"state":"absent"}'), { state: 'absent' })
  assert.equal(parseJsonReply('not json at all'), undefined)
  assert.equal(parseJsonReply(''), undefined)
})

test('a diagnostic line is clipped', () => {
  assert.equal(firstLine('\n\n  real line  \nsecond'), 'real line')
  assert.equal(firstLine('x'.repeat(500)).length, 203)
})
