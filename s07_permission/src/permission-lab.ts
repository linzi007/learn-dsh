import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentStatus } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  CallId,
  createUserMessage,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import {
  SessionId,
  type SessionEvent,
  type TurnEndReason,
} from '@deepseek-ai/dsh-session'
import ApprovalService, {
  type ApprovalOutcome,
  type ApprovalRequest,
} from '@deepseek-ai/dsh-user-approval'
import {
  createScriptedAgent,
} from '../../s06_keyless_agent_loop/src/agent-harness.ts'
import {
  SCRIPTED_PROVIDER,
  ScriptedLlmAdapter,
  textResponse,
  toolCallResponse,
} from '../../s06_keyless_agent_loop/src/scripted-llm.ts'
import {
  COURSE_WRITE_TOOL_NAME,
  MemoryCourseWorkspace,
  createCourseWriteToolPlugin,
  type CourseWriteRecord,
} from './course-write-tool.ts'
import {
  installCourseWritePermissionPolicy,
  type PermissionPolicyObservation,
} from './permission-policy.ts'

export const DRAFT_CALL_ID = CallId('s07-draft')
export const PUBLISH_ALLOWED_CALL_ID = CallId('s07-publish-allowed')
export const PUBLISH_REJECTED_CALL_ID = CallId('s07-publish-rejected')
export const SYSTEM_CALL_ID = CallId('s07-system')

const MAIN_SESSION_ID = SessionId('s07-permission-main')
const NO_ANSWERER_SESSION_ID = SessionId('s07-no-answerer')
const NEVER_SESSION_ID = SessionId('s07-policy-never')

export interface ApprovalAnswerObservation {
  readonly callId: string | undefined
  readonly toolName: string
  readonly reason: string | undefined
  readonly outcome: ApprovalOutcome
}

export interface ToolResultObservation {
  readonly callId: string
  readonly isError: boolean
  readonly text: string
}

export interface ApprovalAuditPair {
  readonly callId: string
  readonly approvalId: string
  readonly outcome: ApprovalOutcome
  readonly trace: readonly string[]
  readonly seqs: readonly number[]
}

export interface PermissionScenarioResult {
  readonly requests: readonly GenerateOptions[]
  readonly events: readonly SessionEvent[]
  readonly policy: readonly PermissionPolicyObservation[]
  readonly approvalAnswers: readonly ApprovalAnswerObservation[]
  readonly approvalAudit: readonly ApprovalAuditPair[]
  readonly toolResults: readonly ToolResultObservation[]
  readonly workspaceWrites: readonly CourseWriteRecord[]
  readonly answererCalls: number
  readonly statusBeforeDispose: AgentStatus
  readonly turnEndReason: TurnEndReason
}

interface MountedPermissionHarness {
  readonly policy: PermissionPolicyObservation[]
}

/**
 * 显式组合真实依赖：公开 testkit 只挂 AgentLoop 前置 Service；本章自行挂载
 * adapter、ApprovalService、course_write、policy，最后才加载 AgentLoop。
 */
async function mountPermissionHarness(
  ctx: Context,
  adapter: ScriptedLlmAdapter,
  workspace: MemoryCourseWorkspace,
  approvalPolicy: 'ask' | 'never',
): Promise<MountedPermissionHarness> {
  await mountAgentLoopTestDependencies(ctx)
  ctx.llm.registerAdapter([SCRIPTED_PROVIDER], adapter)
  await ctx.plugin(ApprovalService, { policy: approvalPolicy })
  await ctx.plugin(createCourseWriteToolPlugin(workspace))
  const policy: PermissionPolicyObservation[] = []
  installCourseWritePermissionPolicy(ctx, policy)
  await ctx.plugin(AgentLoop, { agents: [] })
  return { policy }
}

function textOfToolResult(event: Extract<SessionEvent, { type: 'tool/result' }>): ToolResultObservation {
  const result = event.data.message.content.find(block => block.type === 'tool-result')
  if (result?.type !== 'tool-result') throw new Error('tool/result event has no tool-result block')
  const text = result.content
    .map(block => block.type === 'text' ? block.text : `[${block.type}]`)
    .join('\n')
  return {
    callId: String(result.toolCallId),
    isError: result.isError === true,
    text,
  }
}

function toolResultObservations(events: readonly SessionEvent[]): ToolResultObservation[] {
  return events
    .filter((event): event is Extract<SessionEvent, { type: 'tool/result' }> => event.type === 'tool/result')
    .map(textOfToolResult)
}

function toolResultMatchesCall(event: SessionEvent, callId: string): boolean {
  if (event.type !== 'tool/result') return false
  return event.data.message.content.some(
    block => block.type === 'tool-result' && block.toolCallId === callId,
  )
}

/** 从真实 Session log 按 approval id 和 CallId 重建审计四元组。 */
export function approvalAuditPairs(events: readonly SessionEvent[]): ApprovalAuditPair[] {
  const pairs: ApprovalAuditPair[] = []

  for (const asked of events) {
    if (asked.type !== 'approval/asked' || asked.data.callId === undefined) continue
    const callId = String(asked.data.callId)
    const callIndex = events.findIndex(
      event => event.type === 'tool/call' && event.data.callId === asked.data.callId,
    )
    const askedIndex = events.indexOf(asked)
    const decidedIndex = events.findIndex(
      event => event.type === 'approval/decided' && event.data.id === asked.data.id,
    )
    const resultIndex = events.findIndex(event => toolResultMatchesCall(event, callId))
    if ([callIndex, askedIndex, decidedIndex, resultIndex].some(index => index < 0)) {
      throw new Error(`incomplete approval audit for ${callId}`)
    }
    const decided = events[decidedIndex]
    if (decided?.type !== 'approval/decided') {
      throw new Error(`missing approval/decided for ${callId}`)
    }
    const relevant = new Set([callIndex, askedIndex, decidedIndex, resultIndex])
    const ordered = events.filter((_event, index) => relevant.has(index))
    pairs.push({
      callId,
      approvalId: String(asked.data.id),
      outcome: decided.data.outcome,
      trace: ordered.map(event => event.type),
      seqs: ordered.map(event => event.seq),
    })
  }

  return pairs
}

function turnEndReasonOf(events: readonly SessionEvent[]): TurnEndReason {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/end') return event.data.reason
  }
  throw new Error('permission scenario ended without turn/end')
}

async function disposeHandleAndContext(
  handle: AgentHandle | undefined,
  ctx: Context,
): Promise<void> {
  try {
    if (handle !== undefined) await handle.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
}

function resultOf(
  adapter: ScriptedLlmAdapter,
  handle: AgentHandle,
  workspace: MemoryCourseWorkspace,
  policy: readonly PermissionPolicyObservation[],
  approvalAnswers: readonly ApprovalAnswerObservation[],
  answererCalls: number,
): PermissionScenarioResult {
  const events = [...handle.agent.session.events]
  return {
    requests: [...adapter.requests],
    events,
    policy: [...policy],
    approvalAnswers: [...approvalAnswers],
    approvalAudit: approvalAuditPairs(events),
    toolResults: toolResultObservations(events),
    workspaceWrites: workspace.snapshot(),
    answererCalls,
    statusBeforeDispose: handle.agent.status,
    turnEndReason: turnEndReasonOf(events),
  }
}

/**
 * 一个真实 Turn 中依次执行 draft、两次 publish、system。
 * 第一次 publish 获得 allowed-once，第二次仍会重新 ask 并被拒绝。
 */
export async function runPermissionScenario(): Promise<PermissionScenarioResult> {
  const ctx = new Context()
  const workspace = new MemoryCourseWorkspace()
  const adapter = new ScriptedLlmAdapter([
    toolCallResponse(DRAFT_CALL_ID, COURSE_WRITE_TOOL_NAME, {
      target: 'draft',
      content: '仅保存草稿',
    }),
    toolCallResponse(PUBLISH_ALLOWED_CALL_ID, COURSE_WRITE_TOOL_NAME, {
      target: 'publish',
      content: '第一次发布',
    }),
    toolCallResponse(PUBLISH_REJECTED_CALL_ID, COURSE_WRITE_TOOL_NAME, {
      target: 'publish',
      content: '第二次发布',
    }),
    toolCallResponse(SYSTEM_CALL_ID, COURSE_WRITE_TOOL_NAME, {
      target: 'system',
      content: '修改系统区域',
    }),
    textResponse('权限策略实验完成'),
  ])
  let handle: AgentHandle | undefined

  try {
    const mounted = await mountPermissionHarness(ctx, adapter, workspace, 'ask')
    const answers: readonly ApprovalOutcome[] = ['allowed-once', 'rejected']
    const approvalAnswers: ApprovalAnswerObservation[] = []

    handle = await createScriptedAgent(ctx, MAIN_SESSION_ID)
    handle.agent.ctx.on('approval/request', (request: ApprovalRequest, next) => {
      if (request.toolName !== COURSE_WRITE_TOOL_NAME) return next()
      const outcome = answers[approvalAnswers.length]
      if (outcome === undefined) {
        throw new Error('permission scenario received an unexpected third approval request')
      }
      approvalAnswers.push({
        callId: request.callId === undefined ? undefined : String(request.callId),
        toolName: request.toolName,
        reason: request.reason,
        outcome,
      })
      return Promise.resolve(outcome)
    })

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '依次尝试 draft、两次 publish 和 system 写入' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    return resultOf(
      adapter,
      handle,
      workspace,
      mounted.policy,
      approvalAnswers,
      approvalAnswers.length,
    )
  } finally {
    await disposeHandleAndContext(handle, ctx)
  }
}

/** `ask` 策略下不注册 answerer：ApprovalService 立即 unavailable，绝不挂起。 */
export async function runNoAnswererScenario(): Promise<PermissionScenarioResult> {
  const ctx = new Context()
  const workspace = new MemoryCourseWorkspace()
  const callId = CallId('s07-no-answerer-publish')
  const adapter = new ScriptedLlmAdapter([
    toolCallResponse(callId, COURSE_WRITE_TOOL_NAME, {
      target: 'publish',
      content: '无人回答的发布',
    }),
    textResponse('无 answerer 时已 fail closed'),
  ])
  let handle: AgentHandle | undefined

  try {
    const mounted = await mountPermissionHarness(ctx, adapter, workspace, 'ask')
    handle = await createScriptedAgent(ctx, NO_ANSWERER_SESSION_ID)
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '尝试一次无人审批的 publish' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    return resultOf(adapter, handle, workspace, mounted.policy, [], 0)
  } finally {
    await disposeHandleAndContext(handle, ctx)
  }
}

/** `never` 在 answerer waterfall 之前拒绝；即使注册 answerer 也不会调用。 */
export async function runNeverPolicyScenario(): Promise<PermissionScenarioResult> {
  const ctx = new Context()
  const workspace = new MemoryCourseWorkspace()
  const callId = CallId('s07-never-publish')
  const adapter = new ScriptedLlmAdapter([
    toolCallResponse(callId, COURSE_WRITE_TOOL_NAME, {
      target: 'publish',
      content: 'never 策略下的发布',
    }),
    textResponse('never policy 已拒绝'),
  ])
  let handle: AgentHandle | undefined
  let answererCalls = 0

  try {
    const mounted = await mountPermissionHarness(ctx, adapter, workspace, 'never')
    handle = await createScriptedAgent(ctx, NEVER_SESSION_ID)
    handle.agent.ctx.on('approval/request', () => {
      answererCalls += 1
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '在 never policy 下尝试 publish' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    return resultOf(adapter, handle, workspace, mounted.policy, [], answererCalls)
  } finally {
    await disposeHandleAndContext(handle, ctx)
  }
}
