import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as FsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import type { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import {
  SCRIPTED_MODEL,
  SCRIPTED_PROVIDER,
  type ScriptedLlmAdapter,
} from '../../s06_keyless_agent_loop/src/scripted-llm.ts'
import type { CapstoneFixture } from './capstone-fixtures.ts'
import {
  installWorkspaceToolPolicy,
  type WorkspacePolicyTrace,
} from './workspace-policy.ts'

/**
 * 展开综合项目的真实组合顺序。唯一 fake 是调用方传入的 ScriptedLlmAdapter。
 */
export async function mountCapstoneRuntime(
  ctx: Context,
  adapter: ScriptedLlmAdapter,
  fixture: CapstoneFixture,
  policyTrace: WorkspacePolicyTrace,
): Promise<void> {
  await mountAgentLoopTestDependencies(ctx)
  ctx.llm.registerAdapter([SCRIPTED_PROVIDER], adapter)

  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(LocalFileSystem, { cwd: fixture.workspace })
  await ctx.plugin(FsObservationPolicy)
  await ctx.plugin(ToolFs)
  await installWorkspaceToolPolicy(ctx, fixture.workspace, policyTrace)

  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, {
    root: fixture.persistenceRoot,
    compression: 'none',
    packChunks: false,
  })
}

/** 创建带有精确绝对 cwd 的课程 Agent / Session。 */
export function createCapstoneAgent(
  ctx: Context,
  sessionId: SessionId,
  workspace: string,
): Promise<AgentHandle> {
  return ctx.agents.create({
    sessionId,
    meta: { cwd: workspace },
    agentOptions: {
      provider: SCRIPTED_PROVIDER,
      model: SCRIPTED_MODEL,
    },
  })
}

/** 从 JSONL 恢复同一个 identity；cwd 只能来自持久化 header。 */
export function resumeCapstoneAgent(
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

export async function disposeCapstoneRuntime(
  ctx: Context,
  handle?: AgentHandle,
): Promise<void> {
  try {
    if (handle !== undefined) await handle.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
}
