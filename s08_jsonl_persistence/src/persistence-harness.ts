import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { todoProjection } from '../../s04_projection_replay/src/todo-domain.ts'
import {
  SCRIPTED_MODEL,
  SCRIPTED_PROVIDER,
  type ScriptedLlmAdapter,
} from '../../s06_keyless_agent_loop/src/scripted-llm.ts'

/**
 * S08 故意展开完整加载顺序，Persistence 和 Projection 都不能藏在 S06 helper 里。
 */
export async function mountJsonlAgentRuntime(
  ctx: Context,
  adapter: ScriptedLlmAdapter,
  persistenceRoot: string,
): Promise<void> {
  await mountAgentLoopTestDependencies(ctx)
  ctx.llm.registerAdapter([SCRIPTED_PROVIDER], adapter)

  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(todoProjection)

  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, {
    root: persistenceRoot,
    compression: 'none',
    packChunks: false,
  })
}

/** 创建一个使用课程脚本 provider 的全新 Agent。 */
export function createPersistenceAgent(
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

/** 从 JSONL 后端恢复同一个 Agent / Session identity。 */
export function resumePersistenceAgent(
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
