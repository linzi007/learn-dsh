import { beforeAll, describe, expect, it } from 'vitest'
import {
  runPersistenceRoundTripScenario,
  type PersistenceRoundTripResult,
} from '../src/persistence-lab.ts'
import {
  runCommittedCorruptionScenario,
  runTornTailScenario,
  type CommittedCorruptionResult,
  type TornTailResult,
} from '../src/recovery-lab.ts'

let roundTrip: PersistenceRoundTripResult
let torn: TornTailResult
let corruption: CommittedCorruptionResult

beforeAll(async () => {
  [roundTrip, torn, corruption] = await Promise.all([
    runPersistenceRoundTripScenario(),
    runTornTailScenario(),
    runCommittedCorruptionScenario(),
  ])
})

function contiguousSeqs(length: number): number[] {
  return Array.from({ length }, (_, index) => index)
}

describe('第 8 章：JSONL persistence 与 crash recovery', () => {
  it('Context A 的 Session events 与 packChunks:false JSONL 行逐项一致', () => {
    expect(roundTrip.artifactFilename).toBe('session.jsonl')
    expect(roundTrip.contextAFlushObserved).toBe(true)
    expect(roundTrip.contextAStatus).toBe('idle')
    expect(roundTrip.durableEventRecordsBeforeResume).toEqual(roundTrip.contextAEvents)

    expect(roundTrip.contextAEvents.filter(event => event.type === 'turn/start'))
      .toHaveLength(1)
    expect(roundTrip.contextAEvents.filter(event => event.type === 'turn/end'))
      .toHaveLength(1)
    expect(roundTrip.contextAEvents.some(event => event.type === 'todo/write')).toBe(true)
  })

  it('resume 保留 durable prefix、deriveMessages 与 todo Projection', () => {
    expect(roundTrip.resumedDurablePrefix).toEqual(roundTrip.contextAEvents)
    expect(roundTrip.resumedMessagesBeforeTurn2).toEqual(roundTrip.contextAMessages)
    expect(roundTrip.resumedTodosBeforeTurn2).toEqual(roundTrip.contextATodos)
    expect(roundTrip.contextATodos).toEqual([{
      content: '验证 JSONL 恢复后的 Projection',
      status: 'in_progress',
    }])
    expect(roundTrip.finalTodos).toEqual(roundTrip.contextATodos)
  })

  it('firstLiveSeq 指向新 lifecycle 的 seed marker，后续 Turn 从 2 继续', () => {
    expect(roundTrip.firstLiveSeq).toBe(roundTrip.contextAEvents.length)
    expect(roundTrip.seedMarkerSeq).toBe(roundTrip.firstLiveSeq)
    expect(roundTrip.resumedEventsBeforeTurn2[roundTrip.firstLiveSeq]).toMatchObject({
      type: 'session/end-seed',
      seq: roundTrip.firstLiveSeq,
      data: {},
    })
    expect(roundTrip.turnNumbers).toEqual([1, 2])
  })

  it('Context B flush 后全部 seq 连续，物理事件行等于最终 live log', () => {
    expect(roundTrip.contextBFlushObserved).toBe(true)
    expect(roundTrip.contextBStatus).toBe('idle')
    expect(roundTrip.seqs).toEqual(contiguousSeqs(roundTrip.finalEvents.length))
    expect(roundTrip.durableEventRecordsAfterTurn2).toEqual(roundTrip.finalEvents)
    expect(roundTrip.finalMessages).toHaveLength(4)
  })

  it('torn tail 只丢弃半条 JSON，完整事件和模型历史原样保留', () => {
    expect(torn.originalFlushObserved).toBe(true)
    expect(torn.rawEndedWithTornFragment).toBe(true)
    expect(torn.tornFragmentDiscarded).toBe(true)
    expect(torn.originalPrefixAfterResume).toEqual(torn.originalCompleteEvents)
    expect(torn.resumedMessages).toEqual(torn.originalMessages)
  })

  it('开放 Step 被合成 step/end 与 interrupted turn/end，再追加 seed marker', () => {
    expect(torn.syntheticClosers.map(event => event.type)).toEqual([
      'step/end',
      'turn/end',
    ])
    const stepEnd = torn.syntheticClosers[0]
    const turnEnd = torn.syntheticClosers[1]
    expect(stepEnd).toMatchObject({
      type: 'step/end',
      data: { turn: 1, step: 1 },
    })
    expect(turnEnd).toMatchObject({
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'interrupted' } },
    })
    expect(torn.firstLiveSeq).toBe(torn.originalCompleteEvents.length + 2)
    expect(torn.seedMarkerSeq).toBe(torn.firstLiveSeq)
    expect(torn.resumedEvents[torn.firstLiveSeq]?.type).toBe('session/end-seed')
    expect(torn.resumedStatus).toBe('idle')
    expect(torn.resumedFlushObserved).toBe(true)
    expect(torn.seqs).toEqual(contiguousSeqs(torn.resumedEvents.length))
    expect(torn.repairedEventRecords).toEqual(torn.resumedEvents)
  })

  it('committed corruption 拒绝 resume，不发布对象、不重写文件', () => {
    expect(corruption.errorMessage).toContain('unparsable committed event')
    expect(corruption.agentWasNotPublished).toBe(true)
    expect(corruption.sessionWasNotPublished).toBe(true)
    expect(corruption.artifactBytesUnchanged).toBe(true)
  })

  it('三个场景都只清理各自 mkdtemp 返回的精确根目录', () => {
    expect(roundTrip.tempRootRemoved).toBe(true)
    expect(torn.tempRootRemoved).toBe(true)
    expect(corruption.tempRootRemoved).toBe(true)
  })
})
