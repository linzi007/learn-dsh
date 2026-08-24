import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import {
  isCompactCheckpointSource,
  ManualCompactionError,
  type CompactionResult,
} from '@deepseek-ai/dsh-compaction'
import {
  createUserMessage,
  type Message,
} from '@deepseek-ai/dsh-llm'
import {
  SessionId,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import {
  ScriptedLlmAdapter,
  textResponse,
} from '../../s06_keyless_agent_loop/src/scripted-llm.ts'
import {
  createScenarioRoot,
  disposeRuntime,
  parseUnpackedJsonl,
  pathIsMissing,
  removeScenarioRoot,
  requireArtifactPath,
} from '../../s08_jsonl_persistence/src/jsonl-fixtures.ts'
import {
  createCompactionAgent,
  mountCompactionRuntime,
  resumeCompactionAgent,
} from './compaction-harness.ts'
import {
  FAKE_SUMMARIZER_FAILURE,
  type FakeSummarizerCall,
} from './deterministic-fake-summarizer.ts'

const SUCCESS_SESSION_ID = SessionId('s10-compaction-resume')
const FAILURE_SESSION_ID = SessionId('s10-compaction-failure')
const OLDER_PROMPT = `较早上下文：${'需要在 append-only 日志中保留、但从 model-visible surface 遮蔽。'.repeat(80)}`
const NEWER_PROMPT = `较新上下文：${'这一段帮助观察真实范围选择和近期尾部保留。'.repeat(80)}`

export interface CompactionSuccessScenarioResult {
  readonly tempRoot: string
  readonly tempRootRemoved: boolean
  readonly artifactPath: string
  readonly beforeEvents: readonly SessionEvent[]
  readonly beforeMessages: readonly Message[]
  readonly beforeSurfaceSeqs: readonly number[]
  readonly beforeSurfaceTokens: number
  readonly compaction: CompactionResult
  readonly summarizerCalls: readonly FakeSummarizerCall[]
  readonly compactionFlushCount: number
  readonly contextAEvents: readonly SessionEvent[]
  readonly contextAMessages: readonly Message[]
  readonly contextASurfaceSeqs: readonly number[]
  readonly contextASurfaceTokens: number
  readonly compactionEventTypes: readonly string[]
  readonly checkpointSeq: number
  readonly checkpointSourceRecognized: boolean
  readonly retainedOriginalSeqs: readonly number[]
  readonly shadowedEventsStillInRawLog: boolean
  readonly durableEventRecords: readonly unknown[]
  readonly firstLiveSeq: number
  readonly seedMarkerSeq: number
  readonly resumedDurablePrefix: readonly SessionEvent[]
  readonly resumedMessages: readonly Message[]
  readonly resumedSurfaceSeqs: readonly number[]
  readonly resumedCheckpointSourceRecognized: boolean
}

export interface CompactionFailureScenarioResult {
  readonly tempRoot: string
  readonly tempRootRemoved: boolean
  readonly artifactPath: string
  readonly errorName: string
  readonly errorCode: string
  readonly errorMessage: string
  readonly causeMessage: string
  readonly summarizerCalls: readonly FakeSummarizerCall[]
  readonly compactionFlushCount: number
  readonly beforeEvents: readonly SessionEvent[]
  readonly afterEvents: readonly SessionEvent[]
  readonly beforeMessages: readonly Message[]
  readonly afterMessages: readonly Message[]
  readonly beforeSurfaceSeqs: readonly number[]
  readonly afterSurfaceSeqs: readonly number[]
  readonly compactionEventTypes: readonly string[]
  readonly compactionEndError: string
  readonly hasSummaryEvent: boolean
  readonly hasCheckpoint: boolean
  readonly durableEventRecords: readonly unknown[]
  readonly firstLiveSeq: number
  readonly seedMarkerSeq: number
  readonly resumedDurablePrefix: readonly SessionEvent[]
  readonly resumedMessages: readonly Message[]
  readonly resumedSurfaceSeqs: readonly number[]
}

function checkpointEvent(events: readonly SessionEvent[]) {
  return events.find((event): event is SessionEvent<'user/message'> => (
    event.type === 'user/message' && isCompactCheckpointSource(event.data.source)
  ))
}

function compactionEvents(events: readonly SessionEvent[]): SessionEvent[] {
  return events.filter(event => event.type.startsWith('compaction/'))
}

async function seedTwoTurns(handle: AgentHandle): Promise<void> {
  for (const prompt of [OLDER_PROMPT, NEWER_PROMPT]) {
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
  }
}

async function readDurableEvents(ctx: Context, sessionId: SessionId): Promise<readonly unknown[]> {
  const raw = await ctx.sessionPersistence.readRaw(sessionId)
  if (raw === undefined) throw new Error(`missing JSONL artifact for ${sessionId}`)
  return parseUnpackedJsonl(raw.content).eventRecords
}

async function runSuccessInRoot(
  persistenceRoot: string,
): Promise<Omit<CompactionSuccessScenarioResult, 'tempRoot' | 'tempRootRemoved'>> {
  const ctxA = new Context()
  let handleA: AgentHandle | undefined

  let artifactPath = ''
  let beforeEvents: readonly SessionEvent[] = []
  let beforeMessages: readonly Message[] = []
  let beforeSurfaceSeqs: readonly number[] = []
  let beforeSurfaceTokens = 0
  let compaction: CompactionResult | undefined
  let summarizerCalls: readonly FakeSummarizerCall[] = []
  let compactionFlushCount = 0
  let contextAEvents: readonly SessionEvent[] = []
  let contextAMessages: readonly Message[] = []
  let contextASurfaceSeqs: readonly number[] = []
  let contextASurfaceTokens = 0
  let durableEventRecords: readonly unknown[] = []

  try {
    const adapter = new ScriptedLlmAdapter([
      textResponse('第一轮回答：保留 append-only 事实。'),
      textResponse('第二轮回答：这条最新 assistant 消息应逐字保留。'),
    ])
    const engine = await mountCompactionRuntime(ctxA, adapter, persistenceRoot)
    handleA = await createCompactionAgent(ctxA, SUCCESS_SESSION_ID)
    await seedTwoTurns(handleA)

    beforeEvents = [...handleA.agent.session.events]
    beforeMessages = handleA.agent.session.deriveMessages()
    beforeSurfaceSeqs = [...handleA.agent.session.surface.nodes]
    beforeSurfaceTokens = ctxA.tokenMeter.measure(handleA.agent.session).surfaceTokens

    ctxA.on('session/flush', () => { compactionFlushCount += 1 })
    const result = await ctxA.compaction.compactNow(
      handleA.agent,
      new AbortController().signal,
    )
    if (result === null) throw new Error('two-turn fixture unexpectedly had no compactable range')
    compaction = result

    summarizerCalls = [...engine.calls]
    contextAEvents = [...handleA.agent.session.events]
    contextAMessages = handleA.agent.session.deriveMessages()
    contextASurfaceSeqs = [...handleA.agent.session.surface.nodes]
    contextASurfaceTokens = ctxA.tokenMeter.measure(handleA.agent.session).surfaceTokens
    artifactPath = requireArtifactPath(ctxA, handleA.agent.session.header)
    durableEventRecords = await readDurableEvents(ctxA, SUCCESS_SESSION_ID)

    await handleA.dispose()
    handleA = undefined
  } finally {
    await disposeRuntime(ctxA, handleA)
  }

  if (compaction === undefined) throw new Error('compaction result was not captured')
  const checkpoint = checkpointEvent(contextAEvents)
  if (checkpoint === undefined) throw new Error('successful compaction has no checkpoint event')

  const ctxB = new Context()
  let handleB: AgentHandle | undefined

  try {
    await mountCompactionRuntime(ctxB, new ScriptedLlmAdapter([]), persistenceRoot)
    handleB = await resumeCompactionAgent(ctxB, SUCCESS_SESSION_ID)

    const resumedEvents = [...handleB.agent.session.events]
    const firstLiveSeq = handleB.agent.session.firstLiveSeq
    const seedMarker = resumedEvents[firstLiveSeq]
    if (seedMarker?.type !== 'session/end-seed') {
      throw new Error('resumed compaction session did not append session/end-seed')
    }
    const resumedCheckpoint = checkpointEvent(resumedEvents)

    return {
      artifactPath,
      beforeEvents,
      beforeMessages,
      beforeSurfaceSeqs,
      beforeSurfaceTokens,
      compaction,
      summarizerCalls,
      compactionFlushCount,
      contextAEvents,
      contextAMessages,
      contextASurfaceSeqs,
      contextASurfaceTokens,
      compactionEventTypes: compactionEvents(contextAEvents).map(event => event.type),
      checkpointSeq: checkpoint.seq,
      checkpointSourceRecognized: isCompactCheckpointSource(checkpoint.data.source),
      retainedOriginalSeqs: beforeSurfaceSeqs.filter(seq => contextASurfaceSeqs.includes(seq)),
      shadowedEventsStillInRawLog: compaction.shadowedSeqs.every(seq => (
        contextAEvents[seq]?.seq === seq
      )),
      durableEventRecords,
      firstLiveSeq,
      seedMarkerSeq: seedMarker.seq,
      resumedDurablePrefix: resumedEvents.slice(0, firstLiveSeq),
      resumedMessages: handleB.agent.session.deriveMessages(),
      resumedSurfaceSeqs: [...handleB.agent.session.surface.nodes],
      resumedCheckpointSourceRecognized: resumedCheckpoint !== undefined
        && isCompactCheckpointSource(resumedCheckpoint.data.source),
    }
  } finally {
    await disposeRuntime(ctxB, handleB)
  }
}

/** 显式 compactNow → durable checkpoint → 全新 Context resume。 */
export async function runCompactionSuccessScenario(): Promise<CompactionSuccessScenarioResult> {
  const tempRoot = await createScenarioRoot('s10-compaction-success')
  let result: Omit<CompactionSuccessScenarioResult, 'tempRoot' | 'tempRootRemoved'>

  try {
    result = await runSuccessInRoot(tempRoot)
  } finally {
    await removeScenarioRoot(tempRoot)
  }

  return {
    ...result,
    tempRoot,
    tempRootRemoved: await pathIsMissing(tempRoot),
  }
}

async function runFailureInRoot(
  persistenceRoot: string,
): Promise<Omit<CompactionFailureScenarioResult, 'tempRoot' | 'tempRootRemoved'>> {
  const ctxA = new Context()
  let handleA: AgentHandle | undefined

  let artifactPath = ''
  let caught: ManualCompactionError | undefined
  let summarizerCalls: readonly FakeSummarizerCall[] = []
  let compactionFlushCount = 0
  let beforeEvents: readonly SessionEvent[] = []
  let afterEvents: readonly SessionEvent[] = []
  let beforeMessages: readonly Message[] = []
  let afterMessages: readonly Message[] = []
  let beforeSurfaceSeqs: readonly number[] = []
  let afterSurfaceSeqs: readonly number[] = []
  let durableEventRecords: readonly unknown[] = []

  try {
    const adapter = new ScriptedLlmAdapter([
      textResponse('第一轮回答：失败实验的原始历史。'),
      textResponse('第二轮回答：失败后仍应逐字可见。'),
    ])
    const engine = await mountCompactionRuntime(ctxA, adapter, persistenceRoot)
    handleA = await createCompactionAgent(ctxA, FAILURE_SESSION_ID)
    await seedTwoTurns(handleA)

    beforeEvents = [...handleA.agent.session.events]
    beforeMessages = handleA.agent.session.deriveMessages()
    beforeSurfaceSeqs = [...handleA.agent.session.surface.nodes]
    engine.failNextSummary()
    ctxA.on('session/flush', () => { compactionFlushCount += 1 })

    try {
      await ctxA.compaction.compactNow(handleA.agent, new AbortController().signal)
    } catch (error: unknown) {
      if (!(error instanceof ManualCompactionError)) throw error
      caught = error
    }
    if (caught === undefined) throw new Error('fake summarizer failure unexpectedly committed')

    summarizerCalls = [...engine.calls]
    afterEvents = [...handleA.agent.session.events]
    afterMessages = handleA.agent.session.deriveMessages()
    afterSurfaceSeqs = [...handleA.agent.session.surface.nodes]
    artifactPath = requireArtifactPath(ctxA, handleA.agent.session.header)
    durableEventRecords = await readDurableEvents(ctxA, FAILURE_SESSION_ID)

    await handleA.dispose()
    handleA = undefined
  } finally {
    await disposeRuntime(ctxA, handleA)
  }

  if (caught === undefined) throw new Error('manual compaction failure was not captured')
  const causeMessage = caught.cause instanceof Error ? caught.cause.message : String(caught.cause)
  const compact = compactionEvents(afterEvents)
  const end = compact.find(event => event.type === 'compaction/end')
  if (end?.type !== 'compaction/end' || end.data.error === undefined) {
    throw new Error('failed compaction did not record compaction/end { error }')
  }

  const ctxB = new Context()
  let handleB: AgentHandle | undefined

  try {
    await mountCompactionRuntime(ctxB, new ScriptedLlmAdapter([]), persistenceRoot)
    handleB = await resumeCompactionAgent(ctxB, FAILURE_SESSION_ID)
    const resumedEvents = [...handleB.agent.session.events]
    const firstLiveSeq = handleB.agent.session.firstLiveSeq
    const seedMarker = resumedEvents[firstLiveSeq]
    if (seedMarker?.type !== 'session/end-seed') {
      throw new Error('resumed failed-compaction session did not append session/end-seed')
    }

    return {
      artifactPath,
      errorName: caught.name,
      errorCode: caught.code,
      errorMessage: caught.message,
      causeMessage,
      summarizerCalls,
      compactionFlushCount,
      beforeEvents,
      afterEvents,
      beforeMessages,
      afterMessages,
      beforeSurfaceSeqs,
      afterSurfaceSeqs,
      compactionEventTypes: compact.map(event => event.type),
      compactionEndError: end.data.error,
      hasSummaryEvent: afterEvents.some(event => event.type === 'compaction/summary'),
      hasCheckpoint: checkpointEvent(afterEvents) !== undefined,
      durableEventRecords,
      firstLiveSeq,
      seedMarkerSeq: seedMarker.seq,
      resumedDurablePrefix: resumedEvents.slice(0, firstLiveSeq),
      resumedMessages: handleB.agent.session.deriveMessages(),
      resumedSurfaceSeqs: [...handleB.agent.session.surface.nodes],
    }
  } finally {
    await disposeRuntime(ctxB, handleB)
  }
}

/** fake summarizer 抛错 → durable failed bracket → surface 与 resume 语义不变。 */
export async function runCompactionFailureScenario(): Promise<CompactionFailureScenarioResult> {
  const tempRoot = await createScenarioRoot('s10-compaction-failure')
  let result: Omit<CompactionFailureScenarioResult, 'tempRoot' | 'tempRootRemoved'>

  try {
    result = await runFailureInRoot(tempRoot)
  } finally {
    await removeScenarioRoot(tempRoot)
  }

  return {
    ...result,
    tempRoot,
    tempRootRemoved: await pathIsMissing(tempRoot),
  }
}

export { FAKE_SUMMARIZER_FAILURE }
