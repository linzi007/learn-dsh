import assert from 'node:assert/strict'
import { runAppendOnlyScenario } from './session-lab.ts'

const result = runAppendOnlyScenario()
assert.equal(result.seqContiguous, true)
assert.equal(result.loggedTodoContent, 'understand append-only')
assert.equal(result.nextSeqAfterRejected, result.nextSeqBeforeRejected)
assert.equal(result.sameSnapshotAfterRejected, true)

console.log('S03：Append-only session')
for (const event of result.trace) console.log(event)
