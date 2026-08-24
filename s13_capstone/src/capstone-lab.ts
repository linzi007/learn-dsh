import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentStatus } from '@deepseek-ai/dsh-agent'
import {
  CallId,
  createUserMessage,
  type GenerateOptions,
  type ToolResultBlock,
} from '@deepseek-ai/dsh-llm'
import {
  SessionId,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import type {
  ApprovalOutcome,
  ApprovalRequest,
} from '@deepseek-ai/dsh-user-approval'
import {
  ScriptedLlmAdapter,
  textResponse,
  toolCallResponse,
} from '../../s06_keyless_agent_loop/src/scripted-llm.ts'
import {
  COURSE_FILE_NAME,
  CONTEXT_A_COURSE_CONTENT,
  ESCAPE_LINK_NAME,
  FINAL_COURSE_CONTENT,
  createCapstoneFixture,
  outsideFixtureIsUnchanged,
  pathIsMissing,
  readCourseFile,
  removeCapstoneFixture,
  transcriptLeaksOutsideFixture,
  type CapstoneFixture,
} from './capstone-fixtures.ts'
import {
  createCapstoneAgent,
  disposeCapstoneRuntime,
  mountCapstoneRuntime,
  resumeCapstoneAgent,
} from './capstone-harness.ts'
import type {
  WorkspacePolicyObservation,
  WorkspacePolicyTrace,
} from './workspace-policy.ts'

export const CAPSTONE_SESSION_ID = SessionId('s13-keyless-mini-coding-harness')

export const A_READ_CALL_ID = CallId('s13-a-read')
export const A_EDIT_CALL_ID = CallId('s13-a-edit')
export const B_DIRECT_EDIT_CALL_ID = CallId('s13-b-direct-edit')
export const B_READ_CALL_ID = CallId('s13-b-read')
export const B_RETRY_EDIT_CALL_ID = CallId('s13-b-retry-edit')
export const B_OUTSIDE_WRITE_CALL_ID = CallId('s13-b-outside-write')
export const B_SYMLINK_READ_CALL_ID = CallId('s13-b-symlink-read')

export interface ApprovalAnswerObservation {
  readonly context: 'A' | 'B'
  readonly callId: string | undefined
  readonly toolName: string
  readonly reason: string | undefined
  readonly outcome: ApprovalOutcome
}

export interface ApprovalAuditObservation {
  readonly callId: string
  readonly outcome: ApprovalOutcome
  readonly trace: readonly string[]
  readonly seqs: readonly number[]
}

export interface ToolResultObservation {
  readonly callId: string
  readonly toolName: string
  readonly isError: boolean
  readonly text: string
  readonly errorName: string | undefined
  readonly errorCode: string | undefined
  readonly seq: number
}

export interface CapstoneScenarioResult {
  readonly sessionId: SessionId
  readonly tempRoot: string
  readonly tempRootRemoved: boolean
  readonly workspace: string
  readonly artifactPath: string
  readonly artifactFilename: string
  readonly contextARequests: readonly GenerateOptions[]
  readonly contextBRequests: readonly GenerateOptions[]
  readonly contextAEvents: readonly SessionEvent[]
  readonly durableEventsAfterContextA: readonly unknown[]
  readonly resumedEventsBeforeContextB: readonly SessionEvent[]
  readonly firstLiveSeq: number
  readonly finalEvents: readonly SessionEvent[]
  readonly durableEventsAfterContextB: readonly unknown[]
  readonly turnNumbers: readonly number[]
  readonly contextACwd: string | undefined
  readonly contextBCwd: string | undefined
  readonly contextAFlushObserved: boolean
  readonly contextBFlushObserved: boolean
  readonly contextAStatus: AgentStatus
  readonly contextBStatus: AgentStatus
  readonly contextAAgentMissingAfterDispose: boolean
  readonly contextASessionMissingAfterDispose: boolean
  readonly contextBAgentMissingAfterDispose: boolean
  readonly contextBSessionMissingAfterDispose: boolean
  readonly contextAPolicy: readonly WorkspacePolicyObservation[]
  readonly contextBPolicy: readonly WorkspacePolicyObservation[]
  readonly dispatchedCallIds: readonly string[]
  readonly approvalAnswers: readonly ApprovalAnswerObservation[]
  readonly approvalAudit: readonly ApprovalAuditObservation[]
  readonly toolResults: readonly ToolResultObservation[]
  readonly contextAFinalText: string
  readonly contextBFinalText: string
  readonly courseContentAfterContextA: string
  readonly finalCourseContent: string
  readonly outsideFixtureUnchanged: boolean
  readonly outsideFixtureLeakedToTranscript: boolean
}

interface ContextAResult {
  readonly artifactPath: string
  readonly artifactFilename: string
  readonly requests: readonly GenerateOptions[]
  readonly events: readonly SessionEvent[]
  readonly durableEvents: readonly unknown[]
  readonly cwd: string | undefined
  readonly flushObserved: boolean
  readonly status: AgentStatus
  readonly finalText: string
  readonly courseContent: string
  readonly policy: WorkspacePolicyTrace
  readonly approvals: readonly ApprovalAnswerObservation[]
  readonly agentMissingAfterDispose: boolean
  readonly sessionMissingAfterDispose: boolean
}

interface ContextBResult {
  readonly requests: readonly GenerateOptions[]
  readonly resumedEvents: readonly SessionEvent[]
  readonly firstLiveSeq: number
  readonly finalEvents: readonly SessionEvent[]
  readonly durableEvents: readonly unknown[]
  readonly cwd: string | undefined
  readonly flushObserved: boolean
  readonly status: AgentStatus
  readonly finalText: string
  readonly courseContent: string
  readonly policy: WorkspacePolicyTrace
  readonly approvals: readonly ApprovalAnswerObservation[]
  readonly outsideUnchanged: boolean
  readonly agentMissingAfterDispose: boolean
  readonly sessionMissingAfterDispose: boolean
}

function requireToolResult(
  request: GenerateOptions,
  callId: CallId,
): ToolResultBlock {
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === 'tool-result' && block.toolCallId === callId) return block
    }
  }
  throw new Error(`S13 script expected tool-result for ${callId}`)
}

function renderedTextOf(block: ToolResultBlock): string {
  const text = block.content
    .filter(content => content.type === 'text')
    .map(content => content.text)
    .join('\n')
  if (!text) throw new Error(`S13 tool-result ${block.toolCallId} has no rendered text`)
  return text
}

function finalAssistantText(events: readonly SessionEvent[]): string {
  const event = events
    .filter(candidate => candidate.type === 'assistant/message')
    .at(-1)
  if (event?.type !== 'assistant/message') {
    throw new Error('S13 scenario ended without an assistant message')
  }
  return event.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function createContextAAdapter(): ScriptedLlmAdapter {
  return new ScriptedLlmAdapter([
    toolCallResponse(A_READ_CALL_ID, 'read', {
      file_path: COURSE_FILE_NAME,
    }),
    toolCallResponse(A_EDIT_CALL_ID, 'edit', {
      file_path: COURSE_FILE_NAME,
      old_string: '状态：初始',
      new_string: '状态：Context A 已读后编辑',
    }),
    (request) => {
      const editResult = requireToolResult(request, A_EDIT_CALL_ID)
      if (editResult.isError) throw new Error('Context A edit unexpectedly failed')
      return textResponse(`Context A 从真实 edit tool-result 得到：${renderedTextOf(editResult)}`)
    },
  ])
}

function createContextBAdapter(): ScriptedLlmAdapter {
  return new ScriptedLlmAdapter([
    toolCallResponse(B_DIRECT_EDIT_CALL_ID, 'edit', {
      file_path: COURSE_FILE_NAME,
      old_string: '状态：Context A 已读后编辑',
      new_string: '状态：Context B 恢复后编辑',
    }),
    toolCallResponse(B_READ_CALL_ID, 'read', {
      file_path: COURSE_FILE_NAME,
    }),
    toolCallResponse(B_RETRY_EDIT_CALL_ID, 'edit', {
      file_path: COURSE_FILE_NAME,
      old_string: '状态：Context A 已读后编辑',
      new_string: '状态：Context B 恢复后编辑',
    }),
    toolCallResponse(B_OUTSIDE_WRITE_CALL_ID, 'write', {
      file_path: '../outside.txt',
      content: 'this mutation must never reach the tool body\n',
    }),
    toolCallResponse(B_SYMLINK_READ_CALL_ID, 'read', {
      file_path: ESCAPE_LINK_NAME,
    }),
    (request) => {
      const direct = requireToolResult(request, B_DIRECT_EDIT_CALL_ID)
      const read = requireToolResult(request, B_READ_CALL_ID)
      const retry = requireToolResult(request, B_RETRY_EDIT_CALL_ID)
      const outside = requireToolResult(request, B_OUTSIDE_WRITE_CALL_ID)
      const symlink = requireToolResult(request, B_SYMLINK_READ_CALL_ID)

      if (!direct.isError) throw new Error('resume direct edit should expose a cold observation cache')
      if (read.isError || retry.isError) throw new Error('read-then-retry should succeed')
      if (!outside.isError || !symlink.isError) throw new Error('workspace escapes should be denied')

      return textResponse([
        'Context B 的总结由真实 tool-result 现场生成：',
        `首次恢复编辑：${renderedTextOf(direct)}`,
        `重新读取：${renderedTextOf(read)}`,
        `重试编辑：${renderedTextOf(retry)}`,
        `父目录逃逸：${renderedTextOf(outside)}`,
        `symlink 逃逸：${renderedTextOf(symlink)}`,
      ].join('\n'))
    },
  ])
}

function createPolicyTrace(): WorkspacePolicyTrace {
  return { observations: [], dispatchedCallIds: [] }
}

function installAllowedOnceAnswerer(
  handle: AgentHandle,
  context: 'A' | 'B',
  answers: ApprovalAnswerObservation[],
): void {
  handle.agent.ctx.on('approval/request', (request: ApprovalRequest, next) => {
    if (request.toolName !== 'write' && request.toolName !== 'edit') return next()
    const outcome: ApprovalOutcome = 'allowed-once'
    answers.push({
      context,
      callId: request.callId === undefined ? undefined : String(request.callId),
      toolName: request.toolName,
      reason: request.reason,
      outcome,
    })
    return Promise.resolve(outcome)
  })
}

function parseUnpackedEvents(content: string): unknown[] {
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  lines.shift()
  return lines.map(line => JSON.parse(line))
}

function toolResultMatchesCall(event: SessionEvent, callId: string): boolean {
  return event.type === 'tool/result'
    && event.data.message.content.some(
      block => block.type === 'tool-result' && block.toolCallId === callId,
    )
}

function approvalAuditOf(events: readonly SessionEvent[]): ApprovalAuditObservation[] {
  const result: ApprovalAuditObservation[] = []

  for (const asked of events) {
    if (asked.type !== 'approval/asked' || asked.data.callId === undefined) continue
    const callId = String(asked.data.callId)
    const callIndex = events.findIndex(event =>
      event.type === 'tool/call' && event.data.callId === asked.data.callId)
    const askedIndex = events.indexOf(asked)
    const decidedIndex = events.findIndex(event =>
      event.type === 'approval/decided' && event.data.id === asked.data.id)
    const resultIndex = events.findIndex(event => toolResultMatchesCall(event, callId))
    if ([callIndex, askedIndex, decidedIndex, resultIndex].some(index => index < 0)) {
      throw new Error(`incomplete S13 approval audit for ${callId}`)
    }
    const decided = events[decidedIndex]
    if (decided?.type !== 'approval/decided') {
      throw new Error(`missing S13 approval/decided for ${callId}`)
    }
    const relevant = new Set([callIndex, askedIndex, decidedIndex, resultIndex])
    const ordered = events.filter((_event, index) => relevant.has(index))
    result.push({
      callId,
      outcome: decided.data.outcome,
      trace: ordered.map(event => event.type),
      seqs: ordered.map(event => event.seq),
    })
  }

  return result
}

function toolResultsOf(events: readonly SessionEvent[]): ToolResultObservation[] {
  const names = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool/call') names.set(String(event.data.callId), event.data.name)
  }

  return events
    .filter((event): event is Extract<SessionEvent, { type: 'tool/result' }> =>
      event.type === 'tool/result')
    .map((event) => {
      const block = event.data.message.content.find(content => content.type === 'tool-result')
      if (block?.type !== 'tool-result') throw new Error('S13 tool/result event has no tool-result block')
      const callId = String(block.toolCallId)
      return {
        callId,
        toolName: names.get(callId) ?? 'unknown',
        isError: block.isError === true,
        text: renderedTextOf(block),
        errorName: event.data.error?.name,
        errorCode: event.data.error?.code,
        seq: event.seq,
      }
    })
}

async function runContextA(fixture: CapstoneFixture): Promise<ContextAResult> {
  const ctx = new Context()
  const adapter = createContextAAdapter()
  const policy = createPolicyTrace()
  const approvals: ApprovalAnswerObservation[] = []
  let handle: AgentHandle | undefined

  try {
    await mountCapstoneRuntime(ctx, adapter, fixture, policy)
    handle = await createCapstoneAgent(ctx, CAPSTONE_SESSION_ID, fixture.workspace)
    installAllowedOnceAnswerer(handle, 'A', approvals)

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '先读取课程文件，再做一次最小编辑。' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    const flushObserved = await ctx.sessions.flush(handle.agent.session)
    const events = [...handle.agent.session.events]
    const status = handle.agent.status
    const cwd = handle.agent.session.header.cwd
    const finalText = finalAssistantText(events)
    const courseContent = await readCourseFile(fixture)
    const location = ctx.sessionPersistence.locate(handle.agent.session.header)
    if (location?.kind !== 'jsonl') throw new Error('S13 JSONL artifact is unavailable')
    const raw = await ctx.sessionPersistence.readRaw(CAPSTONE_SESSION_ID)
    if (raw === undefined) throw new Error('S13 Context A did not flush JSONL')

    await handle.dispose()
    handle = undefined
    const agentMissingAfterDispose = ctx.agents.get(CAPSTONE_SESSION_ID) === undefined
    const sessionMissingAfterDispose = ctx.sessions.get(CAPSTONE_SESSION_ID) === undefined

    return {
      artifactPath: location.path,
      artifactFilename: raw.filename,
      requests: [...adapter.requests],
      events,
      durableEvents: parseUnpackedEvents(raw.content),
      cwd,
      flushObserved,
      status,
      finalText,
      courseContent,
      policy,
      approvals,
      agentMissingAfterDispose,
      sessionMissingAfterDispose,
    }
  } finally {
    await disposeCapstoneRuntime(ctx, handle)
  }
}

async function runContextB(fixture: CapstoneFixture): Promise<ContextBResult> {
  const ctx = new Context()
  const adapter = createContextBAdapter()
  const policy = createPolicyTrace()
  const approvals: ApprovalAnswerObservation[] = []
  let handle: AgentHandle | undefined

  try {
    await mountCapstoneRuntime(ctx, adapter, fixture, policy)
    handle = await resumeCapstoneAgent(ctx, CAPSTONE_SESSION_ID)
    const resumedEvents = [...handle.agent.session.events]
    const firstLiveSeq = handle.agent.session.firstLiveSeq
    installAllowedOnceAnswerer(handle, 'B', approvals)

    handle.agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: '恢复后先编辑；如果观察状态丢失就读取再重试，然后验证 workspace 边界。',
      }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    const flushObserved = await ctx.sessions.flush(handle.agent.session)
    const finalEvents = [...handle.agent.session.events]
    const status = handle.agent.status
    const cwd = handle.agent.session.header.cwd
    const finalText = finalAssistantText(finalEvents)
    const courseContent = await readCourseFile(fixture)
    const outsideUnchanged = await outsideFixtureIsUnchanged(fixture)
    const raw = await ctx.sessionPersistence.readRaw(CAPSTONE_SESSION_ID)
    if (raw === undefined) throw new Error('S13 Context B did not flush JSONL')

    await handle.dispose()
    handle = undefined
    const agentMissingAfterDispose = ctx.agents.get(CAPSTONE_SESSION_ID) === undefined
    const sessionMissingAfterDispose = ctx.sessions.get(CAPSTONE_SESSION_ID) === undefined

    return {
      requests: [...adapter.requests],
      resumedEvents,
      firstLiveSeq,
      finalEvents,
      durableEvents: parseUnpackedEvents(raw.content),
      cwd,
      flushObserved,
      status,
      finalText,
      courseContent,
      policy,
      approvals,
      outsideUnchanged,
      agentMissingAfterDispose,
      sessionMissingAfterDispose,
    }
  } finally {
    await disposeCapstoneRuntime(ctx, handle)
  }
}

async function runInFixture(
  fixture: CapstoneFixture,
): Promise<Omit<CapstoneScenarioResult, 'tempRoot' | 'tempRootRemoved'>> {
  const contextA = await runContextA(fixture)
  if (contextA.courseContent !== CONTEXT_A_COURSE_CONTENT) {
    throw new Error('Context A did not produce the expected on-disk edit')
  }

  const contextB = await runContextB(fixture)
  if (contextB.courseContent !== FINAL_COURSE_CONTENT) {
    throw new Error('Context B did not produce the expected on-disk edit')
  }

  const finalEvents = contextB.finalEvents
  return {
    sessionId: CAPSTONE_SESSION_ID,
    workspace: fixture.workspace,
    artifactPath: contextA.artifactPath,
    artifactFilename: contextA.artifactFilename,
    contextARequests: contextA.requests,
    contextBRequests: contextB.requests,
    contextAEvents: contextA.events,
    durableEventsAfterContextA: contextA.durableEvents,
    resumedEventsBeforeContextB: contextB.resumedEvents,
    firstLiveSeq: contextB.firstLiveSeq,
    finalEvents,
    durableEventsAfterContextB: contextB.durableEvents,
    turnNumbers: finalEvents
      .flatMap(event => event.type === 'turn/start' ? [event.data.turn] : []),
    contextACwd: contextA.cwd,
    contextBCwd: contextB.cwd,
    contextAFlushObserved: contextA.flushObserved,
    contextBFlushObserved: contextB.flushObserved,
    contextAStatus: contextA.status,
    contextBStatus: contextB.status,
    contextAAgentMissingAfterDispose: contextA.agentMissingAfterDispose,
    contextASessionMissingAfterDispose: contextA.sessionMissingAfterDispose,
    contextBAgentMissingAfterDispose: contextB.agentMissingAfterDispose,
    contextBSessionMissingAfterDispose: contextB.sessionMissingAfterDispose,
    contextAPolicy: [...contextA.policy.observations],
    contextBPolicy: [...contextB.policy.observations],
    dispatchedCallIds: [
      ...contextA.policy.dispatchedCallIds,
      ...contextB.policy.dispatchedCallIds,
    ],
    approvalAnswers: [...contextA.approvals, ...contextB.approvals],
    approvalAudit: approvalAuditOf(finalEvents),
    toolResults: toolResultsOf(finalEvents),
    contextAFinalText: contextA.finalText,
    contextBFinalText: contextB.finalText,
    courseContentAfterContextA: contextA.courseContent,
    finalCourseContent: contextB.courseContent,
    outsideFixtureUnchanged: contextB.outsideUnchanged,
    outsideFixtureLeakedToTranscript: transcriptLeaksOutsideFixture(finalEvents),
  }
}

/** 运行完整 keyless mini coding harness，并精确清理课程临时根。 */
export async function runCapstoneScenario(): Promise<CapstoneScenarioResult> {
  const fixture = await createCapstoneFixture()
  let result: Omit<CapstoneScenarioResult, 'tempRoot' | 'tempRootRemoved'>

  try {
    result = await runInFixture(fixture)
  } finally {
    await removeCapstoneFixture(fixture.root)
  }

  return {
    ...result,
    tempRoot: fixture.root,
    tempRootRemoved: await pathIsMissing(fixture.root),
  }
}
