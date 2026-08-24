import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { courseAddToolPlugin } from '../../s05_tool_contract/src/course-add-tool.ts'
import type { RealDeepSeekConfig } from './real-config.ts'
import { installMaxStepsPerTurn } from './agent-harness.ts'

export const REAL_DEEPSEEK_MAX_STEPS = 3
export const REAL_DEEPSEEK_MAX_TOKENS = 512
export const REAL_DEEPSEEK_STREAM_IDLE_TIMEOUT_MS = 60_000

/** 挂载与 keyless 轨相同的运行时，只把 scripted adapter 换成官方 DeepSeek adapter。 */
export async function mountRealDeepSeekAgentLoop(ctx: Context): Promise<void> {
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: {
      persona: '你正在参加工具调用实验。必须按用户要求调用提供的工具，'
        + '只能根据工具结果作答，不要自行心算或声称调用了并不存在的工具。',
    },
  })
  await ctx.plugin(LlmDeepSeek, {
    thinking: 'disabled',
    reasoningEffort: 'off',
    maxTokens: REAL_DEEPSEEK_MAX_TOKENS,
    streamIdleTimeoutMs: REAL_DEEPSEEK_STREAM_IDLE_TIMEOUT_MS,
  })
  await ctx.plugin(courseAddToolPlugin)
  await ctx.plugin(AgentLoop, { agents: [] })
  installMaxStepsPerTurn(ctx, REAL_DEEPSEEK_MAX_STEPS)
}

/** 使用课程解析出的 provider/model 创建真实 Agent，Key 仍由 adapter 在请求时读取。 */
export function createRealDeepSeekAgent(
  ctx: Context,
  sessionId: SessionId,
  config: RealDeepSeekConfig,
): Promise<AgentHandle> {
  return ctx.agents.create({
    sessionId,
    agentOptions: {
      provider: config.provider,
      model: config.model,
      maxTokens: REAL_DEEPSEEK_MAX_TOKENS,
    },
  })
}
