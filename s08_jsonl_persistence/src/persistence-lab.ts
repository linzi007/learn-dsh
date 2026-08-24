import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentStatus } from '@deepseek-ai/dsh-agent'
import {
  createUserMessage,
  type Message,
} from '@deepseek-ai/dsh-llm'
import {
  type Session,
  SessionId,
  type SessionEvent,
  type TodoItem,
} from '@deepseek-ai/dsh-session'
import {
  TODO_PROJECTION_KEY,
  todoStateSchema,
} from '../../s04_projection_replay/src/todo-domain.ts'
import {
  ScriptedLlmAdapter,
  textResponse,
} from '../../s06_keyless_agent_loop/src/scripted-llm.ts'
import {
  createPersistenceAgent,
  mountJsonlAgentRuntime,
  resumePersistenceAgent,
} from './persistence-harness.ts'
import {
  createScenarioRoot,
  disposeRuntime,
  parseUnpackedJsonl,
  pathIsMissing,
  removeScenarioRoot,
  requireArtifactPath,
} from './jsonl-fixtures.ts'

const ROUND_TRIP_SESSION_ID = SessionId('s08-jsonl-round-trip')

const persistedTodos = [{
  content: '验证 JSONL 恢复后的 Projection',
  status: 'in_progress',
}] as const satisfies readonly TodoItem[]

export interface PersistenceRoundTripResult {
  readonly tempRoot: string
  readonly tempRootRemoved: boolean
  readonly artifactPath: string
  readonly artifactFilename: string
  readonly contextAFlushObserved: boolean
  readonly contextAStatus: AgentStatus
  readonly contextAEvents: readonly SessionEvent[]
  readonly contextAMessages: readonly Message[]
  readonly contextATodos: readonly TodoItem[]
  readonly durableEventRecordsBeforeResume: readonly unknown[]
  readonly resumedEventsBeforeTurn2: readonly SessionEvent[]
  readonly resumedDurablePrefix: readonly SessionEvent[]
  readonly resumedMessagesBeforeTurn2: readonly Message[]
  readonly resumedTodosBeforeTurn2: readonly TodoItem[]
  readonly firstLiveSeq: number
  readonly seedMarkerSeq: number
  readonly contextBFlushObserved: boolean
  readonly contextBStatus: AgentStatus
  readonly finalEvents: readonly SessionEvent[]
  readonly finalMessages: readonly Message[]
  readonly finalTodos: readonly TodoItem[]
  readonly durableEventRecordsAfterTurn2: readonly unknown[]
  readonly turnNumbers: readonly number[]
  readonly seqs: readonly number[]
}

function projectionTodos(ctx: Context, session: Session) {
  const snapshot = ctx.sessionProjections.snapshot(session)
  const value = snapshot.values[TODO_PROJECTION_KEY]
  if (value === undefined) throw new Error('course/todos projection is not registered')
  return todoStateSchema.parse(value)
}

async function runRoundTripInRoot(
  persistenceRoot: string,
): Promise<Omit<PersistenceRoundTripResult, 'tempRoot' | 'tempRootRemoved'>> {
  const ctxA = new Context()
  let handleA: AgentHandle | undefined

  let contextAEvents: readonly SessionEvent[] = []
  let contextAMessages: readonly Message[] = []
  let contextATodos: readonly TodoItem[] = []
  let durableEventRecordsBeforeResume: readonly unknown[] = []
  let contextAFlushObserved = false
  let contextAStatus: AgentStatus = 'running'
  let artifactPath = ''
  let artifactFilename = ''

  try {
    const adapterA = new ScriptedLlmAdapter([
      textResponse('Context A 的 Turn 1 已完整结束。'),
    ])
    await mountJsonlAgentRuntime(ctxA, adapterA, persistenceRoot)

    let todoWritten = false
    ctxA.on('agent/turn-stopping', ({ agent, turn }) => {
      if (agent.id !== ROUND_TRIP_SESSION_ID || turn !== 1 || todoWritten) return
      todoWritten = true
      agent.session.append('todo/write', { todos: [...persistedTodos] })
    })

    handleA = await createPersistenceAgent(ctxA, ROUND_TRIP_SESSION_ID)
    handleA.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '完成 Turn 1，并保存学习状态。' }],
      source: { kind: 'user' },
    }))
    await handleA.agent.whenIdle()

    contextAFlushObserved = await ctxA.sessions.flush(handleA.agent.session)
    contextAStatus = handleA.agent.status
    contextAEvents = [...handleA.agent.session.events]
    contextAMessages = handleA.agent.session.deriveMessages()
    contextATodos = projectionTodos(ctxA, handleA.agent.session)

    artifactPath = requireArtifactPath(ctxA, handleA.agent.session.header)
    const raw = await ctxA.sessionPersistence.readRaw(ROUND_TRIP_SESSION_ID)
    if (raw === undefined) throw new Error('Context A did not materialize its JSONL artifact')
    artifactFilename = raw.filename
    durableEventRecordsBeforeResume = parseUnpackedJsonl(raw.content).eventRecords

    await handleA.dispose()
    handleA = undefined
  } finally {
    await disposeRuntime(ctxA, handleA)
  }

  const ctxB = new Context()
  let handleB: AgentHandle | undefined

  try {
    const adapterB = new ScriptedLlmAdapter([
      textResponse('Context B 从持久历史继续完成 Turn 2。'),
    ])
    await mountJsonlAgentRuntime(ctxB, adapterB, persistenceRoot)
    handleB = await resumePersistenceAgent(ctxB, ROUND_TRIP_SESSION_ID)

    const firstLiveSeq = handleB.agent.session.firstLiveSeq
    const resumedEventsBeforeTurn2 = [...handleB.agent.session.events]
    const seedMarker = resumedEventsBeforeTurn2[firstLiveSeq]
    if (seedMarker?.type !== 'session/end-seed') {
      throw new Error('resumed Session did not append session/end-seed at firstLiveSeq')
    }

    const resumedDurablePrefix = resumedEventsBeforeTurn2.slice(0, firstLiveSeq)
    const resumedMessagesBeforeTurn2 = handleB.agent.session.deriveMessages()
    const resumedTodosBeforeTurn2 = projectionTodos(ctxB, handleB.agent.session)

    handleB.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '从恢复点继续 Turn 2。' }],
      source: { kind: 'user' },
    }))
    await handleB.agent.whenIdle()
    const contextBFlushObserved = await ctxB.sessions.flush(handleB.agent.session)

    const finalEvents = [...handleB.agent.session.events]
    const finalMessages = handleB.agent.session.deriveMessages()
    const finalTodos = projectionTodos(ctxB, handleB.agent.session)
    const raw = await ctxB.sessionPersistence.readRaw(ROUND_TRIP_SESSION_ID)
    if (raw === undefined) throw new Error('Context B lost its JSONL artifact')

    return {
      artifactPath,
      artifactFilename,
      contextAFlushObserved,
      contextAStatus,
      contextAEvents,
      contextAMessages,
      contextATodos,
      durableEventRecordsBeforeResume,
      resumedEventsBeforeTurn2,
      resumedDurablePrefix,
      resumedMessagesBeforeTurn2,
      resumedTodosBeforeTurn2,
      firstLiveSeq,
      seedMarkerSeq: seedMarker.seq,
      contextBFlushObserved,
      contextBStatus: handleB.agent.status,
      finalEvents,
      finalMessages,
      finalTodos,
      durableEventRecordsAfterTurn2: parseUnpackedJsonl(raw.content).eventRecords,
      turnNumbers: finalEvents
        .filter(event => event.type === 'turn/start')
        .map(event => event.data.turn),
      seqs: finalEvents.map(event => event.seq),
    }
  } finally {
    await disposeRuntime(ctxB, handleB)
  }
}

/** 运行 Context A 写盘、完全释放、Context B resume 并继续 Turn 2 的正向场景。 */
export async function runPersistenceRoundTripScenario(): Promise<PersistenceRoundTripResult> {
  const tempRoot = await createScenarioRoot('round-trip')
  let result: Omit<PersistenceRoundTripResult, 'tempRoot' | 'tempRootRemoved'>

  try {
    result = await runRoundTripInRoot(tempRoot)
  } finally {
    await removeScenarioRoot(tempRoot)
  }

  return {
    ...result,
    tempRoot,
    tempRootRemoved: await pathIsMissing(tempRoot),
  }
}
