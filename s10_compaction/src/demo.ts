import assert from 'node:assert/strict'
import {
  runCompactionFailureScenario,
  runCompactionSuccessScenario,
  FAKE_SUMMARIZER_FAILURE,
} from './compaction-lab.ts'
import {
  FAKE_SUMMARIZER_PROVIDER,
  FAKE_SUMMARY_TEXT,
} from './deterministic-fake-summarizer.ts'

const success = await runCompactionSuccessScenario()
assert.equal(success.summarizerCalls.length, 1)
assert.deepEqual(
  success.compaction.shadowedSeqs,
  success.beforeSurfaceSeqs.slice(0, -1),
)
assert.deepEqual(success.retainedOriginalSeqs, success.beforeSurfaceSeqs.slice(-1))
assert.deepEqual(
  success.contextASurfaceSeqs,
  [success.checkpointSeq, ...success.retainedOriginalSeqs],
)
assert.deepEqual(success.compactionEventTypes, [
  'compaction/start',
  'compaction/summary',
  'compaction/end',
])
assert.equal(success.checkpointSourceRecognized, true)
assert.equal(success.shadowedEventsStillInRawLog, true)
assert.equal(success.compactionFlushCount, 1)
assert.ok(success.contextASurfaceTokens < success.beforeSurfaceTokens)
assert.deepEqual(success.durableEventRecords, success.contextAEvents)
assert.deepEqual(success.resumedDurablePrefix, success.contextAEvents)
assert.deepEqual(success.resumedMessages, success.contextAMessages)
assert.deepEqual(success.resumedSurfaceSeqs, success.contextASurfaceSeqs)
assert.equal(success.resumedCheckpointSourceRecognized, true)
assert.equal(success.seedMarkerSeq, success.firstLiveSeq)
assert.equal(success.tempRootRemoved, true)

console.log('PASS 1/2：真实 compactNow 将较早 surface 替换为 durable checkpoint，resume 后语义一致')
console.log(`  trigger：compactNow()（manual，turn=null）`)
console.log(`  summarizer：${FAKE_SUMMARIZER_PROVIDER}（教学 FAKE，不是模型）`)
console.log(`  shadowed seqs：${success.compaction.shadowedSeqs.join(', ')}`)
console.log(`  retained seqs：${success.retainedOriginalSeqs.join(', ')}`)
console.log(`  surface tokens：${success.beforeSurfaceTokens} → ${success.contextASurfaceTokens}`)
console.log(`  lifecycle：${success.compactionEventTypes.join(' → ')}`)
console.log(`  raw summary text：${FAKE_SUMMARY_TEXT}`)
console.log(`  resume：durable prefix ${success.contextAEvents.length} events + session/end-seed@${success.seedMarkerSeq}`)

const failure = await runCompactionFailureScenario()
assert.equal(failure.errorCode, 'summary')
assert.equal(failure.causeMessage, FAKE_SUMMARIZER_FAILURE)
assert.equal(failure.summarizerCalls.length, 1)
assert.deepEqual(failure.compactionEventTypes, [
  'compaction/start',
  'compaction/end',
])
assert.equal(failure.hasSummaryEvent, false)
assert.equal(failure.hasCheckpoint, false)
assert.deepEqual(failure.afterMessages, failure.beforeMessages)
assert.deepEqual(failure.afterSurfaceSeqs, failure.beforeSurfaceSeqs)
assert.equal(failure.compactionFlushCount, 1)
assert.deepEqual(failure.durableEventRecords, failure.afterEvents)
assert.deepEqual(failure.resumedDurablePrefix, failure.afterEvents)
assert.deepEqual(failure.resumedMessages, failure.beforeMessages)
assert.deepEqual(failure.resumedSurfaceSeqs, failure.beforeSurfaceSeqs)
assert.equal(failure.seedMarkerSeq, failure.firstLiveSeq)
assert.equal(failure.tempRootRemoved, true)

console.log('')
console.log('PASS 2/2：摘要失败写入 durable failed bracket，但不替换 surface')
console.log(`  error：${failure.errorName}(${failure.errorCode}): ${failure.errorMessage}`)
console.log(`  cause：${failure.causeMessage}`)
console.log(`  lifecycle：${failure.compactionEventTypes.join(' → ')}`)
console.log('  summary/checkpoint：false / false')
console.log(`  surface seqs：${failure.beforeSurfaceSeqs.join(', ')}（失败前后及 resume 后一致）`)
