import { describe, expect, it } from 'vitest'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent-in-process-driver'
import { COURSE_SUBAGENT_PROVIDER } from '../src/workflow-harness.ts'
import {
  runAgentCapScenario,
  runMissingStructuredScenario,
  runPositiveWorkflowScenario,
} from '../src/subagent-workflow-lab.ts'

describe('第 12 章：Subagent 与 worker workflow', () => {
  it('真实两阶段脚本汇总 plain child 与 structured child', async () => {
    const scenario = await runPositiveWorkflowScenario()

    expect(scenario.result).toEqual({
      value: {
        candidate: 'release-candidate-17',
        summary: '候选摘要：测试通过，变更说明齐全。',
        verdict: 'ship',
        checks: ['tests', 'release-notes'],
      },
      stopReason: 'completed',
      agentsStarted: 2,
    })
    expect(scenario.modelRequests).toHaveLength(3)
    expect(scenario.parentMarkerSeenByParent).toBe(true)
    expect(scenario.parentMarkerLeakedToChildren).toBe(false)
    expect(scenario.plainChildTools).not.toContain(STRUCTURED_OUTPUT_TOOL)
    expect(scenario.structuredChildTools).toContain(STRUCTURED_OUTPUT_TOOL)
    expect(scenario.structuredToolParameters).toEqual({
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['ship', 'hold'] },
        checks: { type: 'array', items: { type: 'string' } },
      },
      required: ['verdict', 'checks'],
      additionalProperties: false,
    })
    expect(scenario.structuredToolNeverRegisteredGlobally).toBe(true)
    expect(scenario.summaryReachedStructuredChild).toBe(true)
    expect(scenario.childIds).toHaveLength(2)
    expect(new Set(scenario.childIds).size).toBe(2)
    expect(scenario.childrenMissingAfterRunDispose).toBe(true)
    expect(scenario.childSessionsMissingAfterRunDispose).toBe(true)
    expect(scenario.parentAliveAfterRunDispose).toBe(true)
  })

  it('workflow 与 subagent 两套生命周期各自严格配对，并用 childId 交叉关联', async () => {
    const { trace } = await runPositiveWorkflowScenario()
    const workflowStarts = trace.filter(event => event.name === 'workflow/start')
    const workflowEnds = trace.filter(event => event.name === 'workflow/end')
    const agentStarts = trace.filter(event => event.name === 'workflow/agent-start')
    const agentEnds = trace.filter(event => event.name === 'workflow/agent-end')
    const subagentStarts = trace.filter(event => event.name === 'subagent/start')
    const subagentEnds = trace.filter(event => event.name === 'subagent/end')

    expect(trace[0]?.name).toBe('workflow/start')
    expect(trace.at(-1)?.name).toBe('workflow/end')
    expect(workflowStarts).toHaveLength(1)
    expect(workflowEnds).toHaveLength(1)
    expect(workflowEnds[0]?.workflowRunId).toBe(workflowStarts[0]?.workflowRunId)
    expect(workflowEnds[0]).toMatchObject({
      workflowStopReason: 'completed',
      agentsStarted: 2,
    })

    expect(agentStarts.map(event => event.seq)).toEqual([1, 2])
    expect(agentStarts.every(event => event.childPublished === true)).toBe(true)
    expect(agentEnds.map(event => [event.seq, event.workflowOutcome])).toEqual([
      [1, 'completed'],
      [2, 'completed'],
    ])
    expect(agentEnds.map(event => event.childId)).toEqual(agentStarts.map(event => event.childId))

    expect(subagentStarts).toHaveLength(2)
    expect(subagentEnds).toHaveLength(2)
    expect(new Set(subagentStarts.map(event => event.subagentRunId)).size).toBe(2)
    expect(subagentStarts.map(event => event.subagentRunId))
      .not.toContain(workflowStarts[0]?.workflowRunId)
    expect(subagentStarts.map(event => event.childId)).toEqual(agentStarts.map(event => event.childId))
    for (const start of subagentStarts) {
      expect(start).toMatchObject({ provider: COURSE_SUBAGENT_PROVIDER, local: true })
      expect(subagentEnds).toContainEqual(expect.objectContaining({
        subagentRunId: start.subagentRunId,
        childId: start.childId,
        provider: COURSE_SUBAGENT_PROVIDER,
        local: true,
        subagentStopReason: 'completed',
      }))
    }

    expect(trace
      .filter(event => event.name === 'workflow/phase')
      .map(event => event.phase)).toEqual(['收集候选', '形成结论'])
    expect(trace.filter(event => event.name === 'workflow/log')).toHaveLength(2)
  })

  it('schema child 没调用 structured_output 时不重试，脚本收到 null', async () => {
    const scenario = await runMissingStructuredScenario()

    expect(scenario.result).toEqual({
      value: { scriptObserved: 'null' },
      stopReason: 'completed',
      agentsStarted: 1,
    })
    expect(scenario.modelRequestCount).toBe(1)
    expect(scenario.structuredToolWasAdvertised).toBe(true)
    expect(scenario.childrenMissingAfterRunDispose).toBe(true)
    expect(scenario.trace.find(event => event.name === 'subagent/end')).toMatchObject({
      subagentStopReason: 'error',
    })
    expect(scenario.trace.find(event => event.name === 'workflow/agent-end')).toMatchObject({
      workflowOutcome: 'failed',
    })
    expect(scenario.trace.find(event => event.name === 'workflow/end')).toMatchObject({
      workflowStopReason: 'completed',
      agentsStarted: 1,
    })
  })

  it('maxTotalAgents 是 fatal workflow 边界，不把第二个 agent() 降级为 null', async () => {
    const scenario = await runAgentCapScenario()

    expect(scenario.result).toMatchObject({
      value: null,
      stopReason: 'error',
      agentsStarted: 1,
    })
    expect(scenario.result.error).toContain('total agent cap (1)')
    expect(scenario.result.error).toContain('maxTotalAgents')
    expect(scenario.modelRequestCount).toBe(1)
    expect(scenario.childrenMissingAfterRunDispose).toBe(true)
    expect(scenario.trace.filter(event => event.name === 'workflow/agent-start')).toHaveLength(1)
    expect(scenario.trace.filter(event => event.name === 'subagent/start')).toHaveLength(1)
    expect(scenario.trace.find(event => event.name === 'workflow/end')).toMatchObject({
      workflowStopReason: 'error',
      agentsStarted: 1,
    })
  })
})
