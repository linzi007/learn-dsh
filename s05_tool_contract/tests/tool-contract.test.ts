import { beforeAll, describe, expect, it } from 'vitest'
import {
  COURSE_ADD_TOOL_NAME,
  courseAddTool,
  courseAddToolPlugin,
} from '../src/course-add-tool.ts'
import {
  runToolContractScenario,
  type ToolContractScenarioResult,
} from '../src/tool-contract-lab.ts'

let scenario: ToolContractScenarioResult

beforeAll(async () => {
  scenario = await runToolContractScenario()
})

describe('第 5 章：Tool contract', () => {
  it('导出一个可跨章复用的无状态 ToolDefinition 与注册 Plugin', () => {
    expect(courseAddTool.name).toBe(COURSE_ADD_TOOL_NAME)
    expect(courseAddToolPlugin.inject).toEqual(['tools'])
    expect(courseAddTool.parameters).toEqual({
      type: 'object',
      properties: {
        left: { type: 'integer', description: '左侧整数。' },
        right: { type: 'integer', description: '右侧整数。' },
      },
      required: ['left', 'right'],
    })
  })

  it('Registry schema 与 SystemPrompt assembly 的 model-facing schema 一致', () => {
    expect(scenario.registrySchema).toEqual(scenario.assembledSchema)
    expect(scenario.registrySchema).toEqual({
      name: COURSE_ADD_TOOL_NAME,
      description: '将两个整数相加，并返回结构化的和。',
      parameters: courseAddTool.parameters,
    })
    expect(scenario.registrySchema).not.toHaveProperty('execute')
    expect(scenario.registrySchema).not.toHaveProperty('output')
  })

  it('有效调用同时保留 canonical value 与 rendered content', () => {
    expect(scenario.success).toEqual({
      isError: false,
      value: { sum: 42 },
      content: [{ type: 'text', text: '计算结果：20 + 22 = 42' }],
    })
  })

  it('错误参数返回 INVALID_ARGS，而不是成功 value', () => {
    expect(scenario.invalidArguments).toMatchObject({
      isError: true,
      error: {
        info: { name: 'ToolArgsError', code: 'INVALID_ARGS' },
      },
    })
    expect(scenario.invalidArguments).not.toHaveProperty('value')
    expect(scenario.invalidArguments.content).toEqual([{
      type: 'text',
      text: 'Error: invalid arguments: "right" must be an integer',
    }])
  })

  it('故障 body 的错误 canonical value 返回 INVALID_TOOL_OUTPUT', () => {
    expect(scenario.invalidOutput).toMatchObject({
      isError: true,
      error: {
        info: { name: 'ToolOutputError', code: 'INVALID_TOOL_OUTPUT' },
      },
    })
    expect(scenario.invalidOutput).not.toHaveProperty('value')
    expect(scenario.invalidOutput.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('"value.sum" must be an integer'),
    })
  })

  it('tools/result 观察成功、两类失败与 dispose 后调用的最终结果', () => {
    expect(scenario.observations.map(observation => ({
      callId: observation.callId,
      name: observation.name,
      code: observation.errorCode,
    }))).toEqual([
      { callId: 's05-valid', name: COURSE_ADD_TOOL_NAME, code: null },
      { callId: 's05-invalid-args', name: COURSE_ADD_TOOL_NAME, code: 'INVALID_ARGS' },
      { callId: 's05-invalid-output', name: 'course_add_invalid_output_probe', code: 'INVALID_TOOL_OUTPUT' },
      { callId: 's05-after-dispose', name: COURSE_ADD_TOOL_NAME, code: 'UNKNOWN_TOOL' },
    ])
  })

  it('Tool Plugin Fiber dispose 会注销工具，后续执行返回 UNKNOWN_TOOL', () => {
    expect(scenario.schemasAfterDispose).toEqual([])
    expect(scenario.unknownAfterDispose).toMatchObject({
      isError: true,
      error: {
        message: 'unknown tool "course_add"',
        info: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' },
      },
    })
    expect(scenario.unknownAfterDispose).not.toHaveProperty('value')
  })
})
