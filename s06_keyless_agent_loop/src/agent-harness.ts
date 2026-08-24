import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { courseAddToolPlugin } from '../../s05_tool_contract/src/course-add-tool.ts'
import { SCRIPTED_MODEL, SCRIPTED_PROVIDER } from './scripted-llm.ts'

/**
 * 按公开测试组合顺序挂载真实运行时，再把课程 adapter 和 S05 工具接入。
 * testkit 只负责依赖顺序；它不是生产 bundle，也不会替课程驱动 Agent。
 */
export async function mountKeylessAgentLoop(
  ctx: Context,
  adapter: LlmAdapter,
): Promise<void> {
  await mountAgentLoopTestDependencies(ctx)
  ctx.llm.registerAdapter([SCRIPTED_PROVIDER], adapter)
  await ctx.plugin(courseAddToolPlugin)
  await ctx.plugin(AgentLoop, { agents: [] })
}

/** 通过 AgentRegistry 的公开 factory 边界创建一个由调用方持有的 AgentHandle。 */
export function createScriptedAgent(
  ctx: Context,
  sessionId: SessionId,
): Promise<AgentHandle> {
  return ctx.agents.create({
    sessionId,
    agentOptions: {
      provider: SCRIPTED_PROVIDER,
      model: SCRIPTED_MODEL,
    },
  })
}

/**
 * 课程自定义的每轮步骤预算，不是 rc.2 内置配置。
 * step 从 1 开始；超过预算的拟议步骤在写入 step/start 前被拒绝。
 */
export function installMaxStepsPerTurn(
  ctx: Context,
  maxStepsPerTurn: number,
): () => void {
  if (!Number.isInteger(maxStepsPerTurn) || maxStepsPerTurn < 1) {
    throw new RangeError('maxStepsPerTurn must be a positive integer')
  }

  return ctx.on('agent/pre-step', ({ step }, next) => {
    if (step > maxStepsPerTurn) return Promise.resolve({ kind: 'reject' })
    return next()
  })
}
