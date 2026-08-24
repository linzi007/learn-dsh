import {
  LlmError,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { beforeAll, describe, expect, it } from 'vitest'
import { COURSE_ADD_TOOL_NAME } from '../../s05_tool_contract/src/course-add-tool.ts'
import {
  runAgentLoopScenario,
  runStepBudgetScenario,
  type AgentLoopScenarioResult,
  type StepBudgetScenarioResult,
} from '../src/loop-lab.ts'
import { ScriptedLlmAdapter } from '../src/scripted-llm.ts'

let positive: AgentLoopScenarioResult
let budget: StepBudgetScenarioResult

beforeAll(async () => {
  [positive, budget] = await Promise.all([
    runAgentLoopScenario(),
    runStepBudgetScenario(2),
  ])
})

function requiredAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index]
  if (value === undefined) throw new Error(`missing ${label} at index ${index}`)
  return value
}

function findToolResultBlock(request: GenerateOptions) {
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === 'tool-result') return block
    }
  }
  throw new Error('missing tool-result block')
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('第 6 章：无 Key 的真实 AgentLoop', () => {
  it('第一次请求看见 S05 注册的 course_add，第二次请求看见真实 tool-result', () => {
    expect(positive.requests).toHaveLength(2)
    const first = requiredAt(positive.requests, 0, 'first request')
    const second = requiredAt(positive.requests, 1, 'second request')

    expect(first.tools?.map(tool => tool.name)).toContain(COURSE_ADD_TOOL_NAME)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(second)).toBe(true)

    const resultBlock = findToolResultBlock(second)
    expect(resultBlock.isError).toBe(false)
    expect(resultBlock.content).toEqual([{
      type: 'text',
      text: '计算结果：20 + 22 = 42',
    }])
    expect(positive.finalText).toBe(
      '我读取了真实工具结果：计算结果：20 + 22 = 42',
    )
  })

  it('assistant tool-call、tool/call 与 tool/result 使用同一个 CallId 和来源 seq', () => {
    const assistantEvents = positive.events.filter(event => event.type === 'assistant/message')
    const toolCallEvents = positive.events.filter(event => event.type === 'tool/call')
    const toolResultEvents = positive.events.filter(event => event.type === 'tool/result')
    const firstAssistant = requiredAt(assistantEvents, 0, 'first assistant event')
    const toolCall = requiredAt(toolCallEvents, 0, 'tool/call event')
    const toolResult = requiredAt(toolResultEvents, 0, 'tool/result event')

    const assistantCall = firstAssistant.data.message.content.find(
      block => block.type === 'tool-call',
    )
    if (assistantCall?.type !== 'tool-call') throw new Error('missing assistant tool-call')

    const resultBlock = toolResult.data.message.content[0]
    expect(assistantCall.id).toBe(toolCall.data.callId)
    expect(toolResult.data.message.source.callId).toBe(toolCall.data.callId)
    expect(resultBlock.toolCallId).toBe(toolCall.data.callId)
    expect(toolResult.sourceEventSeqs).toEqual([toolCall.seq])
    expect(resultBlock.isError).toBe(false)
  })

  it('一个 Turn 内完成两个 Step，持久事件轨迹最终 completed → idle', () => {
    expect(positive.simplifiedTrace).toEqual([
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'step/start',
      'assistant/message',
      'step/end',
      'turn/end',
    ])

    const stepStarts = positive.events.filter(event => event.type === 'step/start')
    const turnEnd = positive.events.filter(event => event.type === 'turn/end').at(-1)
    expect(stepStarts.map(event => event.data.step)).toEqual([1, 2])
    expect(turnEnd?.data.reason.kind).toBe('completed')
    expect(positive.statusBeforeDispose).toBe('idle')
  })

  it('AgentHandle.dispose 是 teardown capability，会同时移除 Agent 与 Session', () => {
    expect(positive.agentPresentBeforeDispose).toBe(true)
    expect(positive.sessionPresentBeforeDispose).toBe(true)
    expect(positive.agentMissingAfterDispose).toBe(true)
    expect(positive.sessionMissingAfterDispose).toBe(true)
  })

  it('课程自定义 maxStepsPerTurn 在第 3 个拟议 Step 前阻断自循环', () => {
    expect(budget.maxStepsPerTurn).toBe(2)
    expect(budget.requests).toHaveLength(2)

    const stepStarts = budget.events.filter(event => event.type === 'step/start')
    const stepEnds = budget.events.filter(event => event.type === 'step/end')
    const toolCalls = budget.events.filter(event => event.type === 'tool/call')
    const toolResults = budget.events.filter(event => event.type === 'tool/result')

    expect(stepStarts.map(event => event.data.step)).toEqual([1, 2])
    expect(stepEnds.map(event => event.data.step)).toEqual([1, 2])
    expect(toolCalls).toHaveLength(2)
    expect(toolResults).toHaveLength(2)
    expect(toolResults.every(event => event.data.message.content[0].isError === false)).toBe(true)
    expect(budget.turnEndReason.kind).toBe('blocked')
    expect(budget.statusBeforeDispose).toBe('idle')
  })

  it('有限脚本耗尽时给出稳定 SCRIPT_EXHAUSTED，而不是静默返回空流', async () => {
    const adapter = new ScriptedLlmAdapter([])
    const request: GenerateOptions = {
      provider: 'course-scripted',
      model: 'course-scripted-model',
      messages: [],
    }

    await expect(collect(adapter.stream(request))).rejects.toMatchObject({
      name: LlmError.name,
      code: 'SCRIPT_EXHAUSTED',
    })
  })
})
