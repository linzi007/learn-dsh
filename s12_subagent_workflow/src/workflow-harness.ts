import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { GenerateOptions, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { SessionId, type SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import type {
  WorkflowAgentOutcome,
  WorkflowStopReason,
} from '@deepseek-ai/dsh-workflow'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'
import {
  SCRIPTED_MODEL,
  SCRIPTED_PROVIDER,
} from '../../s06_keyless_agent_loop/src/scripted-llm.ts'

export const COURSE_SUBAGENT_PROVIDER = 's12-course-spawn' as const

export interface WorkflowTraceEntry {
  readonly name:
    | 'workflow/start'
    | 'workflow/phase'
    | 'workflow/log'
    | 'workflow/agent-start'
    | 'workflow/agent-end'
    | 'workflow/end'
    | 'subagent/start'
    | 'subagent/end'
  readonly workflowRunId?: string
  readonly subagentRunId?: string
  readonly childId?: SessionIdType
  readonly childPublished?: boolean
  readonly seq?: number
  readonly phase?: string
  readonly message?: string
  readonly provider?: string
  readonly local?: boolean
  readonly workflowOutcome?: WorkflowAgentOutcome
  readonly workflowStopReason?: WorkflowStopReason
  readonly subagentStopReason?: SubagentStopReason
  readonly agentsStarted?: number
}

export interface WorkflowHarness {
  readonly ctx: Context
  readonly adapter: LlmAdapter & { readonly requests: readonly GenerateOptions[] }
  readonly parentHandle: AgentHandle
  readonly trace: WorkflowTraceEntry[]
  dispose(): Promise<void>
}

export interface WorkflowHarnessOptions {
  readonly parentSessionId: string
  readonly adapter: LlmAdapter & { readonly requests: readonly GenerateOptions[] }
  readonly maxTotalAgents?: number
}

function installTrace(ctx: Context, trace: WorkflowTraceEntry[]): void {
  ctx.on('workflow/start', info => {
    trace.push({ name: 'workflow/start', workflowRunId: info.id })
  })
  ctx.on('workflow/phase', (info, phase) => {
    trace.push({ name: 'workflow/phase', workflowRunId: info.id, phase })
  })
  ctx.on('workflow/log', (info, message) => {
    trace.push({ name: 'workflow/log', workflowRunId: info.id, message })
  })
  ctx.on('workflow/agent-start', (info, agent) => {
    trace.push({
      name: 'workflow/agent-start',
      workflowRunId: info.id,
      childId: agent.childId,
      childPublished: ctx.agents.get(agent.childId) !== undefined,
      seq: agent.seq,
      ...agent.phase === undefined ? {} : { phase: agent.phase },
    })
  })
  ctx.on('workflow/agent-end', (info, agent) => {
    trace.push({
      name: 'workflow/agent-end',
      workflowRunId: info.id,
      childId: agent.childId,
      seq: agent.seq,
      workflowOutcome: agent.outcome,
      ...agent.phase === undefined ? {} : { phase: agent.phase },
    })
  })
  ctx.on('workflow/end', (info, result) => {
    trace.push({
      name: 'workflow/end',
      workflowRunId: info.id,
      workflowStopReason: result.stopReason,
      agentsStarted: result.agentsStarted,
    })
  })
  ctx.on('subagent/start', info => {
    trace.push({
      name: 'subagent/start',
      subagentRunId: info.runId,
      childId: info.id,
      provider: info.provider,
      local: info.local,
    })
  })
  ctx.on('subagent/end', info => {
    trace.push({
      name: 'subagent/end',
      subagentRunId: info.runId,
      childId: info.id,
      provider: info.provider,
      local: info.local,
      subagentStopReason: info.stopReason,
    })
  })
}

/**
 * 组合真实 AgentLoop → SubagentRuntime → spawn provider → worker-thread workflow。
 * 唯一替身由调用方传入：一个不访问网络的 scripted LLM adapter。
 */
export async function createWorkflowHarness(
  options: WorkflowHarnessOptions,
): Promise<WorkflowHarness> {
  const ctx = new Context()
  let parentHandle: AgentHandle | undefined

  try {
    await mountAgentLoopTestDependencies(ctx)
    ctx.llm.registerAdapter([SCRIPTED_PROVIDER], options.adapter)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawnInProcess, { providerName: COURSE_SUBAGENT_PROVIDER })
    await ctx.plugin(WorkerThreadWorkflowEngine, {
      provider: COURSE_SUBAGENT_PROVIDER,
      maxConcurrentAgents: 2,
      maxTotalAgents: options.maxTotalAgents ?? 4,
      disposeGraceMs: 1_000,
    })

    const trace: WorkflowTraceEntry[] = []
    installTrace(ctx, trace)

    parentHandle = await ctx.agents.create({
      sessionId: SessionId(options.parentSessionId),
      agentOptions: {
        provider: SCRIPTED_PROVIDER,
        model: SCRIPTED_MODEL,
      },
    })

    const ownedParent = parentHandle
    return {
      ctx,
      adapter: options.adapter,
      parentHandle: ownedParent,
      trace,
      async dispose(): Promise<void> {
        try {
          await ownedParent.dispose()
        } finally {
          await ctx.fiber.dispose()
        }
      },
    }
  } catch (error) {
    try {
      if (parentHandle !== undefined) await parentHandle.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
    throw error
  }
}

export function requestContains(request: GenerateOptions, text: string): boolean {
  return JSON.stringify(request.messages).includes(text)
}

export function requestToolNames(request: GenerateOptions): string[] {
  return (request.tools ?? []).map(tool => tool.name)
}

export function startedChildIds(trace: readonly WorkflowTraceEntry[]): SessionIdType[] {
  return trace
    .filter((entry): entry is WorkflowTraceEntry & { childId: SessionIdType } =>
      entry.name === 'workflow/agent-start' && entry.childId !== undefined)
    .map(entry => entry.childId)
}
