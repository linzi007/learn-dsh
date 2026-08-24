import { beforeAll, describe, expect, it } from 'vitest'
import {
  PUBLIC_FAILURE_TOOL_NAME,
  PUBLIC_LOOKUP_TOOL_NAME,
  runMcpBridgeScenario,
  type McpBridgeScenarioResult,
} from '../src/mcp-bridge-lab.ts'
import {
  RAW_FAILURE_TOOL_NAME,
  RAW_LOOKUP_TOOL_NAME,
} from '../src/fixture-contract.ts'

let scenario: McpBridgeScenarioResult

beforeAll(async () => {
  scenario = await runMcpBridgeScenario()
}, 20_000)

describe('第 11 章：MCP bridge', () => {
  it('通过真实 MCP tools/list 发现 server-qualified public names', () => {
    expect(scenario.discoveredNames).toEqual(expect.arrayContaining([
      PUBLIC_LOOKUP_TOOL_NAME,
      PUBLIC_FAILURE_TOOL_NAME,
    ]))
    expect(scenario.discoveredNames).toHaveLength(2)
    expect(scenario.discoveredNames).not.toContain(RAW_LOOKUP_TOOL_NAME)
    expect(scenario.discoveredNames).not.toContain(RAW_FAILURE_TOOL_NAME)
    expect(scenario.lookupSchemaDescription).toContain('确定性课程 fixture')
    expect(scenario.lookupSchemaParameters).toMatchObject({
      type: 'object',
      properties: { concept: { type: 'string' } },
      required: ['concept'],
    })
  })

  it('raw name 只属于 MCP wire，直接交给 ToolRuntime 会返回 UNKNOWN_TOOL', () => {
    expect(scenario.rawNameCall).toMatchObject({
      isError: true,
      error: {
        message: `unknown tool "${RAW_LOOKUP_TOOL_NAME}"`,
        info: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' },
      },
    })
  })

  it('无效参数由 MCP server SDK 拒绝，没有触达 fixture handler', () => {
    expect(scenario.serverArgumentError).toMatchObject({
      isError: true,
      error: {
        message: expect.stringContaining('MCP error -32602: Input validation error'),
      },
    })
    if (!scenario.serverArgumentError.isError) throw new Error('server argument error unexpectedly succeeded')
    expect(scenario.serverArgumentError.error.info).toBeUndefined()
    expect(scenario.successValue.structuredContent?.callCount).toBe(1)
  })

  it('public name 通过真实 tools/call 命中 raw handler，并保留 canonical MCP blocks', () => {
    expect(scenario.success.isError).toBe(false)
    expect(scenario.success.content).toEqual([{
      type: 'text',
      text: expect.stringContaining('[local fixture] plugin:'),
    }])
    expect(scenario.successValue).toMatchObject({
      content: [{
        type: 'text',
        text: expect.stringContaining('[local fixture] plugin:'),
      }],
      structuredContent: {
        rawToolName: RAW_LOOKUP_TOOL_NAME,
        concept: 'plugin',
        fixture: true,
        callCount: 1,
        serverPid: expect.any(Number),
      },
    })
    expect(scenario.childWasAlive).toBe(true)
  })

  it('MCP isError 成为 ToolRuntime 失败，但不冒充参数错误', () => {
    expect(scenario.mcpToolError.isError).toBe(true)
    if (!scenario.mcpToolError.isError) throw new Error('MCP tool-result error unexpectedly succeeded')
    expect(scenario.mcpToolError.error.message)
      .toContain('[local fixture] rejected: expected boundary probe')
    expect(scenario.mcpToolError.error.info).toBeUndefined()
    expect(scenario.mcpToolError).not.toHaveProperty('value')
  })

  it('Plugin Fiber dispose 注销工具、停止子进程，后续调用返回 UNKNOWN_TOOL', () => {
    expect(scenario.childStoppedAfterDispose).toBe(true)
    expect(scenario.namesAfterDispose).toEqual([])
    expect(scenario.publicNameAfterDispose).toMatchObject({
      isError: true,
      error: {
        info: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' },
      },
    })
  })
})
