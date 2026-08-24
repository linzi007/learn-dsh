import assert from 'node:assert/strict'
import { runPersistenceRoundTripScenario } from './persistence-lab.ts'
import {
  runCommittedCorruptionScenario,
  runTornTailScenario,
} from './recovery-lab.ts'

function contiguousSeqs(length: number): number[] {
  return Array.from({ length }, (_, index) => index)
}

const roundTrip = await runPersistenceRoundTripScenario()
assert.equal(roundTrip.contextAFlushObserved, true)
assert.equal(roundTrip.contextBFlushObserved, true)
assert.equal(roundTrip.contextAStatus, 'idle')
assert.equal(roundTrip.contextBStatus, 'idle')
assert.deepEqual(roundTrip.durableEventRecordsBeforeResume, roundTrip.contextAEvents)
assert.deepEqual(roundTrip.resumedDurablePrefix, roundTrip.contextAEvents)
assert.deepEqual(roundTrip.resumedMessagesBeforeTurn2, roundTrip.contextAMessages)
assert.deepEqual(roundTrip.resumedTodosBeforeTurn2, roundTrip.contextATodos)
assert.equal(roundTrip.seedMarkerSeq, roundTrip.firstLiveSeq)
assert.deepEqual(roundTrip.turnNumbers, [1, 2])
assert.deepEqual(roundTrip.seqs, contiguousSeqs(roundTrip.finalEvents.length))
assert.deepEqual(roundTrip.durableEventRecordsAfterTurn2, roundTrip.finalEvents)
assert.equal(roundTrip.tempRootRemoved, true)

console.log('PASS 1/3：Context A 的完整 Turn 与 todo Projection 经 JSONL 恢复到 Context B')
console.log(`  durable prefix：${roundTrip.contextAEvents.length} events`)
console.log(`  firstLiveSeq / seed marker：${roundTrip.firstLiveSeq} / ${roundTrip.seedMarkerSeq}`)
console.log(`  turn：${roundTrip.turnNumbers.join(' → ')}`)
console.log(`  final seq：0..${roundTrip.seqs.at(-1)}`)

const torn = await runTornTailScenario()
const closerTypes = torn.syntheticClosers.map(event => event.type)
const interruptedTurnEnd = torn.syntheticClosers.find(event => event.type === 'turn/end')
assert.equal(torn.rawEndedWithTornFragment, true)
assert.equal(torn.tornFragmentDiscarded, true)
assert.deepEqual(torn.originalPrefixAfterResume, torn.originalCompleteEvents)
assert.deepEqual(closerTypes, ['step/end', 'turn/end'])
assert.equal(interruptedTurnEnd?.type, 'turn/end')
if (interruptedTurnEnd?.type !== 'turn/end') throw new Error('missing repaired turn/end')
assert.equal(interruptedTurnEnd.data.reason.kind, 'interrupted')
assert.deepEqual(torn.resumedMessages, torn.originalMessages)
assert.deepEqual(torn.seqs, contiguousSeqs(torn.resumedEvents.length))
assert.equal(torn.tempRootRemoved, true)

console.log('')
console.log('PASS 2/3：torn tail 只丢半条 JSON，完整开放 Turn 被 synthetic closers 平衡')
console.log(`  保留事件：${torn.originalCompleteEvents.length}`)
console.log(`  合成事件：${closerTypes.join(' → ')}`)
console.log(`  turn/end：${interruptedTurnEnd.data.reason.kind}`)

const corruption = await runCommittedCorruptionScenario()
assert.match(corruption.errorMessage, /unparsable committed event/)
assert.equal(corruption.agentWasNotPublished, true)
assert.equal(corruption.sessionWasNotPublished, true)
assert.equal(corruption.artifactBytesUnchanged, true)
assert.equal(corruption.tempRootRemoved, true)

console.log('')
console.log('PASS 3/3：committed corruption 被拒绝，Registry 与原始字节均保持不变')
console.log(`  error：${corruption.errorName}: ${corruption.errorMessage}`)
console.log('  publication：Agent=false, Session=false')
console.log('  artifact bytes：unchanged')
