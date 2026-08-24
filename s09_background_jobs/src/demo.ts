import assert from 'node:assert/strict'
import { runBackgroundJobsScenario } from './background-jobs-lab.ts'

const result = await runBackgroundJobsScenario()

assert.equal(result.explicitJobId, 'course-1')
assert.equal(result.firstReadText, 'alpha\nbeta\n')
assert.equal(result.secondReadText, '')
assert.equal(result.timeoutSnapshot.status, 'running')
assert.equal(result.killResult, 'requested')
assert.equal(result.stoppingSnapshot.status, 'stopping')
assert.equal(result.terminalSnapshot.status, 'killed')
assert.deepEqual(result.explicitCancellations, ['lesson no longer needs job A'])
assert.equal(result.cleanupJobId, 'course-2')
assert.equal(result.cleanupBeforeDispose.status, 'running')
assert.deepEqual(result.cleanupCancellations, ['owner disposed'])
assert.deepEqual(result.jobsAfterOwnerDispose, [])

console.log('S09 PASS: real LocalJobRegistry completed both lifecycle paths')
console.log('A:', [
  result.explicitJobId,
  'running',
  'read(delta)',
  'wait(timeout)',
  'stopping',
  result.terminalSnapshot.status,
].join(' -> '))
console.log('B:', [
  result.cleanupJobId,
  result.cleanupBeforeDispose.status,
  'owner Fiber dispose',
  result.cleanupCancellations[0],
  `remaining=${result.jobsAfterOwnerDispose.length}`,
].join(' -> '))
