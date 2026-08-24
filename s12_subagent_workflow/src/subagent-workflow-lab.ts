import { createUserMessage, CallId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent-in-process-driver'
import type { WorkflowResult } from '@deepseek-ai/dsh-workflow'
import {
  ScriptedLlmAdapter,
  textResponse,
  toolCallResponse,
} from '../../s06_keyless_agent_loop/src/scripted-llm.ts'
import {
  COURSE_SUBAGENT_PROVIDER,
  createWorkflowHarness,
  requestContains,
  requestToolNames,
  startedChildIds,
  type WorkflowTraceEntry,
} from './workflow-harness.ts'

export const PARENT_PRIVATE_MARKER = 'parent-only: release-window-17' as const

const POSITIVE_SCRIPT = `phase('收集候选')
log('启动 plain child 整理候选摘要')
const summary = await agent('整理 release-candidate-17 的变更摘要', {
  label: 'candidate-summary',
})

phase('形成结论')
log('启动 structured child 给出发布门禁结论')
const gate = await agent('根据下面摘要判断能否发布：' + summary, {
  label: 'release-gate',
  schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['ship', 'hold'] },
      checks: { type: 'array', items: { type: 'string' } },
    },
    required: ['verdict', 'checks'],
    additionalProperties: false,
  },
})

return {
  candidate: args.candidate,
  summary,
  verdict: gate.verdict,
  checks: gate.checks,
}`

const MISSING_STRUCTURED_SCRIPT = `phase('结构化检查')
const gate = await agent('请给出发布门禁 JSON', {
  label: 'missing-structured-output',
  schema: {
    type: 'object',
    properties: { verdict: { type: 'string', enum: ['ship', 'hold'] } },
    required: ['verdict'],
    additionalProperties: false,
  },
})
return { scriptObserved: gate === null ? 'null' : 'value' }`

const AGENT_CAP_SCRIPT = `phase('容量边界')
const first = await agent('执行第一项独立检查', { label: 'first-check' })
const second = await agent('执行第二项独立检查', { label: 'second-check' })
return { first, second }`

export interface PositiveWorkflowScenario {
  readonly result: WorkflowResult
  readonly trace: readonly WorkflowTraceEntry[]
  readonly modelRequests: readonly GenerateOptions[]
  readonly childIds: readonly string[]
  readonly parentMarkerSeenByParent: boolean
  readonly parentMarkerLeakedToChildren: boolean
  readonly plainChildTools: readonly string[]
  readonly structuredChildTools: readonly string[]
  readonly structuredToolParameters: unknown
  readonly structuredToolNeverRegisteredGlobally: boolean
  readonly summaryReachedStructuredChild: boolean
  readonly childrenMissingAfterRunDispose: boolean
  readonly childSessionsMissingAfterRunDispose: boolean
  readonly parentAliveAfterRunDispose: boolean
}

export interface MissingStructuredScenario {
  readonly result: WorkflowResult
  readonly trace: readonly WorkflowTraceEntry[]
  readonly modelRequestCount: number
  readonly structuredToolWasAdvertised: boolean
  readonly childrenMissingAfterRunDispose: boolean
}

export interface AgentCapScenario {
  readonly result: WorkflowResult
  readonly trace: readonly WorkflowTraceEntry[]
  readonly modelRequestCount: number
  readonly childrenMissingAfterRunDispose: boolean
}

function releaseSummaryResponse(request: GenerateOptions) {
  if (requestContains(request, PARENT_PRIVATE_MARKER)) {
    throw new Error('spawn child unexpectedly received the parent transcript marker')
  }
  return textResponse('候选摘要：测试通过，变更说明齐全。')
}

function releaseGateResponse(request: GenerateOptions) {
  if (!requestContains(request, '候选摘要：测试通过，变更说明齐全。')) {
    throw new Error('structured child did not receive the plain child summary')
  }
  return toolCallResponse(
    CallId('s12-release-gate'),
    STRUCTURED_OUTPUT_TOOL,
    { verdict: 'ship', checks: ['tests', 'release-notes'] },
  )
}

/** 运行 parent transcript → plain child → structured child → 汇总的完整主线。 */
export async function runPositiveWorkflowScenario(): Promise<PositiveWorkflowScenario> {
  const adapter = new ScriptedLlmAdapter([
    textResponse('父级已经记录发布窗口，但不会把 transcript 复制给 spawn child。'),
    releaseSummaryResponse,
    releaseGateResponse,
  ])
  const harness = await createWorkflowHarness({
    parentSessionId: 's12-positive-parent',
    adapter,
  })
  let run: ReturnType<typeof harness.ctx.workflowEngine.start> | undefined

  try {
    harness.parentHandle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: PARENT_PRIVATE_MARKER }],
      source: { kind: 'user' },
    }))
    await harness.parentHandle.agent.whenIdle()

    run = harness.ctx.workflowEngine.start({
      meta: {
        name: 'course-release-gate',
        description: '先整理候选，再输出结构化发布结论',
        phases: [
          { title: '收集候选' },
          { title: '形成结论' },
        ],
      },
      args: { candidate: 'release-candidate-17' },
      script: POSITIVE_SCRIPT,
      parent: harness.parentHandle.agent,
      subagentProvider: COURSE_SUBAGENT_PROVIDER,
      maxTotalAgents: 2,
    })
    const result = await run.result
    const childIds = startedChildIds(harness.trace)

    await run.dispose()
    run = undefined

    const requests = [...adapter.requests]
    const parentRequest = requests[0]
    const plainChildRequest = requests[1]
    const structuredChildRequest = requests[2]
    if (parentRequest === undefined || plainChildRequest === undefined || structuredChildRequest === undefined) {
      throw new Error(`positive scenario expected 3 model requests, got ${requests.length}`)
    }

    return {
      result,
      trace: [...harness.trace],
      modelRequests: requests,
      childIds,
      parentMarkerSeenByParent: requestContains(parentRequest, PARENT_PRIVATE_MARKER),
      parentMarkerLeakedToChildren: requests
        .slice(1)
        .some(request => requestContains(request, PARENT_PRIVATE_MARKER)),
      plainChildTools: requestToolNames(plainChildRequest),
      structuredChildTools: requestToolNames(structuredChildRequest),
      structuredToolParameters: structuredChildRequest.tools
        ?.find(tool => tool.name === STRUCTURED_OUTPUT_TOOL)?.parameters,
      structuredToolNeverRegisteredGlobally:
        harness.ctx.tools.get(STRUCTURED_OUTPUT_TOOL) === undefined,
      summaryReachedStructuredChild: requestContains(
        structuredChildRequest,
        '候选摘要：测试通过，变更说明齐全。',
      ),
      childrenMissingAfterRunDispose: childIds.every(id => harness.ctx.agents.get(id) === undefined),
      childSessionsMissingAfterRunDispose: childIds.every(id => harness.ctx.sessions.get(id) === undefined),
      parentAliveAfterRunDispose:
        harness.ctx.agents.get(harness.parentHandle.agent.session.id) === harness.parentHandle.agent,
    }
  } finally {
    if (run !== undefined) await run.dispose()
    await harness.dispose()
  }
}

/** schema child 只输出 prose：没有隐式重试，普通 child failure 在脚本中成为 null。 */
export async function runMissingStructuredScenario(): Promise<MissingStructuredScenario> {
  const adapter = new ScriptedLlmAdapter([
    textResponse('我只写了 prose，没有调用 structured_output。'),
    textResponse('这个备用响应不应被消费。'),
  ])
  const harness = await createWorkflowHarness({
    parentSessionId: 's12-missing-structured-parent',
    adapter,
  })
  let run: ReturnType<typeof harness.ctx.workflowEngine.start> | undefined

  try {
    run = harness.ctx.workflowEngine.start({
      meta: {
        name: 'course-missing-structured',
        description: '观察 schema child 未提交结构化结果时的 null 边界',
      },
      script: MISSING_STRUCTURED_SCRIPT,
      parent: harness.parentHandle.agent,
      maxTotalAgents: 1,
    })
    const result = await run.result
    const childIds = startedChildIds(harness.trace)
    await run.dispose()
    run = undefined

    const request = adapter.requests[0]
    return {
      result,
      trace: [...harness.trace],
      modelRequestCount: adapter.requests.length,
      structuredToolWasAdvertised:
        request !== undefined && requestToolNames(request).includes(STRUCTURED_OUTPUT_TOOL),
      childrenMissingAfterRunDispose: childIds.every(id => harness.ctx.agents.get(id) === undefined),
    }
  } finally {
    if (run !== undefined) await run.dispose()
    await harness.dispose()
  }
}

/** 第二个 agent() 越过每次运行上限：fatal cap 结束 workflow，不降级成 null。 */
export async function runAgentCapScenario(): Promise<AgentCapScenario> {
  const adapter = new ScriptedLlmAdapter([
    textResponse('第一项独立检查完成。'),
  ])
  const harness = await createWorkflowHarness({
    parentSessionId: 's12-agent-cap-parent',
    adapter,
    maxTotalAgents: 2,
  })
  let run: ReturnType<typeof harness.ctx.workflowEngine.start> | undefined

  try {
    run = harness.ctx.workflowEngine.start({
      meta: {
        name: 'course-agent-cap',
        description: '观察部署上限阻断脚本继续创建 child',
      },
      script: AGENT_CAP_SCRIPT,
      parent: harness.parentHandle.agent,
      maxTotalAgents: 1,
    })
    const result = await run.result
    const childIds = startedChildIds(harness.trace)
    await run.dispose()
    run = undefined

    return {
      result,
      trace: [...harness.trace],
      modelRequestCount: adapter.requests.length,
      childrenMissingAfterRunDispose: childIds.every(id => harness.ctx.agents.get(id) === undefined),
    }
  } finally {
    if (run !== undefined) await run.dispose()
    await harness.dispose()
  }
}
