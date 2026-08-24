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
  type TurnEndReason,
} from '@deepseek-ai/dsh-session'
import {
  COURSE_ADD_TOOL_NAME,
} from '../../s05_tool_contract/src/course-add-tool.ts'
import {
  createScriptedAgent,
  installMaxStepsPerTurn,
  mountKeylessAgentLoop,
} from './agent-harness.ts'
import {
  ScriptedLlmAdapter,
  textResponse,
  toolCallResponse,
} from './scripted-llm.ts'

const POSITIVE_SESSION_ID = SessionId('s06-keyless-round-trip')
const BUDGET_SESSION_ID = SessionId('s06-step-budget')
const POSITIVE_CALL_ID = CallId('s06-course-add-1')

const TRACE_EVENT_TYPES = new Set([
  'turn/start',
  'step/start',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'step/end',
  'turn/end',
])

export interface AgentLoopScenarioResult {
  readonly sessionId: SessionId
  readonly requests: readonly GenerateOptions[]
  readonly events: readonly SessionEvent[]
  readonly simplifiedTrace: readonly string[]
  readonly finalText: string
  readonly statusBeforeDispose: AgentStatus
  readonly agentPresentBeforeDispose: boolean
  readonly sessionPresentBeforeDispose: boolean
  readonly agentMissingAfterDispose: boolean
  readonly sessionMissingAfterDispose: boolean
}

export interface StepBudgetScenarioResult {
  readonly maxStepsPerTurn: number
  readonly requests: readonly GenerateOptions[]
  readonly events: readonly SessionEvent[]
  readonly simplifiedTrace: readonly string[]
  readonly turnEndReason: TurnEndReason
  readonly statusBeforeDispose: AgentStatus
}

function findToolResult(request: GenerateOptions, callId: CallId): ToolResultBlock {
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === 'tool-result' && block.toolCallId === callId) return block
    }
  }
  throw new Error(`script expected tool-result for ${callId}`)
}

function renderedTextOf(block: ToolResultBlock): string {
  const text = block.content
    .filter(content => content.type === 'text')
    .map(content => content.text)
    .join('\n')

  if (!text) throw new Error('script expected rendered text in tool-result')
  return text
}

function finalAssistantText(events: readonly SessionEvent[]): string {
  const assistantEvents = events.filter(event => event.type === 'assistant/message')
  const last = assistantEvents.at(-1)
  if (last?.type !== 'assistant/message') {
    throw new Error('scenario ended without an assistant message')
  }

  return last.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function simplifiedTraceOf(events: readonly SessionEvent[]): string[] {
  return events
    .filter(event => TRACE_EVENT_TYPES.has(event.type))
    .map(event => event.type)
}

function createRoundTripAdapter(): ScriptedLlmAdapter {
  return new ScriptedLlmAdapter([
    toolCallResponse(POSITIVE_CALL_ID, COURSE_ADD_TOOL_NAME, {
      left: 20,
      right: 22,
    }),
    (request) => {
      const result = findToolResult(request, POSITIVE_CALL_ID)
      if (result.isError) throw new Error('course_add unexpectedly failed')
      return textResponse(`我读取了真实工具结果：${renderedTextOf(result)}`)
    },
  ])
}

/** 构造一个跨 step 重复最后脚本、不会自行停止请求工具的 LLM fake。 */
function createEndlessToolCallAdapter(): ScriptedLlmAdapter {
  let requestNumber = 0
  return new ScriptedLlmAdapter([
    () => {
      requestNumber += 1
      return toolCallResponse(
        CallId(`s06-endless-${requestNumber}`),
        COURSE_ADD_TOOL_NAME,
        { left: requestNumber, right: requestNumber },
      )
    },
  ], { repeatLast: true })
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

/** 运行“用户消息 → 真实工具 → 第二次模型请求 → 最终文本”的无 Key 闭环。 */
export async function runAgentLoopScenario(): Promise<AgentLoopScenarioResult> {
  const ctx = new Context()
  const adapter = createRoundTripAdapter()
  let handle: AgentHandle | undefined

  try {
    await mountKeylessAgentLoop(ctx, adapter)
    handle = await createScriptedAgent(ctx, POSITIVE_SESSION_ID)

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '请计算 20 + 22' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    const events = [...handle.agent.session.events]
    const statusBeforeDispose = handle.agent.status
    const agentPresentBeforeDispose = ctx.agents.get(POSITIVE_SESSION_ID) === handle.agent
    const sessionPresentBeforeDispose = ctx.sessions.get(POSITIVE_SESSION_ID) === handle.agent.session
    const finalText = finalAssistantText(events)

    await handle.dispose()
    handle = undefined

    return {
      sessionId: POSITIVE_SESSION_ID,
      requests: [...adapter.requests],
      events,
      simplifiedTrace: simplifiedTraceOf(events),
      finalText,
      statusBeforeDispose,
      agentPresentBeforeDispose,
      sessionPresentBeforeDispose,
      agentMissingAfterDispose: ctx.agents.get(POSITIVE_SESSION_ID) === undefined,
      sessionMissingAfterDispose: ctx.sessions.get(POSITIVE_SESSION_ID) === undefined,
    }
  } finally {
    await disposeHandleAndContext(handle, ctx)
  }
}

/** 运行课程自定义 maxStepsPerTurn，证明工具自循环会在第 3 个拟议 step 前阻断。 */
export async function runStepBudgetScenario(
  maxStepsPerTurn = 2,
): Promise<StepBudgetScenarioResult> {
  const ctx = new Context()
  const adapter = createEndlessToolCallAdapter()
  let handle: AgentHandle | undefined

  try {
    await mountKeylessAgentLoop(ctx, adapter)
    installMaxStepsPerTurn(ctx, maxStepsPerTurn)
    handle = await createScriptedAgent(ctx, BUDGET_SESSION_ID)

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '不断调用工具，直到 policy 阻止你' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    const events = [...handle.agent.session.events]
    const turnEnd = events.filter(event => event.type === 'turn/end').at(-1)
    if (turnEnd?.type !== 'turn/end') throw new Error('scenario ended without turn/end')

    return {
      maxStepsPerTurn,
      requests: [...adapter.requests],
      events,
      simplifiedTrace: simplifiedTraceOf(events),
      turnEndReason: turnEnd.data.reason,
      statusBeforeDispose: handle.agent.status,
    }
  } finally {
    await disposeHandleAndContext(handle, ctx)
  }
}
