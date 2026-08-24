import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentStatus } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type CallId, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { COURSE_ADD_TOOL_NAME } from '../../s05_tool_contract/src/course-add-tool.ts'
import {
  createRealDeepSeekAgent,
  mountRealDeepSeekAgentLoop,
} from './real-agent-harness.ts'
import type { RealDeepSeekConfig } from './real-config.ts'

const REAL_SESSION_ID = SessionId('s06-real-deepseek-round-trip')
const REAL_DEMO_TIMEOUT_MS = 120_000

export interface RealUsageSummary extends TokenUsage {
  readonly calls: number
}

export interface RealDeepSeekScenarioResult {
  readonly config: RealDeepSeekConfig
  readonly events: readonly SessionEvent[]
  readonly requestContexts: readonly { provider: string; model: string }[]
  readonly courseAddCallId: CallId | undefined
  readonly courseAddArguments: string | undefined
  readonly courseAddResultIsError: boolean | undefined
  readonly courseAddResultText: string
  readonly finalText: string
  readonly assistantMessageCount: number
  readonly usage: RealUsageSummary
  readonly turnEndReason: TurnEndReason
  readonly statusBeforeDispose: AgentStatus
  readonly timedOut: boolean
  readonly agentMissingAfterDispose: boolean
  readonly sessionMissingAfterDispose: boolean
}

function finalAssistantText(events: readonly SessionEvent[]): string {
  const last = events.filter(event => event.type === 'assistant/message').at(-1)
  if (last?.type !== 'assistant/message') return ''
  return last.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function summarizeUsage(events: readonly SessionEvent[]): RealUsageSummary {
  const usages = events
    .filter(event => event.type === 'assistant/message')
    .flatMap(event => event.data.usage === undefined ? [] : [event.data.usage])

  return usages.reduce<RealUsageSummary>((total, usage) => ({
    calls: total.calls + 1,
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    cacheReadTokens: (total.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    reasoningTokens: (total.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
  }), {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  })
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

/** 真实调用官方 DeepSeek adapter，并从 Session 证据中提取工具闭环与用量。 */
export async function runRealDeepSeekScenario(
  config: RealDeepSeekConfig,
): Promise<RealDeepSeekScenarioResult> {
  const ctx = new Context()
  let handle: AgentHandle | undefined
  let timedOut = false

  try {
    await mountRealDeepSeekAgentLoop(ctx)
    handle = await createRealDeepSeekAgent(ctx, REAL_SESSION_ID, config)

    handle.agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: '请调用 course_add，参数必须是 left=20、right=22；读取工具结果后，用一句中文回答。',
      }],
      source: { kind: 'user' },
    }))

    const timeout = setTimeout(() => {
      timedOut = true
      handle?.agent.cancel({ kind: 'user' })
    }, REAL_DEMO_TIMEOUT_MS)
    try {
      await handle.agent.whenIdle()
    } finally {
      clearTimeout(timeout)
    }

    const events = [...handle.agent.session.events]
    const requestContexts = events
      .filter(event => event.type === 'request/context')
      .map(event => ({
        provider: event.data.provider,
        model: event.data.model,
      }))
    const courseAddCall = events
      .filter(event => event.type === 'tool/call')
      .find(event => event.data.name === COURSE_ADD_TOOL_NAME)
    const courseAddResult = courseAddCall === undefined
      ? undefined
      : events
          .filter(event => event.type === 'tool/result')
          .find(event => event.data.message.source.callId === courseAddCall.data.callId)
    const courseAddResultText = courseAddResult?.data.message.content[0].content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n') ?? ''
    const turnEnd = events.filter(event => event.type === 'turn/end').at(-1)
    if (turnEnd?.type !== 'turn/end') throw new Error('真实实验结束时缺少 turn/end')

    const statusBeforeDispose = handle.agent.status
    const finalText = finalAssistantText(events)
    const assistantMessageCount = events.filter(event => event.type === 'assistant/message').length
    const usage = summarizeUsage(events)

    await handle.dispose()
    handle = undefined

    return {
      config,
      events,
      requestContexts,
      courseAddCallId: courseAddCall?.data.callId,
      courseAddArguments: courseAddCall?.data.arguments,
      courseAddResultIsError: courseAddResult?.data.message.content[0].isError,
      courseAddResultText,
      finalText,
      assistantMessageCount,
      usage,
      turnEndReason: turnEnd.data.reason,
      statusBeforeDispose,
      timedOut,
      agentMissingAfterDispose: ctx.agents.get(REAL_SESSION_ID) === undefined,
      sessionMissingAfterDispose: ctx.sessions.get(REAL_SESSION_ID) === undefined,
    }
  } finally {
    await disposeHandleAndContext(handle, ctx)
  }
}
