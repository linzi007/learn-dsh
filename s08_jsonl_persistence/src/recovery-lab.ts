import {
  appendFile,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentStatus } from '@deepseek-ai/dsh-agent'
import {
  createAssistantMessage,
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

const TORN_SESSION_ID = SessionId('s08-torn-tail')
const CORRUPT_SESSION_ID = SessionId('s08-committed-corruption')
const TORN_FRAGMENT = '{"course_torn_probe":"HALF-WRITTEN'

interface ArtifactFixture {
  readonly path: string
  readonly events: readonly SessionEvent[]
  readonly messages: readonly Message[]
  readonly flushObserved: boolean
}

export interface TornTailResult {
  readonly tempRoot: string
  readonly tempRootRemoved: boolean
  readonly artifactPath: string
  readonly originalFlushObserved: boolean
  readonly originalCompleteEvents: readonly SessionEvent[]
  readonly originalMessages: readonly Message[]
  readonly rawEndedWithTornFragment: boolean
  readonly originalPrefixAfterResume: readonly SessionEvent[]
  readonly syntheticClosers: readonly SessionEvent[]
  readonly resumedEvents: readonly SessionEvent[]
  readonly resumedMessages: readonly Message[]
  readonly firstLiveSeq: number
  readonly seedMarkerSeq: number
  readonly resumedFlushObserved: boolean
  readonly resumedStatus: AgentStatus
  readonly repairedEventRecords: readonly unknown[]
  readonly tornFragmentDiscarded: boolean
  readonly seqs: readonly number[]
}

export interface CommittedCorruptionResult {
  readonly tempRoot: string
  readonly tempRootRemoved: boolean
  readonly artifactPath: string
  readonly corruptedLineIndex: number
  readonly errorName: string
  readonly errorMessage: string
  readonly agentWasNotPublished: boolean
  readonly sessionWasNotPublished: boolean
  readonly artifactBytesUnchanged: boolean
}

async function createOpenTurnArtifact(root: string): Promise<ArtifactFixture> {
  const ctx = new Context()

  try {
    await mountJsonlAgentRuntime(ctx, new ScriptedLlmAdapter([]), root)
    const session = ctx.sessions.create(TORN_SESSION_ID)

    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '这条完整消息必须在 torn-tail 修复后保留。' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '这条完整 assistant 事件也必须保留。' }],
        source: {
          provider: 'course-scripted',
          model: 'course-scripted-model',
        },
      }),
    }, {
      surfaceOp: 'append',
      sourceEventSeqs: [],
    })

    const flushObserved = await ctx.sessions.flush(session)
    return {
      path: requireArtifactPath(ctx, session.header),
      events: [...session.events],
      messages: session.deriveMessages(),
      flushObserved,
    }
  } finally {
    await disposeRuntime(ctx)
  }
}

async function runTornTailInRoot(
  root: string,
): Promise<Omit<TornTailResult, 'tempRoot' | 'tempRootRemoved'>> {
  const fixture = await createOpenTurnArtifact(root)
  await appendFile(fixture.path, TORN_FRAGMENT, 'utf8')
  const rawBeforeResume = await readFile(fixture.path, 'utf8')

  const ctx = new Context()
  let handle: AgentHandle | undefined

  try {
    await mountJsonlAgentRuntime(ctx, new ScriptedLlmAdapter([]), root)
    handle = await resumePersistenceAgent(ctx, TORN_SESSION_ID)

    const resumedEvents = [...handle.agent.session.events]
    const firstLiveSeq = handle.agent.session.firstLiveSeq
    const seedMarker = resumedEvents[firstLiveSeq]
    if (seedMarker?.type !== 'session/end-seed') {
      throw new Error('torn-tail resume did not append session/end-seed')
    }

    const originalPrefixAfterResume = resumedEvents.slice(0, fixture.events.length)
    const syntheticClosers = resumedEvents.slice(fixture.events.length, firstLiveSeq)
    const resumedMessages = handle.agent.session.deriveMessages()
    const resumedStatus = handle.agent.status
    const resumedFlushObserved = await ctx.sessions.flush(handle.agent.session)
    const rawAfterRepair = await readFile(fixture.path, 'utf8')

    return {
      artifactPath: fixture.path,
      originalFlushObserved: fixture.flushObserved,
      originalCompleteEvents: fixture.events,
      originalMessages: fixture.messages,
      rawEndedWithTornFragment: rawBeforeResume.endsWith(TORN_FRAGMENT),
      originalPrefixAfterResume,
      syntheticClosers,
      resumedEvents,
      resumedMessages,
      firstLiveSeq,
      seedMarkerSeq: seedMarker.seq,
      resumedFlushObserved,
      resumedStatus,
      repairedEventRecords: parseUnpackedJsonl(rawAfterRepair).eventRecords,
      tornFragmentDiscarded: !rawAfterRepair.includes(TORN_FRAGMENT),
      seqs: resumedEvents.map(event => event.seq),
    }
  } finally {
    await disposeRuntime(ctx, handle)
  }
}

/**
 * 保留完整的开放 Turn，只丢弃末尾半条 JSON，并持久追加 synthetic closers。
 */
export async function runTornTailScenario(): Promise<TornTailResult> {
  const tempRoot = await createScenarioRoot('torn-tail')
  let result: Omit<TornTailResult, 'tempRoot' | 'tempRootRemoved'>

  try {
    result = await runTornTailInRoot(tempRoot)
  } finally {
    await removeScenarioRoot(tempRoot)
  }

  return {
    ...result,
    tempRoot,
    tempRootRemoved: await pathIsMissing(tempRoot),
  }
}

async function createBalancedArtifact(root: string): Promise<ArtifactFixture> {
  const ctx = new Context()
  let handle: AgentHandle | undefined

  try {
    await mountJsonlAgentRuntime(ctx, new ScriptedLlmAdapter([
      textResponse('这是一段已完整提交的 Turn。'),
    ]), root)
    handle = await createPersistenceAgent(ctx, CORRUPT_SESSION_ID)
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '生成一个随后用于 committed corruption 的日志。' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    const flushObserved = await ctx.sessions.flush(handle.agent.session)

    return {
      path: requireArtifactPath(ctx, handle.agent.session.header),
      events: [...handle.agent.session.events],
      messages: handle.agent.session.deriveMessages(),
      flushObserved,
    }
  } finally {
    await disposeRuntime(ctx, handle)
  }
}

function corruptOneCommittedEvent(content: string): {
  readonly content: string
  readonly lineIndex: number
} {
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()

  const lineIndex = lines.findIndex((line, index) => {
    if (index === 0) return false
    try {
      const value: unknown = JSON.parse(line)
      return typeof value === 'object'
        && value !== null
        && 'type' in value
        && value.type === 'assistant/chunk'
    } catch {
      return false
    }
  })
  if (lineIndex < 0) throw new Error('fixture has no assistant/chunk line to corrupt')

  lines[lineIndex] = '{"course_committed_corruption":'
  return {
    content: `${lines.join('\n')}\n`,
    lineIndex,
  }
}

async function runCommittedCorruptionInRoot(
  root: string,
): Promise<Omit<CommittedCorruptionResult, 'tempRoot' | 'tempRootRemoved'>> {
  const fixture = await createBalancedArtifact(root)
  const original = await readFile(fixture.path, 'utf8')
  const corruption = corruptOneCommittedEvent(original)
  await writeFile(fixture.path, corruption.content, 'utf8')
  const bytesBeforeResume = await readFile(fixture.path)

  const ctx = new Context()
  let caught: unknown

  try {
    await mountJsonlAgentRuntime(ctx, new ScriptedLlmAdapter([]), root)
    try {
      await resumePersistenceAgent(ctx, CORRUPT_SESSION_ID)
    } catch (error: unknown) {
      caught = error
    }

    if (caught === undefined) throw new Error('committed corruption was unexpectedly accepted')
    const bytesAfterResume = await readFile(fixture.path)
    const errorName = caught instanceof Error ? caught.name : typeof caught
    const errorMessage = caught instanceof Error ? caught.message : String(caught)

    return {
      artifactPath: fixture.path,
      corruptedLineIndex: corruption.lineIndex,
      errorName,
      errorMessage,
      agentWasNotPublished: ctx.agents.get(CORRUPT_SESSION_ID) === undefined,
      sessionWasNotPublished: ctx.sessions.get(CORRUPT_SESSION_ID) === undefined,
      artifactBytesUnchanged: bytesBeforeResume.equals(bytesAfterResume),
    }
  } finally {
    await disposeRuntime(ctx)
  }
}

/** 已提交区的完整坏行必须拒绝恢复，且不得发布或修改原始工件。 */
export async function runCommittedCorruptionScenario(): Promise<CommittedCorruptionResult> {
  const tempRoot = await createScenarioRoot('committed-corruption')
  let result: Omit<CommittedCorruptionResult, 'tempRoot' | 'tempRootRemoved'>

  try {
    result = await runCommittedCorruptionInRoot(tempRoot)
  } finally {
    await removeScenarioRoot(tempRoot)
  }

  return {
    ...result,
    tempRoot,
    tempRootRemoved: await pathIsMissing(tempRoot),
  }
}
