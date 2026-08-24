import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import {
  SCRIPTED_MODEL,
  SCRIPTED_PROVIDER,
  type ScriptedLlmAdapter,
} from '../../s06_keyless_agent_loop/src/scripted-llm.ts'
import { DeterministicFakeSummarizerCompactionEngine } from './deterministic-fake-summarizer.ts'

/**
 * 挂载真实 AgentLoop、Session、TokenMeter、BasicCompactionEngine 事务与 JSONL。
 * 唯一的 compaction 替身是子类覆盖的 deterministic summarize hook。
 */
export async function mountCompactionRuntime(
  ctx: Context,
  adapter: ScriptedLlmAdapter,
  persistenceRoot: string,
): Promise<DeterministicFakeSummarizerCompactionEngine> {
  try {
    await mountAgentLoopTestDependencies(ctx)
    ctx.llm.registerAdapter([SCRIPTED_PROVIDER], adapter)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(JsonlSessionPersistence, {
      root: persistenceRoot,
      compression: 'none',
      packChunks: false,
    })
    await ctx.plugin(TokenMeter)
    await ctx.plugin(DeterministicFakeSummarizerCompactionEngine, { auto: false })

    const engine = ctx.compaction
    if (!(engine instanceof DeterministicFakeSummarizerCompactionEngine)) {
      throw new Error('deterministic fake summarizer compaction engine was not registered')
    }
    return engine
  } catch (error: unknown) {
    await ctx.fiber.dispose()
    throw error
  }
}
/** 通过真实 AgentRegistry 创建新 Agent。 */
export function createCompactionAgent(
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

/** 从 S08 的真实 JSONL 后端恢复 Agent 与 Session。 */
export function resumeCompactionAgent(
  ctx: Context,
  sessionId: SessionId,
): Promise<AgentHandle> {
  return ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: {
      provider: SCRIPTED_PROVIDER,
      model: SCRIPTED_MODEL,
    },
  })
}
