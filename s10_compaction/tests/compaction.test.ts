import {
  isCompactCheckpointSource,
} from '@deepseek-ai/dsh-compaction'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  FAKE_SUMMARIZER_FAILURE,
  runCompactionFailureScenario,
  runCompactionSuccessScenario,
  type CompactionFailureScenarioResult,
  type CompactionSuccessScenarioResult,
} from '../src/compaction-lab.ts'
import {
  FAKE_SUMMARIZER_MODEL,
  FAKE_SUMMARIZER_PROVIDER,
  FAKE_SUMMARY_TEXT,
} from '../src/deterministic-fake-summarizer.ts'

let success: CompactionSuccessScenarioResult
let failure: CompactionFailureScenarioResult

beforeAll(async () => {
  [success, failure] = await Promise.all([
    runCompactionSuccessScenario(),
    runCompactionFailureScenario(),
  ])
})

describe('第 10 章：Compaction checkpoint', () => {
  it('compactNow 用真实选择器遮蔽较早节点，并至少保留最新 surface 节点', () => {
    expect(success.beforeSurfaceSeqs).toHaveLength(4)
    expect(success.compaction.shadowedSeqs).toEqual(success.beforeSurfaceSeqs.slice(0, -1))
    expect(success.compaction.shadowedRange).toEqual({
      start: success.beforeSurfaceSeqs[0],
      end: success.beforeSurfaceSeqs.at(-2),
    })
    expect(success.retainedOriginalSeqs).toEqual(success.beforeSurfaceSeqs.slice(-1))
    expect(success.contextASurfaceSeqs).toEqual([
      success.checkpointSeq,
      ...success.retainedOriginalSeqs,
    ])
    expect(success.contextASurfaceTokens).toBeLessThan(success.beforeSurfaceTokens)
  })

  it('deterministic fake 只接管 summarize hook，并读取真实被遮蔽消息', () => {
    expect(success.summarizerCalls).toHaveLength(1)
    const call = success.summarizerCalls[0]
    expect(call?.signalWasAbortedAtEntry).toBe(false)
    expect(call?.input.messages).toEqual(success.beforeMessages.slice(0, -1))

    const summary = success.contextAEvents.find(event => event.type === 'compaction/summary')
    expect(summary?.type).toBe('compaction/summary')
    if (summary?.type !== 'compaction/summary') throw new Error('missing summary event')
    expect(summary.data.summary).toEqual([{ type: 'text', text: FAKE_SUMMARY_TEXT }])
    expect(summary.data.compactionId).toBe(success.compaction.compactionId)
    expect(summary.data.provider).toBe(FAKE_SUMMARIZER_PROVIDER)
    expect(summary.data.model).toBe(FAKE_SUMMARIZER_MODEL)
    expect(summary.data).not.toHaveProperty('llmStreamCall')
    expect(summary.data).not.toHaveProperty('rawOutput')
  })

  it('成功事务是 log-only bracket + 单个 checkpoint replacement', () => {
    expect(success.compactionEventTypes).toEqual([
      'compaction/start',
      'compaction/summary',
      'compaction/end',
    ])

    const start = success.contextAEvents[success.compaction.startSeq]
    const summary = success.contextAEvents[success.compaction.summarySeq]
    const checkpoint = success.contextAEvents[success.checkpointSeq]
    const end = success.contextAEvents[success.compaction.endSeq]
    expect(start?.type).toBe('compaction/start')
    expect(summary?.type).toBe('compaction/summary')
    expect(checkpoint?.type).toBe('user/message')
    expect(end?.type).toBe('compaction/end')
    expect(success.compaction.startSeq).toBeLessThan(success.compaction.summarySeq)
    expect(success.compaction.summarySeq).toBeLessThan(success.checkpointSeq)
    expect(success.checkpointSeq).toBeLessThan(success.compaction.endSeq)

    if (start?.type !== 'compaction/start'
      || checkpoint?.type !== 'user/message'
      || end?.type !== 'compaction/end') {
      throw new Error('incomplete compaction lifecycle')
    }
    expect(start.data.turn).toBeNull()
    expect(end.data.turn).toBeNull()
    expect(start.data.compactionId).toBe(success.compaction.compactionId)
    expect(summary?.type === 'compaction/summary' && summary.data.compactionId)
      .toBe(success.compaction.compactionId)
    expect(checkpoint.data.source).toMatchObject({
      kind: 'plugin',
      plugin: 'compact',
      compactionId: success.compaction.compactionId,
    })
    expect(end.data.compactionId).toBe(success.compaction.compactionId)
    expect(checkpoint.surfaceOp).toEqual({
      op: 'replace',
      start: success.compaction.shadowedRange.start,
      end: success.compaction.shadowedRange.end,
    })
    expect(isCompactCheckpointSource(checkpoint.data.source)).toBe(true)
    expect(success.compactionFlushCount).toBe(1)
  })

  it('append-only raw log 保留旧事件，model-visible history 只剩 checkpoint 与近期尾部', () => {
    expect(success.shadowedEventsStillInRawLog).toBe(true)
    expect(success.contextAEvents.slice(0, success.beforeEvents.length)).toEqual(success.beforeEvents)
    expect(success.contextAMessages).toHaveLength(2)
    expect(success.contextAMessages[0]?.role).toBe('user')
    expect(success.contextAMessages[0]?.content).toContainEqual({
      type: 'text',
      text: FAKE_SUMMARY_TEXT,
    })
    expect(success.contextAMessages[0]?.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('<compacted-summary>'),
      }),
      { type: 'text', text: FAKE_SUMMARY_TEXT },
      { type: 'text', text: '</compacted-summary>' },
    ])
    expect(success.contextAMessages.at(-1)).toEqual(success.beforeMessages.at(-1))
    expect(success.durableEventRecords).toEqual(success.contextAEvents)
  })

  it('JSONL resume 重放相同 replacement surface，并保留 checkpoint provenance', () => {
    expect(success.resumedDurablePrefix).toEqual(success.contextAEvents)
    expect(success.resumedMessages).toEqual(success.contextAMessages)
    expect(success.resumedSurfaceSeqs).toEqual(success.contextASurfaceSeqs)
    expect(success.resumedCheckpointSourceRecognized).toBe(true)
    expect(success.firstLiveSeq).toBe(success.contextAEvents.length)
    expect(success.seedMarkerSeq).toBe(success.firstLiveSeq)
    expect(success.tempRootRemoved).toBe(true)
  })

  it('摘要失败以 summary 分类闭合并持久化，但不写 summary/checkpoint、不改 surface', () => {
    expect(failure.errorName).toBe('ManualCompactionError')
    expect(failure.errorCode).toBe('summary')
    expect(failure.causeMessage).toBe(FAKE_SUMMARIZER_FAILURE)
    expect(failure.summarizerCalls).toHaveLength(1)
    expect(failure.compactionEventTypes).toEqual([
      'compaction/start',
      'compaction/end',
    ])
    expect(failure.compactionEndError).toContain(FAKE_SUMMARIZER_FAILURE)
    expect(failure.hasSummaryEvent).toBe(false)
    expect(failure.hasCheckpoint).toBe(false)
    expect(failure.afterMessages).toEqual(failure.beforeMessages)
    expect(failure.afterSurfaceSeqs).toEqual(failure.beforeSurfaceSeqs)
    expect(failure.afterEvents.slice(0, failure.beforeEvents.length)).toEqual(failure.beforeEvents)
    expect(failure.compactionFlushCount).toBe(1)
    expect(failure.durableEventRecords).toEqual(failure.afterEvents)
  })

  it('失败 bracket 在全新 Context 可恢复，原 model-visible history 不变', () => {
    expect(failure.resumedDurablePrefix).toEqual(failure.afterEvents)
    expect(failure.resumedMessages).toEqual(failure.beforeMessages)
    expect(failure.resumedSurfaceSeqs).toEqual(failure.beforeSurfaceSeqs)
    expect(failure.firstLiveSeq).toBe(failure.afterEvents.length)
    expect(failure.seedMarkerSeq).toBe(failure.firstLiveSeq)
    expect(failure.tempRootRemoved).toBe(true)
  })
})
